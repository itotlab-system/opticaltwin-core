"""The parts catalogue: tile previews, real photos, and how far a part must be
lifted to stand on the board. Serves the catalogue routes."""

import os
import json
import gzip

from flask import Blueprint, abort, current_app, request, send_from_directory
from pxr import Usd, UsdGeom

from opticaltwin import optics_lib as ol
from opticaltwin import usd_utility as uu

from backend import config
from backend import components
from backend.components import (
    _beam_physics_metadata,
    _component_model_pose,
    _component_primitives,
)
from backend.placement import _rotate_local_offset
from backend.scene import _authored_float, _optics_attrs

bp = Blueprint("library", __name__)

# (catalogue key, previews). Replaced as one tuple rather than mutated field by
# field: the server is threaded, and a half-updated cache would hand a request
# the new key with the old geometry.
_PREVIEW_CACHE = (None, {})

def _library_preview_key():
    """Identity of the catalogue on disk: every preview asset and its mtime.

    ~100 stat calls, well under a millisecond, versus the ~67 ms of USD reads
    the previews themselves cost. A newly imported CAD part changes the key, so
    the catalogue never goes stale behind the cache. A photo dropped beside an
    asset changes it too, so the browser's tile switches to the photograph
    without a server restart.
    """
    key = []
    for asset in sorted(ol.component_library_assets(config.LIB_DIR)):
        component_name = uu.get_component_name(asset)
        path = uu.get_component_usda_path(config.LIB_DIR, component_name)
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            mtime = None
        key.append((asset, mtime, _library_photo_mtime(component_name)))
    return tuple(key)

# A real photograph of the part, dropped into its catalogue folder by hand.
# Optional everywhere: without one the part browser renders its CAD geometry,
# which is what the bench will show anyway.
LIBRARY_PHOTO_NAMES = ("preview.png", "preview.jpg", "preview.jpeg", "preview.webp")

def _library_photo_path(component_name):
    """Path of the photo shipped beside a catalogue asset, or None."""
    directory = os.path.join(config.LIB_DIR, *component_name.split("/"))
    for filename in LIBRARY_PHOTO_NAMES:
        path = os.path.join(directory, filename)
        if os.path.isfile(path):
            return path
    return None

def _library_photo_mtime(component_name):
    path = _library_photo_path(component_name)
    try:
        return os.path.getmtime(path) if path else None
    except OSError:
        return None

def _library_previews():
    """CAD catalogue geometry used by the placement ghost before insertion.

    Cached: this is the same for every project and changes only when the
    catalogue does, but it was rebuilt on every request — including every
    component move.
    """
    global _PREVIEW_CACHE

    key = _library_preview_key()
    cached_key, previews = _PREVIEW_CACHE
    if cached_key == key:
        return previews

    previews = _build_library_previews()
    _PREVIEW_CACHE = (key, previews)
    return previews

def _build_library_previews():
    previews = {}
    for asset in sorted(ol.component_library_assets(config.LIB_DIR)):
        component = _build_library_preview(asset)
        if component is not None:
            previews[asset] = component
    return previews

def _asset_base_offset_mm(stage, root):
    """How far a freshly placed part must be lifted to rest ON the board.

    Posts and holders are modelled with their origin at the mounting foot, so
    they already sit on the breadboard at the placement z.  A lens, an iris or
    a camera is modelled about its optical centre, and dropping one at the
    board top buries half of it inside the board.  The lift is measured from
    the geometry the client actually draws -- the model pose about
    ``rotationCenter``, plus ``geometryOffset`` -- so the placement ghost and
    the part that lands can use the same number.

    This moves no origin: it is a one-off translate chosen when the part is
    inserted, so zoom framing, grouping and the gizmo centre keep reading the
    authored origin they always have.  It only ever lifts -- an asset whose
    geometry sits above its origin keeps the convention it was authored with.
    """
    # Untransformed, because the meshes shipped to the client are in
    # component-local space (`_component_meshes` divides out the asset's own
    # root op) and the client re-applies that op as `modelRotation` about
    # `rotationCenter`.  A composed bound would be the pose measured about the
    # wrong pivot.
    bounds = UsdGeom.BBoxCache(
        Usd.TimeCode.Default(), [UsdGeom.Tokens.default_]
    ).ComputeUntransformedBound(root).ComputeAlignedRange()
    if bounds.IsEmpty():
        return 0.0
    pose = _component_model_pose(stage, root)
    rot_x, rot_y, rot_z = pose["modelRotation"]
    cx, cy, cz = pose["rotationCenter"]
    offset_z = _authored_float(root, "optics:geometryOffsetZ_mm") or 0.0
    mn, mx = bounds.GetMin(), bounds.GetMax()
    lowest = cz + offset_z + min(
        _rotate_local_offset(x - cx, y - cy, z - cz, rot_x, rot_y, rot_z)[2]
        for x in (mn[0], mx[0])
        for y in (mn[1], mx[1])
        for z in (mn[2], mx[2])
    )
    return round(max(0.0, -lowest), 6)

def _library_base_offset_mm(asset):
    """The rest-on-the-board lift for one catalogue asset (0 when unknown)."""
    preview = _library_previews().get(asset) or {}
    return float(preview.get("baseOffsetZ") or 0.0)

def _build_library_preview(asset, render_mode="lo"):
    """One catalogue part, posed at the origin, as the client draws components.

    `render_mode` is "lo" for the payload-wide catalogue (the placement ghost
    only needs a silhouette) and "hi" for a single part fetched on demand by the
    part browser: a lo asset is a bounding-box stand-in, so every post holder
    would otherwise be the same anonymous block on its tile.
    """
    cad_assets = ol.cad_library_assets(config.LIB_DIR)
    component_name = uu.get_component_name(asset)
    path = uu.get_component_usda_path(config.LIB_DIR, component_name, render_mode)
    if not os.path.exists(path):
        path = uu.get_component_usda_path(config.LIB_DIR, component_name)
    stage = Usd.Stage.Open(path)
    if stage is None or not stage.GetDefaultPrim().IsValid():
        return None
    root = stage.GetDefaultPrim()
    cad_derived = asset in cad_assets
    component = {
        "name": component_name,
        "type": root.GetAttribute("optics:type").Get(),
        "x": 0,
        "y": 0,
        "z": 0,
        # All three rotations, not just rotZ: the client multiplies each by
        # DEG, and a missing one is NaN, which poisons the whole transform.
        "rotX": 0,
        "rotY": 0,
        "rotZ": 0,
        "attrs": _optics_attrs(root),
        "asset": asset,
        "cadDerived": cad_derived,
        "renderMode": render_mode,
    }
    photo_mtime = _library_photo_mtime(component_name)
    if photo_mtime is not None:
        # Cache-busted by mtime: replacing the file replaces the tile.
        component["photo"] = (
            f"/api/library/photo/{component_name}?v={int(photo_mtime)}"
        )
    # The hand-built Low_model parts are drawn procedurally by the client
    # from their `optics:` dims, so shipping their gprims would be dead
    # weight in a payload that already carries every CAD mesh.
    meshes = components._component_meshes(stage, root) if cad_derived else []
    primitives = _component_primitives(stage, root) if cad_derived else []
    if meshes:
        component["meshes"] = meshes
    if primitives:
        component["primitives"] = primitives
    component.update(_component_model_pose(stage, root))
    component["baseOffsetZ"] = _asset_base_offset_mm(stage, root)
    component["physics"] = _beam_physics_metadata(component)
    return component

@bp.get("/api/library/preview/<path:asset>")
def library_preview(asset):
    """One catalogue part's geometry, for a part-browser thumbnail.

    Deliberately one asset per request rather than a hi-res catalogue in the
    project payload: the browser draws each tile once and keeps the picture, so
    the several hundred kB of a hi asset is paid once and thrown away, instead
    of being carried by every project load.

    Served gzipped and cached. A hi asset is ~940 kB of vertex floats as JSON
    and the catalogue is 86 of them, so filling the part browser moved ~81 MB
    over the wire — which was the whole reason it took minutes, not the drawing.
    Float text compresses ~6x, and the bytes are identical for every user and
    every project, so they are built once and held.
    """
    if asset not in ol.component_library_assets(config.LIB_DIR):
        abort(404)
    render_mode = "hi" if request.args.get("renderMode") == "hi" else "lo"
    body = _library_preview_body(asset, render_mode)
    if body is None:
        abort(404)
    payload, compressed = body

    # Every browser sends gzip, but a curl or a test client may not, and a body
    # it cannot read is worse than a slow one.
    if compressed and "gzip" not in request.headers.get("Accept-Encoding", ""):
        payload, compressed = gzip.decompress(payload), False

    response = current_app.response_class(payload, mimetype="application/json")
    if compressed:
        response.headers["Content-Encoding"] = "gzip"
    # The catalogue's own key already changes when a part's CAD or photo does,
    # so a stale tile cannot outlive an import.
    response.headers["Vary"] = "Accept-Encoding"
    return response

# (asset, render_mode) -> (gzipped json, True). Bounded by the catalogue size;
# ~13 MB compressed for all 86 hi assets, against the ~81 MB it saves sending.
_PREVIEW_BODY_CACHE = {}

_PREVIEW_BODY_KEY = None

def _library_preview_body(asset, render_mode):
    """The response bytes for one preview, gzipped, built at most once."""
    global _PREVIEW_BODY_CACHE, _PREVIEW_BODY_KEY

    key = _library_preview_key()
    if _PREVIEW_BODY_KEY != key:
        # A part was re-imported: every cached body is now potentially stale.
        _PREVIEW_BODY_CACHE = {}
        _PREVIEW_BODY_KEY = key

    entry = _PREVIEW_BODY_CACHE.get((asset, render_mode))
    if entry is None:
        component = _build_library_preview(asset, render_mode)
        if component is None:
            return None
        raw = json.dumps({"component": component}).encode("utf-8")
        # Level 6 is ~44 ms for the largest asset and within a few percent of
        # the ratio at 9; the difference is not worth the CPU on a lab server.
        entry = (gzip.compress(raw, 6), True)
        _PREVIEW_BODY_CACHE[(asset, render_mode)] = entry
    return entry

@bp.get("/api/library/photo/<path:component>")
def library_photo(component):
    """The optional real photograph of a catalogue part, for the part browser."""
    path = _library_photo_path(uu.get_component_name(component))
    if not path:
        abort(404)
    # `component` comes off the URL, so confirm the file really is inside the
    # catalogue before serving it rather than trusting the joined path.
    library_root = os.path.realpath(config.LIB_DIR)
    real_path = os.path.realpath(path)
    if os.path.commonpath((library_root, real_path)) != library_root:
        abort(404)
    return send_from_directory(
        os.path.dirname(real_path),
        os.path.basename(real_path),
        max_age=86400,
    )
