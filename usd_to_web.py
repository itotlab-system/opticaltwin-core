"""
usd_to_web.py  --  export a USD setup to glTF (.glb) for the web viewer
-----------------------------------------------------------------------
USD stays the source of truth; this writes a *derived* web-native file that any
browser can show (via web/viewer.html + Google's <model-viewer>). No install for
the end user -- just open a link.

It traverses the setup, reads each simple gprim (Cube / Cylinder / BasisCurves)
with its resolved world transform and display color, and builds a glb scene.
Breadboard mounting holes (a PointInstancer) are skipped to keep the file light.

Run:   python usd_to_web.py [setups/slm_imaging.usda ...]
       (no args -> exports every setups/*.usda)
Out:   web/<setup_name>.glb
"""

import os
import sys
import glob
import numpy as np
import trimesh
from trimesh import transformations as tf
from pxr import Usd, UsdGeom

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(ROOT_DIR, "web")
os.makedirs(WEB_DIR, exist_ok=True)

BEAM_RADIUS_MM = 1.5
OPTIC_CYLINDER_SECTIONS = 96


def gf_to_np(m):
    """Gf.Matrix4d (row-vector convention) -> numpy 4x4 (column-vector)."""
    a = np.array([[m[r][c] for c in range(4)] for r in range(4)], dtype=float)
    return a.T


def color_of(prim, default=(0.6, 0.6, 0.6)):
    attr = prim.GetAttribute("primvars:displayColor")
    c = attr.Get() if attr and attr.HasAuthoredValue() else None
    r, g, b = (c[0] if c else default)
    return [int(r * 255), int(g * 255), int(b * 255), 255]


def axis_align(axis_token):
    """Local rotation so a Z-aligned trimesh cylinder points along USD axis."""
    if axis_token == UsdGeom.Tokens.x:
        return tf.rotation_matrix(np.radians(90), [0, 1, 0])   # Z -> X
    if axis_token == UsdGeom.Tokens.y:
        return tf.rotation_matrix(np.radians(-90), [1, 0, 0])  # Z -> Y
    return np.eye(4)


def convert(setup_path, out_path=None):
    stage = Usd.Stage.Open(setup_path)
    xcache = UsdGeom.XformCache()
    scene = trimesh.Scene()

    for prim in stage.Traverse():
        path = str(prim.GetPath())
        if "/Holes" in path:          # skip the breadboard hole instancer
            continue
        world = gf_to_np(xcache.GetLocalToWorldTransform(prim))
        mesh = None

        if prim.IsA(UsdGeom.Cube):
            size = UsdGeom.Cube(prim).GetSizeAttr().Get() or 1.0
            mesh = trimesh.creation.box(extents=[size, size, size])
            mesh.apply_transform(world)

        elif prim.IsA(UsdGeom.Cylinder):
            cyl = UsdGeom.Cylinder(prim)
            r = cyl.GetRadiusAttr().Get()
            h = cyl.GetHeightAttr().Get()
            ax = cyl.GetAxisAttr().Get()
            mesh = trimesh.creation.cylinder(
                radius=r,
                height=h,
                sections=OPTIC_CYLINDER_SECTIONS,
                transform=axis_align(ax),
            )
            mesh.apply_transform(world)

        elif prim.IsA(UsdGeom.Sphere):
            sphere = UsdGeom.Sphere(prim)
            radius = sphere.GetRadiusAttr().Get() or 1.0
            mesh = trimesh.creation.icosphere(subdivisions=2, radius=radius)
            mesh.apply_transform(world)

        elif prim.IsA(UsdGeom.BasisCurves):
            crv = UsdGeom.BasisCurves(prim)
            pts = [world @ np.array([p[0], p[1], p[2], 1.0])
                   for p in crv.GetPointsAttr().Get()]
            counts = crv.GetCurveVertexCountsAttr().Get() or []
            col = color_of(prim, (1.0, 0.1, 0.1))
            i = 0
            for n in counts:
                for k in range(i, i + n - 1):
                    seg = trimesh.creation.cylinder(
                        radius=BEAM_RADIUS_MM,
                        segment=[pts[k][:3], pts[k + 1][:3]])
                    seg.visual.face_colors = col
                    scene.add_geometry(seg)
                i += n
            continue

        if mesh is not None:
            mesh.visual.face_colors = color_of(prim)
            scene.add_geometry(mesh)

    # USD is Z-up; glTF is Y-up. Rotate the whole scene so it sits upright in
    # any web 3D engine (Three.js / model-viewer).
    scene.apply_transform(tf.rotation_matrix(np.radians(-90), [1, 0, 0]))

    if out_path is None:
        name = os.path.splitext(os.path.basename(setup_path))[0]
        out_path = os.path.join(WEB_DIR, f"{name}.glb")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    scene.export(out_path)
    tris = sum(len(g.faces) for g in scene.geometry.values())
    print(f"  {setup_path} -> {out_path}  ({len(scene.geometry)} meshes, {tris} tris)")
    return out_path


def main(argv):
    setups = argv[1:] or sorted(glob.glob(os.path.join(ROOT_DIR, "setups", "*.usda")))
    if not setups:
        print("No setups found. Run a setup script first.")
        return
    print("Exporting USD -> glb:")
    for s in setups:
        convert(s)


if __name__ == "__main__":
    main(sys.argv)
