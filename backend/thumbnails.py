"""Gallery thumbnails: a picture of the bench, stored beside the layer.

The editor takes the picture — from the frame already on its screen — and
uploads it; the gallery only shows the file. Before this, every viewer's
browser rendered every bench itself, which is too heavy per card with full CAD
models. The server has no GPU, so it does not render: the browser that already
holds the models is the cheap place to take the picture.

Like project.json, the picture and its record are files in the project folder
rather than USD: they are not scene data, writing them must not change the
layer's mtime (the card's "last edited"), and as files they travel with
rename, duplicate and git on their own.

Whether the picture still shows the bench is decided by the layer's *contents*,
not its mtime: a git pull or the daily autosave rewrites mtimes without
changing the bench, and a duplicate's identical layer keeps its picture current.
"""
import hashlib
import json
import os

from flask import Blueprint, abort, jsonify, request, send_from_directory

from backend import config
from backend.scene import SAFE

bp = Blueprint("thumbnails", __name__)

THUMBNAIL_FILE = "thumbnail.png"
THUMBNAIL_RECORD = "thumbnail.json"
# A 480x300 bench is ~150 kB; anything near this is not a card picture.
THUMBNAIL_MAX_BYTES = 4 * 1024 * 1024
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _project_dir(name):
    """The project's folder, refusing bad names and unknown projects.

    Deliberately not scene.project_setup(): that may normalize the layer's
    references and rewrite it, and taking a picture must never touch the layer.
    """
    if not SAFE.match(name):
        abort(400, "bad project name")
    folder = os.path.join(config.PROJECTS_DIR, name)
    if not os.path.exists(os.path.join(folder, "setup.usda")):
        abort(404, "no such project")
    return folder


def _digest(data):
    return hashlib.sha1(data).hexdigest()[:16]


def _layer_rev(folder):
    """Fingerprint of the bench as it is now: a hash of setup.usda's bytes."""
    try:
        with open(os.path.join(folder, "setup.usda"), "rb") as fh:
            return _digest(fh.read())
    except OSError:
        return ""


def _thumbnail_summary(name):
    """What a gallery card needs: None, or {v: cache key, current: bool}.

    Never raises — one unreadable record must not fail the whole listing. A
    picture without a record (copied in by hand) is shown but counted stale.
    """
    folder = os.path.join(config.PROJECTS_DIR, name)
    if not os.path.isfile(os.path.join(folder, THUMBNAIL_FILE)):
        return None
    record = {}
    try:
        with open(os.path.join(folder, THUMBNAIL_RECORD), encoding="utf-8") as fh:
            loaded = json.load(fh)
        if isinstance(loaded, dict):
            record = loaded
    except (OSError, ValueError):
        pass
    image = record.get("image")
    if not isinstance(image, str) or not image:
        try:
            image = str(int(os.path.getmtime(os.path.join(folder, THUMBNAIL_FILE))))
        except OSError:
            image = "0"
    rev = record.get("rev")
    return dict(v=image, current=bool(rev) and rev == _layer_rev(folder))


@bp.post("/api/projects/<name>/thumbnail")
def upload_thumbnail(name):
    """Store the gallery picture (PNG body), taken by the editor.

    Not undoable on purpose (see _NOT_UNDOABLE in tests/test_history.py):
    rewinding the bench is not a reason to bring back an older picture.
    """
    folder = _project_dir(name)
    data = request.get_data(cache=False)
    if not data or len(data) > THUMBNAIL_MAX_BYTES:
        abort(400, "thumbnail must be a PNG under 4 MB")
    if not data.startswith(PNG_SIGNATURE):
        abort(400, "thumbnail must be a PNG")
    image = _digest(data)
    # Written to a temporary name and renamed into place, so a gallery listing
    # read mid-upload never sees half a file.
    for filename, payload in (
        (THUMBNAIL_FILE, data),
        (THUMBNAIL_RECORD,
         (json.dumps({"rev": _layer_rev(folder), "image": image}) + "\n").encode()),
    ):
        path = os.path.join(folder, filename)
        tmp = path + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(payload)
        os.replace(tmp, path)
    return jsonify(ok=True, thumbnail=_thumbnail_summary(name))


@bp.get("/api/projects/<name>/thumbnail.png")
def thumbnail_file(name):
    folder = _project_dir(name)
    if not os.path.isfile(os.path.join(folder, THUMBNAIL_FILE)):
        abort(404)
    # The card asks for ?v=<image digest>, so a new picture is a new URL and the
    # browser may keep this one for as long as it likes.
    return send_from_directory(folder, THUMBNAIL_FILE, max_age=86400)
