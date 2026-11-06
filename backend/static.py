"""Serving the built React client (app/dist), falling back to the plain-HTML MVP."""

import os

from flask import Blueprint, send_from_directory

from backend import config

bp = Blueprint("static", __name__)

# -------------------------------------------------------------------------
# Static: serve the built React app (app/dist) in production; fall back to the
# plain-HTML MVP (web/) if it hasn't been built. Plus the generated glbs.
# -------------------------------------------------------------------------


@bp.get("/")
def index():
    if os.path.exists(os.path.join(config.APP_DIST, "index.html")):
        return send_from_directory(config.APP_DIST, "index.html")
    return send_from_directory(config.WEB_DIR, "editor.html")

@bp.get("/<path:f>")
def static_file(f):
    # built React assets/models first, else the old web/ MVP
    if os.path.exists(os.path.join(config.APP_DIST, f)):
        return send_from_directory(config.APP_DIST, f)
    return send_from_directory(config.WEB_DIR, f)
