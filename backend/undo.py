"""The undo/redo routes. The history itself lives in backend/history.py."""

from flask import Blueprint, jsonify
from pxr import Usd

from backend import history
from backend import scene
from backend.activity import _record_activity
from backend.history import _HISTORY_LOCK, _history, _layer_text, _restore_layer
from backend.payload import _project_payload

bp = Blueprint("undo", __name__)

def _step_history(name, take, keep):
    """Move one step between the undo and redo stacks.

    `take` is the stack to pop the snapshot from and `keep` the one that gets
    the current state, so undo and redo are the same operation mirrored.
    """
    with _HISTORY_LOCK:
        h = _history(name)
        snapshot = h[take].pop() if h[take] else None
        if snapshot is not None:
            h[keep].append(_layer_text(name))
            del h[keep][:-history.HISTORY_LIMIT]

    if snapshot is not None:
        _restore_layer(name, snapshot)

    stage = Usd.Stage.Open(scene.project_setup(name))
    payload = _project_payload(name, stage)
    payload["ok"] = True
    payload["stepped"] = snapshot is not None   # False = nothing left to do
    return jsonify(payload)

@bp.post("/api/projects/<name>/undo")
def undo_project(name):
    """Rewind one editing step. Returns the restored scene."""
    response = _step_history(name, "undo", "redo")
    if response.get_json().get("stepped"):
        _record_activity(name)
    return response

@bp.post("/api/projects/<name>/redo")
def redo_project(name):
    response = _step_history(name, "redo", "undo")
    if response.get_json().get("stepped"):
        _record_activity(name)
    return response
