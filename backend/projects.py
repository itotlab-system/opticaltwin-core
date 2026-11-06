"""The gallery: listing, creating, duplicating, renaming, filing and removing
projects."""

import os
import re
import json
import math

from flask import Blueprint, abort, jsonify, request
from pxr import Usd, Sdf

from opticaltwin import optics_lib as ol
from opticaltwin import templates as tpl
import setup_projects

from backend import config
from backend.activity import _activity_path, _last_editor
from backend.board import _board
from backend.history import _forget_history, _rename_history
from backend.lasers import (
    BEAM_HEIGHT_RANGE_MM,
    DEFAULT_BEAM_HEIGHT_MM,
    FROM_LASER_TEMPLATE,
    FROM_PHOTO_TEMPLATE,
    _laser_assets,
    _laser_option,
    _place_starting_laser,
)
from backend.scene import SAFE, _component_prims

bp = Blueprint("projects", __name__)

# New projects only offer an empty breadboard, or a copy of a stored 4f setup:
# the demo templates (slm_imaging/two_lens) bake a static beam path that goes
# stale as soon as components move. tpl.TEMPLATES itself is untouched so
# existing tooling (setup_projects.py) keeps working.
# setup_projects.CLONE_TEMPLATES supplies the "4f_default" option, copied from
# project_templates/4f_default/setup.usda rather than replayed from a recipe,
# and offered only when that file exists (_clone_template_available).
NEW_PROJECT_TEMPLATE_KEYS = ("blank",)

# -------------------------------------------------------------------------
# API
# -------------------------------------------------------------------------
def _project_summary(name):
    """Lightweight info for the gallery: component count + the types present.

    `modified` is the layer's mtime. The gallery draws each bench into a
    thumbnail in the browser and caches the picture; the mtime is what tells it
    a cached thumbnail is stale, so it must change whenever the setup does.
    """
    setup = os.path.join(config.PROJECTS_DIR, name, "setup.usda")
    stage = Usd.Stage.Open(setup)
    types = [p.GetAttribute("optics:type").Get() for p in _component_prims(stage)]
    try:
        modified = os.path.getmtime(setup)
    except OSError:
        modified = 0.0
    # The board's footprint: which bench this is, in the terms the lab uses for
    # them. One bounded prim per project, so it costs little on the listing.
    board = _board(stage)
    meta = _project_meta(name)
    return dict(
        name=name,
        components=len(types),
        types=types,
        modified=modified,
        boardSizeX=_card_size(board["sizeX"]),
        boardSizeY=_card_size(board["sizeY"]),
        folder=meta["folder"],
        archived=meta["archived"],
        lastEditor=_last_editor(name, modified),
    )

# How a project is filed in the gallery: which folder it sits in ("2027年度")
# and whether it has been archived out of the way. This is shelving, not scene
# data, so it lives in a sidecar next to setup.usda rather than in the layer.
#
# Two reasons it is not a USD attribute on the Setup prim. Archiving a project
# would rewrite the layer, and the layer's mtime is the gallery's `modified` —
# both the card's "last edited" line and the cache key for its bench thumbnail
# (see _project_summary). Filing something away would report it as edited and
# redraw its picture. And nothing in the 3D scene depends on it.
#
# It is a file inside the project folder so it travels by itself: rename moves
# the folder, duplicate copytrees it, and git syncs it with the project.
PROJECT_META_FILE = "project.json"

FOLDER_MAX_LEN = 60

def _project_meta_path(name):
    return os.path.join(config.PROJECTS_DIR, name, PROJECT_META_FILE)

def _project_meta(name):
    """A project's filing info, defaulted for every project that has none.

    Never raises: a project whose sidecar is missing, unreadable or hand-edited
    into something that isn't an object is simply an unfiled, live project. A
    gallery listing must not fail over one bad file.
    """
    meta = {}
    try:
        with open(_project_meta_path(name), encoding="utf-8") as fh:
            loaded = json.load(fh)
        if isinstance(loaded, dict):
            meta = loaded
    except (OSError, ValueError):
        pass
    return dict(
        folder=_clean_folder(meta.get("folder")),
        archived=bool(meta.get("archived")),
    )

def _clean_folder(raw):
    """A folder label reduced to something a card can print. "" = unfiled.

    Unlike a project name this is never used as a path — it is only ever a
    label grouping cards — so it keeps Japanese, spaces and punctuation as
    typed. It is only trimmed, length-capped, and stripped of the control
    characters and newlines that would break the tab strip.
    """
    if not isinstance(raw, str):
        return ""
    label = re.sub(r"[\x00-\x1f\x7f]", " ", raw).strip()
    return label[:FOLDER_MAX_LEN]

def _write_project_meta(name, meta):
    """Save filing info, or delete the sidecar once there is nothing to say.

    A project that is unfiled and unarchived is the default, so it carries no
    file — that keeps `projects/` clean and keeps an unused sidecar out of git
    for every project nobody has filed.
    """
    path = _project_meta_path(name)
    if not meta["folder"] and not meta["archived"]:
        try:
            os.remove(path)
        except OSError:
            pass
        return meta
    payload = {}
    if meta["folder"]:
        payload["folder"] = meta["folder"]
    if meta["archived"]:
        payload["archived"] = True
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    return meta

def _card_size(value):
    """A board dimension fit to print on a gallery card, else 0.

    A board whose asset cannot be resolved bounds to USD's empty range, and its
    "size" comes back as -6.8e38. The card would print that. Anything that isn't
    a real positive length is no size at all, and the card leaves it blank.
    """
    size = float(value or 0.0)
    return round(size, 1) if math.isfinite(size) and size > 0 else 0.0

@bp.get("/api/projects")
def list_projects():
    names = []
    if os.path.isdir(config.PROJECTS_DIR):
        for n in sorted(os.listdir(config.PROJECTS_DIR)):
            if os.path.exists(os.path.join(config.PROJECTS_DIR, n, "setup.usda")):
                names.append(n)
    return jsonify(
        projects=[_project_summary(n) for n in names],
        templates=(
            [dict(key=k, label=v[1]) for k, v in tpl.TEMPLATES.items()
             if k in NEW_PROJECT_TEMPLATE_KEYS]
            + [dict(key=k, label=v[1])
               for k, v in setup_projects.CLONE_TEMPLATES.items()
               if _clone_template_available(k)]
            + ([dict(key=FROM_LASER_TEMPLATE, label="Design from a laser")]
               if _laser_assets() else [])
            + [dict(key=FROM_PHOTO_TEMPLATE, label="Start from a photo")]
        ),
        lasers=[_laser_option(a) for a in _laser_assets()],
        defaultBeamHeight=DEFAULT_BEAM_HEIGHT_MM,
    )

def _clone_template_available(template):
    """Whether a clone template's stored setup is actually there.

    A clone template is only as real as the file it copies. Offering one whose
    setup is missing puts an option in the New Project menu that can only fail —
    which is what happened while `4f_default` still pointed at a live project
    that lab members had renamed away.
    """
    source = setup_projects.clone_source_path(template)
    return bool(source) and os.path.exists(source)

def _clean_project_name(raw):
    """A typed-in project name reduced to something safe to use as a folder.

    Spaces and punctuation become underscores rather than being rejected, so a
    user typing "SLM imaging" gets `SLM_imaging` instead of an error.
    """
    name = re.sub(r"[^A-Za-z0-9_\-]", "_", (raw or "").strip())
    if not name or not SAFE.match(name):
        abort(400, "invalid name")
    return name

@bp.post("/api/projects")
def new_project():
    body = request.get_json(force=True)
    name = _clean_project_name(body.get("name"))
    template = body.get("template", "blank")
    laser_asset = None
    if template == FROM_LASER_TEMPLATE:
        laser_asset = body.get("laser") or next(iter(_laser_assets()), None)
        if laser_asset not in _laser_assets():
            abort(400, "unknown laser")
        try:
            beam_height = float(body.get("beamHeight", DEFAULT_BEAM_HEIGHT_MM))
        except (TypeError, ValueError):
            abort(400, "beamHeight must be a number")
        low, high = BEAM_HEIGHT_RANGE_MM
        if not math.isfinite(beam_height) or not low <= beam_height <= high:
            abort(400, f"beamHeight must be between {low:g} and {high:g} mm")
        template = "blank"
    elif template == FROM_PHOTO_TEMPLATE:
        template = "blank"
    elif template not in NEW_PROJECT_TEMPLATE_KEYS and template not in setup_projects.CLONE_TEMPLATES:
        abort(400, "unknown template")
    if os.path.exists(os.path.join(config.PROJECTS_DIR, name, "setup.usda")):
        abort(409, "project already exists")
    if not os.path.isdir(config.LIB_DIR) or not os.listdir(config.LIB_DIR):
        ol.build_component_library(config.LIB_DIR)   # ensure the catalogue exists
    try:
        setup_projects.create_project(name, template, overwrite=True)
    except (FileNotFoundError, ValueError) as exc:
        # A clone template whose source project has been renamed or deleted.
        # It must come back as a response the browser can show; this used to
        # raise SystemExit, which killed the worker mid-request.
        abort(400, str(exc))
    if laser_asset:
        _place_starting_laser(name, laser_asset, beam_height)
    return jsonify(ok=True, name=name)

def _unique_project_name(base):
    """First free project name: bench_copy, bench_copy_2, ..."""
    name, i = base, 1
    while os.path.exists(os.path.join(config.PROJECTS_DIR, name, "setup.usda")):
        i += 1
        name = f"{base}_{i}"
    return name

@bp.post("/api/projects/<name>/duplicate")
def duplicate_project(name):
    """Copy a whole project under an auto-generated name.

    Duplicating bench gives bench_copy, then bench_copy_2 -- the existing
    _copy suffix is counted on rather than stacked.
    """
    if not SAFE.match(name):
        abort(400)
    if not os.path.exists(os.path.join(config.PROJECTS_DIR, name, "setup.usda")):
        abort(404, "no such project")
    stem = re.sub(r"_copy(_\d+)?$", "", name) or name
    new_name = _unique_project_name(f"{stem}_copy")
    setup_projects.duplicate_project(name, new_name, projects_dir=config.PROJECTS_DIR)
    # copytree brought the sidecar across, so the copy is filed beside its
    # original -- but it is never archived, however the original was filed. You
    # duplicate a project to work on it, and a copy born hidden looks lost.
    meta = _project_meta(new_name)
    meta["archived"] = False
    _write_project_meta(new_name, meta)
    # Nobody has edited the copy yet; its original's tally stays with it.
    try:
        os.remove(_activity_path(new_name))
    except OSError:
        pass
    return jsonify(ok=True, name=new_name, project=_project_summary(new_name))

@bp.post("/api/projects/<name>/meta")
def update_project_meta(name):
    """File a project into a folder, and/or archive it out of the gallery.

    Both fields are optional and each is applied only when present, so the
    archive toggle can't wipe a project's folder and vice versa. `folder: null`
    (or "") is the way to take a project back out of its folder.

    Not wrapped in @records_history: undo is the scene's history, and a folder
    label is not part of the scene. Rewinding a bench by twenty steps should
    not also un-archive it.
    """
    if not SAFE.match(name):
        abort(400)
    if not os.path.exists(os.path.join(config.PROJECTS_DIR, name, "setup.usda")):
        abort(404, "no such project")

    body = request.get_json(force=True) or {}
    meta = _project_meta(name)
    if "folder" in body:
        meta["folder"] = _clean_folder(body.get("folder"))
    if "archived" in body:
        meta["archived"] = bool(body.get("archived"))
    _write_project_meta(name, meta)
    return jsonify(ok=True, name=name, project=_project_summary(name))

@bp.post("/api/projects/<name>/rename")
def rename_project(name):
    """Rename a project folder.

    The whole folder moves — setup.usda, notes.md, whatever else the team put
    there — so the relative `../../components/...` references inside the layer
    resolve unchanged (same depth, same reasoning as duplicate_project).

    USD's layer registry is keyed by path and holds only layers something
    still references — normally nothing does between requests, but Flask is
    threaded and a request in flight does. Such a layer is re-keyed to the new
    path, so it can't keep the old name claimed and hand its stale in-memory
    scene to whatever project is created with that name next.
    """
    if not SAFE.match(name):
        abort(400)
    old_dir = os.path.join(config.PROJECTS_DIR, name)
    if not os.path.exists(os.path.join(old_dir, "setup.usda")):
        abort(404, "no such project")

    new_name = _clean_project_name((request.get_json(force=True) or {}).get("name"))
    if new_name == name:
        return jsonify(ok=True, name=name, project=_project_summary(name))
    new_dir = os.path.join(config.PROJECTS_DIR, new_name)
    if os.path.exists(new_dir):
        abort(409, "project already exists")

    layer = Sdf.Layer.Find(os.path.join(old_dir, "setup.usda"))
    os.rename(old_dir, new_dir)
    if layer:
        # Re-key before anything reopens the new path -- two layers may not
        # share an identifier, and project_setup() opens a stage of its own.
        layer.identifier = os.path.join(new_dir, "setup.usda")

    _rename_history(name, new_name)
    old_glb = os.path.join(config.BUILD_DIR, f"{name}.glb")
    if os.path.exists(old_glb):
        os.remove(old_glb)
    return jsonify(ok=True, name=new_name, project=_project_summary(new_name))

@bp.post("/api/projects/<name>/remove")
def remove_project(name):
    if not SAFE.match(name):
        abort(400)
    import shutil
    d = os.path.join(config.PROJECTS_DIR, name)
    if not os.path.isdir(d):
        abort(404)
    shutil.rmtree(d)
    _forget_history(name)
    return jsonify(ok=True)
