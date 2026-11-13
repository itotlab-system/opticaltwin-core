"""Editing a bench: moving, adding, duplicating and deleting components, and
changing the board."""

import os
import re
import math

from flask import Blueprint, abort, jsonify, request
from pxr import Usd, Sdf

from opticaltwin import optics_lib as ol
from opticaltwin import usd_utility as uu
from opticaltwin import generic_parts

from backend import config
from backend import scene
from backend.beam_edit import _snap_onto_beam
from backend.board import _set_board_extents
from backend.groups import _groups, _groups_with_copies, _write_groups
from backend.history import records_history
from backend.library import _library_base_offset_mm
from backend.beam import _beam_path
from backend.payload import _move_payload, _project_components, _project_payload
from backend.placement import (
    HOLDER_POST_HOLE_X_MM,
    _board_top,
    _catalog_asset_type,
    _clamp_z,
    _linked_holder,
    _matching_post_component,
    _placement_xform_values,
    _rebase_asset_paths,
    _relink_paired_copies,
    _replace_component_reference,
    _rotate_local_offset,
    _set_custom_attr,
    _set_xform,
    _string_attr,
    _sync_linked_post,
    _unique_component_name,
)
from backend.scene import SAFE, _component_prims

bp = Blueprint("editing", __name__)

@bp.get("/api/projects/<name>")
def get_project(name):
    stage = Usd.Stage.Open(scene.project_setup(name)) #name="project名"で、このprojectからsetup.usdaをusda形式でstageに読み込む
    render_mode = request.args.get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")
    return jsonify(_project_payload(name, stage, render_mode))

@bp.post("/api/projects/<name>/board/model")
@records_history
def update_board_model(name):
    """Change the fixed board CAD reference without authoring a transform."""
    body = request.get_json(force=True)
    asset = body.get("asset")
    render_mode = body.get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")
    board_assets = {
        candidate for candidate in ol.cad_library_assets(config.LIB_DIR)
        if candidate.startswith("Breadboard/")
    }
    if not isinstance(asset, str) or asset not in board_assets:
        abort(400, "unknown breadboard asset")

    setup = scene.project_setup(name)
    stage = Usd.Stage.Open(setup)
    board = stage.GetPrimAtPath(
        f"{stage.GetDefaultPrim().GetPath()}/Breadboard"
    )
    fixed = board.GetAttribute("optics:fixedBoard") if board else None
    if not board or not board.IsValid() or not fixed or not fixed.Get():
        abort(404, "project has no fixed breadboard")

    _replace_component_reference(board, asset, os.path.dirname(setup))
    stage.GetRootLayer().Save()
    payload = _project_payload(name, stage, render_mode)
    payload["ok"] = True
    return jsonify(payload)

@bp.post("/api/projects/<name>/board")
@records_history
def update_board(name):
    """Resize each side of the breadboard and persist it in USD."""
    body = request.get_json(force=True)
    try:
        if all(key in body for key in (
            "extentXNegative",
            "extentXPositive",
            "extentYNegative",
            "extentYPositive",
        )):
            extent_x_negative = float(body["extentXNegative"])
            extent_x_positive = float(body["extentXPositive"])
            extent_y_negative = float(body["extentYNegative"])
            extent_y_positive = float(body["extentYPositive"])
        else:
            # Backward compatibility for clients that only send total sizes.
            size_x = float(body["sizeX"])
            size_y = float(body["sizeY"])
            extent_x_negative = extent_x_positive = size_x / 2.0
            extent_y_negative = extent_y_positive = size_y / 2.0
    except (KeyError, TypeError, ValueError):
        abort(400, "breadboard extents must be numbers")
    if not all(math.isfinite(value) for value in (
        extent_x_negative,
        extent_x_positive,
        extent_y_negative,
        extent_y_positive,
    )):
        abort(400, "breadboard extents must be finite")

    render_mode = body.get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")
    setup = scene.project_setup(name)
    stage = Usd.Stage.Open(setup)
    _set_board_extents(
        stage,
        extent_x_negative,
        extent_x_positive,
        extent_y_negative,
        extent_y_positive,
    )
    stage.GetRootLayer().Save()

    payload = _project_payload(name, stage, render_mode)
    payload["ok"] = True
    return jsonify(payload)

@bp.post("/api/projects/<name>/components/<comp>")
@records_history
def update_component(name, comp):
    if not SAFE.match(comp):
        abort(400)
    body = request.get_json(force=True)
    setup = scene.project_setup(name)
    stage = Usd.Stage.Open(setup)
    prim = stage.GetPrimAtPath(f"{stage.GetDefaultPrim().GetPath()}/{comp}")
    if not prim or not prim.IsValid():
        abort(404, "no such component")
    x, y, z, rot_x, rot_y, rot_z = _placement_xform_values(prim)
    holder = _linked_holder(stage, prim)
    if holder:
        # A paired post has one degree of freedom: world Z relative to its
        # holder. X/Y and orientation are always derived from the holder.
        requested_z = _clamp_z(stage, body.get("z", z))
        hx, hy, hz, hrx, hry, hrz = _placement_xform_values(holder)
        dx, dy, dz = _rotate_local_offset(
            HOLDER_POST_HOLE_X_MM, 0.0, 0.0, hrx, hry, hrz
        )
        _set_custom_attr(
            prim, "holderZOffset_mm", float(requested_z - hz - dz),
            Sdf.ValueTypeNames.Double
        )
        _sync_linked_post(stage, holder)
    else:
        _set_xform(prim,
                   float(body.get("x", x)), float(body.get("y", y)),
                   _clamp_z(stage, body.get("z", z)),
                   float(body.get("rotX", rot_x)),
                   float(body.get("rotY", rot_y)),
                   float(body.get("rotZ", rot_z)))
        _sync_linked_post(stage, prim)
    stage.GetRootLayer().Save()

    render_mode = body.get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")
    payload = _move_payload(name, stage, render_mode)
    payload["ok"] = True
    return jsonify(payload)

@bp.post("/api/projects/<name>/components/<comp>/model")
@records_history
def update_component_model(name, comp):
    """Change a holder/post catalogue model without changing its placement."""
    if not SAFE.match(comp):
        abort(400)
    body = request.get_json(force=True)
    asset = body.get("asset")
    render_mode = body.get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")
    if not isinstance(asset, str) or asset not in ol.component_library_assets():
        abort(400, "unknown asset")

    setup = scene.project_setup(name)
    stage = Usd.Stage.Open(setup)
    prim = stage.GetPrimAtPath(f"{stage.GetDefaultPrim().GetPath()}/{comp}")
    if not prim or not prim.IsValid():
        abort(404, "no such component")

    current_type = prim.GetAttribute("optics:type").Get()
    if current_type not in ("holder", "post"):
        abort(400, "model selection is only available for holders and posts")
    if _catalog_asset_type(asset) != current_type:
        abort(400, "asset type does not match component type")

    _replace_component_reference(prim, asset, os.path.dirname(setup))
    # Re-derive the linked post pose after either member changes. The authored
    # placement and pairing attributes remain on the project prim.
    holder = prim if current_type == "holder" else _linked_holder(stage, prim)
    if holder:
        _sync_linked_post(stage, holder)
    stage.GetRootLayer().Save()

    payload = _project_payload(name, stage, render_mode)
    payload["ok"] = True
    return jsonify(payload)

@bp.post("/api/projects/<name>/components/batch")
@records_history
def update_components(name):
    """Move several components in one save + one beam retrace.

    A group drag moves every member at once; sending them one at a time would
    re-save the layer and retrace the beam for each part.  Every name is
    resolved before anything is written, so a bad request leaves the layer
    untouched instead of half-applied.
    """
    body = request.get_json(force=True)
    updates = body.get("updates")
    if not isinstance(updates, list) or not updates:
        abort(400, "updates must be a non-empty list")

    render_mode = body.get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")

    setup = scene.project_setup(name)
    stage = Usd.Stage.Open(setup)
    root = stage.GetDefaultPrim().GetPath()

    resolved, seen = [], set()
    for update in updates:
        if not isinstance(update, dict):
            abort(400, "invalid update")
        comp = update.get("name")
        if not isinstance(comp, str) or not SAFE.match(comp):
            abort(400, "bad component name")
        if comp in seen:
            abort(400, f"duplicate component: {comp}")
        prim = stage.GetPrimAtPath(f"{root}/{comp}")
        if not prim or not prim.IsValid():
            abort(404, f"no such component: {comp}")
        seen.add(comp)
        resolved.append((prim, update))

    for prim, update in resolved:
        x, y, z, rot_x, rot_y, rot_z = _placement_xform_values(prim)
        holder = _linked_holder(stage, prim)
        if holder:
            requested_z = _clamp_z(stage, update.get("z", z))
            _, _, hz, hrx, hry, hrz = _placement_xform_values(holder)
            _, _, dz = _rotate_local_offset(
                HOLDER_POST_HOLE_X_MM, 0.0, 0.0, hrx, hry, hrz
            )
            _set_custom_attr(
                prim, "holderZOffset_mm", float(requested_z - hz - dz),
                Sdf.ValueTypeNames.Double
            )
        else:
            _set_xform(prim,
                       float(update.get("x", x)), float(update.get("y", y)),
                       _clamp_z(stage, update.get("z", z)),
                       float(update.get("rotX", rot_x)),
                       float(update.get("rotY", rot_y)),
                       float(update.get("rotZ", rot_z)))
    # Synchronize after all requested holder poses and post Z offsets have
    # landed, making batch result independent of request order.
    for prim in _component_prims(stage):
        if _string_attr(prim, "pairedPost"):
            _sync_linked_post(stage, prim)
    stage.GetRootLayer().Save()

    payload = _move_payload(name, stage, render_mode)
    payload["ok"] = True
    return jsonify(payload)

@bp.post("/api/projects/<name>/add")
@records_history
def add_component(name):
    """Place a catalogue part, and answer with what the open bench must merge.

    The light move payload (transforms + beam + undo state) plus the new part
    itself. A holder brings its post along, so every part that was not there
    before is sent. The client used to re-fetch the whole bench after each
    placement: ~9 s and 45 MB in hi mode on a 47-part bench.
    """
    body = request.get_json(force=True)
    render_mode = body.get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")
    setup = scene.project_setup(name)
    stage = Usd.Stage.Open(setup)
    before = {prim.GetName() for prim in _component_prims(stage)}
    comp_name = _add_asset(stage, body.get("asset", ""), float(body.get("x", 0)),
                           float(body.get("y", 0)), body.get("name"))
    snapped = None
    if body.get("snap", True):
        snapped = _snap_onto_beam(stage, comp_name,
                                  float(body.get("x", 0)), float(body.get("y", 0)))
    stage.GetRootLayer().Save()

    added = {prim.GetName() for prim in _component_prims(stage)} - before
    payload = _move_payload(name, stage, render_mode)
    payload.update(
        ok=True, name=comp_name, snapped=snapped,
        added=_project_components(stage, render_mode, only_names=added),
        beamPath=_beam_path(stage),
    )
    return jsonify(payload)

def _add_asset(stage, asset, x, y, wanted_name=None):
    """Place a catalogue part on the board at (x, y); return its prim name.

    The authored layer is changed but not saved -- the caller saves once,
    after anything else it does in the same edit (snapping, a whole photo
    build).
    """
    component_path = uu.get_component_name(asset or "")
    library_assets = ol.component_library_assets()
    library_asset = (
        asset if asset in library_assets else f"{component_path}.usda"
    )
    if library_asset not in library_assets:
        abort(400, "unknown asset")
    default_name = os.path.basename(component_path)
    comp_name = wanted_name or default_name
    comp_name = re.sub(r"[^A-Za-z0-9_]", "_", comp_name)
    proj_dir = os.path.dirname(stage.GetRootLayer().realPath)
    root = str(stage.GetDefaultPrim().GetPath())
    comp_name = _unique_component_name(stage, root, comp_name)
    rel = uu.get_relative_component_usda_path(
        config.LIB_DIR,
        component_path,
        proj_dir,
    )
    # Sit the new part ON the board, not halfway through it: an optic is
    # modelled about its optical centre, so the bare placement z buried the
    # lower half of it in the breadboard.  Only the inserted translate moves --
    # the part keeps the authored origin that zoom framing and grouping read.
    drop_z = _clamp_z(
        stage, _board_top(stage) + _library_base_offset_mm(library_asset)
    )
    ol.place(stage, root, comp_name, rel, x, y, drop_z)
    post_component = _matching_post_component(component_path)
    if post_component:
        post_name = f"{comp_name}_Post"
        base, i = post_name, 1
        while stage.GetPrimAtPath(f"{root}/{post_name}").IsValid():
            i += 1
            post_name = f"{base}_{i}"
        post_rel = uu.get_relative_component_usda_path(
            config.LIB_DIR, post_component, proj_dir
        )
        post = ol.place(
            stage, root, post_name, post_rel, x, y,
            _clamp_z(
                stage,
                _board_top(stage)
                + _library_base_offset_mm(f"{post_component}.usda"),
            ),
        )
        holder = stage.GetPrimAtPath(f"{root}/{comp_name}")
        _set_custom_attr(holder, "pairedPost", post_name)
        _set_custom_attr(post, "pairedHolder", comp_name)
        _set_custom_attr(
            post, "holderZOffset_mm", 0.0, Sdf.ValueTypeNames.Double
        )
        _sync_linked_post(stage, holder)
    return comp_name

def _add_generic(stage, role, size, label="", model="", x=0.0, y=0.0,
                 request_part=False):
    """Place a placeholder part on the board at (x, y); return its prim name."""
    if role not in generic_parts.ROLES:
        abort(400, "unknown role")
    size = generic_parts.clean_size(size, role)
    root = str(stage.GetDefaultPrim().GetPath())
    stem = re.sub(r"[^A-Za-z0-9_]", "_", generic_parts.clean_text(label))
    stem = re.sub(r"_+", "_", stem).strip("_") or role.capitalize()
    # A Japanese label survives in optics:label but not in a prim name.
    if not re.search(r"[A-Za-z0-9]", stem):
        stem = role.capitalize()
    elif not re.match(r"[A-Za-z_]", stem):
        stem = f"{role.capitalize()}_{stem}"
    comp_name = _unique_component_name(stage, root, stem)
    prim = generic_parts.author(stage, f"{root}/{comp_name}", role, size,
                                label=label, model=model, request_part=request_part)
    # Its body is centred on its origin, so half its height lifts it onto
    # the board -- the same "lands ON the board" rule as a catalogue part.
    _set_xform(prim, x, y, _clamp_z(stage, _board_top(stage) + size[2] / 2),
               0.0, 0.0, 0.0)
    return comp_name

@bp.post("/api/projects/<name>/generic")
@records_history
def add_generic_part(name):
    """Add a placeholder for a part the catalogue does not have.

    Body: {role, size?: [x, y, z] mm, label?, model?, requestPart?, x, y,
    snap?}. Dropped near the beam it snaps into it like any in-beam part.
    """
    body = request.get_json(force=True)
    stage = Usd.Stage.Open(scene.project_setup(name))
    x, y = float(body.get("x", 0)), float(body.get("y", 0))
    comp_name = _add_generic(stage, body.get("role"), body.get("size") or [],
                             body.get("label", ""), body.get("model", ""), x, y,
                             bool(body.get("requestPart")))
    snapped = _snap_onto_beam(stage, comp_name, x, y) if body.get("snap", True) else None
    stage.GetRootLayer().Save()
    return jsonify(ok=True, name=comp_name, snapped=snapped)

@bp.post("/api/projects/<name>/components/duplicate")
@records_history
def duplicate_components(name):
    """Copy components into a project — the paste half of copy & paste.

    Body: {names: [...], sourceProject?, offsetX?, offsetY?, renderMode?}

    The prim *spec* is copied rather than the library asset re-placed, so the
    reference and every authored override (z, rotations, per-instance optics:
    attributes) come along; a fresh /add would drop all of them. Offsets
    default to one breadboard hole diagonally so the copy lands on-grid and
    visibly beside the original.

    `sourceProject` copies out of another project instead of this one, which is
    how a selection copied in project1 pastes into project2. Only this
    project is written to (and so only its history records a step); the source
    is opened read-only.
    """
    body = request.get_json(force=True)
    names = body.get("names")
    if not isinstance(names, list) or not names:
        abort(400, "names must be a non-empty list")
    render_mode = body.get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")
    offset_x = float(body.get("offsetX", ol.GRID_MM))
    offset_y = float(body.get("offsetY", ol.GRID_MM))
    source_project = body.get("sourceProject") or name
    if not isinstance(source_project, str):
        abort(400, "sourceProject must be a string")

    setup = scene.project_setup(name)
    stage = Usd.Stage.Open(setup)
    layer = stage.GetRootLayer()
    root = str(stage.GetDefaultPrim().GetPath())

    if source_project == name:
        src_stage, src_layer, src_root = stage, layer, root
    else:
        src_stage = Usd.Stage.Open(scene.project_setup(source_project))
        src_layer = src_stage.GetRootLayer()
        src_root = str(src_stage.GetDefaultPrim().GetPath())

    # Validate every source up front so a bad name writes nothing (as /batch does).
    sources = []
    for comp in names:
        if not isinstance(comp, str) or not SAFE.match(comp):
            abort(400, "bad component name")
        path = f"{src_root}/{comp}"
        if not src_stage.GetPrimAtPath(path).IsValid():
            abort(404, f"no such component: {source_project}/{comp}")
        if src_layer.GetPrimAtPath(path) is None:
            abort(400, f"{comp} is not authored in {source_project}'s layer")
        if comp not in sources:
            sources.append(comp)

    name_map = {}
    for comp in sources:
        # A trailing _<n> is a previous copy's suffix — count on from it
        # instead of stacking suffixes (Lens_2 -> Lens_3, not Lens_2_2).
        stem = re.sub(r"_\d+$", "", comp) or comp
        copy_name = _unique_component_name(stage, root, stem,
                                           taken=set(name_map.values()))
        Sdf.CopySpec(src_layer, Sdf.Path(f"{src_root}/{comp}"),
                     layer, Sdf.Path(f"{root}/{copy_name}"))
        if src_layer is not layer:
            _rebase_asset_paths(layer, Sdf.Path(f"{root}/{copy_name}"), src_layer)
        name_map[comp] = copy_name

    for comp, copy_name in name_map.items():
        source = src_stage.GetPrimAtPath(f"{src_root}/{comp}")
        x, y, z, rot_x, rot_y, rot_z = _placement_xform_values(source)
        _set_xform(stage.GetPrimAtPath(f"{root}/{copy_name}"),
                   x + offset_x, y + offset_y, _clamp_z(stage, z),
                   rot_x, rot_y, rot_z)

    _relink_paired_copies(stage, root, name_map)

    groups = _groups(stage)
    merged = _groups_with_copies(groups, name_map,
                                 None if src_stage is stage else _groups(src_stage))
    if merged != groups:
        _write_groups(stage, merged)

    layer.Save()

    payload = _project_payload(name, stage, render_mode)
    payload["ok"] = True
    payload["names"] = [name_map[comp] for comp in sources]
    return jsonify(payload)

@bp.post("/api/projects/<name>/delete/<comp>")
@records_history
def delete_component(name, comp):
    if not SAFE.match(comp):
        abort(400)
    setup = scene.project_setup(name)
    stage = Usd.Stage.Open(setup)
    path = f"{stage.GetDefaultPrim().GetPath()}/{comp}"
    if not stage.GetPrimAtPath(path).IsValid():
        abort(404)
    prim = stage.GetPrimAtPath(path)
    paired_post = _string_attr(prim, "pairedPost")
    paired_holder = _string_attr(prim, "pairedHolder")
    stage.RemovePrim(path)
    if paired_post:
        paired_path = f"{stage.GetDefaultPrim().GetPath()}/{paired_post}"
        if stage.GetPrimAtPath(paired_path).IsValid():
            stage.RemovePrim(paired_path)
    elif paired_holder:
        holder = stage.GetPrimAtPath(
            f"{stage.GetDefaultPrim().GetPath()}/{paired_holder}"
        )
        if holder and holder.IsValid():
            attr = holder.GetAttribute("optics:pairedPost")
            if attr:
                attr.Clear()
    # The removed part may still be listed in a group; _groups() prunes it and
    # drops any group left empty, so re-author the normalized list.
    groups_before = stage.GetDefaultPrim().GetAttribute("optics:groups")
    if groups_before and groups_before.HasAuthoredValue():
        _write_groups(stage, _groups(stage))
    stage.GetRootLayer().Save()
    
    return jsonify(ok=True)
