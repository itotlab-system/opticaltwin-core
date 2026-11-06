"""The JSON the client renders: the full project payload, and the light move
payload (transforms + beam only) that the client merges with mergeMove."""

import os
import threading
from collections import OrderedDict

from pxr import Usd

from opticaltwin import optics_lib as ol
from opticaltwin import usd_utility as uu
from opticaltwin import beam_tracer
from opticaltwin import generic_parts

from backend import config
from backend import catalog
from backend import components
from backend import library
from backend.beam import (
    _apply_beam_shape,
    _beam_path,
    _beam_segments,
    _beam_shape,
    _laser_emission_segments,
    _resolve_beam_path,
)
from backend.board import BOARD_MODEL_ORDER, _board
from backend.callouts import _callouts
from backend.components import (
    LASER_APERTURE_OFFSET_MM,
    _beam_physics_metadata,
    _component_asset_name,
    _component_model_pose,
    _component_primitives,
    _rod_asset_shoulder_offsets,
)
from backend.groups import _groups
from backend.history import _history_state
from backend.pins import _pins
from backend.placement import _placement_xform_values
from backend.scene import _component_prims, _optics_attrs

_MOVE_ASSET_CACHE_LIMIT = 64

_MOVE_ASSET_CACHE = OrderedDict()

_MOVE_ASSET_CACHE_LOCK = threading.Lock()

# optics:* attributes that live on the project's placement prim rather than in
# the reusable component asset, and so are layered over the asset's own attrs.
# A move can author one of them (holderZOffset_mm), which is why the light move
# payload carries exactly these keys and no others.
PLACEMENT_ATTR_KEYS = (
    "pairedPost", "pairedHolder", "holderZOffset_mm",
    # Whether this particular laser is switched on. Without this a CAD laser
    # takes the catalogue value and the switch appears to do nothing.
    "laserOn",
)

def _move_asset_cache_get(key):
    """Return cached immutable beam geometry and mark it as recently used."""
    with _MOVE_ASSET_CACHE_LOCK:
        cached = _MOVE_ASSET_CACHE.get(key)
        if cached is not None:
            _MOVE_ASSET_CACHE.move_to_end(key)
        return cached

def _move_asset_cache_put(key, value):
    """Keep a bounded LRU of asset-local data used to retrace moves."""
    with _MOVE_ASSET_CACHE_LOCK:
        _MOVE_ASSET_CACHE[key] = value
        _MOVE_ASSET_CACHE.move_to_end(key)
        while len(_MOVE_ASSET_CACHE) > _MOVE_ASSET_CACHE_LIMIT:
            _MOVE_ASSET_CACHE.popitem(last=False)

def _project_components(stage, render_mode="lo", include_fixed=False, *, beam_only=False,
                        names=None):
    """Every placed component as the client renders it.

    `names` limits it to those parts. A part added to an open bench is sent on
    its own this way, built by exactly the code a full reload uses, so merging
    it gives the same scene as reloading.
    """
    if render_mode not in ("hi", "lo"):
        raise ValueError("render_mode must be 'hi' or 'lo'")
    comps = []
    cad_assets = ol.cad_library_assets(config.LIB_DIR)
    asset_data_cache = {}
    for prim in _component_prims(stage, include_fixed=include_fixed):
        if names is not None and prim.GetName() not in names:
            continue
        x, y, z, rot_x, rot_y, rot_z = _placement_xform_values(prim)
        t = prim.GetAttribute("optics:type").Get()
        asset = _component_asset_name(prim)
        geometry_stage = stage
        geometry_root = prim
        geometry_key = None
        placement_attrs = _optics_attrs(prim)
        attrs = placement_attrs
        model_pose = {
            "modelRotation": [0.0, 0.0, 0.0],
            "rotationCenter": [0.0, 0.0, 0.0],
        }

        # Generated CAD assets are opened directly in both modes.  Reading lo
        # through the project reference would let the placement prim's xform
        # order mask rotations authored on the lo.usda root.
        if asset and (render_mode == "hi" or asset in cad_assets):
            component_name = uu.get_component_name(asset)
            geometry_path = uu.get_component_usda_path(
                config.LIB_DIR, component_name, render_mode
            )
            if not os.path.exists(geometry_path):
                if render_mode == "hi":
                    continue
            else:
                geometry_stat = os.stat(geometry_path)
                geometry_key = (
                    os.path.realpath(geometry_path),
                    geometry_stat.st_mtime_ns,
                    geometry_stat.st_size,
                    render_mode,
                    beam_only,
                )
                cached = asset_data_cache.get(geometry_key)
                if cached is None and beam_only:
                    cached = _move_asset_cache_get(geometry_key)
                    if cached is not None:
                        asset_data_cache[geometry_key] = cached
                if cached is None:
                    asset_stage = Usd.Stage.Open(geometry_path)
                    if (
                        asset_stage is None
                        or not asset_stage.GetDefaultPrim().IsValid()
                    ):
                        if render_mode == "hi":
                            continue
                        geometry_key = None
                    else:
                        asset_root = asset_stage.GetDefaultPrim()
                        asset_pose = _component_model_pose(asset_stage, asset_root)
                        asset_type = asset_root.GetAttribute("optics:type")
                        asset_attrs = _optics_attrs(asset_root)
                        asset_type_value = (
                            asset_type.Get()
                            if asset_type and asset_type.HasAuthoredValue()
                            else None
                        )
                        asset_meshes = (
                            components._component_meshes(asset_stage, asset_root, beam_only=True)
                            if beam_only else components._component_meshes(asset_stage, asset_root)
                        )
                        asset_primitives = _component_primitives(asset_stage, asset_root)
                        cached = (
                            asset_pose, asset_type_value, asset_attrs,
                            asset_meshes, asset_primitives,
                        )
                        asset_data_cache[geometry_key] = cached
                        if beam_only:
                            _move_asset_cache_put(geometry_key, cached)
                if geometry_key is not None:
                    (
                        model_pose, asset_type_value, attrs, meshes, primitives,
                    ) = cached
                    if asset_type_value is not None:
                        t = asset_type_value
                    attrs = dict(attrs)
                elif render_mode == "hi":
                    continue
        elif render_mode == "hi":
            # A placeholder has no library asset to read hi geometry from;
            # its own inline shape is all there is, in either mode.
            if not asset and not generic_parts.is_generic(prim):
                continue

        if geometry_key is None:
            meshes = (
                components._component_meshes(geometry_stage, geometry_root, beam_only=True)
                if beam_only else components._component_meshes(geometry_stage, geometry_root)
            )
            primitives = _component_primitives(geometry_stage, geometry_root)
        component = dict(name=prim.GetName(), type=t,
                         x=round(x, 3), y=round(y, 3), z=round(z, 3),
                         rotX=round(rot_x, 3), rotY=round(rot_y, 3),
                         rotZ=round(rot_z, 3), attrs=_optics_attrs(prim),
                         asset=asset,
                         cadDerived=asset in cad_assets,
                         renderMode=render_mode)
        component["attrs"] = attrs
        # Relationship/trim metadata is authored on the project placement
        # prim, not in the reusable component asset.
        for key in PLACEMENT_ATTR_KEYS:
            if key in placement_attrs:
                component["attrs"][key] = placement_attrs[key]
        rod_shoulders = _rod_asset_shoulder_offsets(asset)
        if rod_shoulders:
            component["attrs"].update(rod_shoulders)
        component.update(model_pose)
        if meshes:
            component["meshes"] = meshes
        if primitives:
            component["primitives"] = primitives
        component["physics"] = _beam_physics_metadata(component)
        comps.append(component)
    return comps

def _resolved_project_beam(stage, comps_by_name, beam_path):
    traced = beam_tracer.trace_lasers(
        list(comps_by_name.values()),
        aperture_offset_mm=LASER_APERTURE_OFFSET_MM,
    )
    if traced:
        # The tracer ends a leg at every hit, including the mounts and posts the
        # beam passes through. Fuse those back together so a segment is the
        # stretch between two optics — the thing a user means by "the beam
        # between the lenses", and the thing they click to shape.
        return beam_tracer.merge_structural(traced, comps_by_name)
    if beam_tracer.has_laser(comps_by_name.values()):
        # There is a laser and it emitted nothing, so it is switched off. The
        # bench must go dark: falling through to an authored beam path here
        # would draw a beam with the source turned off.
        return []
    if beam_path:
        beam = _resolve_beam_path(stage, comps_by_name)
        return beam
    return _beam_segments(stage) + _laser_emission_segments(comps_by_name)

def _project_payload(name, stage, render_mode="lo"):
    catalog._sync_cad_catalog()
    all_components = _project_components(stage, render_mode, include_fixed=True)
    editable_names = {prim.GetName() for prim in _component_prims(stage)}
    comps = [c for c in all_components if c["name"] in editable_names]
    board_model = next(
        (component for component in all_components
         if component["type"] == "breadboard"),
        None,
    )
    beam_path = _beam_path(stage)
    physics_comps = (
        comps
        if render_mode == "lo"
        else _project_components(stage, "lo")
    )
    comps_by_name = {c["name"]: c for c in physics_comps}
    return dict(name=name, components=comps,
                beam=_apply_beam_shape(
                    _resolved_project_beam(stage, comps_by_name, beam_path),
                    _beam_shape(stage),
                ),
                beamPath=beam_path,
                board=_board(stage, board_model),
                boardModels=[
                    asset for asset in BOARD_MODEL_ORDER
                    if asset in ol.cad_library_assets(config.LIB_DIR)
                ],
                library=ol.component_library_assets(),
                libraryPreviews=library._library_previews(),
                renderMode=render_mode,
                pins=_pins(stage),
                callouts=_callouts(stage),
                groups=_groups(stage),
                **_history_state(name))

def _move_payload(name, stage, render_mode="lo"):
    """The subset of the scene a component move can change.

    A move rewrites transforms and retraces the beam. It never touches geometry,
    the board, the catalogue, pins or groups — yet the full payload re-serialized
    all of it on every drag: 0.47 MB in lo and 50 MB in hi, the latter costing
    ~18 s because it re-reads every hi-res CAD asset. This carries transforms
    only, so it is the same handful of kB in either mode, and the client merges
    it into the scene it already has (see mergeMove in app/src/moveMerge.ts).

    Keep low-detail collision primitives and transparent mesh points for beam
    bounds, without preparing opaque vertices, triangles or mesh materials.
    """
    comps = _project_components(stage, "lo", beam_only=True)
    beam_path = _beam_path(stage)
    comps_by_name = {c["name"]: c for c in comps}
    return dict(
        name=name,
        partial=True,               # a merge, not a replacement
        components=[
            {
                "name": c["name"],
                "x": c["x"], "y": c["y"], "z": c["z"],
                "rotX": c["rotX"], "rotY": c["rotY"], "rotZ": c["rotZ"],
                "attrs": {k: c["attrs"][k]
                          for k in PLACEMENT_ATTR_KEYS if k in c["attrs"]},
            }
            for c in comps
        ],
        beam=_apply_beam_shape(
            _resolved_project_beam(stage, comps_by_name, beam_path),
            _beam_shape(stage),
        ),
        renderMode=render_mode,
        **_history_state(name),
    )
