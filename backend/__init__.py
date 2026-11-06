"""OpticalTwin's Flask backend.

server.py is the entry point (`python server.py`) and only calls create_app(),
so the lab server's service, the Playwright runner and the docs are unchanged.

Modules are layered; a module imports only from the ones above it:

    config                         paths and the login password
    scene                          opening a project, its component prims
    components, placement          reading assets; transforms and links
    beam, board, library, catalog  beam tracing, breadboard, parts catalogue
    activity, history              who edited; undo snapshots
    callouts, groups, pins, glb    per-project data beside the scene
    payload                        the JSON the client renders
    beam_edit, lasers              editing the beam; starting from a laser
    editing, undo, projects,       the routes, one blueprint per area
    photo, auth, static

Two rules keep the tests honest:

* Paths and the password are read as ``config.NAME`` at call time.
* A function the tests patch (``project_setup``, ``_library_previews``,
  ``_component_meshes``, ``_sync_cad_catalog``, ...) is called as
  ``module.name`` from other modules, so patching its home module reaches
  every caller. A ``from ... import`` copy would keep the original.
"""

import os
import secrets

from flask import Flask

from backend import config


def create_app():
    # Named "server" with the repository as its root, exactly as the app was
    # when it lived in server.py: same name, same (absent) static folder.
    app = Flask("server", root_path=config.ROOT_DIR)

    # Shared-password login. Set OT_PASSWORD to require a login; leaving it unset
    # leaves the server open, which is only safe on a trusted network. Never put a
    # real password here as a default -- this file is meant to be publishable.
    app.secret_key = os.environ.get("OT_SESSION_SECRET") or secrets.token_hex(32)

    from backend import (
        auth, beam_edit, callouts, editing, glb, groups, library, photo, pins,
        projects, static, undo,
    )
    for module in (auth, projects, editing, undo, beam_edit, callouts, groups,
                   pins, photo, library, glb, static):
        app.register_blueprint(module.bp)
    return app
