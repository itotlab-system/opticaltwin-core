# Getting started

[← Back to the README](../README.md)

## Requirements

- **Linux, macOS or Windows**
- **Python 3.12 or newer** (3.12, 3.13 and 3.14 are tested)
- **Node 20 or newer** (only to build the web app; it does not need to keep running)

Check with `python --version` (`python3 --version` on Linux and macOS) and
`node --version`. If either is missing, install it from
[python.org](https://www.python.org/downloads/) or [nodejs.org](https://nodejs.org/)
(the LTS version). On Windows, tick *Add python.exe to PATH* in the Python
installer, then open a new terminal so it sees the new install.

## Install and run

Run everything from the repository root, in one terminal, one line at a time.
After the line that activates the environment, your prompt starts with
`(.venv)`. Check for it before `pip install`: without it, the packages go into
your system Python instead.

**Linux and macOS** (and Windows under WSL):

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-app.txt
python setup_projects.py                    # builds the parts library and an example bench
(cd app && npm install && npm run build)    # builds the web app, once
python server.py                            # then open http://localhost:8000
```

**Windows** (Command Prompt or PowerShell):

```bat
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements-app.txt
python setup_projects.py
cd app
npm install
npm run build
cd ..
python server.py
```

If `python` opens the Microsoft Store or says it is not recognized, Python is
not installed or not on your PATH; see Requirements above.

To start it again later, activate the environment and start the server:

```bash
source .venv/bin/activate && python server.py     # Linux and macOS
.venv\Scripts\activate && python server.py        # Windows Command Prompt
```

### Using conda

If you already use conda (Anaconda, Miniconda), make an environment for
OpticalTwin instead of the venv, and run the remaining lines inside it:

```bash
conda create -n opticaltwin python=3.13 -y
conda activate opticaltwin
pip install -r requirements-app.txt
python setup_projects.py
```

then build the web app and start the server as above. Your prompt shows
`(opticaltwin)`. Do not install into `(base)`: conda itself depends on some of
the same packages.

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
| `source` is not recognized | You are in Windows Command Prompt or PowerShell. Use the Windows commands above. |
| `No matching distribution found for numpy` (or scipy) | Your Python is older than 3.12. Install a current one from python.org, delete the `.venv` folder and start again. Check with `python --version`. |
| `python` or `python3` is not recognized, or opens the Microsoft Store | Python is not installed, or not on your PATH. Install it from python.org; on Windows, tick *Add python.exe to PATH* in the installer and open a new terminal. |
| `pip install` worked but the server says `No module named flask` | The packages went into another Python, because the environment was not active. Activate it (`(.venv)` in the prompt) and run `pip install -r requirements-app.txt` again. |
| PowerShell says running scripts is disabled | Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or use Command Prompt. |
| `Address already in use` | Something else is on port 8000. Stop it, or find it with `ss -ltnp \| grep 8000` (Windows: `netstat -ano \| findstr :8000`). |
| The project list is empty | `python setup_projects.py` has not been run. |

## The parts are generated

`components/` is **not** checked in. `python setup_projects.py` builds it from
the `make_*` generators in `opticaltwin/optics_lib.py`: lenses, mirrors, a
beamsplitter, an iris, detectors and so on, as simple shapes dimensioned to
common Ø1″ / 30 mm-cage standards. Re-run it any time to rebuild.

Simple shapes at the right size are all a layout needs. To work with models that
look like the hardware on your bench, add manufacturer CAD: see
[Manufacturer CAD models](cad-models.md). Every part, generated or CAD, has
exactly one model: `components/<Group>/<Model>/model.usda`.

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
