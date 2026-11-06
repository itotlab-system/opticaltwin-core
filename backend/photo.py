"""Building a bench from a photo: storing the photo and its labels, and placing
the marked parts along the traced beam."""

import os
import re
import json
import math
import datetime

from flask import Blueprint, abort, jsonify, request, send_from_directory
from pxr import Usd

from opticaltwin import beam_first
from opticaltwin import generic_parts

from backend import config
from backend import library
from backend import scene
from backend.beam import _beam_path
from backend.beam_edit import _fold, _snap_onto_beam, _traced_components
from backend.components import LASER_APERTURE_OFFSET_MM
from backend.editing import _add_asset, _add_generic
from backend.groups import _groups, _write_groups
from backend.history import records_history
from backend.lasers import BEAM_HEIGHT_RANGE_MM, DEFAULT_BEAM_HEIGHT_MM
from backend.payload import _project_payload, _resolved_project_beam
from backend.placement import (
    _board_top,
    _clamp_z,
    _placement_xform_values,
    _set_xform,
    _string_attr,
)
from backend.scene import SAFE

bp = Blueprint("photo", __name__)

# -------------------------------------------------------------------------
# Building a bench from a photo
# -------------------------------------------------------------------------
# The photo and what was marked on it live beside the layer, like
# project.json: they are the evidence the bench was built from, not scene
# data, and being files in the project folder they travel with rename,
# duplicate and git. The public export already leaves projects/ out.
PHOTO_DIR = "photos"

PHOTO_LABELS_FILE = "photo_labels.json"

PHOTO_MAX_BYTES = 8 * 1024 * 1024

PHOTO_LABELS_MAX_BYTES = 512 * 1024

PHOTO_FILE = re.compile(r"^photo-\d{8,}\.jpg$")

# Parts that stand ON the board (no beam height of their own).
STANDING_TYPES = {"post", "holder", "mount", "rod", "cage", "breadboard"}

def _photo_labels_path(name):
    return os.path.join(config.PROJECTS_DIR, name, PHOTO_LABELS_FILE)

def _photo_labels(name):
    try:
        with open(_photo_labels_path(name), encoding="utf-8") as fh:
            loaded = json.load(fh)
        return loaded if isinstance(loaded, dict) else {}
    except (OSError, ValueError):
        return {}

def _write_photo_labels(name, labels):
    path = _photo_labels_path(name)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(labels, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, path)

@bp.post("/api/projects/<name>/photo")
def upload_photo(name):
    """Store the bench photo (JPEG body). The browser has already shrunk it."""
    scene.project_setup(name)
    data = request.get_data(cache=False)
    if not data or len(data) > PHOTO_MAX_BYTES:
        abort(400, "photo must be a JPEG under 8 MB")
    if data[:3] != b"\xff\xd8\xff":
        abort(400, "photo must be a JPEG")
    folder = os.path.join(config.PROJECTS_DIR, name, PHOTO_DIR)
    os.makedirs(folder, exist_ok=True)
    filename = f"photo-{int(datetime.datetime.now().timestamp() * 1000)}.jpg"
    with open(os.path.join(folder, filename), "wb") as fh:
        fh.write(data)
    return jsonify(ok=True, file=filename)

@bp.get("/api/projects/<name>/photo/<filename>")
def photo_file(name, filename):
    if not SAFE.match(name) or not PHOTO_FILE.match(filename):
        abort(404)
    return send_from_directory(os.path.join(config.PROJECTS_DIR, name, PHOTO_DIR),
                               filename, max_age=3600)

@bp.get("/api/projects/<name>/photo-labels")
def get_photo_labels(name):
    scene.project_setup(name)
    return jsonify(_photo_labels(name))

@bp.post("/api/projects/<name>/photo-labels")
def save_photo_labels(name):
    """Save what was marked on the photo: calibration, feet, part choices.

    Deliberately not an undo step (like the folder/archive sidecar): marking
    a photo changes nothing on the bench until it is built.
    """
    scene.project_setup(name)
    raw = request.get_data(cache=False)
    if len(raw) > PHOTO_LABELS_MAX_BYTES:
        abort(400, "labels too large")
    try:
        labels = json.loads(raw or b"{}")
    except ValueError:
        abort(400, "labels must be JSON")
    if not isinstance(labels, dict):
        abort(400, "labels must be an object")
    photo = labels.get("photo")
    if photo is not None and (not isinstance(photo, str) or not PHOTO_FILE.match(photo)):
        abort(400, "bad photo name")
    # The build owns this map; a stale editor tab must not overwrite it.
    labels["built"] = _photo_labels(name).get("built", {})
    _write_photo_labels(name, labels)
    return jsonify(ok=True)

def _photo_part_spec(raw):
    """One marked part from the build request, validated."""
    if not isinstance(raw, dict) or not isinstance(raw.get("id"), str):
        abort(400, "each part needs an id")
    try:
        x, y = float(raw["x"]), float(raw["y"])
    except (KeyError, TypeError, ValueError):
        abort(400, "each part needs x and y in mm")
    direction = None
    if raw.get("dir") is not None:
        try:
            dx, dy = float(raw["dir"][0]), float(raw["dir"][1])
        except (TypeError, ValueError, IndexError):
            abort(400, "dir must be [dx, dy]")
        if math.hypot(dx, dy) > 1e-9:
            direction = (dx, dy)
    generic = raw.get("generic")
    asset = raw.get("asset")
    if generic is not None:
        if not isinstance(generic, dict) or generic.get("role") not in generic_parts.ROLES:
            abort(400, "generic part needs a known role")
    elif not isinstance(asset, str) or not asset:
        abort(400, "each part needs an asset or a generic role")
    return dict(id=raw["id"], x=x, y=y, dir=direction, asset=asset, generic=generic,
                off_beam=bool(raw.get("offBeam")), emit_at=bool(raw.get("emitAt")))

def _photo_part_type(spec):
    if spec["generic"] is not None:
        return generic_parts.ROLES[spec["generic"]["role"]][0]
    preview = library._library_previews().get(spec["asset"], {})
    return preview.get("type") or ""

def _place_photo_part(stage, spec):
    if spec["generic"] is not None:
        g = spec["generic"]
        return _add_generic(stage, g["role"], g.get("size") or [], g.get("label", ""),
                            g.get("model", ""), spec["x"], spec["y"],
                            bool(g.get("requestPart")))
    return _add_asset(stage, spec["asset"], spec["x"], spec["y"])

def _orient_at_beam_height(stage, comp_name, x, y, rot_z, beam_z):
    """Stand an in-beam part at (x, y) with its optical centre at beam_z."""
    comp = _traced_components(stage)[comp_name]
    ox, oy, oz = beam_first.origin_for(comp, [x, y, beam_z], 0.0, 0.0, rot_z)
    _set_xform(stage.GetPrimAtPath(f"{stage.GetDefaultPrim().GetPath()}/{comp_name}"),
               ox, oy, _clamp_z(stage, oz), 0.0, 0.0, rot_z)

def _turn_towards(incoming, direction):
    """'left' or 'right': which fold sends `incoming` closest to `direction`."""
    cross = incoming[0] * direction[1] - incoming[1] * direction[0]
    return "left" if cross >= 0 else "right"

def _build_from_photo(stage, specs, beam_height):
    """Place every marked part; return {part id: component name}.

    Lasers first, so there is a beam. Then, repeatedly, the not-yet-placed
    part that sits closest to the *start* of the beam goes next and snaps into
    it -- so a lens takes the beam's direction and a mirror folds it before
    the parts after it are placed, exactly as building beam-first by hand.
    A mirror's arrow, when drawn, says which way the beam leaves it. Parts the
    beam never reaches are stood where their foot was marked, facing their
    arrow (or +X), at beam height.
    """
    built = {}
    beam_z = _board_top(stage) + beam_height
    root = str(stage.GetDefaultPrim().GetPath())
    lasers = [s for s in specs if _photo_part_type(s) == "laser" and not s["off_beam"]]
    rest = [s for s in specs if s not in lasers and not s["off_beam"]]
    # Marked "not on the beam": stood where marked, never pulled into it.
    loose = [s for s in specs if s["off_beam"]]

    for spec in lasers:
        name = _place_photo_part(stage, spec)
        rot_z = beam_first.heading_deg(spec["dir"]) if spec["dir"] else 0.0
        comp = _traced_components(stage)[name]
        physics = comp.get("physics", {})
        emission_z = float(physics.get("emissionCenterZ_mm", 0.0))
        x, y = spec["x"], spec["y"]
        if spec["emit_at"]:
            # (x, y) is where the drafted beam starts: the laser's OUTPUT, so
            # its body sits behind it.
            back = float(physics.get("emissionOffset_mm", LASER_APERTURE_OFFSET_MM))
            x -= math.cos(math.radians(rot_z)) * back
            y -= math.sin(math.radians(rot_z)) * back
        _set_xform(stage.GetPrimAtPath(f"{root}/{name}"), x, y,
                   _clamp_z(stage, beam_z - emission_z), 0.0, 0.0, round(rot_z, 6))
        built[spec["id"]] = name

    remaining = list(rest)
    while remaining:
        comps = _traced_components(stage)
        beam = _resolved_project_beam(stage, comps, _beam_path(stage))
        best = None
        for spec in remaining:
            if _photo_part_type(spec) not in beam_first.SNAP_TYPES:
                continue
            hit = beam_first.nearest_leg(beam, spec["x"], spec["y"])
            if hit is None:
                continue
            leg, point, _ = hit
            index = beam.index(leg)
            along = math.dist(point, leg["pts"][0])
            if best is None or (index, along) < best[0]:
                best = ((index, along), spec)
        if best is None:
            break
        spec = best[1]
        remaining.remove(spec)
        name = _place_photo_part(stage, spec)
        _snap_onto_beam(stage, name, spec["x"], spec["y"])
        if _photo_part_type(spec) in beam_first.FOLD_TYPES and spec["dir"]:
            comps = _traced_components(stage)
            beam = _resolved_project_beam(stage, comps, _beam_path(stage))
            leg = beam_first.incoming_leg(beam, name)
            if leg is not None:
                incoming = beam_first.leg_direction(leg)
                _fold(stage, name, _turn_towards(incoming, spec["dir"]))
        built[spec["id"]] = name

    for spec in remaining + loose:
        name = _place_photo_part(stage, spec)
        if _photo_part_type(spec) not in STANDING_TYPES:
            rot_z = beam_first.heading_deg(spec["dir"]) if spec["dir"] else 0.0
            _orient_at_beam_height(stage, name, spec["x"], spec["y"],
                                   round(rot_z, 6), beam_z)
        elif spec["dir"]:
            prim = stage.GetPrimAtPath(f"{root}/{name}")
            x, y, z, *_ = _placement_xform_values(prim)
            _set_xform(prim, x, y, z, 0.0, 0.0,
                       round(beam_first.heading_deg(spec["dir"]), 6))
        built[spec["id"]] = name
    return built

@bp.post("/api/projects/<name>/photo/build")
@records_history
def build_from_photo(name):
    """Turn the parts marked on the photo into the bench.

    Body: {beamHeight, parts: [{id, x, y, dir?, asset | generic}], renderMode?}
    with x/y already in board millimetres (the browser owns the photo-to-board
    mapping, since it draws the predicted hole grid with it). Rebuilding first
    removes what the previous build placed, so the photo stays the source and
    the build can be repeated as the labels are corrected. One undo step.
    """
    body = request.get_json(force=True)
    render_mode = body.get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")
    try:
        beam_height = float(body.get("beamHeight", DEFAULT_BEAM_HEIGHT_MM))
    except (TypeError, ValueError):
        abort(400, "beamHeight must be a number")
    low, high = BEAM_HEIGHT_RANGE_MM
    if not math.isfinite(beam_height) or not low <= beam_height <= high:
        abort(400, f"beamHeight must be between {low:g} and {high:g} mm")
    parts = body.get("parts")
    if not isinstance(parts, list):
        abort(400, "parts must be a list")
    specs = [_photo_part_spec(p) for p in parts]

    stage = Usd.Stage.Open(scene.project_setup(name))
    root = str(stage.GetDefaultPrim().GetPath())
    labels = _photo_labels(name)
    for old in (labels.get("built") or {}).values():
        if isinstance(old, str) and SAFE.match(old):
            prim = stage.GetPrimAtPath(f"{root}/{old}")
            if prim.IsValid():
                post = _string_attr(prim, "pairedPost")
                stage.RemovePrim(f"{root}/{old}")
                if post and stage.GetPrimAtPath(f"{root}/{post}").IsValid():
                    stage.RemovePrim(f"{root}/{post}")

    built = _build_from_photo(stage, specs, beam_height)
    groups_attr = stage.GetDefaultPrim().GetAttribute("optics:groups")
    if groups_attr and groups_attr.HasAuthoredValue():
        _write_groups(stage, _groups(stage))
    stage.GetRootLayer().Save()

    labels["built"] = built
    _write_photo_labels(name, labels)
    payload = _project_payload(name, stage, render_mode)
    payload["ok"] = True
    payload["built"] = built
    return jsonify(payload)
