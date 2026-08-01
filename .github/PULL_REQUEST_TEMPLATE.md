<!--
  Contributing from outside the lab? Please read CONTRIBUTING.md first.

  Short version: the public repository is a periodic export of the lab's
  development repository. Accepted changes are applied upstream and arrive here
  inside the next sync commit, so a merged pull request may not show up as your
  own commit. It is not dropped — contributors are credited in CHANGELOG.md and
  the release notes. Tell us in this PR if you want to be credited differently.
-->

## What this changes

<!-- One or two sentences. Link the issue: "Fixes #123". -->

## Why

<!-- The problem being solved. If there is a non-obvious reason for the
     approach, put it here and in a code comment — this codebase documents its
     awkward decisions so they are not undone by accident later. -->

## How it was tested

<!-- Commands run, and what you checked by hand in the browser if relevant. -->

## Checklist

- [ ] Conventions kept: millimetres, Z-up, optical axis +X, `optics:` namespace,
      relative asset reference paths, text `.usda`
- [ ] `python -m unittest test_component_library test_beam_tracer test_cad_importer` passes
- [ ] `cd app && npm run build` passes (type-check included)
- [ ] Tests added or updated for the change
- [ ] No optical physics added (see Scope in CONTRIBUTING.md), or it was agreed in an issue first
- [ ] No manufacturer CAD, lab network details, or unpublished experimental setups included
