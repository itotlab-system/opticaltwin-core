# Component 3D models (.glb)

Drop realistic component models here as **glTF binary (`.glb`)**. They are served
at `/models/<file>.glb` and loaded by the editor when a component **type** is
registered in `app/src/scene/models.ts`.

Naming: use the component `optics:type`, e.g. `camera.glb`, `eyepiece.glb`,
`lens.glb`, `beamsplitter.glb`, `slm.glb`, `mirror.glb`, `polarizer.glb`,
`iris.glb`, `laser.glb`, `cylindrical_lens.glb`.

Conventions to match (so the model lines up):
- **Units: millimetres**, centred on the component origin.
- **Clear aperture / optical axis faces +X** (rotate in `models.ts` `rot` if not).
- Keep them **light** (target < ~50k triangles, Draco-compressed) — see
  `docs/dev/ASSETS.md` for the sourcing + STEP→glТF + optimise pipeline.

Until a `.glb` exists for a type, the editor falls back to the procedural shape,
so you can add models one at a time.
