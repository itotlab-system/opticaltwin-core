"""Opening a project's layer and reading its component prims.

The base layer of the backend: everything else builds on these helpers."""

import os
import re

from flask import abort

from opticaltwin import usd_utility as uu

from backend import config

SAFE = re.compile(r"^[A-Za-z0-9_\-]+$")             # guard path params

def project_setup(name):
    if not SAFE.match(name):
        abort(400, "bad project name")
    path = os.path.join(config.PROJECTS_DIR, name, "setup.usda")
    if not os.path.exists(path):
        abort(404, "no such project")
    uu.normalize_component_references_in_usda(path)
    uu.ensure_fixed_breadboard_reference(path)
    return path

def _component_prims(stage, include_fixed=False):
    """Top-level placed components = prims that carry an optics:type."""
    out = []
    for prim in stage.Traverse():
        t = prim.GetAttribute("optics:type")
        fixed = prim.GetAttribute("optics:fixedBoard")
        is_fixed = bool(fixed and fixed.HasAuthoredValue() and fixed.Get())
        if (
            t and t.HasAuthoredValue()
            and prim.GetParent() == stage.GetDefaultPrim()
            and (include_fixed or not is_fixed)
        ):
            out.append(prim)
    return out

def _optics_attrs(prim):
    """All authored optics:* attributes on a component, for the Inspector / render."""
    out = {}
    for attr in prim.GetAttributes():
        n = attr.GetName()
        if n.startswith("optics:") and attr.HasAuthoredValue():
            out[n[len("optics:"):]] = attr.Get()
    return out

def _authored_float(prim, name):
    """Read one authored numeric attribute, returning None when absent."""
    if not prim:
        return None
    attr = prim.GetAttribute(name)
    if not attr or not attr.HasAuthoredValue():
        return None
    value = attr.Get()
    return float(value) if value is not None else None
