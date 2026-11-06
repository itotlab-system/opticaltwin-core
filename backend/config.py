"""Where the backend reads and writes, and how it is secured.

Every module reads these as ``config.NAME`` at call time, never through
``from backend.config import NAME``: an imported copy is frozen at import, so
the test suite (``tests/conftest.py``) could no longer point PROJECTS_DIR at a
throwaway folder, and a test would write into the lab's real projects.
"""

import os

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PROJECTS_DIR = os.path.join(ROOT_DIR, "projects")   # live team benches
LIB_DIR = os.path.join(ROOT_DIR, "components")      # the parts catalogue
WEB_DIR = os.path.join(ROOT_DIR, "web")             # plain-HTML MVP
BUILD_DIR = os.path.join(WEB_DIR, "_build")         # generated glbs (gitignored)
APP_DIST = os.path.join(ROOT_DIR, "app", "dist")    # built React client

# Shared-password login. Unset means the server is open to anyone who can
# reach it -- fine on a laptop, not on a reachable server (see SECURITY.md).
AUTH_PASSWORD = os.environ.get("OT_PASSWORD", "")
