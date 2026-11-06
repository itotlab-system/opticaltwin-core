"""Who edited a project and when, kept in projects/<n>/activity.json.

Attribution on a trusted LAN, not access control."""

import os
import re
import json
import threading
import datetime
import urllib.parse

from flask import request

from backend import config
from backend import scene

# --- Who edited: the activity sidecar ---------------------------------------
#
# The login is one shared password, so the server cannot tell lab members apart
# on its own. The client asks each person for a name once, remembers it, and
# sends it on every request as X-OT-Editor. Each landed edit is recorded in
# `projects/<n>/activity.json`:
#
#     {"last": {"name": "山田", "at": 1790150000.12},
#      "days": {"2026-09-23": {"山田": 12, "Smith": 3}}}
#
# `days` is a day-by-name tally, not a log of every drag: enough to count how
# many people edit each month (the adoption goal) and small enough to read in a
# git diff. `last` is who made the most recent edit, for the gallery card's
# "山田 · 1 分前に編集"; `at` is the layer's mtime right after that edit, so
# the card can tell whether the layer has changed since (see _last_editor).
#
# Like project.json it lives in the project folder, so rename carries it and the
# autosave commits it -- but a duplicate starts without one, because nobody has
# edited the copy yet. A name is trusted as typed: this records who says they
# edited, on a LAN behind a shared password, and is not access control.
EDITOR_HEADER = "X-OT-Editor"

ACTIVITY_FILE = "activity.json"

EDITOR_MAX_LEN = 40

# How far the recorded edit time may sit from the layer's mtime and still be
# the same edit. Both are read from the same file on the same disk, so they
# normally agree exactly; the slack only absorbs coarse filesystem timestamps.
LAST_EDIT_SLACK_S = 2.0

_ACTIVITY_LOCK = threading.Lock()

def _clean_editor(raw):
    """The editor name from the header, or "" when there is none to record.

    The client percent-encodes it, since a header can only carry Latin-1 and
    names are routinely Japanese. Trimmed, capped and stripped of control
    characters, the same way a folder label is.
    """
    if not isinstance(raw, str) or not raw:
        return ""
    name = urllib.parse.unquote(raw, errors="replace")
    name = re.sub(r"[\x00-\x1f\x7f]", " ", name).strip()
    return name[:EDITOR_MAX_LEN]

def _activity_path(name):
    return os.path.join(config.PROJECTS_DIR, name, ACTIVITY_FILE)

def _read_activity(name):
    """The sidecar, or {} for a missing or unreadable file. Never raises."""
    try:
        with open(_activity_path(name), encoding="utf-8") as fh:
            loaded = json.load(fh)
    except (OSError, ValueError):
        return {}
    return loaded if isinstance(loaded, dict) else {}

def _record_activity(name):
    """Count one edit of `name` for its editor, and remember them as the last.

    Anonymous edits are not recorded -- they come from the legacy editor or a
    client too old to ask. They still change the layer, which is exactly what
    makes a stale `last` stop matching it.
    """
    editor = _clean_editor(request.headers.get(EDITOR_HEADER, ""))
    if not editor:
        return
    day = datetime.date.today().isoformat()
    try:
        at = os.path.getmtime(scene.project_setup(name))
    except OSError:
        at = 0.0
    with _ACTIVITY_LOCK:
        activity = _read_activity(name)
        days = activity.get("days")
        if not isinstance(days, dict):
            days = activity["days"] = {}
        counts = days.get(day)
        if not isinstance(counts, dict):
            counts = days[day] = {}
        counts[editor] = int(counts.get(editor, 0) or 0) + 1
        activity["last"] = {"name": editor, "at": at}
        path = _activity_path(name)
        tmp = f"{path}.tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(activity, fh, ensure_ascii=False, indent=2,
                          sort_keys=True)
                fh.write("\n")
            os.replace(tmp, path)
        except OSError:
            # Losing a tally must never fail the edit it was counting.
            pass

def _last_editor(name, modified):
    """Who made the layer what it is now, or "" when that is not known.

    Only a name whose recorded edit time matches the layer's mtime is returned.
    The layer also changes without passing through a named edit -- the
    autosave's git pull bringing in another copy's work, a hand edit, the
    legacy editor -- and the card must then show the time alone rather than
    credit the change to whoever edited before it. No name beats a wrong one.
    """
    last = _read_activity(name).get("last")
    if not isinstance(last, dict):
        return ""
    editor, at = last.get("name"), last.get("at")
    if not isinstance(editor, str) or not isinstance(at, (int, float)):
        return ""
    if abs(float(at) - float(modified)) > LAST_EDIT_SLACK_S:
        return ""
    return editor
