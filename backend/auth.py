"""The shared-password login, and the app-wide request hooks (login check,
CORS and cache headers)."""

import hmac

from flask import Blueprint, jsonify, request, session

from backend import config

bp = Blueprint("auth", __name__)

@bp.get("/api/auth/status")
def auth_status():
    return jsonify(
        required=bool(config.AUTH_PASSWORD),
        authenticated=not config.AUTH_PASSWORD or bool(session.get("authenticated")),
    )

@bp.post("/api/auth/login")
def login():
    if not config.AUTH_PASSWORD:
        return jsonify(ok=True)
    password = (request.get_json(silent=True) or {}).get("password", "")
    if hmac.compare_digest(str(password), config.AUTH_PASSWORD):
        session["authenticated"] = True
        return jsonify(ok=True)
    # `code` is the machine-readable form; the client picks the message in the
    # user's own language. `error` stays for anything reading the old shape.
    return jsonify(
        ok=False, code="invalid_password", error="パスワードが違います。"
    ), 401

@bp.post("/api/auth/logout")
def logout():
    session.clear()
    return jsonify(ok=True)

@bp.before_app_request
def require_login():
    if (
        not config.AUTH_PASSWORD
        or request.method == "OPTIONS"
        or request.path.startswith("/api/auth/")
    ):
        return None
    if not session.get("authenticated"):
        if request.path.startswith(("/api/", "/model/")):
            return jsonify(error="Login required."), 401
    return None

@bp.after_app_request
def cors(resp):
    """Allow the Vite dev server (:5173) to call this API during development."""
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    if request.path.startswith("/api/") and not request.path.startswith(
        "/api/library/photo/"
    ):
        # Scene geometry changes frequently while editing. Never let a browser
        # reuse beam data calculated before a component move or server reload.
        # Catalogue photos are the exception: they are static files whose URL
        # carries the file's mtime, so they are safe (and worth) caching.
        resp.headers["Cache-Control"] = "no-store"
    return resp
