"""Figure callouts: validating and storing the labels drawn over a figure."""

import re
import json
import math

from flask import Blueprint, abort, jsonify, request
from pxr import Usd, Sdf

from backend import scene
from backend.history import _history_state, records_history
from backend.scene import _component_prims

bp = Blueprint("callouts", __name__)

# A figure callout: the label text plus where its box sits relative to the part
# it points at. `dx`/`dy` are *screen* pixels at the stored zoom, not millimetres
# — the box is placed by eye against the rendered picture, and the leader line is
# redrawn from the projected anchor every frame, so the layout survives orbiting.
#
# Where the line *lands* is the opposite kind of quantity: `ax`/`ay`/`az` are
# millimetres in the part's own frame, so a dot dragged onto a lens surface stays
# on that surface when the part is moved, rotated, or looked at from elsewhere.
# Absent means the part's origin, which is where a fresh callout points.
CALLOUT_ANCHOR_KEYS = ("ax", "ay", "az")

# Leader-line and box colours. Stored as CSS hex (plus "none" for a box with no
# fill, which a figure over a photograph often wants). The *palette* the UI
# offers lives in the client (`CALLOUT_COLORS` in app/src/callouts.ts) — the
# server only checks the shape, so adding a swatch never needs a backend change.
# The text colour is deliberately not stored: it is derived from the box fill so
# a label cannot be styled into unreadability.
CALLOUT_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

def _clean_callout_color(value, allow_none):
    """A callout colour -> normalized string, or None if it isn't one."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    if allow_none and value.lower() == "none":
        return "none"
    return value.lower() if CALLOUT_COLOR_RE.match(value) else None

def _clean_callout(callout, valid_names):
    """Validate one callout -> a normalized dict, or None if unusable.

    A callout points at a component prim, so it shares the components' fate:
    delete the part and the label that names it is meaningless. Dropping it on
    read (rather than chasing deletes from every mutating route) matches how
    `_normalize_groups` treats stale members.
    """
    if not isinstance(callout, dict):
        return None
    cid, target = callout.get("id"), callout.get("target")
    if not isinstance(cid, str) or not cid:
        return None
    if not isinstance(target, str) or target not in valid_names:
        return None
    try:
        dx, dy = float(callout.get("dx", 0)), float(callout.get("dy", 0))
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(dx) and math.isfinite(dy)):
        return None
    clean = dict(id=cid, target=target,
                 text=str(callout.get("text") or ""),
                 dx=round(dx, 2), dy=round(dy, 2))
    try:
        font_px = float(callout["fontPx"])
    except (KeyError, TypeError, ValueError):
        font_px = None
    if font_px is not None and math.isfinite(font_px):
        clean["fontPx"] = round(max(6.0, min(96.0, font_px)), 2)

    # The anchor offset is all-or-nothing: two of three axes would place the dot
    # somewhere nobody asked for, so a partial or unreadable triple falls back to
    # the origin rather than being half-applied.
    try:
        anchor = [float(callout[key]) for key in CALLOUT_ANCHOR_KEYS]
    except (KeyError, TypeError, ValueError):
        anchor = None
    if anchor is not None and all(math.isfinite(value) for value in anchor):
        clean.update(zip(CALLOUT_ANCHOR_KEYS, (round(v, 3) for v in anchor)))

    # Styling is optional throughout: an unreadable colour is dropped rather
    # than rejected, so an old or hand-edited layer still opens.
    line_color = _clean_callout_color(callout.get("lineColor"), allow_none=False)
    if line_color:
        clean["lineColor"] = line_color
    box_color = _clean_callout_color(callout.get("boxColor"), allow_none=True)
    if box_color:
        clean["boxColor"] = box_color
    if callout.get("hidden"):
        clean["hidden"] = True
    return clean

def _callouts(stage):
    """Read optics:callouts -> [{id, target, text, dx, dy, fontPx?}]."""
    attr = stage.GetDefaultPrim().GetAttribute("optics:callouts")
    if not attr or not attr.HasAuthoredValue():
        return []
    try:
        callouts = json.loads(attr.Get())
    except (TypeError, json.JSONDecodeError):
        return []
    if not isinstance(callouts, list):
        return []
    valid = {prim.GetName() for prim in _component_prims(stage)}
    out, seen = [], set()
    for callout in callouts:
        clean = _clean_callout(callout, valid)
        if clean is None or clean["id"] in seen:
            continue
        seen.add(clean["id"])
        out.append(clean)
    return out

@bp.post("/api/projects/<name>/callouts")
@records_history
def update_callouts(name):
    """Replace the whole figure-callout list (add / edit / drag / delete).

    Like pins and groups this is annotation, not scene data: it moves nothing on
    the bench. It is a whole-list replace because a drag rewrites one box and a
    delete removes one, and both are one undo step either way.
    """
    body = request.get_json(force=True)
    callouts = body.get("callouts")
    if not isinstance(callouts, list):
        abort(400, "callouts must be a list")

    setup = scene.project_setup(name)
    stage = Usd.Stage.Open(setup)
    valid = {prim.GetName() for prim in _component_prims(stage)}

    clean, seen = [], set()
    for callout in callouts:
        one = _clean_callout(callout, valid)
        if one is None:
            abort(400, "invalid callout")
        if one["id"] in seen:
            abort(400, f"duplicate callout id: {one['id']}")
        seen.add(one["id"])
        clean.append(one)

    prim = stage.GetDefaultPrim()
    attr = prim.GetAttribute("optics:callouts")
    if not attr:
        attr = prim.CreateAttribute("optics:callouts", Sdf.ValueTypeNames.String)
    attr.Set(json.dumps(clean, ensure_ascii=False))
    stage.GetRootLayer().Save()
    return jsonify(ok=True, callouts=clean, **_history_state(name))
