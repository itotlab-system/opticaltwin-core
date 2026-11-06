"""Undo/redo history: whole-layer snapshots taken by @records_history around
every mutating route. Per project, shared between users, in memory only."""

import functools
import threading

from pxr import Sdf

from backend import scene
from backend.activity import _record_activity

# -------------------------------------------------------------------------
# Undo / redo
#
# Every editing step is recorded as a snapshot of the whole USD layer, taken
# just before the change lands. The layers are small (8-54 kB of text, and
# they compress to ~2 kB), so keeping 50 of them costs less than writing and
# testing an inverse for each of the nine mutating endpoints -- and it makes
# the awkward cases (deleting a part, resizing the board) undo perfectly,
# references and attribute overrides included.
#
# The history is shared per project rather than per user: on the lab server
# Ctrl+Z undoes the last change to the project, whoever made it. It lives in
# this process only, so a server restart starts everyone from a clean slate.
# -------------------------------------------------------------------------
HISTORY_LIMIT = 50

_HISTORY = {}                       # project -> {"undo": [...], "redo": [...]}

_HISTORY_LOCK = threading.Lock()

def _layer_text(name):
    """The project's USD layer serialized to a string.

    Goes through Sdf rather than reading the file so the snapshot matches what
    USD currently has in memory — the layer registry hands the same Sdf.Layer
    back to every Usd.Stage.Open of this path.
    """
    layer = Sdf.Layer.FindOrOpen(scene.project_setup(name))
    return layer.ExportToString() if layer else None

def _restore_layer(name, text):
    """Replace the project's layer contents with a snapshot and save it.

    ImportFromString updates the registered layer in place, so stages opened
    afterwards see the restored scene. Writing the file directly would leave
    the cached layer stale.
    """
    layer = Sdf.Layer.FindOrOpen(scene.project_setup(name))
    layer.ImportFromString(text)
    layer.Save()

def _history(name):
    return _HISTORY.setdefault(name, {"undo": [], "redo": []})

def _push_history(name, snapshot):
    """Record a step, returning the redo stack it displaced.

    A fresh edit invalidates whatever was redoable. The displaced stack comes
    back so a failed request can be rolled back cleanly.
    """
    with _HISTORY_LOCK:
        h = _history(name)
        redo_was = list(h["redo"])
        h["undo"].append(snapshot)
        h["redo"].clear()
        return redo_was

def _rollback_history(name, redo_was):
    with _HISTORY_LOCK:
        h = _history(name)
        if h["undo"]:
            h["undo"].pop()
        h["redo"][:] = redo_was

def _trim_history(name):
    with _HISTORY_LOCK:
        h = _history(name)
        del h["undo"][:-HISTORY_LIMIT]

def _forget_history(name):
    with _HISTORY_LOCK:
        _HISTORY.pop(name, None)

def _rename_history(old, new):
    """Carry a project's undo stack over to its new name.

    The stacks are whole-layer snapshots, and a rename changes nothing inside
    the layer, so every recorded step is still valid under the new name.
    """
    with _HISTORY_LOCK:
        h = _HISTORY.pop(old, None)
        if h is not None:
            _HISTORY[new] = h

def _history_state(name):
    """What the editor needs to enable or grey out its undo/redo controls."""
    with _HISTORY_LOCK:
        h = _HISTORY.get(name) or {"undo": [], "redo": []}
        return dict(canUndo=bool(h["undo"]), canRedo=bool(h["redo"]))

def records_history(view):
    """Snapshot the project layer before an edit, and keep it if the edit lands.

    Wraps the mutating routes, all of which take the project as `name`.

    The step is recorded *before* the view runs, so the payload the view builds
    already reports canUndo — otherwise the editor's undo button would lag one
    edit behind. A view that aborts rolls the record back, so failed requests
    leave no step behind.
    """
    @functools.wraps(view)
    def wrapper(name, *args, **kwargs):
        before = _layer_text(name)
        if before is None:              # unreadable layer — edit, but don't record
            return view(name, *args, **kwargs)
        redo_was = _push_history(name, before)
        try:
            response = view(name, *args, **kwargs)
        except Exception:
            _rollback_history(name, redo_was)
            raise
        _trim_history(name)
        _record_activity(name)
        return response
    wrapper.records_history = True     # asserted by tests/test_history.py
    return wrapper
