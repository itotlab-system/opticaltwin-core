# Component models — sourcing & conversion guide

How to turn the placeholder primitives into realistic component models, like the
reference render (cage rods, lens tubes, the Sony body, the Meade eyepiece).

The editor renders each part **procedurally** by default. When a real model
exists for a component **type**, it loads that instead (see
`app/src/scene/models.ts` + `app/public/models/`). The web needs **glTF binary
(`.glb`)** — Three.js loads it natively. So whatever the source, the end product
is a small, optimised `.glb`.

```
  source model        →   glTF (.glb)      →   optimise        →   app/public/models/
  (STEP / Blender /        (export)            (decimate +          + register in
   downloaded)                                  Draco compress)      models.ts
```

---

## 1. Where to get the source model (easiest first)

| Part | Best source |
|------|-------------|
| Optomechanics (mounts, cage, posts, lens tubes) | **Thorlabs** product page → *Download* → **STEP** (most parts have CAD) |
| Lenses / mirrors / beamsplitter | Thorlabs/Newport STEP, or a simple Blender model (they're basic shapes) |
| **Sony α camera body** | GrabCAD / Sketchfab / manufacturer (search "Sony A7 3D model glb") |
| **Meade 21 mm eyepiece** | GrabCAD / Sketchfab, or model the barrel in Blender |
| SLM (Thorlabs Exulus etc.) | Thorlabs STEP for the exact model |

Check the licence on downloaded models (most CAD-for-visualisation is fine for
internal lab use; redistribution may differ).

## 2. Convert to glTF

**Option A — Blender (recommended; also your optimiser):**
1. Install the free **STEP/CAD importer** (Blender 4.x: enable *Import-Export:
   STEP* add-on, or use the *CAD Sketcher* / *STEPper* add-ons; FreeCAD route below
   is a fallback).
2. `File → Import → STEP` (or open a downloaded `.blend`/`.fbx`/`.obj`).
3. Set scene units to **millimetres**; place the part centred at the origin with
   its **optical axis along +X** (or fix later via `rot` in `models.ts`).
4. `File → Export → glTF 2.0 (.glb)`, **Format: glb**, include only the meshes.

**Option B — FreeCAD (STEP → glTF), free, scriptable:**
- Open the STEP, then `File → Export → glTF (*.glb)`. Then optimise (step 3).

## 3. Optimise for the web (important)

Vendor CAD is often **millions** of triangles — too heavy for a browser. Reduce it:
- In Blender: add a **Decimate** modifier (Collapse ~0.1–0.3) per object; aim for
  **< ~50k triangles** total per part.
- Compress: run **gltf-transform** (Node tool) for Draco + dedup:
  ```bash
  npx @gltf-transform/cli optimize in.glb out.glb --compress draco
  ```
- Sanity-check file size: aim for **< ~1–2 MB** per part.

## 4. Drop it in and register

1. Put the file in `app/public/models/`, named by type, e.g. `camera.glb`.
2. Add an entry in `app/src/scene/models.ts`:
   ```ts
   camera: { url: "/models/camera.glb", scale: 1, rot: [0, 0, 0] },
   ```
3. Refresh the editor — that component type now renders the real model
   (still selectable + draggable). Tune `scale`/`rot` if it's the wrong
   size/orientation (model should be mm, aperture facing +X).

Add parts **one at a time**, starting with the most visible (camera, eyepiece,
lenses). Anything without a `.glb` keeps the procedural look, so the app always
works.

---

## Notes
- USD stays the source of truth for **layout** (positions/attributes). These
  `.glb` models are **presentation assets** for the web client only.
- Keep `.glb` files in git only if they're small; large ones are better stored
  via Git LFS or fetched from a known location. (Currently `app/public/models/`
  is tracked — revisit if models get large.)
