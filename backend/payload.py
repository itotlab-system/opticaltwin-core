import os
import threading
from collections import OrderedDict
from typing import Any, Literal, NamedTuple, NotRequired, TypedDict

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

_ASSET_CACHE_MAX_ENTRIES = 128

_ASSET_CACHE = OrderedDict()

_ASSET_CACHE_LOCK = threading.Lock()

PLACEMENT_ATTR_KEYS = (
    "pairedPost", "pairedHolder", "holderZOffset_mm",
    "laserOn",
)

def _asset_cache_get(key):
    with _ASSET_CACHE_LOCK:
        cached = _ASSET_CACHE.get(key)
        if cached is not None:
            _ASSET_CACHE.move_to_end(key)
        return cached

def _asset_cache_put(key, value):
    with _ASSET_CACHE_LOCK:
        _ASSET_CACHE[key] = value
        _ASSET_CACHE.move_to_end(key)
        while len(_ASSET_CACHE) > _ASSET_CACHE_MAX_ENTRIES:
            _ASSET_CACHE.popitem(last=False)

class _AssetData(NamedTuple):
    model_pose: components.ModelPose
    type: Any
    attrs: dict
    meshes: list
    primitives: list


def _load_asset_arrays(geometry_path, transparent_points_only):
    asset_stage = Usd.Stage.Open(geometry_path)
    if asset_stage is None or not asset_stage.GetDefaultPrim().IsValid():
        return None
    asset_root = asset_stage.GetDefaultPrim()
    asset_type = asset_root.GetAttribute("optics:type")
    return _AssetData(
        model_pose=_component_model_pose(asset_stage, asset_root),
        type=asset_type.Get() if asset_type and asset_type.HasAuthoredValue() else None,
        attrs=_optics_attrs(asset_root),
        meshes=components._component_mesh_arrays(
            asset_stage, asset_root, transparent_points_only=transparent_points_only
        ),
        primitives=_component_primitives(asset_stage, asset_root),
    )


def _read_asset_data(geometry_path, render_mode, transparent_points_only, request_cache):
    if not os.path.exists(geometry_path):
        return None
    geometry_stat = os.stat(geometry_path)
    key = (
        os.path.realpath(geometry_path),
        geometry_stat.st_mtime_ns,
        geometry_stat.st_size,
        render_mode,
        transparent_points_only,
    )
    if key not in request_cache:
        stored = _asset_cache_get(key) or _load_asset_arrays(geometry_path, transparent_points_only)
        if stored is None:
            return None
        _asset_cache_put(key, stored)
        request_cache[key] = stored._replace(meshes=components._fresh_mesh_lists(stored.meshes))
    return request_cache[key]


def _renders_inline_in_hi(prim, asset):
    return not asset and generic_parts.is_generic(prim)


def _project_components(stage, render_mode="lo", include_fixed=False, *,
                        transparent_points_only=False, only_names=None):
    if render_mode not in ("hi", "lo"):
        raise ValueError("render_mode must be 'hi' or 'lo'")
    comps = []
    cad_assets = ol.cad_library_assets(config.LIB_DIR)
    asset_data_cache = {}
    for prim in _component_prims(stage, include_fixed=include_fixed):
        if only_names is not None and prim.GetName() not in only_names:
            continue
        x, y, z, rot_x, rot_y, rot_z = _placement_xform_values(prim)
        t = prim.GetAttribute("optics:type").Get()
        asset = _component_asset_name(prim)
        placement_attrs = _optics_attrs(prim)

        asset_data = None
        # USD composition: the placement prim's xformOpOrder would mask rotations authored on the lo.usda root.
        if asset and (render_mode == "hi" or asset in cad_assets):
            geometry_path = uu.get_component_usda_path(
                config.LIB_DIR, uu.get_component_name(asset), render_mode
            )
            asset_data = _read_asset_data(
                geometry_path, render_mode, transparent_points_only, asset_data_cache
            )
        if render_mode == "hi" and asset_data is None and not _renders_inline_in_hi(prim, asset):
            continue

        if asset_data is not None:
            model_pose = asset_data.model_pose
            if asset_data.type is not None:
                t = asset_data.type
            attrs = dict(asset_data.attrs)
            meshes = asset_data.meshes
            primitives = asset_data.primitives
        else:
            model_pose = components.ModelPose(
                modelRotation=[0.0, 0.0, 0.0], rotationCenter=[0.0, 0.0, 0.0]
            )
            attrs = placement_attrs
            meshes = components._component_meshes(
                stage, prim, transparent_points_only=transparent_points_only
            )
            primitives = _component_primitives(stage, prim)
        component = dict(name=prim.GetName(), type=t,
                         x=round(x, 3), y=round(y, 3), z=round(z, 3),
                         rotX=round(rot_x, 3), rotY=round(rot_y, 3),
                         rotZ=round(rot_z, 3), attrs=_optics_attrs(prim),
                         asset=asset,
                         cadDerived=asset in cad_assets,
                         renderMode=render_mode)
        component["attrs"] = attrs
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
        return beam_tracer.fuse_legs_between_optics(traced, comps_by_name)
    if beam_tracer.has_laser(comps_by_name.values()):
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

class MovePayload(TypedDict):
    name: str
    partial: Literal[True]
    components: list[dict]
    beam: list[dict]
    renderMode: Literal["hi", "lo"]
    canUndo: NotRequired[bool]
    canRedo: NotRequired[bool]
    ok: NotRequired[bool]
    added: NotRequired[list[dict]]
    beamPath: NotRequired[list]


def _move_payload(name, stage, render_mode="lo") -> MovePayload:
    comps = _project_components(stage, "lo", transparent_points_only=True)
    beam_path = _beam_path(stage)
    comps_by_name = {c["name"]: c for c in comps}
    return MovePayload(
        name=name,
        partial=True,
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
