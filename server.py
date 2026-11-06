"""
server.py  --  local web editor for optical-setup projects
-----------------------------------------------------------
A small Flask backend that lets a team open a project in the browser, move
components by exact distance, add/remove parts, and SAVE -- with USD as the
source of truth. Every edit is written straight back to projects/<name>/setup.usda
and the 3D view is regenerated. Run it locally; sync projects via git.

Run:  python server.py        # then open http://localhost:8000/
"""

import os

from backend import create_app

app = create_app()


if __name__ == "__main__":
    print("OpticalTwin -> http://0.0.0.0:8000/")
    app.run(
        host="0.0.0.0",
        port=8000,
        debug=False,
        threaded=True,
        use_reloader=os.environ.get("OT_DEV_RELOAD") == "1",
    )
