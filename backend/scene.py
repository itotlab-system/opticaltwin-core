"""Opening a project's layer and reading its component prims.

The base layer of the backend: everything else builds on these helpers."""

import os
import re

from flask import abort
from pxr import Sdf

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
    _keep_library_layers_loaded(path)
    uu.ensure_fixed_breadboard_reference(path)
    return path

# Library model layers held open for the life of the process: realpath ->
# (mtime, Sdf.Layer).
#
# Every request opens the project's stage afresh, and USD composes each
# referenced model file into it. Each part's one model is its full CAD mesh, so
# re-parsing them all made every move cost ~0.3 s on a 37-part bench. While a
# handle is held, the layer registry hands the parsed layer to every
# Usd.Stage.Open instead. Only components/ is held -- read-only from here --
# never a project layer, which the editing routes change. A model re-converted
# from its STEP (a newer mtime) is reloaded.
_LIBRARY_LAYERS = {}

def _keep_library_layers_loaded(setup_path):
    layer = Sdf.Layer.FindOrOpen(setup_path)
    if layer is None:
        return
    library_root = os.path.realpath(config.LIB_DIR) + os.sep
    base = os.path.dirname(os.path.abspath(setup_path))
    for asset_path in layer.GetCompositionAssetDependencies():
        path = os.path.realpath(os.path.join(base, asset_path))
        if not path.startswith(library_root) or not os.path.isfile(path):
            continue
        mtime = os.path.getmtime(path)
        held = _LIBRARY_LAYERS.get(path)
        if held and held[0] == mtime:
            continue
        model = Sdf.Layer.FindOrOpen(path)
        if model is None:
            continue
        if held:
            model.Reload()
        _LIBRARY_LAYERS[path] = (mtime, model)

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
