# Changelog

All notable changes to OpticalTwin are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each release is archived by Zenodo and gets its own version DOI. The concept DOI
[10.5281/zenodo.21594827](https://doi.org/10.5281/zenodo.21594827) always
resolves to the latest release, so a citation of it stays valid.

> This repository is a periodic export of the lab's development repository (see
> [CONTRIBUTING.md](CONTRIBUTING.md)). "Unreleased" therefore means *written and
> merged upstream, not yet in a public release here*.

## [Unreleased]

### Added

- **Beam-segment editing in the 3D viewport.** Beam legs are selectable objects.
  Clicking a leg opens an editor beside it that sets the drawn length and the
  width at each end, with four shapes — parallel, expand, shrink, focus — driving
  both ends from a single width. Widths are drag bars rather than spinner boxes,
  because a beam width is judged by eye against the optics. The profile is stored
  per leg and survives components being moved. It is a planning sketch: editing a
  leg changes only how that leg is drawn and moves no component.
- **Component grouping.** Ctrl+click to multi-select, `Ctrl+G` / `Ctrl+Shift+G`
  to group and ungroup, then move or rotate a group as one rigid body. Clicking
  selects the group, double-clicking drills into a member.
- **Copy and paste.** `Ctrl+C` / `Ctrl+V` / `Ctrl+D` on a selection, and a
  Duplicate button in the Inspector. Copies are made server-side from the USD
  prim spec, so the library reference and every authored override come along.
  The clipboard also crosses projects.
- **Undo and redo.** `Ctrl+Z` / `Ctrl+Shift+Z` (or `Ctrl+Y`) and toolbar buttons,
  covering every mutating operation including delete. History is per project,
  shared between users, and in memory only — it is lost on server restart.
- **Laser on/off** per laser source, from the toolbar.
- **Viewport background** — dark, gray and light, chosen independently of the UI
  theme. The mid gray exists for visibility: black anodized mounts vanish against
  near-black and silver optics wash out against near-white.
- `cad/SOURCES.toml` and `tools/fetch_cad.py` — a manifest of the manufacturer
  CAD parts the component library was built from, with a script to fetch the ones
  that have a direct link and print the product page for the rest. Pointers only;
  no vendor CAD is redistributed.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` and this changelog.
- Continuous integration on pull requests: Python tests and a frontend
  type-check and build.

### Fixed

- Sensors block the beam on their housing as well as their active area. Testing
  only the sensor plane let light pass through a camera turned side-on, because
  an edge-on plane makes the intersection test degenerate.
- Beam legs that only pass straight through structural hardware are fused, so a
  real bench reports the dozen stretches a user means rather than 25 slivers,
  most of them between cage plates.
- The interaction budget counts pass-throughs and is large enough for a real
  bench. It used to run out mid-bench, report the beam as escaping, and leave the
  camera at the end unreachable.

### Known issues

- Switching a project to high level of detail can empty the scene: 13 of the
  generated components have no `hi.usda`, and the switch drops every component
  rather than falling back per part.

## [1.0.0] — 2026-07-26

Initial public release.

### Added

- **USD data model.** Millimetre units, Z-up, optical axis along +X, custom
  attributes in the `optics:` namespace. Each optic is its own `.usda` asset;
  setups pull them in by USD Reference, so one asset can be placed many times and
  scenes stay text that diffs and merges in git.
- **Component library generators** (`optics_lib.py`) — lenses, mirrors,
  beamsplitters, polarizers, irises, detectors and mounts at Ø1″ / 30 mm-cage
  standard dimensions, plus breadboard, placement and beam helpers.
- **Setup templates** (`templates.py`) and project scaffolding
  (`setup_projects.py`).
- **Web editor** — a Flask backend reading and writing USD directly, with a React
  and React Three Fiber client: outliner, 3D viewport, and a numeric inspector.
  Every edit is written straight back to the `.usda` file; the editor holds no
  hidden state.
- **Beam path resolution** (`beam_tracer.py`) — straight planning lines between
  components, with geometric folds at mirrors and beamsplitters. No refraction,
  focusing, diffraction or ray tracing, by design.
- **CAD import** (`cad_importer.py`) — STEP to USD conversion for manufacturer
  models you supply yourself.
- **glTF export** (`usd_to_web.py`) and a static, view-only viewer.
- Shared-password access control via `OT_PASSWORD`, for use on a trusted LAN.

[Unreleased]: https://github.com/itotlab-system/opticaltwin-core/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/itotlab-system/opticaltwin-core/releases/tag/v1.0.0
