# Contributing to OpticalTwin

Thanks for looking. Issues, questions and pull requests are all welcome.

Please read the first section before opening a pull request — this repository is
laid out in a way that is not obvious, and knowing it will save you time.

---

## How this repository relates to development

`opticaltwin-core` is a **published export of a private repository** kept by the
Ito–Shimobaba–Wang Laboratory at Chiba University. Development happens in the
private repository; this one is refreshed from it at each release.

It works this way because the private repository also holds things that cannot
be published: manufacturer CAD data that is not ours to redistribute, and
unpublished experimental setups belonging to lab members. Splitting those out
per-commit is not practical, so the public repository is regenerated wholesale
instead.

Two consequences, and neither is meant as a slight:

- **A merged pull request may not appear as your commit here.** Changes are
  applied upstream and arrive in this repository inside the next sync commit.
  We record contributors in `CHANGELOG.md` and in the release notes. If you would
  like to be credited differently, say so in the pull request and we will follow it.
- **Direct pushes to this repository are overwritten** by the next export. If
  you have write access, that still applies to you.

If a change is accepted, it lands upstream — it is not dropped. The mechanism is
just a bit indirect.

## Before you open a pull request

Please open an issue first for anything beyond a bug fix or a typo. That is
especially true for anything touching optical physics: see *Scope* below.

## Scope

OpticalTwin is for **layout and planning** — where components sit on a
breadboard, whether they fit, whether they line up. Beam paths are straight
planning lines drawn between components.

It deliberately does **not** model refraction, focusing, diffraction, or perform
ray tracing, and it is not going to become an optical design suite. Zemax,
Code V, and OpticStudio exist and are better at that than we will ever be.

This is the single most common source of scope creep on the project, so
pull requests that add optical physics will be declined unless they were agreed
in an issue beforehand. It is not that the idea is bad — it is that the tool is
useful precisely because it stays small.

## Conventions that matter

These are load-bearing. Code that breaks them will not work with existing scenes.

| Rule | Value |
|---|---|
| Units | millimetres (`metersPerUnit = 0.001` on every stage) |
| Up axis | Z |
| Optical axis | +X — beams travel along +X by default, at Z = 0 |
| Custom attributes | the `optics:` namespace, e.g. `optics:focalLength_mm` |
| Scene format | text `.usda`, so scenes diff and merge in git |
| Asset references | **relative** paths — absolute paths break portability |

Each optical component is its own `.usda` asset under `components/`; setups pull
them in via USD **References** so one asset can be placed many times. Please keep
that structure — it is the backbone of the data model.

## Development setup

Requires Python 3.12 and Node 20.

```bash
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements-app.txt
python setup_projects.py     # generates components/ and an example project
python server.py             # backend on :8000

cd app && npm install && npm run dev    # frontend on :5173
```

Optional, for the CAD import path only:

```bash
pip install cadquery-ocp    # large; only cad_importer.py needs it
```

## Tests

```bash
python -m unittest test_component_library test_beam_tracer test_cad_importer
cd app && npx playwright test     # browser end-to-end, starts the servers itself
```

The CAD import tests need `cadquery-ocp`. Please add a test alongside a change
rather than after it — coverage is thinner than we would like, and the way it
gets better is one pull request at a time.

## Style

Match the surrounding code rather than applying a preferred style over the top.
Concretely: small functions, existing naming (`make_lens`, `place`, `add_beam`),
and comments that explain *why* a thing is done, not what the line does. Several
non-obvious decisions in this codebase are documented in comments precisely so
they are not undone by accident — if one is in your way, that comment is the
argument you need to answer.

## Reporting bugs

Use the issue templates. What helps most: what you did, what you expected, what
happened, and the `setup.usda` if you can share it. Scenes are text, so a diff or
an excerpt is usually enough — please check it holds no unpublished work of your
own before pasting it.

## Licence

By contributing you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE), the same terms as the project.
