"""Exporting a project to glb for the plain-HTML MVP in web/. The React client
never loads it."""

import os

from flask import Blueprint, abort, send_from_directory

from opticaltwin import usd_to_web

from backend import config
from backend import scene
from backend.scene import SAFE

bp = Blueprint("glb", __name__)

os.makedirs(config.BUILD_DIR, exist_ok=True)

def rebuild_glb(name):
    setup = scene.project_setup(name)
    usd_to_web.convert(setup, os.path.join(config.BUILD_DIR, f"{name}.glb"))

def rebuild_glb_if_stale(name):
    """Export the glb only when it is older than the project layer.

    The React client never loads /model/<name>.glb -- it renders from the mesh
    JSON in the project payload. Only the legacy web/editor.html does. Rebuilding
    on every mutating route therefore spent ~50 ms per edit on a file nobody
    read; the export now happens on demand, in the GET route, and stays a no-op
    while the layer is unchanged.
    """
    setup = scene.project_setup(name)
    glb = os.path.join(config.BUILD_DIR, f"{name}.glb")
    try:
        # Strictly newer, not equal: the export always runs after the save, so
        # on any sub-second-resolution filesystem it wins. Equal timestamps mean
        # a coarse filesystem, where re-exporting is the safe way to be wrong.
        if os.path.getmtime(glb) > os.path.getmtime(setup):
            return glb
    except OSError:
        pass                            # missing glb (or setup) -- build it
    rebuild_glb(name)
    return glb

@bp.get("/model/<name>.glb")
def model(name):
    if not SAFE.match(name):
        abort(400)
    if os.path.exists(scene.project_setup(name)):
        rebuild_glb_if_stale(name)      # editing routes no longer pre-build it
    return send_from_directory(config.BUILD_DIR, f"{name}.glb")
