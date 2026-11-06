"""Component groups: normalising, storing and copying them with their parts."""

import json

from flask import Blueprint, abort, jsonify, request
from pxr import Usd, Sdf

from backend import scene
from backend.history import records_history
from backend.scene import _component_prims

bp = Blueprint("groups", __name__)

def _normalize_groups(groups, valid_names):
    """Drop anything a group can no longer refer to.

    Components are deleted independently of the groups that mention them, so a
    stored group is only ever a hint: keep the members that still exist and keep
    a component in the first group that claims it.  A group that ends up with
    fewer than two members is dropped -- a group of one moves and rotates
    exactly like the bare component, and the editor offers no way to dissolve
    it because its panels only appear for a multi-selection.
    """
    out, seen_ids, claimed = [], set(), set()
    for group in groups:
        if not isinstance(group, dict):
            continue
        gid = group.get("id")
        members = group.get("members")
        if not isinstance(gid, str) or gid in seen_ids:
            continue
        if not isinstance(members, list):
            continue
        kept = []
        for name in members:
            if name in valid_names and name not in claimed and name not in kept:
                kept.append(name)
        if len(kept) < 2:
            continue
        seen_ids.add(gid)
        claimed.update(kept)
        clean = dict(id=gid, name=str(group.get("name") or gid), members=kept)
        color = group.get("color")
        if isinstance(color, str):
            clean["color"] = color
        out.append(clean)
    return out

def _groups(stage):
    """Read optics:groups -> [{id, name, members, color}] (empty if unset)."""
    attr = stage.GetDefaultPrim().GetAttribute("optics:groups")
    if not attr or not attr.HasAuthoredValue():
        return []
    try:
        groups = json.loads(attr.Get())
    except (TypeError, json.JSONDecodeError):
        return []
    if not isinstance(groups, list):
        return []
    valid = {prim.GetName() for prim in _component_prims(stage)}
    return _normalize_groups(groups, valid)

def _write_groups(stage, groups):
    """Author optics:groups on the default prim (caller saves the layer)."""
    prim = stage.GetDefaultPrim()
    attr = prim.GetAttribute("optics:groups")
    if not attr:
        attr = prim.CreateAttribute("optics:groups", Sdf.ValueTypeNames.String)
    attr.Set(json.dumps(groups, ensure_ascii=False))

def _groups_with_copies(groups, name_map, source_groups=None):
    """Append a copy of every group whose members were *all* duplicated.

    Pasting a whole assembly should give another assembly; pasting part of one
    gives loose components, which is what PowerPoint-style grouping implies.

    `groups` is the list being written back (the paste target's); the copies are
    derived from `source_groups`, which is the same list for a within-project
    paste and the other project's groups for a cross-project one.
    """
    out = list(groups)
    used_ids = {group["id"] for group in groups}
    for group in (groups if source_groups is None else source_groups):
        if not all(member in name_map for member in group["members"]):
            continue
        gid, i = f"{group['id']}-copy", 1
        while gid in used_ids:
            i += 1
            gid = f"{group['id']}-copy-{i}"
        used_ids.add(gid)
        out.append(dict(group, id=gid,
                        members=[name_map[m] for m in group["members"]]))
    return out

@bp.post("/api/projects/<name>/groups")
@records_history
def update_groups(name):
    """Replace the whole group list (create / rename / ungroup all land here)."""
    body = request.get_json(force=True)
    groups = body.get("groups")
    if not isinstance(groups, list):
        abort(400, "groups must be a list")

    setup = scene.project_setup(name)
    stage = Usd.Stage.Open(setup)
    valid = {prim.GetName() for prim in _component_prims(stage)}

    seen_ids, claimed = set(), set()
    for group in groups:
        if not isinstance(group, dict):
            abort(400, "invalid group")
        gid, gname, members = group.get("id"), group.get("name"), group.get("members")
        if not isinstance(gid, str) or not gid:
            abort(400, "group id must be a non-empty string")
        if gid in seen_ids:
            abort(400, f"duplicate group id: {gid}")
        if not isinstance(gname, str) or not gname:
            abort(400, "group name must be a non-empty string")
        if not isinstance(members, list) or len(members) < 2:
            abort(400, "a group needs at least two members")
        for member in members:
            if member not in valid:
                abort(400, f"no such component: {member}")
            if member in claimed:
                abort(400, f"component in two groups: {member}")
            claimed.add(member)
        seen_ids.add(gid)

    clean = _normalize_groups(groups, valid)
    _write_groups(stage, clean)
    stage.GetRootLayer().Save()
    return jsonify(ok=True, groups=clean)
