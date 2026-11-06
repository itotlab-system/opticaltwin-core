"""Editing the beam: folding at a mirror, snapping parts onto it, switching
lasers, shaping legs and pinning beam nodes."""

import json
import math

from flask import Blueprint, abort, jsonify, request
from pxr import Usd, Sdf

from opticaltwin import beam_tracer
from opticaltwin import beam_first

from backend import scene
from backend.beam import BEAM_MAX_DRAW_MM, BEAM_WIDTH_RANGE_MM, _beam_path, _beam_shape
from backend.history import records_history
from backend.payload import (
    _move_payload,
    _project_components,
    _resolved_project_beam,
)
from backend.placement import _clamp_z, _set_custom_attr, _set_xform
from backend.scene import SAFE, _component_prims

bp = Blueprint("beam_edit", __name__)

def _traced_components(stage):
    """The tracer's view of the bench: placement + attrs + physics, by name.

    beam_only, as the move payload traces: collision primitives and the
    points of transparent meshes, without opaque vertices or materials. Every
    drag already retraces the beam from this view, so snapping, folding and the
    photo build now see exactly the beam the user sees, and skip reading every
    mesh (0.5 s of a 0.56 s placement on a 47-part bench).
    """
    return {c["name"]: c for c in _project_components(stage, "lo", beam_only=True)}

def _snap_onto_beam(stage, comp_name, x, y):
    """Centre a just-dropped optic on the beam leg it was dropped on.

    Beam-first building: the user drops a lens near the beam and it lands IN
    it -- at beam height, facing along it -- instead of on the board where the
    click was. A mirror or beamsplitter also turns to fold the beam left, so
    the drop visibly does something; the fold arrows change the side. Returns
    the leg's key, or None when the part is not an in-beam type or the drop
    was not near any beam.
    """
    comps = _traced_components(stage)
    comp = comps.get(comp_name)
    if comp is None or comp["type"] not in beam_first.SNAP_TYPES:
        return None
    others = {n: c for n, c in comps.items() if n != comp_name}
    beam = _resolved_project_beam(stage, others, _beam_path(stage))
    hit = beam_first.nearest_leg(beam, x, y)
    if hit is None:
        return None
    leg, point, direction = hit
    if comp["type"] in beam_first.FOLD_TYPES:
        rot_z = beam_first.fold_rot_z(comp["type"], direction, "left")
    else:
        rot_z = round(beam_first.heading_deg(direction), 6)
    ox, oy, oz = beam_first.origin_for(comp, point, 0.0, 0.0, rot_z)
    _set_xform(stage.GetPrimAtPath(f"{stage.GetDefaultPrim().GetPath()}/{comp_name}"),
               ox, oy, _clamp_z(stage, oz), 0.0, 0.0, rot_z)
    return leg.get("key")

def _fold(stage, comp, turn):
    """Turn `comp` so the beam leaves it to `turn`; (status, message) on failure.

    The surface the beam hits now, dropped onto the incoming line, is the
    pivot: the part turns about it and stays in the beam.
    """
    comps = _traced_components(stage)
    target = comps.get(comp)
    if target is None:
        return 404, "no such component"
    if target["type"] not in beam_first.FOLD_TYPES:
        return 400, "only a mirror or beamsplitter folds the beam"
    beam = _resolved_project_beam(stage, comps, _beam_path(stage))
    leg = beam_first.incoming_leg(beam, comp)
    if leg is None:
        return 409, "the beam does not reach this part"
    direction = beam_first.leg_direction(leg)
    try:
        rot_z = beam_first.fold_rot_z(target["type"], direction, turn)
    except ValueError as exc:
        return 409, str(exc)
    offset = beam_first.optical_centre_offset(
        target, target["rotX"], target["rotY"], target["rotZ"])
    centre = [target[k] + offset[i] for i, k in enumerate(("x", "y", "z"))]
    on_beam = beam_first.project_onto_line(centre, leg["pts"][0], direction)
    ox, oy, oz = beam_first.origin_for(target, on_beam, 0.0, 0.0, rot_z)
    prim = stage.GetPrimAtPath(f"{stage.GetDefaultPrim().GetPath()}/{comp}")
    _set_xform(prim, ox, oy, _clamp_z(stage, oz), 0.0, 0.0, rot_z)
    return None

@bp.post("/api/projects/<name>/components/<comp>/fold")
@records_history
def fold_beam(name, comp):
    """Turn a mirror or beamsplitter so the beam leaves it to the left or right.

    Body: {turn: "left" | "right", renderMode?}. "Left" is counter-clockwise
    seen from above, relative to the way the beam is travelling when it
    arrives. The part's active surface stays on the incoming beam; only its
    rotation changes, so nothing else on the bench moves (parts downstream
    that are now off the beam stay where they are, by design).
    """
    if not SAFE.match(comp):
        abort(400)
    body = request.get_json(force=True)
    turn = body.get("turn")
    if turn not in beam_first.TURNS:
        abort(400, "turn must be left or right")
    render_mode = body.get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")

    stage = Usd.Stage.Open(scene.project_setup(name))
    error = _fold(stage, comp, turn)
    if error:
        abort(*error)
    stage.GetRootLayer().Save()

    payload = _move_payload(name, stage, render_mode)
    payload["ok"] = True
    return jsonify(payload)

@bp.post("/api/projects/<name>/lasers")
@records_history
def switch_lasers(name):
    """Switch lasers on or off.

    A laser that is off emits nothing, so the bench goes dark: no beam in 3D,
    none in the diagram, and nothing to shape. Body: {on: bool} for every laser
    in the project, or {on: bool, names: [...]} for particular ones.
    """
    body = request.get_json(force=True)
    if not isinstance(body.get("on"), bool):
        abort(400, "on must be true or false")
    on = body["on"]

    render_mode = body.get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")

    names = body.get("names")
    if names is not None and (
        not isinstance(names, list)
        or not all(isinstance(n, str) and SAFE.match(n) for n in names)
    ):
        abort(400, "names must be a list of component names")

    stage = Usd.Stage.Open(scene.project_setup(name))
    switched = []
    for prim in _component_prims(stage):
        if prim.GetAttribute("optics:type").Get() not in beam_tracer.EMITTER_TYPES:
            continue
        if names is not None and prim.GetName() not in names:
            continue
        _set_custom_attr(prim, "laserOn", on, Sdf.ValueTypeNames.Bool)
        switched.append(prim.GetName())

    if names is not None and not switched:
        abort(404, "no such laser")

    stage.GetRootLayer().Save()

    # Only an attribute and the beam change: the light move payload, which
    # carries laserOn, not the full scene (~9 s in hi mode on a large bench).
    payload = _move_payload(name, stage, render_mode)
    payload["ok"] = True
    payload["switched"] = switched
    return jsonify(payload)

@bp.post("/api/projects/<name>/beam/shape")
@records_history
def set_beam_shape(name):
    """Set or clear the drawn width of one beam leg.

    Body: {key, wIn, wOut} to shape a leg, or {key, clear: true} to hand it
    back to the default. Widths are the full drawn width in mm at each end of
    the leg: equal makes a parallel block, unequal a wedge. This is the
    planning sketch only — it changes no component and no other leg.
    """
    body = request.get_json(force=True)
    key = body.get("key")
    if not isinstance(key, str) or not key.strip():
        abort(400, "key must be a non-empty string")

    render_mode = body.get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")

    setup = scene.project_setup(name)
    stage = Usd.Stage.Open(setup)
    shape = _beam_shape(stage)

    if body.get("clear"):
        shape.pop(key, None)
    else:
        low, high = BEAM_WIDTH_RANGE_MM
        widths = {}
        for field in ("wIn", "wOut"):
            try:
                value = float(body[field])
            except (KeyError, TypeError, ValueError):
                abort(400, f"{field} must be a number")
            if not math.isfinite(value) or not low <= value <= high:
                abort(400, f"{field} must be between {low} and {high} mm")
            widths[field] = round(value, 4)

        # How far the beam is drawn along this leg. Purely how it is sketched:
        # it moves nothing, so setting it never shoves the optic at the far end
        # (a camera, say) down the bench.
        if body.get("lengthMm") is not None:
            try:
                draw_length = float(body["lengthMm"])
            except (TypeError, ValueError):
                abort(400, "lengthMm must be a number")
            if not math.isfinite(draw_length) or not 0 < draw_length <= BEAM_MAX_DRAW_MM:
                abort(400, f"lengthMm must be between 0 and {BEAM_MAX_DRAW_MM} mm")
            widths["lengthMm"] = round(draw_length, 3)

        # Optional pinch point, for a leg drawn as a focus rather than a wedge.
        if body.get("waistW") is not None:
            try:
                waist_w = float(body["waistW"])
                waist_at = float(body.get("waistAt", 0.5))
            except (TypeError, ValueError):
                abort(400, "waistW and waistAt must be numbers")
            if not math.isfinite(waist_w) or not low <= waist_w <= high:
                abort(400, f"waistW must be between {low} and {high} mm")
            if not math.isfinite(waist_at) or not 0.0 < waist_at < 1.0:
                abort(400, "waistAt must be between 0 and 1 (exclusive)")
            widths["waistW"] = round(waist_w, 4)
            widths["waistAt"] = round(waist_at, 4)

        shape[key] = widths

    prim = stage.GetDefaultPrim()
    attr = prim.GetAttribute("optics:beamShape")
    if not attr:
        attr = prim.CreateAttribute("optics:beamShape", Sdf.ValueTypeNames.String)
    attr.Set(json.dumps(shape, sort_keys=True))
    stage.GetRootLayer().Save()

    # A shape edit is a drag on the width bars, and changes only the beam --
    # the same subset a move does, so it takes the same light payload.
    payload = _move_payload(name, stage, render_mode)
    payload["ok"] = True
    return jsonify(payload)

@bp.post("/api/projects/<name>/beam/pin")
@records_history
def pin_beam_node(name):
    """Set or clear a pin override on a specific beam node.

    Body: {segment: int, node: int, position: [x,y,z] | null}
    A non-null position pins the vertex to that coordinate (ignoring the
    component's live position). null clears the pin (auto mode resumes).
    """
    body = request.get_json(force=True)
    seg_idx = int(body.get("segment", 0))
    node_idx = int(body.get("node", 0))
    position = body.get("position")  # list[float] or None

    setup = scene.project_setup(name)
    stage = Usd.Stage.Open(setup)
    bp_attr = stage.GetDefaultPrim().GetAttribute("optics:beamPath")
    if not bp_attr or not bp_attr.HasAuthoredValue():
        abort(404, "project has no beam path")

    segs = json.loads(bp_attr.Get())
    if seg_idx >= len(segs) or node_idx >= len(segs[seg_idx]):
        abort(400, "segment or node index out of range")

    node = segs[seg_idx][node_idx]
    # Normalise node to dict form
    if isinstance(node, str):
        node = {"ref": node}
    if position is None:
        node.pop("pin", None)  # clear pin → auto
    else:
        node["pin"] = [round(float(v), 3) for v in position[:3]]
    segs[seg_idx][node_idx] = node

    bp_attr.Set(json.dumps(segs))
    stage.GetRootLayer().Save()

    return jsonify(ok=True)
