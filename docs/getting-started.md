# Getting started

[← Back to the README](../README.md)

## Requirements

- **Python 3.12**
- **Node 20**
- Optional: `cadquery-ocp`, only for importing manufacturer CAD (see
  [Manufacturer CAD models](cad-models.md))

## Install and run

```bash
# 1: Python backend
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements-app.txt
python setup_projects.py    # generates components/ and an example project
python server.py            # http://localhost:8000

# 2: React frontend (separate terminal)
cd app
npm install
npm run dev                 # http://localhost:5173
```

Open **http://localhost:5173/**. Vite proxies `/api` and `/model` to the backend.

## A production build

Run `npm run build` in `app/`. The backend then serves `app/dist/` directly on
port 8000, so the frontend dev server is not needed. Before running it anywhere
other people can reach, read [Running it for your lab](deployment.md).

## The component library is generated

`components/` is **not** checked in. `python setup_projects.py` builds the
catalogue from the `make_*` generators in `opticaltwin/optics_lib.py`: lenses,
mirrors, beamsplitters, irises, detectors and so on, dimensioned to common
Ø1″ / 30 mm-cage standards. Re-run it any time to rebuild.

These are procedural shapes with correct dimensions, which is all the layout
needs. For parts that look like the real hardware, import manufacturer CAD:
see [Manufacturer CAD models](cad-models.md).

## Example scenes

```bash
python scripts/optical_bench_prototype.py   # a minimal bench -> setups/optical_bench.usda
python -m opticaltwin.usd_to_web            # setups/*.usda -> web/*.glb for the static viewer
```

## Tests

See [CONTRIBUTING.md](../CONTRIBUTING.md#tests).
