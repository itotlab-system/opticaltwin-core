# Getting started

[← Back to the README](../README.md)

## Requirements

- **Python 3.12**
- **Node 20** (only to build the web app; it does not need to keep running)

## Install and run

Run everything from the repository root, in one terminal.

```bash
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements-app.txt
python setup_projects.py                    # builds the parts library and an example bench
(cd app && npm install && npm run build)    # builds the web app, once
python server.py                            # then open http://localhost:8000
```

On Windows, use `py -3.12 -m venv .venv` and `.venv\Scripts\activate` for the
first line, and run `cd app`, `npm install`, `npm run build`, `cd ..` as
separate commands for the fourth.

To start it again later, only the last step is needed:

```bash
source .venv/bin/activate && python server.py
```

## What you should see

1. **A name prompt.** Type any name. It is recorded with your edits and shown on
   the project list. There is no account and, unless you set one, no password.
2. **The project list**, with one example bench, `project1`.
3. **The editor**, after you open it: the bench in 3D on a breadboard, the parts
   list on the left and the selected part's position on the right.

Drag in the 3D view to look around. Select a part to move it by typing exact
millimetres or by dragging its handle. **Add a part** opens the part browser.

To start a bench of your own, choose **New project** on the project list. The
default, *Design from a laser*, puts a laser on an empty board with its beam at
the height you choose; parts dropped near the beam snap onto it.
Every change is saved straight to `projects/<name>/setup.usda`, a text file you
can commit and share.

## If something is not right

| What you see | Cause and fix |
|---|---|
| A plain page titled "OpticalTwin Editor" with no 3D toolbar | The web app has not been built, so the server fell back to its old built-in page. Run `npm install && npm run build` in `app/`, then reload. |
| A password prompt | `OT_PASSWORD` is set in your environment. Enter that value, or start the server without it. |
| `npm install` reports vulnerabilities | They are in the build tools (Vite and its dependencies), which run only on your machine while building. Nothing from them is served to the browser. |
| `Address already in use` | Something else is on port 8000. Stop it, or find it with `ss -ltnp \| grep 8000`. |
| The project list is empty | `python setup_projects.py` has not been run. |

## The parts are generated

`components/` is **not** checked in. `python setup_projects.py` builds it from
the `make_*` generators in `opticaltwin/optics_lib.py`: lenses, mirrors, a
beamsplitter, an iris, detectors and so on, as simple shapes dimensioned to
common Ø1″ / 30 mm-cage standards. Re-run it any time to rebuild.

Simple shapes at the right size are all a layout needs. To work with models that
look like the hardware on your bench, add manufacturer CAD: see
[Manufacturer CAD models](cad-models.md). Generated parts have one model each,
so the *Simple* and *Detailed* views show them the same; CAD parts have a light
model for editing and a detailed one for looking.

Nothing is fetched from the internet while the app runs, so it works on a
closed lab network once installed.

## Going further

### Share it with your group

Read [Running it for your lab](deployment.md) before anyone else can reach the
server. It covers the shared password and running on a lab network.

### Develop the web app

For working on the code, run the backend and the Vite dev server side by side.
The dev server reloads the page as you edit.

```bash
python server.py                 # terminal 1: backend on :8000
cd app && npm run dev            # terminal 2: open http://localhost:5173
```

Vite proxies `/api` and `/model` to the backend. While developing, use port
5173; port 8000 serves the last *built* app, which does not follow your edits.

### Example scenes outside the editor

```bash
python scripts/optical_bench_prototype.py   # a minimal bench -> setups/optical_bench.usda
python -m opticaltwin.usd_to_web            # setups/*.usda -> web/*.glb for the static viewer
```

### Tests

See [CONTRIBUTING.md](../CONTRIBUTING.md#tests).
