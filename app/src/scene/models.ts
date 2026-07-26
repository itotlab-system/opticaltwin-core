// Real 3D models per component type. When a type has an entry here, the editor
// loads the .glb instead of drawing the procedural primitive — see Component3D.
//
// To add a model: drop a file in app/public/models/, then add an entry below.
// `scale` (mm→mm fudge) and `rot` (radians, applied before the part's own rotZ)
// let you line a vendor model up with our convention (clear aperture facing +X).
// See docs/dev/ASSETS.md for how to source and convert models.

export interface ModelDef {
  url: string;
  scale?: number;
  rot?: [number, number, number];
}

export const MODELS: Record<string, ModelDef> = {
  // examples — uncomment once the files exist in app/public/models/:
  // camera:   { url: "/models/camera.glb",   scale: 1, rot: [0, 0, 0] },
  // eyepiece: { url: "/models/eyepiece.glb", scale: 1, rot: [0, 0, 0] },
  // lens:     { url: "/models/lens.glb",     scale: 1, rot: [0, 0, 0] },
};
