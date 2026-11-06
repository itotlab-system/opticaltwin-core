"""3D pin annotations placed on the bench."""

import json

from flask import Blueprint, abort, jsonify, request
from pxr import Usd, Sdf

from backend import scene
from backend.history import records_history

bp = Blueprint("pins", __name__)

def _pins(stage):
    attr = stage.GetDefaultPrim().GetAttribute("optics:pins")
    if not attr or not attr.HasAuthoredValue():
        return []
    try:
        pins = json.loads(attr.Get())
        return pins if isinstance(pins, list) else []
    except (TypeError, json.JSONDecodeError):
        return []

@bp.post("/api/projects/<name>/pins")
@records_history
def update_pins(name):
    body = request.get_json(force=True)
    pins = body.get("pins")
    if not isinstance(pins, list):
        abort(400, "pins must be a list")

    required = {"id", "label", "x", "y", "z", "authorName", "color", "createdAt"}
    if any(not isinstance(pin, dict) or not required.issubset(pin) for pin in pins):
        abort(400, "invalid pin")

    setup = scene.project_setup(name)
    stage = Usd.Stage.Open(setup)
    attr = stage.GetDefaultPrim().GetAttribute("optics:pins")
    if not attr:
        attr = stage.GetDefaultPrim().CreateAttribute("optics:pins", Sdf.ValueTypeNames.String)
    attr.Set(json.dumps(pins, ensure_ascii=False))
    stage.GetRootLayer().Save()
    return jsonify(ok=True, pins=pins)
