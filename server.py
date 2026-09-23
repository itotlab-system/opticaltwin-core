"""
server.py  --  local web editor for optical-setup projects
-----------------------------------------------------------
A small Flask backend that lets a team open a project in the browser, move
components by exact distance, add/remove parts, and SAVE -- with USD as the
source of truth. Every edit is written straight back to projects/<name>/setup.usda
and the 3D view is regenerated. Run it locally; sync projects via git.

Run:  python server.py        # then open http://localhost:8000/
"""

import os
import re
import json
import math
import gzip
import hmac
import functools
import secrets
import threading
from flask import Flask, jsonify, request, send_from_directory, abort, session
from pxr import Usd, UsdGeom, Gf, Sdf

import optics_lib as ol
import usd_to_web
import templates as tpl
import setup_projects
import usd_utility as uu
import beam_tracer

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECTS_DIR = os.path.join(ROOT_DIR, "projects")
LIB_DIR = os.path.join(ROOT_DIR, "components")
WEB_DIR = os.path.join(ROOT_DIR, "web")
BUILD_DIR = os.path.join(WEB_DIR, "_build")        # generated glbs (gitignored)
Z_MAX_MM = 300.0        # component height ceiling; mirrors the app's drag limit
os.makedirs(BUILD_DIR, exist_ok=True)
_CAD_CATALOG_SYNC_LOCK = threading.Lock()
_ROD_SHOULDER_CACHE = {}


def _sync_cad_catalog_group(
    cad_directory,
    group_name,
    component_type,
    source_forward_axis,
):
    """Generate missing or stale nested assets for one CAD catalogue group."""
    if not os.path.isdir(cad_directory):
        return
    with _CAD_CATALOG_SYNC_LOCK:
        stale_steps = []
        for filename in sorted(os.listdir(cad_directory)):
            step_path = os.path.join(cad_directory, filename)
            stem, extension = os.path.splitext(filename)
            if (
                not os.path.isfile(step_path)
                or extension.lower() not in (".step", ".stp")
            ):
                continue
            component_dir = os.path.join(LIB_DIR, group_name, stem)
            outputs = [
                os.path.join(component_dir, "hi.usda"),
                os.path.join(component_dir, "lo.usda"),
            ]
            source_mtime = os.path.getmtime(step_path)
            if any(
                not os.path.isfile(output)
                or os.path.getmtime(output) < source_mtime
                for output in outputs
            ):
                stale_steps.append((step_path, stem))

        if not stale_steps:
            return
        import cad_importer

        for step_path, stem in stale_steps:
            source_axis = source_forward_axis
            extra_arguments = []
            if group_name == "Breadboard":
                extra_arguments = [
                    "--source-roll-deg", "90",
                    "--lo-proxy", "box",
                    "--color", "0.72", "0.74", "0.78",
                    "--lo-color", "0.72", "0.74", "0.78",
                    "--ignore-step-colors",
                    "--metalness", "1",
                    "--roughness", "1",
                ]
            elif group_name == "Cage" and stem.lower() == "lcp6x-step":
                source_axis = "+Z"
                extra_arguments = [
                    "--source-origin", "0", "0", "3",
                ]
            elif (
                group_name == "Polarizer"
                and stem.lower() == "lpvise100-a-step"
            ):
                source_axis = "+Z"
                extra_arguments = [
                    "--source-origin",
                    "1.5325228571327916",
                    "0.8399980422382267",
                    "-2.229373699137465",
                ]
            elif group_name == "Lens" and stem.lower() == "dlb-30-50pm":
                # AUTO reads the widest axis as the optical one, which for a
                # 30 mm biconvex disc is its diameter, not its thickness.
                source_axis = "+Y"
                extra_arguments = [
                    "--source-origin", "0", "-7.15", "0",
                    "--attr", "focalLength_mm=50",
                ]
            elif group_name == "Lens" and stem.lower() == "mvl7000-step":
                # An objective, not a bare element: no surface to fit a lens
                # primitive to, and its barrel is black rather than glass.
                extra_arguments = [
                    "--source-origin", "-33.36", "0", "0",
                    "--lo-proxy", "cylinder",
                    "--lo-color", "0.12", "0.12", "0.13",
                    "--attr", "barrelDiameter_mm=61.849",
                    "--attr", "sizeX_mm=173.044",
                    "--attr", "sizeY_mm=68.461",
                    "--attr", "sizeZ_mm=61.849",
                    "--attr", "centerX_mm=0.003",
                    "--attr", "centerY_mm=3.306",
                    "--attr", "centerZ_mm=0",
                    "--attr", "mount=C",
                ]
                source_axis = "+X"
            elif group_name == "Lens" and stem.lower() == "mvl12m23-step":
                # Same family as MVL7000: a C-mount objective, so a cylinder
                # proxy and a black barrel rather than a glass disc. The STEP
                # already sits on its optical axis with the C-mount thread at
                # +X, which is the end that faces the sensor/DMD.
                source_axis = "+X"
                extra_arguments = [
                    "--lo-proxy", "cylinder",
                    # The STEP carries no face colors, so hi would fall back to
                    # the glass-blue default on what is an anodized black
                    # barrel. 0.051269 is the black the cage plates, post
                    # holders and iris already read out of their own STEP
                    # files; no metalness/roughness, so it lands on the
                    # viewport's matte default like they do.
                    "--ignore-step-colors",
                    "--color", "0.051269", "0.051269", "0.051269",
                    "--lo-color", "0.051269", "0.051269", "0.051269",
                    "--attr", "barrelDiameter_mm=38.24",
                    "--attr", "focalLength_mm=12",
                    "--attr", "mount=C",
                ]
            elif group_name == "Lens" and stem.lower() == "mvl12m1-step":
                # The 1" format sibling of the MVL12M23 above: same C-mount
                # objective treatment, same anodized black, thread at +X. Its
                # STEP is authored 40.894 mm off its own origin along the
                # optical axis, so unlike the MVL12M23 it needs recentering --
                # otherwise the whole barrel draws behind wherever it is
                # placed.
                source_axis = "+X"
                extra_arguments = [
                    "--source-origin", "-40.894", "0", "0",
                    "--lo-proxy", "cylinder",
                    "--ignore-step-colors",
                    "--color", "0.051269", "0.051269", "0.051269",
                    "--lo-color", "0.051269", "0.051269", "0.051269",
                    "--attr", "barrelDiameter_mm=44.61",
                    "--attr", "focalLength_mm=12",
                    "--attr", "mount=C",
                ]
            elif group_name == "SLM" and stem.lower() == "s440c-step":
                # Origin on the front face so the modulating plane, not the
                # middle of the board, is what gets positioned -- the same
                # convention the Exulus panel follows.
                source_axis = "-Z"
                extra_arguments = [
                    "--source-origin", "5.10", "7.69", "20.14",
                    "--attr", "activeWidth_mm=14.0",
                    "--attr", "activeHeight_mm=10.5",
                    "--attr", "reflective=1",
                    "--attr", "slmKind=DMD",
                ]
            elif group_name == "LED" and stem.lower() == "ledw7e-step":
                # Emission leaves the dome, which sits at the +X end of the
                # envelope once the leads trailing behind it are included.
                source_axis = "+Y"
                extra_arguments = [
                    "--source-origin", "0", "-9.2", "0",
                    "--attr", "wavelength_nm=0",
                    "--attr", "color=white",
                    "--attr", "emissionOffset_mm=17.8",
                    "--attr", "emissionCenterY_mm=0",
                    "--attr", "emissionCenterZ_mm=0",
                    "--attr", "beamBehavior=emit",
                ]
            elif group_name == "Mount" and stem.lower() == "lmr30_m-step":
                # Origin on the bore axis at mid-thickness, and rolled so the
                # mounting tab hangs below the optic where its post goes.
                extra_arguments = [
                    "--source-origin", "0", "0", "-5.08",
                    "--source-roll-deg", "90",
                    # A mount blocks the beam everywhere except its authored
                    # aperture, so the ring's ø30.1 bore has to be declared or
                    # the ray stops at the front face.
                    "--attr", "beamApertureRadius_mm=15.05",
                ]
            elif group_name == "Mount" and stem.lower() == "mlh7_m-step":
                # Mini-series fixed lens mount for a 6.35 mm optic. Same
                # treatment as the LMR30 above -- origin on the bore axis at
                # mid-thickness, rolled so the M3 tapped hole in its base
                # points down at the post -- but its STEP puts that axis at
                # (0.4159, 12.2563), not the origin, so it has to be named.
                extra_arguments = [
                    "--source-origin",
                    "0.415913", "12.256343", "11.760101",
                    "--source-roll-deg", "90",
                    # Black anodized, like the cage plates and post holders it
                    # sits among: the mount default of 0.9 renders it as
                    # chrome. Roughness stays at the mount default of 0.08,
                    # which is what LCP33B pairs with a matte metalness.
                    "--metalness", "0",
                    # --color, not --lo-color: a mount's lo is a decimated
                    # mesh rather than a proxy, and --lo-color is only applied
                    # on the proxy path, which is why the LMR30 beside it is
                    # still glass-blue in lo. Only lo is repainted -- hi reads
                    # the STEP's own face colors, and this is just the
                    # fallback for faces that have none.
                    "--color", "0.051269", "0.051269", "0.051269",
                    # The narrowest of its five bores -- the ø5.842 through
                    # hole -- is what actually passes the beam.
                    "--attr", "beamApertureRadius_mm=2.921",
                ]
            elif group_name == "Detector" and stem.lower() == "det100a2-step":
                # Origin on the SM1 input aperture rather than the middle of
                # the housing, so the beam stops where the light enters.
                source_axis = "+Z"
                extra_arguments = [
                    "--source-origin", "0", "0", "-22.15",
                    "--source-roll-deg", "90",
                    "--attr", "sensorWidth_mm=11.3",
                    "--attr", "sensorHeight_mm=11.3",
                    "--attr", "apertureDiameter_mm=26.3",
                    "--attr", "beamBehavior=block",
                ]
            cad_importer.main([
                step_path,
                "--type", component_type,
                "--lod", "both",
                "--component-name", f"{group_name}/{stem}",
                # "=" rather than a separate element: argparse reads a bare
                # "-Z" as an unknown option, not as this option's value.
                f"--source-forward-axis={source_axis}",
                *extra_arguments,
            ])


def _sync_cad_catalog():
    """Synchronize every element category authored under cad/."""
    groups = (
        ("Breadboard", "breadboard", "+X"),
        ("Beam Splitter", "beamsplitter", "AUTO"),
        ("Cage", "mount", "AUTO"),
        ("Detector", "detector", "+Z"),
        ("Holder", "holder", "AUTO"),
        ("Iris", "iris", "AUTO"),
        ("LED", "led", "+Y"),
        ("Laser", "laser", "AUTO"),
        ("Lens", "lens", "AUTO"),
        ("Mirror", "mirror", "AUTO"),
        ("Mount", "mount", "+Z"),
        ("Polarizer", "polarizer", "+Z"),
        ("Post", "post", "AUTO"),
        ("Rod", "rod", "+Y"),
        ("SLM", "slm", "AUTO"),
    )
    for group_name, component_type, source_axis in groups:
        _sync_cad_catalog_group(
            os.path.join(ROOT_DIR, "cad", group_name),
            group_name,
            component_type,
            source_axis,
        )

# New projects only offer an empty breadboard, or a clone of project1's
# *current* 4f setup, for now (see #88): the demo templates (slm_imaging/
# two_lens) bake a static beam path that goes stale as soon as components
# move. tpl.TEMPLATES itself is untouched so existing tooling
# (setup_projects.py) keeps working. setup_projects.CLONE_TEMPLATES supplies
# the "4f_default" option, which is built by copying project1/setup.usda
# rather than replaying the buggy recipe.
NEW_PROJECT_TEMPLATE_KEYS = ("blank",)
BOARD_MODEL_ORDER = (
    "Breadboard/MB6060_M-Step.usda",
    "Breadboard/MB6090_M-Step.usda",
    "Breadboard/MB60120_M-Step.usda",
    "Breadboard/MB7575_M-Step.usda",
)

app = Flask(__name__)
SAFE = re.compile(r"^[A-Za-z0-9_\-]+$")             # guard path params

# Shared-password login. Set OT_PASSWORD to require a login; leaving it unset
# leaves the server open, which is only safe on a trusted network. Never put a
# real password here as a default -- this file is meant to be publishable.
AUTH_PASSWORD = os.environ.get("OT_PASSWORD", "")
app.secret_key = os.environ.get("OT_SESSION_SECRET") or secrets.token_hex(32)


@app.get("/api/auth/status")
def auth_status():
    return jsonify(
        required=bool(AUTH_PASSWORD),
        authenticated=not AUTH_PASSWORD or bool(session.get("authenticated")),
    )


@app.post("/api/auth/login")
def login():
    if not AUTH_PASSWORD:
        return jsonify(ok=True)
    password = (request.get_json(silent=True) or {}).get("password", "")
    if hmac.compare_digest(str(password), AUTH_PASSWORD):
        session["authenticated"] = True
        return jsonify(ok=True)
    # `code` is the machine-readable form; the client picks the message in the
    # user's own language. `error` stays for anything reading the old shape.
    return jsonify(
        ok=False, code="invalid_password", error="パスワードが違います。"
    ), 401


@app.post("/api/auth/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.before_request
def require_login():
    if (
        not AUTH_PASSWORD
        or request.method == "OPTIONS"
        or request.path.startswith("/api/auth/")
    ):
        return None
    if not session.get("authenticated"):
        if request.path.startswith(("/api/", "/model/")):
            return jsonify(error="Login required."), 401
    return None


@app.after_request
def cors(resp):
    """Allow the Vite dev server (:5173) to call this API during development."""
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    if request.path.startswith("/api/") and not request.path.startswith(
        "/api/library/photo/"
    ):
        # Scene geometry changes frequently while editing. Never let a browser
        # reuse beam data calculated before a component move or server reload.
        # Catalogue photos are the exception: they are static files whose URL
        # carries the file's mtime, so they are safe (and worth) caching.
        resp.headers["Cache-Control"] = "no-store"
    return resp


def project_setup(name):
    if not SAFE.match(name):
        abort(400, "bad project name")
    path = os.path.join(PROJECTS_DIR, name, "setup.usda")
    if not os.path.exists(path):
        abort(404, "no such project")
    uu.normalize_component_references_in_usda(path)
    uu.ensure_fixed_breadboard_reference(path)
    return path


def _component_prims(stage, include_fixed=False):
    """Top-level placed components = prims that carry an optics:type."""
    out = []
    for prim in stage.Traverse():
        t = prim.GetAttribute("optics:type")
        fixed = prim.GetAttribute("optics:fixedBoard")
        is_fixed = bool(fixed and fixed.HasAuthoredValue() and fixed.Get())
        if (
            t and t.HasAuthoredValue()
            and prim.GetParent() == stage.GetDefaultPrim()
            and (include_fixed or not is_fixed)
        ):
            out.append(prim)
    return out


def _optics_attrs(prim):
    """All authored optics:* attributes on a component, for the Inspector / render."""
    out = {}
    for attr in prim.GetAttributes():
        n = attr.GetName()
        if n.startswith("optics:") and attr.HasAuthoredValue():
            out[n[len("optics:"):]] = attr.Get()
    return out


def _inherited_material_value(prim, component_prim, name):
    """Read the closest optics material override within a component subtree."""
    current = prim
    while current.IsValid():
        attr = current.GetAttribute(f"optics:{name}")
        if attr and attr.HasAuthoredValue():
            return float(attr.Get())
        if current == component_prim:
            break
        current = current.GetParent()
    return None


def _component_meshes(stage, component_prim):
    """Serialize referenced UsdGeom.Mesh geometry in component-local space."""
    meshes = []
    xcache = UsdGeom.XformCache()
    component_to_world = xcache.GetLocalToWorldTransform(component_prim)
    world_to_component = component_to_world.GetInverse()

    for prim in Usd.PrimRange(component_prim):
        if not prim.IsA(UsdGeom.Mesh):
            continue

        usd_mesh = UsdGeom.Mesh(prim)
        points = usd_mesh.GetPointsAttr().Get() or []
        counts = usd_mesh.GetFaceVertexCountsAttr().Get() or []
        face_indices = usd_mesh.GetFaceVertexIndicesAttr().Get() or []
        if not points or not counts or not face_indices:
            continue

        mesh_to_world = xcache.GetLocalToWorldTransform(prim)
        local_points = []
        for point in points:
            world_point = mesh_to_world.Transform(Gf.Vec3d(*point))
            local_point = world_to_component.Transform(world_point)
            local_points.append([
                round(float(local_point[0]), 6),
                round(float(local_point[1]), 6),
                round(float(local_point[2]), 6),
            ])

        # Three.js consumes triangle indices. Triangulate any polygonal USD
        # faces with a fan while preserving the authored winding order.
        triangles = []
        offset = 0
        for count in counts:
            count = int(count)
            face = face_indices[offset:offset + count]
            for i in range(1, count - 1):
                triangles.extend([int(face[0]), int(face[i]), int(face[i + 1])])
            offset += count

        display_color = usd_mesh.GetDisplayColorAttr().Get() or [(0.6, 0.7, 0.8)]
        display_opacity = usd_mesh.GetDisplayOpacityAttr().Get() or [1.0]
        color = display_color[0]
        mesh_data = {
            "points": local_points,
            "indices": triangles,
            "color": [float(color[0]), float(color[1]), float(color[2])],
            "opacity": float(display_opacity[0]),
            "doubleSided": bool(usd_mesh.GetDoubleSidedAttr().Get()),
        }
        for material_name in ("metalness", "roughness"):
            value = _inherited_material_value(
                prim, component_prim, material_name
            )
            if value is not None:
                mesh_data[material_name] = value
        meshes.append(mesh_data)

    return meshes


def _component_primitives(stage, component_prim):
    """Serialize analytic USD shapes without converting the source to Mesh."""
    primitives = []
    xcache = UsdGeom.XformCache()
    component_to_world = xcache.GetLocalToWorldTransform(component_prim)
    world_to_component = component_to_world.GetInverse()

    for prim in Usd.PrimRange(component_prim):
        primitive = None
        if prim.IsA(UsdGeom.Cube):
            cube = UsdGeom.Cube(prim)
            primitive = {
                "kind": "cube",
                "size": float(cube.GetSizeAttr().Get() or 1.0),
            }
        elif prim.IsA(UsdGeom.Cylinder):
            cylinder = UsdGeom.Cylinder(prim)
            primitive = {
                "kind": "cylinder",
                "radius": float(cylinder.GetRadiusAttr().Get() or 1.0),
                "height": float(cylinder.GetHeightAttr().Get() or 2.0),
                "axis": str(
                    cylinder.GetAxisAttr().Get() or UsdGeom.Tokens.z
                ),
            }
            cap_side = prim.GetAttribute("optics:capSide")
            if cap_side and cap_side.HasAuthoredValue():
                primitive["capSide"] = str(cap_side.Get())
        elif prim.IsA(UsdGeom.Sphere):
            sphere = UsdGeom.Sphere(prim)
            primitive = {
                "kind": "sphere",
                "radius": float(sphere.GetRadiusAttr().Get() or 1.0),
            }
            sphere_portion = prim.GetAttribute("optics:spherePortion")
            if sphere_portion and sphere_portion.HasAuthoredValue():
                primitive["spherePortion"] = str(sphere_portion.Get())
        if primitive is None:
            continue

        primitive_to_world = xcache.GetLocalToWorldTransform(prim)
        primitive_to_component = primitive_to_world * world_to_component
        # Gf uses row-vector matrices. Flattening rows directly produces the
        # column-major element order consumed by THREE.Matrix4.fromArray().
        primitive["matrix"] = [
            round(float(primitive_to_component[row][column]), 9)
            for row in range(4)
            for column in range(4)
        ]
        gprim = UsdGeom.Gprim(prim)
        display_color = (
            gprim.GetDisplayColorAttr().Get() or [(0.6, 0.7, 0.8)]
        )
        display_opacity = gprim.GetDisplayOpacityAttr().Get() or [1.0]
        color = display_color[0]
        primitive.update({
            "color": [
                float(color[0]),
                float(color[1]),
                float(color[2]),
            ],
            "opacity": float(display_opacity[0]),
            "doubleSided": bool(gprim.GetDoubleSidedAttr().Get()),
        })
        for material_name in ("metalness", "roughness"):
            value = _inherited_material_value(
                prim, component_prim, material_name
            )
            if value is not None:
                primitive[material_name] = value
        primitives.append(primitive)

    return primitives


def _rod_thread_shoulder_offsets(component_prim):
    """Return the two X positions where a Rod's threads meet CADMesh_001.

    Rod hi assets are split into a central body (CADMesh_001), inner thread
    sections (CADMesh_002/004), and outer thread sections (003/005).  Reading
    the inner sections also works when CADMesh_001 is hidden for inspection.
    """
    if component_prim.GetName() != "Rod":
        return None

    positive = component_prim.GetChild("CADMesh_002")
    negative = component_prim.GetChild("CADMesh_004")
    if not positive.IsValid() or not negative.IsValid():
        return None

    positive_extent = UsdGeom.Mesh(positive).GetExtentAttr().Get()
    negative_extent = UsdGeom.Mesh(negative).GetExtentAttr().Get()
    if not positive_extent or not negative_extent:
        return None

    return {
        "rodShoulderMinX_mm": float(negative_extent[1][0]),
        "rodShoulderMaxX_mm": float(positive_extent[0][0]),
    }


def _rod_asset_shoulder_offsets(asset):
    """Read stable Rod alignment metadata for both render modes."""
    if not asset or not asset.lower().startswith("rod/"):
        return None
    component_name = uu.get_component_name(asset)
    path = uu.get_component_usda_path(LIB_DIR, component_name, "hi")
    if not os.path.isfile(path):
        return None
    lo_path = uu.get_component_usda_path(LIB_DIR, component_name, "lo")
    modified = (
        os.path.getmtime(path),
        os.path.getmtime(lo_path) if os.path.isfile(lo_path) else None,
    )
    cached = _ROD_SHOULDER_CACHE.get(path)
    if cached and cached[0] == modified:
        return cached[1]
    stage = Usd.Stage.Open(path)
    result = (
        _rod_thread_shoulder_offsets(stage.GetDefaultPrim())
        if stage is not None and stage.GetDefaultPrim().IsValid()
        else None
    )
    if result and os.path.isfile(lo_path):
        lo_stage = Usd.Stage.Open(lo_path)
        if lo_stage is not None and lo_stage.GetDefaultPrim().IsValid():
            bounds = UsdGeom.BBoxCache(
                Usd.TimeCode.Default(), [UsdGeom.Tokens.default_]
            ).ComputeLocalBound(
                lo_stage.GetDefaultPrim()
            ).ComputeAlignedRange()
            result.update({
                "rodLoEndMinX_mm": float(bounds.GetMin()[0]),
                "rodLoEndMaxX_mm": float(bounds.GetMax()[0]),
            })
    _ROD_SHOULDER_CACHE[path] = (modified, result)
    return result


def _component_model_pose(stage, component_prim):
    """Return asset-authored rotations and the geometry center they pivot on.

    Project placement transforms live on the referencing prim and are handled
    separately by ``x/y/z/rotZ``.  These values come from the component asset
    itself, so editing xformOp:rotateX/Y/Z in hi.usda or lo.usda changes the
    model orientation without moving its optical center in the viewport.
    """
    rotations = []
    for axis in ("X", "Y", "Z"):
        attr = component_prim.GetAttribute(f"xformOp:rotate{axis}")
        rotations.append(
            float(attr.Get() or 0.0)
            if attr and attr.HasAuthoredValue()
            else 0.0
        )

    authored_center = []
    for axis in ("X", "Y", "Z"):
        attr = component_prim.GetAttribute(
            f"optics:rotationCenter{axis}_mm"
        )
        authored_center.append(
            float(attr.Get())
            if attr and attr.HasAuthoredValue()
            else None
        )
    if all(value is not None for value in authored_center):
        center = [round(value, 6) for value in authored_center]
    else:
        bbox = UsdGeom.BBoxCache(
            Usd.TimeCode.Default(), [UsdGeom.Tokens.default_]
        ).ComputeLocalBound(component_prim)
        aligned = bbox.ComputeAlignedRange()
        minimum = aligned.GetMin()
        maximum = aligned.GetMax()
        center = [
            round(float((minimum[index] + maximum[index]) / 2.0), 6)
            for index in range(3)
        ]
    return {
        "modelRotation": [round(value, 6) for value in rotations],
        "rotationCenter": center,
    }


def _component_asset_name(component_prim):
    """Return the catalogue asset that contributes this referenced prim."""
    library_root = os.path.realpath(LIB_DIR)
    for spec in component_prim.GetPrimStack():
        identifier = spec.layer.realPath or spec.layer.identifier
        if not identifier:
            continue
        path = os.path.realpath(identifier)
        try:
            if os.path.commonpath((library_root, path)) != library_root:
                continue
        except ValueError:
            continue
        if os.path.basename(path) not in ("hi.usda", "lo.usda"):
            continue
        component_path = os.path.relpath(
            os.path.dirname(path),
            library_root,
        ).replace(os.sep, "/")
        return f"{component_path}.usda"
    return None


def _beam_physics_metadata(component):
    """Derive ray-tracing dimensions from the actual serialized USD asset."""
    attrs = component.get("attrs", {})
    result = {}

    if component.get("type") in beam_tracer.EMITTER_TYPES:
        # Prefer an explicitly detected output-aperture center. Fall back to
        # the positive-X CAD envelope for older laser assets.
        emission_offset = attrs.get("emissionOffset_mm")
        size_x = attrs.get("sizeX_mm")
        if emission_offset is not None:
            result["emissionOffset_mm"] = float(emission_offset)
        elif size_x is not None:
            result["emissionOffset_mm"] = float(size_x) / 2.0
        else:
            result["emissionOffset_mm"] = LASER_APERTURE_OFFSET_MM
        for key in ("emissionCenterY_mm", "emissionCenterZ_mm"):
            if attrs.get(key) is not None:
                result[key] = float(attrs[key])

    # CAD optical plates are commonly represented by a transparent mesh. Its
    # local-space bounds are more reliable than a generic 1-inch fallback.
    optical_points = [
        point
        for mesh in component.get("meshes", [])
        if float(mesh.get("opacity", 1.0)) < 1.0
        for point in mesh.get("points", [])
    ]
    if optical_points:
        ys = [float(point[1]) for point in optical_points]
        zs = [float(point[2]) for point in optical_points]
        result.update({
            "activeCenterY_mm": (min(ys) + max(ys)) / 2.0,
            "activeCenterZ_mm": (min(zs) + max(zs)) / 2.0,
            "activeHalfY_mm": (max(ys) - min(ys)) / 2.0,
            "activeHalfZ_mm": (max(zs) - min(zs)) / 2.0,
        })
    return result


# (catalogue key, previews). Replaced as one tuple rather than mutated field by
# field: the server is threaded, and a half-updated cache would hand a request
# the new key with the old geometry.
_PREVIEW_CACHE = (None, {})


def _library_preview_key():
    """Identity of the catalogue on disk: every preview asset and its mtime.

    ~100 stat calls, well under a millisecond, versus the ~67 ms of USD reads
    the previews themselves cost. A newly imported CAD part changes the key, so
    the catalogue never goes stale behind the cache. A photo dropped beside an
    asset changes it too, so the browser's tile switches to the photograph
    without a server restart.
    """
    key = []
    for asset in sorted(ol.component_library_assets(LIB_DIR)):
        component_name = uu.get_component_name(asset)
        path = uu.get_component_usda_path(LIB_DIR, component_name)
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            mtime = None
        key.append((asset, mtime, _library_photo_mtime(component_name)))
    return tuple(key)


# A real photograph of the part, dropped into its catalogue folder by hand.
# Optional everywhere: without one the part browser renders its CAD geometry,
# which is what the bench will show anyway.
LIBRARY_PHOTO_NAMES = ("preview.png", "preview.jpg", "preview.jpeg", "preview.webp")


def _library_photo_path(component_name):
    """Path of the photo shipped beside a catalogue asset, or None."""
    directory = os.path.join(LIB_DIR, *component_name.split("/"))
    for filename in LIBRARY_PHOTO_NAMES:
        path = os.path.join(directory, filename)
        if os.path.isfile(path):
            return path
    return None


def _library_photo_mtime(component_name):
    path = _library_photo_path(component_name)
    try:
        return os.path.getmtime(path) if path else None
    except OSError:
        return None


def _library_previews():
    """CAD catalogue geometry used by the placement ghost before insertion.

    Cached: this is the same for every project and changes only when the
    catalogue does, but it was rebuilt on every request — including every
    component move.
    """
    global _PREVIEW_CACHE

    key = _library_preview_key()
    cached_key, previews = _PREVIEW_CACHE
    if cached_key == key:
        return previews

    previews = _build_library_previews()
    _PREVIEW_CACHE = (key, previews)
    return previews


def _build_library_previews():
    previews = {}
    for asset in sorted(ol.component_library_assets(LIB_DIR)):
        component = _build_library_preview(asset)
        if component is not None:
            previews[asset] = component
    return previews


def _asset_base_offset_mm(stage, root):
    """How far a freshly placed part must be lifted to rest ON the board.

    Posts and holders are modelled with their origin at the mounting foot, so
    they already sit on the breadboard at the placement z.  A lens, an iris or
    a camera is modelled about its optical centre, and dropping one at the
    board top buries half of it inside the board.  The lift is measured from
    the geometry the client actually draws -- the model pose about
    ``rotationCenter``, plus ``geometryOffset`` -- so the placement ghost and
    the part that lands can use the same number.

    This moves no origin: it is a one-off translate chosen when the part is
    inserted, so zoom framing, grouping and the gizmo centre keep reading the
    authored origin they always have.  It only ever lifts -- an asset whose
    geometry sits above its origin keeps the convention it was authored with.
    """
    # Untransformed, because the meshes shipped to the client are in
    # component-local space (`_component_meshes` divides out the asset's own
    # root op) and the client re-applies that op as `modelRotation` about
    # `rotationCenter`.  A composed bound would be the pose measured about the
    # wrong pivot.
    bounds = UsdGeom.BBoxCache(
        Usd.TimeCode.Default(), [UsdGeom.Tokens.default_]
    ).ComputeUntransformedBound(root).ComputeAlignedRange()
    if bounds.IsEmpty():
        return 0.0
    pose = _component_model_pose(stage, root)
    rot_x, rot_y, rot_z = pose["modelRotation"]
    cx, cy, cz = pose["rotationCenter"]
    offset_z = _authored_float(root, "optics:geometryOffsetZ_mm") or 0.0
    mn, mx = bounds.GetMin(), bounds.GetMax()
    lowest = cz + offset_z + min(
        _rotate_local_offset(x - cx, y - cy, z - cz, rot_x, rot_y, rot_z)[2]
        for x in (mn[0], mx[0])
        for y in (mn[1], mx[1])
        for z in (mn[2], mx[2])
    )
    return round(max(0.0, -lowest), 6)


def _library_base_offset_mm(asset):
    """The rest-on-the-board lift for one catalogue asset (0 when unknown)."""
    preview = _library_previews().get(asset) or {}
    return float(preview.get("baseOffsetZ") or 0.0)


def _build_library_preview(asset, render_mode="lo"):
    """One catalogue part, posed at the origin, as the client draws components.

    `render_mode` is "lo" for the payload-wide catalogue (the placement ghost
    only needs a silhouette) and "hi" for a single part fetched on demand by the
    part browser: a lo asset is a bounding-box stand-in, so every post holder
    would otherwise be the same anonymous block on its tile.
    """
    cad_assets = ol.cad_library_assets(LIB_DIR)
    component_name = uu.get_component_name(asset)
    path = uu.get_component_usda_path(LIB_DIR, component_name, render_mode)
    if not os.path.exists(path):
        path = uu.get_component_usda_path(LIB_DIR, component_name)
    stage = Usd.Stage.Open(path)
    if stage is None or not stage.GetDefaultPrim().IsValid():
        return None
    root = stage.GetDefaultPrim()
    cad_derived = asset in cad_assets
    component = {
        "name": component_name,
        "type": root.GetAttribute("optics:type").Get(),
        "x": 0,
        "y": 0,
        "z": 0,
        # All three rotations, not just rotZ: the client multiplies each by
        # DEG, and a missing one is NaN, which poisons the whole transform.
        "rotX": 0,
        "rotY": 0,
        "rotZ": 0,
        "attrs": _optics_attrs(root),
        "asset": asset,
        "cadDerived": cad_derived,
        "renderMode": render_mode,
    }
    photo_mtime = _library_photo_mtime(component_name)
    if photo_mtime is not None:
        # Cache-busted by mtime: replacing the file replaces the tile.
        component["photo"] = (
            f"/api/library/photo/{component_name}?v={int(photo_mtime)}"
        )
    # The hand-built Low_model parts are drawn procedurally by the client
    # from their `optics:` dims, so shipping their gprims would be dead
    # weight in a payload that already carries every CAD mesh.
    meshes = _component_meshes(stage, root) if cad_derived else []
    primitives = _component_primitives(stage, root) if cad_derived else []
    if meshes:
        component["meshes"] = meshes
    if primitives:
        component["primitives"] = primitives
    component.update(_component_model_pose(stage, root))
    component["baseOffsetZ"] = _asset_base_offset_mm(stage, root)
    component["physics"] = _beam_physics_metadata(component)
    return component


def _beam_segments(stage):
    """BasisCurves polylines → list of {pts, wavelength} dicts (world space)."""
    xcache = UsdGeom.XformCache()
    segs = []
    for prim in stage.Traverse():
        if prim.IsA(UsdGeom.BasisCurves):
            crv = UsdGeom.BasisCurves(prim)
            pts = crv.GetPointsAttr().Get() or []
            counts = crv.GetCurveVertexCountsAttr().Get() or [len(pts)]
            m = xcache.GetLocalToWorldTransform(prim)
            wpts = [m.Transform(Gf.Vec3d(p[0], p[1], p[2])) for p in pts]
            wl_attr = prim.GetAttribute("optics:beam:wavelength")
            wavelength = float(wl_attr.Get()) if wl_attr and wl_attr.HasAuthoredValue() else 532.0
            i = 0
            for n in counts:
                segs.append({
                    "pts": [[round(q[0], 2), round(q[1], 2), round(q[2], 2)]
                            for q in wpts[i:i + n]],
                    "wavelength": wavelength,
                })
                i += n
    return segs


LASER_APERTURE_OFFSET_MM = 43.0
LASER_EMISSION_LENGTH_MM = 10000.0


def _beam_node_ref(node):
    return node if isinstance(node, str) else node.get("ref", "")


def _component_wavelength(comp, default=532.0):
    wl = comp.get("attrs", {}).get("wavelength_nm", default)
    try:
        return float(wl)
    except (TypeError, ValueError):
        return default


def _component_local_axes(comp):
    """Local XYZ axes using the viewport's XYZ Euler convention."""
    rot_x = math.radians(float(comp.get("rotX", 0.0)))
    rot_y = math.radians(float(comp.get("rotY", 0.0)))
    rot_z = math.radians(float(comp.get("rotZ", 0.0)))
    sin_x, cos_x = math.sin(rot_x), math.cos(rot_x)
    sin_y, cos_y = math.sin(rot_y), math.cos(rot_y)
    sin_z, cos_z = math.sin(rot_z), math.cos(rot_z)
    return (
        [cos_z * cos_y, sin_z * cos_y, -sin_y],
        [
            cos_z * sin_y * sin_x - sin_z * cos_x,
            sin_z * sin_y * sin_x + cos_z * cos_x,
            cos_y * sin_x,
        ],
        [
            cos_z * sin_y * cos_x + sin_z * sin_x,
            sin_z * sin_y * cos_x - cos_z * sin_x,
            cos_y * cos_x,
        ],
    )


def _component_forward(comp):
    """Return the component's local +X direction."""
    return _component_local_axes(comp)[0]


def _component_beam_point(comp):
    """Return the optical centerline point for a component."""
    if comp.get("type") in beam_tracer.EMITTER_TYPES:
        physics = comp.get("physics", {})
        offset = float(
            physics.get("emissionOffset_mm", LASER_APERTURE_OFFSET_MM)
        )
        center_y = float(physics.get("emissionCenterY_mm", 0.0))
        center_z = float(physics.get("emissionCenterZ_mm", 0.0))
        x_axis, y_axis, z_axis = _component_local_axes(comp)
        return [
            float(comp["x"]) + x_axis[0] * offset
            + y_axis[0] * center_y + z_axis[0] * center_z,
            float(comp["y"]) + x_axis[1] * offset
            + y_axis[1] * center_y + z_axis[1] * center_z,
            float(comp["z"]) + x_axis[2] * offset
            + y_axis[2] * center_y + z_axis[2] * center_z,
        ]
    return [float(comp["x"]), float(comp["y"]), float(comp["z"])]


def _laser_emission_segment(comp):
    start = _component_beam_point(comp)
    direction = _component_forward(comp)
    end = [
        start[0] + direction[0] * LASER_EMISSION_LENGTH_MM,
        start[1] + direction[1] * LASER_EMISSION_LENGTH_MM,
        start[2] + direction[2] * LASER_EMISSION_LENGTH_MM,
    ]
    return {
        "pts": [[round(v, 2) for v in start], [round(v, 2) for v in end]],
        "wavelength": _component_wavelength(comp),
    }


def _laser_emission_segments(components_by_name, exclude_names=None):
    excluded = exclude_names or set()
    return [
        _laser_emission_segment(comp)
        for name, comp in components_by_name.items()
        if comp.get("type") in beam_tracer.EMITTER_TYPES and name not in excluded
    ]


def _project_point_to_line(point, start, end, clamp=True):
    """Project point onto the start->end line, optionally clamped to the segment."""
    vx, vy, vz = end[0] - start[0], end[1] - start[1], end[2] - start[2]
    denom = vx * vx + vy * vy + vz * vz
    if denom < 1e-8:
        return list(start)
    t = ((point[0] - start[0]) * vx +
         (point[1] - start[1]) * vy +
         (point[2] - start[2]) * vz) / denom
    if clamp:
        t = max(0.0, min(1.0, t))
    return [start[0] + t * vx, start[1] + t * vy, start[2] + t * vz]


def _resolve_beam_nodes(seg_nodes, components_by_name):
    """Resolve a raw beamPath segment to straight, world-space node records."""
    nodes = []
    for node in seg_nodes:
        name = _beam_node_ref(node)
        comp = components_by_name.get(name)
        if isinstance(node, dict) and "pin" in node:
            pos = [float(v) for v in node["pin"][:3]]
        elif comp:
            pos = _component_beam_point(comp)
        else:
            continue
        nodes.append({"ref": name, "comp": comp, "pos": pos})

    if len(nodes) < 2:
        return nodes

    start, end = nodes[0]["pos"], nodes[-1]["pos"]
    for node in nodes[1:-1]:
        node["pos"] = _project_point_to_line(node["pos"], start, end)
    return nodes


def _resolve_beam_path(stage, components_by_name):
    """Resolve optics:beamPath (component names / pins) → [{pts, wavelength}].

    Each node is either a plain component name (auto: use live position) or a
    dict {"ref": name, "pin": [x,y,z]} (override: use the stored coordinate).
    Intermediate nodes are projected onto each segment's start->end axis, so
    pass-through optics do not bend the rendered beam centerline.
    Returns the same shape as _beam_segments() so callers get one consistent format.
    """
    bp_attr = stage.GetDefaultPrim().GetAttribute("optics:beamPath")
    if not bp_attr or not bp_attr.HasAuthoredValue():
        return []
    raw_segs = json.loads(bp_attr.Get())

    # Read wavelength from the BasisCurves prim (same as _beam_segments picks up)
    wavelengths = []
    for prim in stage.Traverse():
        if prim.IsA(UsdGeom.BasisCurves):
            wl_attr = prim.GetAttribute("optics:beam:wavelength")
            wavelengths.append(
                float(wl_attr.Get()) if wl_attr and wl_attr.HasAuthoredValue() else 532.0)

    result = []
    for si, seg in enumerate(raw_segs):
        wl = wavelengths[si] if si < len(wavelengths) else 532.0
        nodes = _resolve_beam_nodes(seg, components_by_name)
        pts = [[round(v, 2) for v in node["pos"]] for node in nodes]
        if len(pts) >= 2:
            result.append({"pts": pts, "wavelength": wl})
    return result

def _breadboard_prims(stage):
    """Return the project's board cube and its hole instancer."""
    root = stage.GetDefaultPrim().GetPath()
    board_prim = stage.GetPrimAtPath(f"{root}/Breadboard")
    holes_prim = stage.GetPrimAtPath(f"{root}/Holes")
    board = (
        UsdGeom.Cube(board_prim)
        if board_prim and board_prim.IsA(UsdGeom.Cube)
        else None
    )
    holes = (
        UsdGeom.PointInstancer(holes_prim)
        if holes_prim and holes_prim.IsA(UsdGeom.PointInstancer)
        else None
    )
    return board, holes


def _authored_float(prim, name):
    """Read one authored numeric attribute, returning None when absent."""
    if not prim:
        return None
    attr = prim.GetAttribute(name)
    if not attr or not attr.HasAuthoredValue():
        return None
    value = attr.Get()
    return float(value) if value is not None else None


def _grid_spacing(positions):
    """Infer the physical grid pitch from legacy hole positions."""
    gaps = []
    for axis in (0, 1):
        values = sorted({round(float(p[axis]), 6) for p in positions})
        gaps.extend(
            b - a for a, b in zip(values, values[1:]) if b - a > 1e-6
        )
    return min(gaps) if gaps else float(ol.GRID_MM)


def _board(stage, model=None):
    """Breadboard extent, limits and physical hole grid.

    Older projects do not carry resize metadata. For those projects, the
    currently authored dimensions are exposed as their minimum dimensions;
    the metadata is persisted only when the board is first resized.
    """
    board, holes_instancer = _breadboard_prims(stage)
    fixed_prim = stage.GetPrimAtPath(
        f"{stage.GetDefaultPrim().GetPath()}/Breadboard"
    )
    positions = list(holes_instancer.GetPositionsAttr().Get() or []) \
        if holes_instancer else []
    holes = [
        [round(float(p[0]), 1), round(float(p[1]), 1)]
        for p in positions
    ]
    hole_top = float(positions[0][2]) if positions else None

    geometry_prim = board.GetPrim() if board else (
        fixed_prim if fixed_prim and fixed_prim.IsValid() else None
    )
    if not geometry_prim:
        return dict(
            holes=holes,
            holeZ=hole_top,
            bbox=None,
            sizeX=0.0,
            sizeY=0.0,
            minSizeX=0.0,
            minSizeY=0.0,
            spacing=float(ol.GRID_MM),
            centerX=0.0,
            centerY=0.0,
            extentXNegative=0.0,
            extentXPositive=0.0,
            extentYNegative=0.0,
            extentYPositive=0.0, model=model,
        )

    wb = UsdGeom.BBoxCache(
        Usd.TimeCode.Default(), [UsdGeom.Tokens.default_]
    ).ComputeWorldBound(geometry_prim)
    bounds = wb.ComputeAlignedRange()
    mn, mx = bounds.GetMin(), bounds.GetMax()
    size_x = float(mx[0] - mn[0])
    size_y = float(mx[1] - mn[1])
    board_prim = geometry_prim
    spacing = (
        _authored_float(board_prim, "optics:gridSpacing")
        or _grid_spacing(positions)
    )
    if not positions and model:
        nx = max(1, int(round(size_x / spacing)))
        ny = max(1, int(round(size_y / spacing)))
        x0 = -(nx - 1) * spacing / 2.0
        y0 = -(ny - 1) * spacing / 2.0
        holes = [
            [round(x0 + i * spacing, 1), round(y0 + j * spacing, 1)]
            for i in range(nx) for j in range(ny)
        ]
        hole_top = float(mx[2])
    min_size_x = (
        _authored_float(board_prim, "optics:minSizeX") or size_x
    )
    min_size_y = (
        _authored_float(board_prim, "optics:minSizeY") or size_y
    )
    bbox = dict(
        min=[round(float(mn[0]), 1), round(float(mn[1]), 1),
             round(float(mn[2]), 1)],
        max=[round(float(mx[0]), 1), round(float(mx[1]), 1),
             round(float(mx[2]), 1)],
    )
    return dict(
        holes=holes,
        holeZ=hole_top,
        bbox=bbox,
        sizeX=round(size_x, 1),
        sizeY=round(size_y, 1),
        minSizeX=round(min_size_x, 1),
        minSizeY=round(min_size_y, 1),
        spacing=round(spacing, 6),
        centerX=round(float(mn[0] + mx[0]) / 2.0, 1),
        centerY=round(float(mn[1] + mx[1]) / 2.0, 1),
        extentXNegative=round(-float(mn[0]), 1),
        extentXPositive=round(float(mx[0]), 1),
        extentYNegative=round(-float(mn[1]), 1),
        extentYPositive=round(float(mx[1]), 1),
        model=model,
    )


def _set_board_extents(stage, extent_x_negative, extent_x_positive,
                       extent_y_negative, extent_y_positive):
    """Set the distance from the origin to each of the four board edges."""
    board, holes_instancer = _breadboard_prims(stage)
    if not board or not holes_instancer:
        abort(404, "project has no resizable breadboard")

    info = _board(stage)
    board_prim = board.GetPrim()
    positions = list(holes_instancer.GetPositionsAttr().Get() or [])
    spacing = (
        _authored_float(board_prim, "optics:gridSpacing")
        or info["spacing"]
    )
    min_size_x = (
        _authored_float(board_prim, "optics:minSizeX")
        or info["sizeX"]
    )
    min_size_y = (
        _authored_float(board_prim, "optics:minSizeY")
        or info["sizeY"]
    )

    half_min_x = min_size_x / 2.0
    half_min_y = min_size_y / 2.0
    extents = (
        (extent_x_negative, half_min_x),
        (extent_x_positive, half_min_x),
        (extent_y_negative, half_min_y),
        (extent_y_positive, half_min_y),
    )
    if any(value < minimum - 1e-6 for value, minimum in extents):
        abort(400, "each breadboard side cannot be smaller than its minimum")
    if any(
        not math.isclose(
            (value - minimum) / spacing,
            round((value - minimum) / spacing),
            abs_tol=1e-6,
        )
        for value, minimum in extents
    ):
        abort(400, f"each breadboard side must grow in {spacing:g} mm steps")

    size_x = extent_x_negative + extent_x_positive
    size_y = extent_y_negative + extent_y_positive
    nx_float, ny_float = size_x / spacing, size_y / spacing
    nx, ny = round(nx_float), round(ny_float)
    if (
        nx < 1 or ny < 1
        or not math.isclose(nx_float, nx, abs_tol=1e-6)
        or not math.isclose(ny_float, ny, abs_tol=1e-6)
    ):
        abort(400, f"breadboard size must be a multiple of {spacing:g} mm")

    bbox = info["bbox"]
    _, _, min_z = bbox["min"]
    max_z = bbox["max"][2]
    min_x, max_x = -extent_x_negative, extent_x_positive
    min_y, max_y = -extent_y_negative, extent_y_positive
    origin_x = min_x + spacing / 2.0
    origin_y = min_y + spacing / 2.0

    # Persist the original dimensions before changing legacy projects, so a
    # later edit can shrink an expanded board back to its true baseline.
    metadata = {
        "optics:minSizeX": min_size_x,
        "optics:minSizeY": min_size_y,
        "optics:gridSpacing": spacing,
        "optics:gridOriginX": origin_x,
        "optics:gridOriginY": origin_y,
    }
    for name, value in metadata.items():
        attr = board_prim.GetAttribute(name)
        if not attr:
            attr = board_prim.CreateAttribute(name, Sdf.ValueTypeNames.Double)
        attr.Set(float(value))
    thickness = max_z - min_z
    center = Gf.Vec3d(
        (min_x + max_x) / 2.0,
        (min_y + max_y) / 2.0,
        min_z + thickness / 2.0,
    )
    matrix = Gf.Matrix4d().SetScale(
        Gf.Vec3d(size_x, size_y, thickness)
    ).SetTranslateOnly(center)
    xformable = UsdGeom.Xformable(board_prim)
    transform_op = next(
        (op for op in xformable.GetOrderedXformOps()
         if op.GetOpName() == "xformOp:transform"),
        None,
    )
    if transform_op is None:
        xformable.ClearXformOpOrder()
        transform_op = xformable.AddTransformOp()
    transform_op.Set(matrix)
    xformable.SetXformOpOrder([transform_op])
    board.GetSizeAttr().Set(1.0)

    hole_z = float(positions[0][2]) if positions else max_z - 3.0
    new_positions = [
        Gf.Vec3f(
            origin_x + i * spacing,
            origin_y + j * spacing,
            hole_z,
        )
        for i in range(nx)
        for j in range(ny)
    ]
    holes_instancer.GetPositionsAttr().Set(new_positions)
    holes_instancer.GetProtoIndicesAttr().Set([0] * len(new_positions))


def _xform_values(prim):
    xf = UsdGeom.Xformable(prim)
    x = y = z = rot_x = rot_y = rot_z = 0.0
    for op in xf.GetOrderedXformOps():
        n = op.GetOpName()
        if n == "xformOp:translate":
            v = op.Get()
            if v:
                x, y, z = float(v[0]), float(v[1]), float(v[2])
        elif n == "xformOp:rotateX":
            rot_x = float(op.Get() or 0.0)
        elif n == "xformOp:rotateY":
            rot_y = float(op.Get() or 0.0)
        elif n == "xformOp:rotateZ":
            rot_z = float(op.Get() or 0.0)
    return x, y, z, rot_x, rot_y, rot_z


def _placement_xform_values(prim):
    """Return only transforms authored by the project placement layer.

    A referenced component asset can author its own root rotation to define
    the model's canonical pose.  Reading the composed prim with
    ``_xform_values`` would expose that asset rotation as a placement rotation
    as well, causing the viewport to apply it twice.
    """
    root_layer = prim.GetStage().GetRootLayer()
    spec = root_layer.GetPrimAtPath(prim.GetPath())
    if spec is None:
        return 0.0, 0.0, 0.0, 0.0, 0.0, 0.0

    def authored(name, default):
        attribute = spec.attributes.get(name)
        value = attribute.default if attribute is not None else None
        return default if value is None else value

    translate = authored("xformOp:translate", (0.0, 0.0, 0.0))
    return (
        float(translate[0]),
        float(translate[1]),
        float(translate[2]),
        float(authored("xformOp:rotateX", 0.0)),
        float(authored("xformOp:rotateY", 0.0)),
        float(authored("xformOp:rotateZ", 0.0)),
    )

def _board_top(stage):
    """Top surface z of the breadboard — components rest on or above it."""
    for prim in stage.Traverse():
        if prim.GetName() == "Breadboard":
            wb = UsdGeom.BBoxCache(Usd.TimeCode.Default(),
                                   [UsdGeom.Tokens.default_]).ComputeWorldBound(prim)
            extent = wb.ComputeAlignedRange()
            # A board prim whose reference does not resolve -- components/ not
            # generated yet, or an asset moved -- carries no geometry, and an
            # empty range reports its max as -FLT_MAX (-3.4e38). Returned as the
            # floor that is *silently no floor at all*: `max(-3.4e38, z)` is
            # always z, so _clamp_z stops clamping and parts sink through the
            # board instead of resting on it. Treat "no measurable board" the
            # same as "no board", which is the Z=0 the layout convention assumes.
            if extent.IsEmpty():
                return 0.0
            return float(extent.GetMax()[2])
    return 0.0

def _clamp_z(stage, z):
    """Keep a component out of the board and inside the scene."""
    return min(Z_MAX_MM, max(_board_top(stage), float(z)))

def _set_xform(prim, x, y, z, rot_x, rot_y, rot_z):
    """Rewrite a component's translation and editable XYZ rotations."""
    xf = UsdGeom.Xformable(prim)
    ops = {op.GetOpName(): op for op in xf.GetOrderedXformOps()}
    if "xformOp:translate" in ops:
        ops["xformOp:translate"].Set(Gf.Vec3d(x, y, z))
        t = ops["xformOp:translate"]
    else:
        t = xf.AddTranslateOp()
        t.Set(Gf.Vec3d(x, y, z))
    order = [t.GetOpName()]
    rotations = (
        ("X", rot_x, xf.AddRotateXOp),
        ("Y", rot_y, xf.AddRotateYOp),
        ("Z", rot_z, xf.AddRotateZOp),
    )
    for axis, value, add_op in rotations:
        op_name = f"xformOp:rotate{axis}"
        if op_name in ops:
            op = ops[op_name]
            op.Set(float(value))
            order.append(op.GetOpName())
        elif value:
            op = add_op()
            op.Set(float(value))
            order.append(op.GetOpName())
    xf.SetXformOpOrder([op for op in xf.GetOrderedXformOps()
                        if op.GetOpName() in order])

# Post holders in the PHxxE family use the matching TRxx post.  Their authored
# placement origin is the insertion-hole centre, so the holder and generated
# post must share the same X/Y gizmo centre.
HOLDER_POST_HOLE_X_MM = 0.0


def _string_attr(prim, name):
    attr = prim.GetAttribute(f"optics:{name}")
    if attr and attr.HasAuthoredValue():
        value = attr.Get()
        return value if isinstance(value, str) else str(value)
    return None


def _set_custom_attr(prim, name, value, value_type=Sdf.ValueTypeNames.String):
    attr = prim.GetAttribute(f"optics:{name}")
    if not attr:
        attr = prim.CreateAttribute(f"optics:{name}", value_type)
    attr.Set(value)


def _matching_post_component(holder_component):
    """Return the library component path for a PHxxE holder's TRxx post."""
    leaf = os.path.basename(holder_component)
    match = re.match(r"^PH(\d+)E(?P<suffix>.*)$", leaf, re.IGNORECASE)
    if not match:
        return None
    candidate = f"Post/TR{match.group(1)}{match.group('suffix')}"
    return candidate if os.path.exists(
        uu.get_component_usda_path(LIB_DIR, candidate, "lo")
    ) else None


def _rotate_local_offset(x, y, z, rot_x, rot_y, rot_z):
    """Apply the editor's intrinsic XYZ Euler rotation to a local vector."""
    rx, ry, rz = (math.radians(v) for v in (rot_x, rot_y, rot_z))
    cx, sx = math.cos(rx), math.sin(rx)
    cy, sy = math.cos(ry), math.sin(ry)
    cz, sz = math.cos(rz), math.sin(rz)
    # Rz * Ry * Rx, matching THREE.Euler's default XYZ convention.
    return (
        (cz * cy) * x + (cz * sy * sx - sz * cx) * y
        + (cz * sy * cx + sz * sx) * z,
        (sz * cy) * x + (sz * sy * sx + cz * cx) * y
        + (sz * sy * cx - cz * sx) * z,
        (-sy) * x + (cy * sx) * y + (cy * cx) * z,
    )


def _sync_linked_post(stage, holder):
    """Keep a holder's post on its insertion-hole axis, preserving Z trim."""
    post_name = _string_attr(holder, "pairedPost")
    if not post_name:
        return
    post = stage.GetPrimAtPath(
        f"{stage.GetDefaultPrim().GetPath()}/{post_name}"
    )
    if not post or not post.IsValid():
        return
    hx, hy, hz, rx, ry, rz = _placement_xform_values(holder)
    dx, dy, dz = _rotate_local_offset(
        HOLDER_POST_HOLE_X_MM, 0.0, 0.0, rx, ry, rz
    )
    z_offset_attr = post.GetAttribute("optics:holderZOffset_mm")
    z_offset = float(z_offset_attr.Get()) if (
        z_offset_attr and z_offset_attr.HasAuthoredValue()
    ) else 0.0
    _set_xform(post, hx + dx, hy + dy, _clamp_z(stage, hz + dz + z_offset),
               rx, ry, rz)


def _linked_holder(stage, post):
    holder_name = _string_attr(post, "pairedHolder")
    if not holder_name:
        return None
    holder = stage.GetPrimAtPath(
        f"{stage.GetDefaultPrim().GetPath()}/{holder_name}"
    )
    return holder if holder and holder.IsValid() else None


def _catalog_asset_type(asset):
    """Return the component type authored by a catalogue asset."""
    component_name = uu.get_component_name(asset)
    path = uu.get_component_usda_path(LIB_DIR, component_name, "lo")
    asset_stage = Usd.Stage.Open(path) if os.path.exists(path) else None
    if asset_stage is None or not asset_stage.GetDefaultPrim().IsValid():
        return None
    attr = asset_stage.GetDefaultPrim().GetAttribute("optics:type")
    return attr.Get() if attr and attr.HasAuthoredValue() else None


def _replace_component_reference(prim, asset, project_dir):
    """Swap only the library reference, preserving instance-authored state."""
    component_name = uu.get_component_name(asset)
    relative_path = uu.get_relative_component_usda_path(
        LIB_DIR, component_name, project_dir
    )
    references = prim.GetReferences()
    references.ClearReferences()
    references.AddReference(relative_path)


def _rebased_reference(ref, from_layer, to_dir):
    """The same reference, expressed relative to `to_dir` instead of its layer."""
    path = ref.assetPath
    if not path or os.path.isabs(path) or "://" in path:
        return ref
    absolute = from_layer.ComputeAbsolutePath(path)
    rebased = os.path.relpath(absolute, to_dir).replace(os.sep, "/")
    if rebased == path:
        return ref
    return Sdf.Reference(rebased, ref.primPath, ref.layerOffset, ref.customData)


def _rebase_asset_paths(layer, prim_path, from_layer):
    """Re-anchor a prim spec copied out of `from_layer` into `layer`.

    Reference paths are authored relative to the file holding them
    (`../../components/...` from `projects/<n>/setup.usda`), so a spec pasted
    from another project's layer has to be recomputed against this one — the
    relative path that resolved there may not resolve here.
    """
    spec = layer.GetPrimAtPath(prim_path)
    if spec is None:
        return
    to_dir = os.path.dirname(layer.realPath or os.path.abspath(layer.identifier))
    for child in spec.nameChildren.values():
        _rebase_asset_paths(layer, child.path, from_layer)
    refs = spec.referenceList
    for field in ("prependedItems", "appendedItems", "explicitItems"):
        items = list(getattr(refs, field))
        if items:
            setattr(refs, field, [_rebased_reference(r, from_layer, to_dir)
                                  for r in items])


def _relink_paired_copies(stage, root, name_map):
    """Point each copy's holder/post link at the copy of its partner.

    A holder names its post in `optics:pairedPost` (and the post names the
    holder back). Copying one without the other would leave the copy driving
    the *original* post — and after a cross-project paste the name wouldn't
    exist here at all — so an unpaired link is dropped instead.
    """
    for copy_name in name_map.values():
        prim = stage.GetPrimAtPath(f"{root}/{copy_name}")
        for key in ("pairedPost", "pairedHolder"):
            partner = _string_attr(prim, key)
            if not partner:
                continue
            if partner in name_map:
                _set_custom_attr(prim, key, name_map[partner])
            else:
                prim.RemoveProperty(f"optics:{key}")
                if key == "pairedHolder":
                    # Only means anything while the post follows a holder.
                    prim.RemoveProperty("optics:holderZOffset_mm")


def _unique_component_name(stage, root, base, taken=()):
    """First free prim name under root: Lens, Lens_2, Lens_3, ...

    `taken` reserves names already handed out in this request but not yet
    authored into the stage.
    """
    name, i = base, 1
    while name in taken or stage.GetPrimAtPath(f"{root}/{name}").IsValid():
        i += 1
        name = f"{base}_{i}"
    return name


# -------------------------------------------------------------------------
# Undo / redo (#157)
#
# Every editing step is recorded as a snapshot of the whole USD layer, taken
# just before the change lands. The layers are small (8-54 kB of text, and
# they compress to ~2 kB), so keeping 50 of them costs less than writing and
# testing an inverse for each of the nine mutating endpoints -- and it makes
# the awkward cases (deleting a part, resizing the board) undo perfectly,
# references and attribute overrides included.
#
# The history is shared per project rather than per user: on the lab server
# Ctrl+Z undoes the last change to the project, whoever made it. It lives in
# this process only, so a server restart starts everyone from a clean slate.
# -------------------------------------------------------------------------
HISTORY_LIMIT = 50
_HISTORY = {}                       # project -> {"undo": [...], "redo": [...]}
_HISTORY_LOCK = threading.Lock()


def _layer_text(name):
    """The project's USD layer serialized to a string.

    Goes through Sdf rather than reading the file so the snapshot matches what
    USD currently has in memory — the layer registry hands the same Sdf.Layer
    back to every Usd.Stage.Open of this path.
    """
    layer = Sdf.Layer.FindOrOpen(project_setup(name))
    return layer.ExportToString() if layer else None


def _restore_layer(name, text):
    """Replace the project's layer contents with a snapshot and save it.

    ImportFromString updates the registered layer in place, so stages opened
    afterwards see the restored scene. Writing the file directly would leave
    the cached layer stale.
    """
    layer = Sdf.Layer.FindOrOpen(project_setup(name))
    layer.ImportFromString(text)
    layer.Save()


def _history(name):
    return _HISTORY.setdefault(name, {"undo": [], "redo": []})


def _push_history(name, snapshot):
    """Record a step, returning the redo stack it displaced.

    A fresh edit invalidates whatever was redoable. The displaced stack comes
    back so a failed request can be rolled back cleanly.
    """
    with _HISTORY_LOCK:
        h = _history(name)
        redo_was = list(h["redo"])
        h["undo"].append(snapshot)
        h["redo"].clear()
        return redo_was


def _rollback_history(name, redo_was):
    with _HISTORY_LOCK:
        h = _history(name)
        if h["undo"]:
            h["undo"].pop()
        h["redo"][:] = redo_was


def _trim_history(name):
    with _HISTORY_LOCK:
        h = _history(name)
        del h["undo"][:-HISTORY_LIMIT]


def _forget_history(name):
    with _HISTORY_LOCK:
        _HISTORY.pop(name, None)


def _rename_history(old, new):
    """Carry a project's undo stack over to its new name (#207).

    The stacks are whole-layer snapshots, and a rename changes nothing inside
    the layer, so every recorded step is still valid under the new name.
    """
    with _HISTORY_LOCK:
        h = _HISTORY.pop(old, None)
        if h is not None:
            _HISTORY[new] = h


def _history_state(name):
    """What the editor needs to enable or grey out its undo/redo controls."""
    with _HISTORY_LOCK:
        h = _HISTORY.get(name) or {"undo": [], "redo": []}
        return dict(canUndo=bool(h["undo"]), canRedo=bool(h["redo"]))


def records_history(view):
    """Snapshot the project layer before an edit, and keep it if the edit lands.

    Wraps the mutating routes, all of which take the project as `name`.

    The step is recorded *before* the view runs, so the payload the view builds
    already reports canUndo — otherwise the editor's undo button would lag one
    edit behind. A view that aborts rolls the record back, so failed requests
    leave no step behind.
    """
    @functools.wraps(view)
    def wrapper(name, *args, **kwargs):
        before = _layer_text(name)
        if before is None:              # unreadable layer — edit, but don't record
            return view(name, *args, **kwargs)
        redo_was = _push_history(name, before)
        try:
            response = view(name, *args, **kwargs)
        except Exception:
            _rollback_history(name, redo_was)
            raise
        _trim_history(name)
        return response
    wrapper.records_history = True     # asserted by tests/test_history.py
    return wrapper


def rebuild_glb(name):
    setup = project_setup(name)
    usd_to_web.convert(setup, os.path.join(BUILD_DIR, f"{name}.glb"))


def rebuild_glb_if_stale(name):
    """Export the glb only when it is older than the project layer.

    The React client never loads /model/<name>.glb -- it renders from the mesh
    JSON in the project payload. Only the legacy web/editor.html does. Rebuilding
    on every mutating route therefore spent ~50 ms per edit on a file nobody
    read; the export now happens on demand, in the GET route, and stays a no-op
    while the layer is unchanged.
    """
    setup = project_setup(name)
    glb = os.path.join(BUILD_DIR, f"{name}.glb")
    try:
        # Strictly newer, not equal: the export always runs after the save, so
        # on any sub-second-resolution filesystem it wins. Equal timestamps mean
        # a coarse filesystem, where re-exporting is the safe way to be wrong.
        if os.path.getmtime(glb) > os.path.getmtime(setup):
            return glb
    except OSError:
        pass                            # missing glb (or setup) -- build it
    rebuild_glb(name)
    return glb


# -------------------------------------------------------------------------
# API
# -------------------------------------------------------------------------
def _project_summary(name):
    """Lightweight info for the gallery: component count + the types present.

    `modified` is the layer's mtime. The gallery draws each bench into a
    thumbnail in the browser and caches the picture; the mtime is what tells it
    a cached thumbnail is stale, so it must change whenever the setup does.
    """
    setup = os.path.join(PROJECTS_DIR, name, "setup.usda")
    stage = Usd.Stage.Open(setup)
    types = [p.GetAttribute("optics:type").Get() for p in _component_prims(stage)]
    try:
        modified = os.path.getmtime(setup)
    except OSError:
        modified = 0.0
    # The board's footprint: which bench this is, in the terms the lab uses for
    # them. One bounded prim per project, so it costs little on the listing.
    board = _board(stage)
    meta = _project_meta(name)
    return dict(
        name=name,
        components=len(types),
        types=types,
        modified=modified,
        boardSizeX=_card_size(board["sizeX"]),
        boardSizeY=_card_size(board["sizeY"]),
        folder=meta["folder"],
        archived=meta["archived"],
    )


# How a project is filed in the gallery: which folder it sits in ("2027年度")
# and whether it has been archived out of the way. This is shelving, not scene
# data, so it lives in a sidecar next to setup.usda rather than in the layer.
#
# Two reasons it is not a USD attribute on the Setup prim. Archiving a project
# would rewrite the layer, and the layer's mtime is the gallery's `modified` —
# both the card's "last edited" line and the cache key for its bench thumbnail
# (see _project_summary). Filing something away would report it as edited and
# redraw its picture. And nothing in the 3D scene depends on it.
#
# It is a file inside the project folder so it travels by itself: rename moves
# the folder, duplicate copytrees it, and git syncs it with the project.
PROJECT_META_FILE = "project.json"
FOLDER_MAX_LEN = 60


def _project_meta_path(name):
    return os.path.join(PROJECTS_DIR, name, PROJECT_META_FILE)


def _project_meta(name):
    """A project's filing info, defaulted for every project that has none.

    Never raises: a project whose sidecar is missing, unreadable or hand-edited
    into something that isn't an object is simply an unfiled, live project. A
    gallery listing must not fail over one bad file.
    """
    meta = {}
    try:
        with open(_project_meta_path(name), encoding="utf-8") as fh:
            loaded = json.load(fh)
        if isinstance(loaded, dict):
            meta = loaded
    except (OSError, ValueError):
        pass
    return dict(
        folder=_clean_folder(meta.get("folder")),
        archived=bool(meta.get("archived")),
    )


def _clean_folder(raw):
    """A folder label reduced to something a card can print. "" = unfiled.

    Unlike a project name this is never used as a path — it is only ever a
    label grouping cards — so it keeps Japanese, spaces and punctuation as
    typed. It is only trimmed, length-capped, and stripped of the control
    characters and newlines that would break the tab strip.
    """
    if not isinstance(raw, str):
        return ""
    label = re.sub(r"[\x00-\x1f\x7f]", " ", raw).strip()
    return label[:FOLDER_MAX_LEN]


def _write_project_meta(name, meta):
    """Save filing info, or delete the sidecar once there is nothing to say.

    A project that is unfiled and unarchived is the default, so it carries no
    file — that keeps `projects/` clean and keeps an unused sidecar out of git
    for every project nobody has filed.
    """
    path = _project_meta_path(name)
    if not meta["folder"] and not meta["archived"]:
        try:
            os.remove(path)
        except OSError:
            pass
        return meta
    payload = {}
    if meta["folder"]:
        payload["folder"] = meta["folder"]
    if meta["archived"]:
        payload["archived"] = True
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    return meta


def _card_size(value):
    """A board dimension fit to print on a gallery card, else 0.

    A board whose asset cannot be resolved bounds to USD's empty range, and its
    "size" comes back as -6.8e38. The card would print that. Anything that isn't
    a real positive length is no size at all, and the card leaves it blank.
    """
    size = float(value or 0.0)
    return round(size, 1) if math.isfinite(size) and size > 0 else 0.0


# optics:* attributes that live on the project's placement prim rather than in
# the reusable component asset, and so are layered over the asset's own attrs.
# A move can author one of them (holderZOffset_mm), which is why the light move
# payload carries exactly these keys and no others.
PLACEMENT_ATTR_KEYS = (
    "pairedPost", "pairedHolder", "holderZOffset_mm",
    # Whether this particular laser is switched on. Without this a CAD laser
    # takes the catalogue value and the switch appears to do nothing.
    "laserOn",
)


def _project_components(stage, render_mode="lo", include_fixed=False):
    if render_mode not in ("hi", "lo"):
        raise ValueError("render_mode must be 'hi' or 'lo'")
    comps = []
    cad_assets = ol.cad_library_assets(LIB_DIR)
    for prim in _component_prims(stage, include_fixed=include_fixed):
        x, y, z, rot_x, rot_y, rot_z = _placement_xform_values(prim)
        t = prim.GetAttribute("optics:type").Get()
        asset = _component_asset_name(prim)
        geometry_stage = stage
        geometry_root = prim
        placement_attrs = _optics_attrs(prim)
        attrs = placement_attrs
        model_pose = {
            "modelRotation": [0.0, 0.0, 0.0],
            "rotationCenter": [0.0, 0.0, 0.0],
        }

        # Generated CAD assets are opened directly in both modes.  Reading lo
        # through the project reference would let the placement prim's xform
        # order mask rotations authored on the lo.usda root.
        if asset and (render_mode == "hi" or asset in cad_assets):
            component_name = uu.get_component_name(asset)
            geometry_path = uu.get_component_usda_path(
                LIB_DIR, component_name, render_mode
            )
            if not os.path.exists(geometry_path):
                if render_mode == "hi":
                    continue
            else:
                asset_stage = Usd.Stage.Open(geometry_path)
                if (
                    asset_stage is not None
                    and asset_stage.GetDefaultPrim().IsValid()
                ):
                    geometry_stage = asset_stage
                    geometry_root = asset_stage.GetDefaultPrim()
                    model_pose = _component_model_pose(
                        geometry_stage, geometry_root
                    )
                    asset_type = geometry_root.GetAttribute("optics:type")
                    if asset_type and asset_type.HasAuthoredValue():
                        t = asset_type.Get()
                    attrs = _optics_attrs(geometry_root)
                elif render_mode == "hi":
                    continue
        elif render_mode == "hi":
            if not asset:
                continue

        meshes = _component_meshes(geometry_stage, geometry_root)
        primitives = _component_primitives(geometry_stage, geometry_root)
        component = dict(name=prim.GetName(), type=t,
                         x=round(x, 3), y=round(y, 3), z=round(z, 3),
                         rotX=round(rot_x, 3), rotY=round(rot_y, 3),
                         rotZ=round(rot_z, 3), attrs=_optics_attrs(prim),
                         asset=asset,
                         cadDerived=asset in cad_assets,
                         renderMode=render_mode)
        component["attrs"] = attrs
        # Relationship/trim metadata is authored on the project placement
        # prim, not in the reusable component asset.
        for key in PLACEMENT_ATTR_KEYS:
            if key in placement_attrs:
                component["attrs"][key] = placement_attrs[key]
        rod_shoulders = _rod_asset_shoulder_offsets(asset)
        if rod_shoulders:
            component["attrs"].update(rod_shoulders)
        component.update(model_pose)
        if meshes:
            component["meshes"] = meshes
        if primitives:
            component["primitives"] = primitives
        component["physics"] = _beam_physics_metadata(component)
        comps.append(component)
    return comps


def _beam_path(stage):
    bp = stage.GetDefaultPrim().GetAttribute("optics:beamPath")
    return json.loads(bp.Get()) if bp and bp.HasAuthoredValue() else []


# Width a beam leg is drawn at until someone shapes it. This is a planning
# sketch, not a simulation, so it starts at one readable size and the user
# draws the profile they intend.
DEFAULT_BEAM_WIDTH_MM = 6.0
# Guard rails for a typed width: below this it vanishes, above it swamps the bench.
BEAM_WIDTH_RANGE_MM = (0.05, 300.0)
# Longest a leg may be *drawn*. The tracer runs an escaping ray to 10 m, and a
# sketch is allowed to show that, but not more.
BEAM_MAX_DRAW_MM = 10000.0


def _beam_shape(stage):
    """Per-segment drawn widths, keyed by the tracer's stable segment key."""
    attr = stage.GetDefaultPrim().GetAttribute("optics:beamShape")
    if not attr or not attr.HasAuthoredValue():
        return {}
    try:
        shape = json.loads(attr.Get())
    except (TypeError, json.JSONDecodeError):
        return {}
    return shape if isinstance(shape, dict) else {}


def _apply_beam_shape(segments, shape):
    """Attach the drawn width to each leg, falling back to the default.

    Overrides are looked up by segment key, so a leg keeps its shape when parts
    move. A key whose leg no longer exists is simply not applied — it stays in
    USD in case the layout comes back, rather than being silently discarded.
    """
    for segment in segments:
        override = shape.get(segment.get("key")) or {}
        for field in ("wIn", "wOut"):
            try:
                value = float(override[field])
            except (KeyError, TypeError, ValueError):
                value = DEFAULT_BEAM_WIDTH_MM
            segment[field] = round(value, 4)
        # A pinched leg carries a waist: where along it the beam is narrowest
        # (0..1) and how wide it is there. That is the bow-tie between a focus
        # pair; without it a leg is a single straight-sided block or wedge.
        try:
            segment["waistAt"] = round(float(override["waistAt"]), 4)
            segment["waistW"] = round(float(override["waistW"]), 4)
        except (KeyError, TypeError, ValueError):
            segment.pop("waistAt", None)
            segment.pop("waistW", None)
        # Drawn length, when the sketch says the beam runs a different distance
        # from the gap between the two parts.
        try:
            segment["lengthMm"] = round(float(override["lengthMm"]), 3)
        except (KeyError, TypeError, ValueError):
            segment.pop("lengthMm", None)
        segment["shaped"] = bool(override)
    return segments


def _pins(stage):
    attr = stage.GetDefaultPrim().GetAttribute("optics:pins")
    if not attr or not attr.HasAuthoredValue():
        return []
    try:
        pins = json.loads(attr.Get())
        return pins if isinstance(pins, list) else []
    except (TypeError, json.JSONDecodeError):
        return []


# A figure callout: the label text plus where its box sits relative to the part
# it points at. `dx`/`dy` are *screen* pixels at the stored zoom, not millimetres
# — the box is placed by eye against the rendered picture, and the leader line is
# redrawn from the projected anchor every frame, so the layout survives orbiting.
#
# Where the line *lands* is the opposite kind of quantity: `ax`/`ay`/`az` are
# millimetres in the part's own frame, so a dot dragged onto a lens surface stays
# on that surface when the part is moved, rotated, or looked at from elsewhere.
# Absent means the part's origin, which is where a fresh callout points.
CALLOUT_ANCHOR_KEYS = ("ax", "ay", "az")

# Leader-line and box colours. Stored as CSS hex (plus "none" for a box with no
# fill, which a figure over a photograph often wants). The *palette* the UI
# offers lives in the client (`CALLOUT_COLORS` in app/src/callouts.ts) — the
# server only checks the shape, so adding a swatch never needs a backend change.
# The text colour is deliberately not stored: it is derived from the box fill so
# a label cannot be styled into unreadability.
CALLOUT_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def _clean_callout_color(value, allow_none):
    """A callout colour -> normalized string, or None if it isn't one."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    if allow_none and value.lower() == "none":
        return "none"
    return value.lower() if CALLOUT_COLOR_RE.match(value) else None


def _clean_callout(callout, valid_names):
    """Validate one callout -> a normalized dict, or None if unusable.

    A callout points at a component prim, so it shares the components' fate:
    delete the part and the label that names it is meaningless. Dropping it on
    read (rather than chasing deletes from every mutating route) matches how
    `_normalize_groups` treats stale members.
    """
    if not isinstance(callout, dict):
        return None
    cid, target = callout.get("id"), callout.get("target")
    if not isinstance(cid, str) or not cid:
        return None
    if not isinstance(target, str) or target not in valid_names:
        return None
    try:
        dx, dy = float(callout.get("dx", 0)), float(callout.get("dy", 0))
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(dx) and math.isfinite(dy)):
        return None
    clean = dict(id=cid, target=target,
                 text=str(callout.get("text") or ""),
                 dx=round(dx, 2), dy=round(dy, 2))
    try:
        font_px = float(callout["fontPx"])
    except (KeyError, TypeError, ValueError):
        font_px = None
    if font_px is not None and math.isfinite(font_px):
        clean["fontPx"] = round(max(6.0, min(96.0, font_px)), 2)

    # The anchor offset is all-or-nothing: two of three axes would place the dot
    # somewhere nobody asked for, so a partial or unreadable triple falls back to
    # the origin rather than being half-applied.
    try:
        anchor = [float(callout[key]) for key in CALLOUT_ANCHOR_KEYS]
    except (KeyError, TypeError, ValueError):
        anchor = None
    if anchor is not None and all(math.isfinite(value) for value in anchor):
        clean.update(zip(CALLOUT_ANCHOR_KEYS, (round(v, 3) for v in anchor)))

    # Styling is optional throughout: an unreadable colour is dropped rather
    # than rejected, so an old or hand-edited layer still opens.
    line_color = _clean_callout_color(callout.get("lineColor"), allow_none=False)
    if line_color:
        clean["lineColor"] = line_color
    box_color = _clean_callout_color(callout.get("boxColor"), allow_none=True)
    if box_color:
        clean["boxColor"] = box_color
    if callout.get("hidden"):
        clean["hidden"] = True
    return clean


def _callouts(stage):
    """Read optics:callouts -> [{id, target, text, dx, dy, fontPx?}]."""
    attr = stage.GetDefaultPrim().GetAttribute("optics:callouts")
    if not attr or not attr.HasAuthoredValue():
        return []
    try:
        callouts = json.loads(attr.Get())
    except (TypeError, json.JSONDecodeError):
        return []
    if not isinstance(callouts, list):
        return []
    valid = {prim.GetName() for prim in _component_prims(stage)}
    out, seen = [], set()
    for callout in callouts:
        clean = _clean_callout(callout, valid)
        if clean is None or clean["id"] in seen:
            continue
        seen.add(clean["id"])
        out.append(clean)
    return out


def _normalize_groups(groups, valid_names):
    """Drop anything a group can no longer refer to.

    Components are deleted independently of the groups that mention them, so a
    stored group is only ever a hint: keep the members that still exist and keep
    a component in the first group that claims it.  A group that ends up with
    fewer than two members is dropped -- a group of one moves and rotates
    exactly like the bare component, and the editor offers no way to dissolve
    it because its panels only appear for a multi-selection.
    """
    out, seen_ids, claimed = [], set(), set()
    for group in groups:
        if not isinstance(group, dict):
            continue
        gid = group.get("id")
        members = group.get("members")
        if not isinstance(gid, str) or gid in seen_ids:
            continue
        if not isinstance(members, list):
            continue
        kept = []
        for name in members:
            if name in valid_names and name not in claimed and name not in kept:
                kept.append(name)
        if len(kept) < 2:
            continue
        seen_ids.add(gid)
        claimed.update(kept)
        clean = dict(id=gid, name=str(group.get("name") or gid), members=kept)
        color = group.get("color")
        if isinstance(color, str):
            clean["color"] = color
        out.append(clean)
    return out


def _groups(stage):
    """Read optics:groups -> [{id, name, members, color}] (empty if unset)."""
    attr = stage.GetDefaultPrim().GetAttribute("optics:groups")
    if not attr or not attr.HasAuthoredValue():
        return []
    try:
        groups = json.loads(attr.Get())
    except (TypeError, json.JSONDecodeError):
        return []
    if not isinstance(groups, list):
        return []
    valid = {prim.GetName() for prim in _component_prims(stage)}
    return _normalize_groups(groups, valid)


def _write_groups(stage, groups):
    """Author optics:groups on the default prim (caller saves the layer)."""
    prim = stage.GetDefaultPrim()
    attr = prim.GetAttribute("optics:groups")
    if not attr:
        attr = prim.CreateAttribute("optics:groups", Sdf.ValueTypeNames.String)
    attr.Set(json.dumps(groups, ensure_ascii=False))


def _groups_with_copies(groups, name_map, source_groups=None):
    """Append a copy of every group whose members were *all* duplicated.

    Pasting a whole assembly should give another assembly; pasting part of one
    gives loose components, which is what PowerPoint-style grouping implies.

    `groups` is the list being written back (the paste target's); the copies are
    derived from `source_groups`, which is the same list for a within-project
    paste and the other project's groups for a cross-project one.
    """
    out = list(groups)
    used_ids = {group["id"] for group in groups}
    for group in (groups if source_groups is None else source_groups):
        if not all(member in name_map for member in group["members"]):
            continue
        gid, i = f"{group['id']}-copy", 1
        while gid in used_ids:
            i += 1
            gid = f"{group['id']}-copy-{i}"
        used_ids.add(gid)
        out.append(dict(group, id=gid,
                        members=[name_map[m] for m in group["members"]]))
    return out


def _resolved_project_beam(stage, comps_by_name, beam_path):
    traced = beam_tracer.trace_lasers(
        list(comps_by_name.values()),
        aperture_offset_mm=LASER_APERTURE_OFFSET_MM,
    )
    if traced:
        # The tracer ends a leg at every hit, including the mounts and posts the
        # beam passes through. Fuse those back together so a segment is the
        # stretch between two optics — the thing a user means by "the beam
        # between the lenses", and the thing they click to shape.
        return beam_tracer.merge_structural(traced, comps_by_name)
    if beam_tracer.has_laser(comps_by_name.values()):
        # There is a laser and it emitted nothing, so it is switched off. The
        # bench must go dark: falling through to an authored beam path here
        # would draw a beam with the source turned off.
        return []
    if beam_path:
        beam = _resolve_beam_path(stage, comps_by_name)
        return beam
    return _beam_segments(stage) + _laser_emission_segments(comps_by_name)


def _project_payload(name, stage, render_mode="lo"):
    _sync_cad_catalog()
    comps = _project_components(stage, render_mode)
    fixed = _project_components(stage, render_mode, include_fixed=True)
    board_model = next(
        (component for component in fixed if component["type"] == "breadboard"),
        None,
    )
    beam_path = _beam_path(stage)
    physics_comps = (
        comps
        if render_mode == "lo"
        else _project_components(stage, "lo")
    )
    comps_by_name = {c["name"]: c for c in physics_comps}
    return dict(name=name, components=comps,
                beam=_apply_beam_shape(
                    _resolved_project_beam(stage, comps_by_name, beam_path),
                    _beam_shape(stage),
                ),
                beamPath=beam_path,
                board=_board(stage, board_model),
                boardModels=[
                    asset for asset in BOARD_MODEL_ORDER
                    if asset in ol.cad_library_assets(LIB_DIR)
                ],
                library=ol.component_library_assets(),
                libraryPreviews=_library_previews(),
                renderMode=render_mode,
                pins=_pins(stage),
                callouts=_callouts(stage),
                groups=_groups(stage),
                **_history_state(name))


def _move_payload(name, stage, render_mode="lo"):
    """The subset of the scene a component move can change.

    A move rewrites transforms and retraces the beam. It never touches geometry,
    the board, the catalogue, pins or groups — yet the full payload re-serialized
    all of it on every drag: 0.47 MB in lo and 50 MB in hi, the latter costing
    ~18 s because it re-reads every hi-res CAD asset. This carries transforms
    only, so it is the same handful of kB in either mode, and the client merges
    it into the scene it already has (see mergeMove in app/src/moveMerge.ts).

    `lo` is deliberate for the geometry pass here: it is only feeding the beam
    tracer, which reads placement and physics metadata, not meshes.
    """
    comps = _project_components(stage, "lo")
    beam_path = _beam_path(stage)
    comps_by_name = {c["name"]: c for c in comps}
    return dict(
        name=name,
        partial=True,               # a merge, not a replacement
        components=[
            {
                "name": c["name"],
                "x": c["x"], "y": c["y"], "z": c["z"],
                "rotX": c["rotX"], "rotY": c["rotY"], "rotZ": c["rotZ"],
                "attrs": {k: c["attrs"][k]
                          for k in PLACEMENT_ATTR_KEYS if k in c["attrs"]},
            }
            for c in comps
        ],
        beam=_apply_beam_shape(
            _resolved_project_beam(stage, comps_by_name, beam_path),
            _beam_shape(stage),
        ),
        renderMode=render_mode,
        **_history_state(name),
    )


@app.get("/api/projects")
def list_projects():
    names = []
    if os.path.isdir(PROJECTS_DIR):
        for n in sorted(os.listdir(PROJECTS_DIR)):
            if os.path.exists(os.path.join(PROJECTS_DIR, n, "setup.usda")):
                names.append(n)
    return jsonify(
        projects=[_project_summary(n) for n in names],
        templates=(
            [dict(key=k, label=v[1]) for k, v in tpl.TEMPLATES.items()
             if k in NEW_PROJECT_TEMPLATE_KEYS]
            + [dict(key=k, label=v[1])
               for k, v in setup_projects.CLONE_TEMPLATES.items()
               if _clone_template_available(k)]
        ),
    )


def _clone_template_available(template):
    """Whether a clone template's stored setup is actually there.

    A clone template is only as real as the file it copies. Offering one whose
    setup is missing puts an option in the New Project menu that can only fail —
    which is what happened while `4f_default` still pointed at a live project
    that lab members had renamed away.
    """
    source = setup_projects.clone_source_path(template)
    return bool(source) and os.path.exists(source)

def _clean_project_name(raw):
    """A typed-in project name reduced to something safe to use as a folder.

    Spaces and punctuation become underscores rather than being rejected, so a
    user typing "SLM imaging" gets `SLM_imaging` instead of an error.
    """
    name = re.sub(r"[^A-Za-z0-9_\-]", "_", (raw or "").strip())
    if not name or not SAFE.match(name):
        abort(400, "invalid name")
    return name


@app.post("/api/projects")
def new_project():
    body = request.get_json(force=True)
    name = _clean_project_name(body.get("name"))
    template = body.get("template", "blank")
    if template not in NEW_PROJECT_TEMPLATE_KEYS and template not in setup_projects.CLONE_TEMPLATES:
        abort(400, "unknown template")
    if os.path.exists(os.path.join(PROJECTS_DIR, name, "setup.usda")):
        abort(409, "project already exists")
    if not os.path.isdir(LIB_DIR) or not os.listdir(LIB_DIR):
        ol.build_component_library(LIB_DIR)   # ensure the catalogue exists
    try:
        setup_projects.create_project(name, template, overwrite=True)
    except (FileNotFoundError, ValueError) as exc:
        # A clone template whose source project has been renamed or deleted.
        # It must come back as a response the browser can show; this used to
        # raise SystemExit, which killed the worker mid-request.
        abort(400, str(exc))
    return jsonify(ok=True, name=name)

def _unique_project_name(base):
    """First free project name: bench_copy, bench_copy_2, ..."""
    name, i = base, 1
    while os.path.exists(os.path.join(PROJECTS_DIR, name, "setup.usda")):
        i += 1
        name = f"{base}_{i}"
    return name


@app.post("/api/projects/<name>/duplicate")
def duplicate_project(name):
    """Copy a whole project under an auto-generated name (#155).

    Duplicating bench gives bench_copy, then bench_copy_2 -- the existing
    _copy suffix is counted on rather than stacked.
    """
    if not SAFE.match(name):
        abort(400)
    if not os.path.exists(os.path.join(PROJECTS_DIR, name, "setup.usda")):
        abort(404, "no such project")
    stem = re.sub(r"_copy(_\d+)?$", "", name) or name
    new_name = _unique_project_name(f"{stem}_copy")
    setup_projects.duplicate_project(name, new_name, projects_dir=PROJECTS_DIR)
    # copytree brought the sidecar across, so the copy is filed beside its
    # original -- but it is never archived, however the original was filed. You
    # duplicate a project to work on it, and a copy born hidden looks lost.
    meta = _project_meta(new_name)
    meta["archived"] = False
    _write_project_meta(new_name, meta)
    return jsonify(ok=True, name=new_name, project=_project_summary(new_name))


@app.post("/api/projects/<name>/meta")
def update_project_meta(name):
    """File a project into a folder, and/or archive it out of the gallery.

    Both fields are optional and each is applied only when present, so the
    archive toggle can't wipe a project's folder and vice versa. `folder: null`
    (or "") is the way to take a project back out of its folder.

    Not wrapped in @records_history: undo is the scene's history, and a folder
    label is not part of the scene. Rewinding a bench by twenty steps should
    not also un-archive it.
    """
    if not SAFE.match(name):
        abort(400)
    if not os.path.exists(os.path.join(PROJECTS_DIR, name, "setup.usda")):
        abort(404, "no such project")

    body = request.get_json(force=True) or {}
    meta = _project_meta(name)
    if "folder" in body:
        meta["folder"] = _clean_folder(body.get("folder"))
    if "archived" in body:
        meta["archived"] = bool(body.get("archived"))
    _write_project_meta(name, meta)
    return jsonify(ok=True, name=name, project=_project_summary(name))


@app.post("/api/projects/<name>/rename")
def rename_project(name):
    """Rename a project folder (#207).

    The whole folder moves — setup.usda, notes.md, whatever else the team put
    there — so the relative `../../components/...` references inside the layer
    resolve unchanged (same depth, same reasoning as duplicate_project).

    USD's layer registry is keyed by path and holds only layers something
    still references — normally nothing does between requests, but Flask is
    threaded and a request in flight does. Such a layer is re-keyed to the new
    path, so it can't keep the old name claimed and hand its stale in-memory
    scene to whatever project is created with that name next.
    """
    if not SAFE.match(name):
        abort(400)
    old_dir = os.path.join(PROJECTS_DIR, name)
    if not os.path.exists(os.path.join(old_dir, "setup.usda")):
        abort(404, "no such project")

    new_name = _clean_project_name((request.get_json(force=True) or {}).get("name"))
    if new_name == name:
        return jsonify(ok=True, name=name, project=_project_summary(name))
    new_dir = os.path.join(PROJECTS_DIR, new_name)
    if os.path.exists(new_dir):
        abort(409, "project already exists")

    layer = Sdf.Layer.Find(os.path.join(old_dir, "setup.usda"))
    os.rename(old_dir, new_dir)
    if layer:
        # Re-key before anything reopens the new path -- two layers may not
        # share an identifier, and project_setup() opens a stage of its own.
        layer.identifier = os.path.join(new_dir, "setup.usda")

    _rename_history(name, new_name)
    old_glb = os.path.join(BUILD_DIR, f"{name}.glb")
    if os.path.exists(old_glb):
        os.remove(old_glb)
    return jsonify(ok=True, name=new_name, project=_project_summary(new_name))


@app.post("/api/projects/<name>/remove")
def remove_project(name):
    if not SAFE.match(name):
        abort(400)
    import shutil
    d = os.path.join(PROJECTS_DIR, name)
    if not os.path.isdir(d):
        abort(404)
    shutil.rmtree(d)
    _forget_history(name)
    return jsonify(ok=True)


def _step_history(name, take, keep, render_mode):
    """Move one step between the undo and redo stacks.

    `take` is the stack to pop the snapshot from and `keep` the one that gets
    the current state, so undo and redo are the same operation mirrored.
    """
    with _HISTORY_LOCK:
        h = _history(name)
        snapshot = h[take].pop() if h[take] else None
        if snapshot is not None:
            h[keep].append(_layer_text(name))
            del h[keep][:-HISTORY_LIMIT]

    if snapshot is not None:
        _restore_layer(name, snapshot)

    stage = Usd.Stage.Open(project_setup(name))
    payload = _project_payload(name, stage, render_mode)
    payload["ok"] = True
    payload["stepped"] = snapshot is not None   # False = nothing left to do
    return jsonify(payload)


@app.post("/api/projects/<name>/undo")
def undo_project(name):
    """Rewind one editing step (#157). Returns the restored scene."""
    render_mode = (request.get_json(silent=True) or {}).get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")
    return _step_history(name, "undo", "redo", render_mode)


@app.post("/api/projects/<name>/redo")
def redo_project(name):
    render_mode = (request.get_json(silent=True) or {}).get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")
    return _step_history(name, "redo", "undo", render_mode)

@app.get("/api/projects/<name>")
def get_project(name):
    stage = Usd.Stage.Open(project_setup(name)) #name="project名"で、このprojectからsetup.usdaをusda形式でstageに読み込む
    render_mode = request.args.get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")
    return jsonify(_project_payload(name, stage, render_mode))


@app.post("/api/projects/<name>/board/model")
@records_history
def update_board_model(name):
    """Change the fixed board CAD reference without authoring a transform."""
    body = request.get_json(force=True)
    asset = body.get("asset")
    render_mode = body.get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")
    board_assets = {
        candidate for candidate in ol.cad_library_assets(LIB_DIR)
        if candidate.startswith("Breadboard/")
    }
    if not isinstance(asset, str) or asset not in board_assets:
        abort(400, "unknown breadboard asset")

    setup = project_setup(name)
    stage = Usd.Stage.Open(setup)
    board = stage.GetPrimAtPath(
        f"{stage.GetDefaultPrim().GetPath()}/Breadboard"
    )
    fixed = board.GetAttribute("optics:fixedBoard") if board else None
    if not board or not board.IsValid() or not fixed or not fixed.Get():
        abort(404, "project has no fixed breadboard")

    _replace_component_reference(board, asset, os.path.dirname(setup))
    stage.GetRootLayer().Save()
    payload = _project_payload(name, stage, render_mode)
    payload["ok"] = True
    return jsonify(payload)


@app.post("/api/projects/<name>/board")
@records_history
def update_board(name):
    """Resize each side of the breadboard and persist it in USD."""
    body = request.get_json(force=True)
    try:
        if all(key in body for key in (
            "extentXNegative",
            "extentXPositive",
            "extentYNegative",
            "extentYPositive",
        )):
            extent_x_negative = float(body["extentXNegative"])
            extent_x_positive = float(body["extentXPositive"])
            extent_y_negative = float(body["extentYNegative"])
            extent_y_positive = float(body["extentYPositive"])
        else:
            # Backward compatibility for clients that only send total sizes.
            size_x = float(body["sizeX"])
            size_y = float(body["sizeY"])
            extent_x_negative = extent_x_positive = size_x / 2.0
            extent_y_negative = extent_y_positive = size_y / 2.0
    except (KeyError, TypeError, ValueError):
        abort(400, "breadboard extents must be numbers")
    if not all(math.isfinite(value) for value in (
        extent_x_negative,
        extent_x_positive,
        extent_y_negative,
        extent_y_positive,
    )):
        abort(400, "breadboard extents must be finite")

    render_mode = body.get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")
    setup = project_setup(name)
    stage = Usd.Stage.Open(setup)
    _set_board_extents(
        stage,
        extent_x_negative,
        extent_x_positive,
        extent_y_negative,
        extent_y_positive,
    )
    stage.GetRootLayer().Save()

    payload = _project_payload(name, stage, render_mode)
    payload["ok"] = True
    return jsonify(payload)


@app.post("/api/projects/<name>/pins")
@records_history
def update_pins(name):
    body = request.get_json(force=True)
    pins = body.get("pins")
    if not isinstance(pins, list):
        abort(400, "pins must be a list")

    required = {"id", "label", "x", "y", "z", "authorName", "color", "createdAt"}
    if any(not isinstance(pin, dict) or not required.issubset(pin) for pin in pins):
        abort(400, "invalid pin")

    setup = project_setup(name)
    stage = Usd.Stage.Open(setup)
    attr = stage.GetDefaultPrim().GetAttribute("optics:pins")
    if not attr:
        attr = stage.GetDefaultPrim().CreateAttribute("optics:pins", Sdf.ValueTypeNames.String)
    attr.Set(json.dumps(pins, ensure_ascii=False))
    stage.GetRootLayer().Save()
    return jsonify(ok=True, pins=pins)


@app.post("/api/projects/<name>/callouts")
@records_history
def update_callouts(name):
    """Replace the whole figure-callout list (add / edit / drag / delete).

    Like pins and groups this is annotation, not scene data: it moves nothing on
    the bench. It is a whole-list replace because a drag rewrites one box and a
    delete removes one, and both are one undo step either way.
    """
    body = request.get_json(force=True)
    callouts = body.get("callouts")
    if not isinstance(callouts, list):
        abort(400, "callouts must be a list")

    setup = project_setup(name)
    stage = Usd.Stage.Open(setup)
    valid = {prim.GetName() for prim in _component_prims(stage)}

    clean, seen = [], set()
    for callout in callouts:
        one = _clean_callout(callout, valid)
        if one is None:
            abort(400, "invalid callout")
        if one["id"] in seen:
            abort(400, f"duplicate callout id: {one['id']}")
        seen.add(one["id"])
        clean.append(one)

    prim = stage.GetDefaultPrim()
    attr = prim.GetAttribute("optics:callouts")
    if not attr:
        attr = prim.CreateAttribute("optics:callouts", Sdf.ValueTypeNames.String)
    attr.Set(json.dumps(clean, ensure_ascii=False))
    stage.GetRootLayer().Save()
    return jsonify(ok=True, callouts=clean, **_history_state(name))


@app.post("/api/projects/<name>/groups")
@records_history
def update_groups(name):
    """Replace the whole group list (create / rename / ungroup all land here)."""
    body = request.get_json(force=True)
    groups = body.get("groups")
    if not isinstance(groups, list):
        abort(400, "groups must be a list")

    setup = project_setup(name)
    stage = Usd.Stage.Open(setup)
    valid = {prim.GetName() for prim in _component_prims(stage)}

    seen_ids, claimed = set(), set()
    for group in groups:
        if not isinstance(group, dict):
            abort(400, "invalid group")
        gid, gname, members = group.get("id"), group.get("name"), group.get("members")
        if not isinstance(gid, str) or not gid:
            abort(400, "group id must be a non-empty string")
        if gid in seen_ids:
            abort(400, f"duplicate group id: {gid}")
        if not isinstance(gname, str) or not gname:
            abort(400, "group name must be a non-empty string")
        if not isinstance(members, list) or len(members) < 2:
            abort(400, "a group needs at least two members")
        for member in members:
            if member not in valid:
                abort(400, f"no such component: {member}")
            if member in claimed:
                abort(400, f"component in two groups: {member}")
            claimed.add(member)
        seen_ids.add(gid)

    clean = _normalize_groups(groups, valid)
    _write_groups(stage, clean)
    stage.GetRootLayer().Save()
    return jsonify(ok=True, groups=clean)


@app.post("/api/projects/<name>/components/<comp>")
@records_history
def update_component(name, comp):
    if not SAFE.match(comp):
        abort(400)
    body = request.get_json(force=True)
    setup = project_setup(name)
    stage = Usd.Stage.Open(setup)
    prim = stage.GetPrimAtPath(f"{stage.GetDefaultPrim().GetPath()}/{comp}")
    if not prim or not prim.IsValid():
        abort(404, "no such component")
    x, y, z, rot_x, rot_y, rot_z = _placement_xform_values(prim)
    holder = _linked_holder(stage, prim)
    if holder:
        # A paired post has one degree of freedom: world Z relative to its
        # holder. X/Y and orientation are always derived from the holder.
        requested_z = _clamp_z(stage, body.get("z", z))
        hx, hy, hz, hrx, hry, hrz = _placement_xform_values(holder)
        dx, dy, dz = _rotate_local_offset(
            HOLDER_POST_HOLE_X_MM, 0.0, 0.0, hrx, hry, hrz
        )
        _set_custom_attr(
            prim, "holderZOffset_mm", float(requested_z - hz - dz),
            Sdf.ValueTypeNames.Double
        )
        _sync_linked_post(stage, holder)
    else:
        _set_xform(prim,
                   float(body.get("x", x)), float(body.get("y", y)),
                   _clamp_z(stage, body.get("z", z)),
                   float(body.get("rotX", rot_x)),
                   float(body.get("rotY", rot_y)),
                   float(body.get("rotZ", rot_z)))
        _sync_linked_post(stage, prim)
    stage.GetRootLayer().Save()

    render_mode = body.get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")
    payload = _move_payload(name, stage, render_mode)
    payload["ok"] = True
    return jsonify(payload)


@app.post("/api/projects/<name>/components/<comp>/model")
@records_history
def update_component_model(name, comp):
    """Change a holder/post catalogue model without changing its placement."""
    if not SAFE.match(comp):
        abort(400)
    body = request.get_json(force=True)
    asset = body.get("asset")
    render_mode = body.get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")
    if not isinstance(asset, str) or asset not in ol.component_library_assets():
        abort(400, "unknown asset")

    setup = project_setup(name)
    stage = Usd.Stage.Open(setup)
    prim = stage.GetPrimAtPath(f"{stage.GetDefaultPrim().GetPath()}/{comp}")
    if not prim or not prim.IsValid():
        abort(404, "no such component")

    current_type = prim.GetAttribute("optics:type").Get()
    if current_type not in ("holder", "post"):
        abort(400, "model selection is only available for holders and posts")
    if _catalog_asset_type(asset) != current_type:
        abort(400, "asset type does not match component type")

    _replace_component_reference(prim, asset, os.path.dirname(setup))
    # Re-derive the linked post pose after either member changes. The authored
    # placement and pairing attributes remain on the project prim.
    holder = prim if current_type == "holder" else _linked_holder(stage, prim)
    if holder:
        _sync_linked_post(stage, holder)
    stage.GetRootLayer().Save()

    payload = _project_payload(name, stage, render_mode)
    payload["ok"] = True
    return jsonify(payload)


@app.post("/api/projects/<name>/components/batch")
@records_history
def update_components(name):
    """Move several components in one save + one beam retrace.

    A group drag moves every member at once; sending them one at a time would
    re-save the layer and retrace the beam for each part.  Every name is
    resolved before anything is written, so a bad request leaves the layer
    untouched instead of half-applied.
    """
    body = request.get_json(force=True)
    updates = body.get("updates")
    if not isinstance(updates, list) or not updates:
        abort(400, "updates must be a non-empty list")

    render_mode = body.get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")

    setup = project_setup(name)
    stage = Usd.Stage.Open(setup)
    root = stage.GetDefaultPrim().GetPath()

    resolved, seen = [], set()
    for update in updates:
        if not isinstance(update, dict):
            abort(400, "invalid update")
        comp = update.get("name")
        if not isinstance(comp, str) or not SAFE.match(comp):
            abort(400, "bad component name")
        if comp in seen:
            abort(400, f"duplicate component: {comp}")
        prim = stage.GetPrimAtPath(f"{root}/{comp}")
        if not prim or not prim.IsValid():
            abort(404, f"no such component: {comp}")
        seen.add(comp)
        resolved.append((prim, update))

    for prim, update in resolved:
        x, y, z, rot_x, rot_y, rot_z = _placement_xform_values(prim)
        holder = _linked_holder(stage, prim)
        if holder:
            requested_z = _clamp_z(stage, update.get("z", z))
            _, _, hz, hrx, hry, hrz = _placement_xform_values(holder)
            _, _, dz = _rotate_local_offset(
                HOLDER_POST_HOLE_X_MM, 0.0, 0.0, hrx, hry, hrz
            )
            _set_custom_attr(
                prim, "holderZOffset_mm", float(requested_z - hz - dz),
                Sdf.ValueTypeNames.Double
            )
        else:
            _set_xform(prim,
                       float(update.get("x", x)), float(update.get("y", y)),
                       _clamp_z(stage, update.get("z", z)),
                       float(update.get("rotX", rot_x)),
                       float(update.get("rotY", rot_y)),
                       float(update.get("rotZ", rot_z)))
    # Synchronize after all requested holder poses and post Z offsets have
    # landed, making batch result independent of request order.
    for prim in _component_prims(stage):
        if _string_attr(prim, "pairedPost"):
            _sync_linked_post(stage, prim)
    stage.GetRootLayer().Save()

    payload = _move_payload(name, stage, render_mode)
    payload["ok"] = True
    return jsonify(payload)


@app.post("/api/projects/<name>/add")
@records_history
def add_component(name):
    body = request.get_json(force=True)
    asset = body.get("asset", "")
    component_path = uu.get_component_name(asset)
    library_assets = ol.component_library_assets()
    library_asset = (
        asset if asset in library_assets else f"{component_path}.usda"
    )
    if library_asset not in library_assets:
        abort(400, "unknown asset")
    default_name = os.path.basename(component_path)
    comp_name = body.get("name") or default_name
    comp_name = re.sub(r"[^A-Za-z0-9_]", "_", comp_name)
    setup = project_setup(name)
    proj_dir = os.path.dirname(setup)
    stage = Usd.Stage.Open(setup)
    root = str(stage.GetDefaultPrim().GetPath())
    comp_name = _unique_component_name(stage, root, comp_name)
    rel = uu.get_relative_component_usda_path(
        LIB_DIR,
        component_path,
        proj_dir,
    )
    # Sit the new part ON the board, not halfway through it: an optic is
    # modelled about its optical centre, so the bare placement z buried the
    # lower half of it in the breadboard.  Only the inserted translate moves --
    # the part keeps the authored origin that zoom framing and grouping read.
    drop_z = _clamp_z(
        stage, _board_top(stage) + _library_base_offset_mm(library_asset)
    )
    ol.place(stage, root, comp_name, rel,
             float(body.get("x", 0)), float(body.get("y", 0)), drop_z)
    post_component = _matching_post_component(component_path)
    if post_component:
        post_name = f"{comp_name}_Post"
        base, i = post_name, 1
        while stage.GetPrimAtPath(f"{root}/{post_name}").IsValid():
            i += 1
            post_name = f"{base}_{i}"
        post_rel = uu.get_relative_component_usda_path(
            LIB_DIR, post_component, proj_dir
        )
        post = ol.place(
            stage, root, post_name, post_rel,
            float(body.get("x", 0)), float(body.get("y", 0)),
            _clamp_z(
                stage,
                _board_top(stage)
                + _library_base_offset_mm(f"{post_component}.usda"),
            ),
        )
        holder = stage.GetPrimAtPath(f"{root}/{comp_name}")
        _set_custom_attr(holder, "pairedPost", post_name)
        _set_custom_attr(post, "pairedHolder", comp_name)
        _set_custom_attr(
            post, "holderZOffset_mm", 0.0, Sdf.ValueTypeNames.Double
        )
        _sync_linked_post(stage, holder)
    stage.GetRootLayer().Save()
    
    return jsonify(ok=True, name=comp_name)


@app.post("/api/projects/<name>/components/duplicate")
@records_history
def duplicate_components(name):
    """Copy components into a project — the paste half of copy & paste (#155).

    Body: {names: [...], sourceProject?, offsetX?, offsetY?, renderMode?}

    The prim *spec* is copied rather than the library asset re-placed, so the
    reference and every authored override (z, rotations, per-instance optics:
    attributes) come along; a fresh /add would drop all of them. Offsets
    default to one breadboard hole diagonally so the copy lands on-grid and
    visibly beside the original.

    `sourceProject` copies out of another project instead of this one, which is
    how a selection copied in project1 pastes into project2 (#155). Only this
    project is written to (and so only its history records a step); the source
    is opened read-only.
    """
    body = request.get_json(force=True)
    names = body.get("names")
    if not isinstance(names, list) or not names:
        abort(400, "names must be a non-empty list")
    render_mode = body.get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")
    offset_x = float(body.get("offsetX", ol.GRID_MM))
    offset_y = float(body.get("offsetY", ol.GRID_MM))
    source_project = body.get("sourceProject") or name
    if not isinstance(source_project, str):
        abort(400, "sourceProject must be a string")

    setup = project_setup(name)
    stage = Usd.Stage.Open(setup)
    layer = stage.GetRootLayer()
    root = str(stage.GetDefaultPrim().GetPath())

    if source_project == name:
        src_stage, src_layer, src_root = stage, layer, root
    else:
        src_stage = Usd.Stage.Open(project_setup(source_project))
        src_layer = src_stage.GetRootLayer()
        src_root = str(src_stage.GetDefaultPrim().GetPath())

    # Validate every source up front so a bad name writes nothing (as /batch does).
    sources = []
    for comp in names:
        if not isinstance(comp, str) or not SAFE.match(comp):
            abort(400, "bad component name")
        path = f"{src_root}/{comp}"
        if not src_stage.GetPrimAtPath(path).IsValid():
            abort(404, f"no such component: {source_project}/{comp}")
        if src_layer.GetPrimAtPath(path) is None:
            abort(400, f"{comp} is not authored in {source_project}'s layer")
        if comp not in sources:
            sources.append(comp)

    name_map = {}
    for comp in sources:
        # A trailing _<n> is a previous copy's suffix — count on from it
        # instead of stacking suffixes (Lens_2 -> Lens_3, not Lens_2_2).
        stem = re.sub(r"_\d+$", "", comp) or comp
        copy_name = _unique_component_name(stage, root, stem,
                                           taken=set(name_map.values()))
        Sdf.CopySpec(src_layer, Sdf.Path(f"{src_root}/{comp}"),
                     layer, Sdf.Path(f"{root}/{copy_name}"))
        if src_layer is not layer:
            _rebase_asset_paths(layer, Sdf.Path(f"{root}/{copy_name}"), src_layer)
        name_map[comp] = copy_name

    for comp, copy_name in name_map.items():
        source = src_stage.GetPrimAtPath(f"{src_root}/{comp}")
        x, y, z, rot_x, rot_y, rot_z = _placement_xform_values(source)
        _set_xform(stage.GetPrimAtPath(f"{root}/{copy_name}"),
                   x + offset_x, y + offset_y, _clamp_z(stage, z),
                   rot_x, rot_y, rot_z)

    _relink_paired_copies(stage, root, name_map)

    groups = _groups(stage)
    merged = _groups_with_copies(groups, name_map,
                                 None if src_stage is stage else _groups(src_stage))
    if merged != groups:
        _write_groups(stage, merged)

    layer.Save()

    payload = _project_payload(name, stage, render_mode)
    payload["ok"] = True
    payload["names"] = [name_map[comp] for comp in sources]
    return jsonify(payload)


@app.post("/api/projects/<name>/delete/<comp>")
@records_history
def delete_component(name, comp):
    if not SAFE.match(comp):
        abort(400)
    setup = project_setup(name)
    stage = Usd.Stage.Open(setup)
    path = f"{stage.GetDefaultPrim().GetPath()}/{comp}"
    if not stage.GetPrimAtPath(path).IsValid():
        abort(404)
    prim = stage.GetPrimAtPath(path)
    paired_post = _string_attr(prim, "pairedPost")
    paired_holder = _string_attr(prim, "pairedHolder")
    stage.RemovePrim(path)
    if paired_post:
        paired_path = f"{stage.GetDefaultPrim().GetPath()}/{paired_post}"
        if stage.GetPrimAtPath(paired_path).IsValid():
            stage.RemovePrim(paired_path)
    elif paired_holder:
        holder = stage.GetPrimAtPath(
            f"{stage.GetDefaultPrim().GetPath()}/{paired_holder}"
        )
        if holder and holder.IsValid():
            attr = holder.GetAttribute("optics:pairedPost")
            if attr:
                attr.Clear()
    # The removed part may still be listed in a group; _groups() prunes it and
    # drops any group left empty, so re-author the normalized list.
    groups_before = stage.GetDefaultPrim().GetAttribute("optics:groups")
    if groups_before and groups_before.HasAuthoredValue():
        _write_groups(stage, _groups(stage))
    stage.GetRootLayer().Save()
    
    return jsonify(ok=True)


@app.post("/api/projects/<name>/lasers")
@records_history
def switch_lasers(name):
    """Switch lasers on or off.

    A laser that is off emits nothing, so the bench goes dark: no beam in 3D,
    none in the diagram, and nothing to shape. Body: {on: bool} for every laser
    in the project, or {on: bool, names: [...]} for particular ones.
    """
    body = request.get_json(force=True)
    if not isinstance(body.get("on"), bool):
        abort(400, "on must be true or false")
    on = body["on"]

    render_mode = body.get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")

    names = body.get("names")
    if names is not None and (
        not isinstance(names, list)
        or not all(isinstance(n, str) and SAFE.match(n) for n in names)
    ):
        abort(400, "names must be a list of component names")

    stage = Usd.Stage.Open(project_setup(name))
    switched = []
    for prim in _component_prims(stage):
        if prim.GetAttribute("optics:type").Get() not in beam_tracer.EMITTER_TYPES:
            continue
        if names is not None and prim.GetName() not in names:
            continue
        _set_custom_attr(prim, "laserOn", on, Sdf.ValueTypeNames.Bool)
        switched.append(prim.GetName())

    if names is not None and not switched:
        abort(404, "no such laser")

    stage.GetRootLayer().Save()

    payload = _project_payload(name, stage, render_mode)
    payload["ok"] = True
    payload["switched"] = switched
    return jsonify(payload)


@app.post("/api/projects/<name>/beam/shape")
@records_history
def set_beam_shape(name):
    """Set or clear the drawn width of one beam leg.

    Body: {key, wIn, wOut} to shape a leg, or {key, clear: true} to hand it
    back to the default. Widths are the full drawn width in mm at each end of
    the leg: equal makes a parallel block, unequal a wedge. This is the
    planning sketch only — it changes no component and no other leg.
    """
    body = request.get_json(force=True)
    key = body.get("key")
    if not isinstance(key, str) or not key.strip():
        abort(400, "key must be a non-empty string")

    render_mode = body.get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")

    setup = project_setup(name)
    stage = Usd.Stage.Open(setup)
    shape = _beam_shape(stage)

    if body.get("clear"):
        shape.pop(key, None)
    else:
        low, high = BEAM_WIDTH_RANGE_MM
        widths = {}
        for field in ("wIn", "wOut"):
            try:
                value = float(body[field])
            except (KeyError, TypeError, ValueError):
                abort(400, f"{field} must be a number")
            if not math.isfinite(value) or not low <= value <= high:
                abort(400, f"{field} must be between {low} and {high} mm")
            widths[field] = round(value, 4)

        # How far the beam is drawn along this leg. Purely how it is sketched:
        # it moves nothing, so setting it never shoves the optic at the far end
        # (a camera, say) down the bench.
        if body.get("lengthMm") is not None:
            try:
                draw_length = float(body["lengthMm"])
            except (TypeError, ValueError):
                abort(400, "lengthMm must be a number")
            if not math.isfinite(draw_length) or not 0 < draw_length <= BEAM_MAX_DRAW_MM:
                abort(400, f"lengthMm must be between 0 and {BEAM_MAX_DRAW_MM} mm")
            widths["lengthMm"] = round(draw_length, 3)

        # Optional pinch point, for a leg drawn as a focus rather than a wedge.
        if body.get("waistW") is not None:
            try:
                waist_w = float(body["waistW"])
                waist_at = float(body.get("waistAt", 0.5))
            except (TypeError, ValueError):
                abort(400, "waistW and waistAt must be numbers")
            if not math.isfinite(waist_w) or not low <= waist_w <= high:
                abort(400, f"waistW must be between {low} and {high} mm")
            if not math.isfinite(waist_at) or not 0.0 < waist_at < 1.0:
                abort(400, "waistAt must be between 0 and 1 (exclusive)")
            widths["waistW"] = round(waist_w, 4)
            widths["waistAt"] = round(waist_at, 4)

        shape[key] = widths

    prim = stage.GetDefaultPrim()
    attr = prim.GetAttribute("optics:beamShape")
    if not attr:
        attr = prim.CreateAttribute("optics:beamShape", Sdf.ValueTypeNames.String)
    attr.Set(json.dumps(shape, sort_keys=True))
    stage.GetRootLayer().Save()

    # A shape edit is a drag on the width bars, and changes only the beam --
    # the same subset a move does, so it takes the same light payload.
    payload = _move_payload(name, stage, render_mode)
    payload["ok"] = True
    return jsonify(payload)


@app.post("/api/projects/<name>/beam/pin")
@records_history
def pin_beam_node(name):
    """Set or clear a pin override on a specific beam node.

    Body: {segment: int, node: int, position: [x,y,z] | null}
    A non-null position pins the vertex to that coordinate (ignoring the
    component's live position). null clears the pin (auto mode resumes).
    """
    body = request.get_json(force=True)
    seg_idx = int(body.get("segment", 0))
    node_idx = int(body.get("node", 0))
    position = body.get("position")  # list[float] or None

    setup = project_setup(name)
    stage = Usd.Stage.Open(setup)
    bp_attr = stage.GetDefaultPrim().GetAttribute("optics:beamPath")
    if not bp_attr or not bp_attr.HasAuthoredValue():
        abort(404, "project has no beam path")

    segs = json.loads(bp_attr.Get())
    if seg_idx >= len(segs) or node_idx >= len(segs[seg_idx]):
        abort(400, "segment or node index out of range")

    node = segs[seg_idx][node_idx]
    # Normalise node to dict form
    if isinstance(node, str):
        node = {"ref": node}
    if position is None:
        node.pop("pin", None)  # clear pin → auto
    else:
        node["pin"] = [round(float(v), 3) for v in position[:3]]
    segs[seg_idx][node_idx] = node

    bp_attr.Set(json.dumps(segs))
    stage.GetRootLayer().Save()

    return jsonify(ok=True)


# -------------------------------------------------------------------------
# Paraxial (ABCD) beam simulation
# -------------------------------------------------------------------------

def _find_components_on_segment(comps_by_name, pos_a, pos_b, tolerance=8.0):
    """Components whose (x,y) lies on the segment from pos_a to pos_b.
    Returns list of (t_along, name, comp) sorted by distance from pos_a,
    excluding the endpoints themselves."""
    ax, ay = pos_a[0], pos_a[1]
    bx, by = pos_b[0], pos_b[1]
    dx, dy = bx - ax, by - ay
    length = math.sqrt(dx * dx + dy * dy)
    if length < 1e-4:
        return []
    ux, uy = dx / length, dy / length
    nx, ny = -uy, ux
    result = []
    for name, c in comps_by_name.items():
        cx, cy = c["x"], c["y"]
        t = (cx - ax) * ux + (cy - ay) * uy
        perp = abs((cx - ax) * nx + (cy - ay) * ny)
        if 1e-3 < t < length - 1e-3 and perp < tolerance:
            result.append((t, name, c))
    result.sort()
    return result


def _paraxial_segments(stage, comps_by_name, w0_mm=0.0025):
    """Gaussian beam propagation via ABCD matrices along the beam path.

    w0_mm: input beam waist radius in mm (default 0.0025 = 2.5 µm fiber tip).
    Returns list of {pts, widths, wavelength, info} — widths are beam radii in mm.
    info contains per-element physics stats computed entirely server-side.
    """
    # Per-segment wavelengths from BasisCurves prims
    seg_wavelengths = []
    for prim in stage.Traverse():
        if prim.IsA(UsdGeom.BasisCurves):
            wl_attr = prim.GetAttribute("optics:beam:wavelength")
            seg_wavelengths.append(
                float(wl_attr.Get()) if wl_attr and wl_attr.HasAuthoredValue() else 532.0)

    wavelength_nm = seg_wavelengths[0] if seg_wavelengths else 532.0
    wavelength_mm = wavelength_nm * 1e-6  # nm → mm
    z_R0 = math.pi * w0_mm ** 2 / wavelength_mm
    q = complex(0.0, z_R0)  # complex beam parameter at fiber waist

    bp_attr = stage.GetDefaultPrim().GetAttribute("optics:beamPath")
    if not bp_attr or not bp_attr.HasAuthoredValue():
        return []
    raw_segs = json.loads(bp_attr.Get())

    def beam_width(q_val):
        try:
            inv_q = 1.0 / q_val
            w2 = -wavelength_mm / (math.pi * inv_q.imag)
            return round(math.sqrt(max(w2, 1e-5)), 5)
        except Exception:
            return w0_mm

    def focal_length(comp):
        t = comp.get("type", "")
        if t in ("lens", "cylindrical_lens", "eyepiece"):
            f = comp.get("attrs", {}).get("focalLength_mm")
            return float(f) if f else None
        return None

    def _make_element_stat(comp, q_before, q_after):
        """Physics summary for one optical element at the current q state."""
        stat = {
            "name": comp["name"],
            "type": comp.get("type", "unknown"),
            "w_in_mm": beam_width(q_before),
        }
        f = focal_length(comp)
        if f:
            # After the lens: new Rayleigh range = Im(q_after)
            z_R_new = abs(q_after.imag)
            # Distance from this lens to the next beam waist = -Re(q_after)
            # (positive means waist is downstream of the lens)
            z_waist = -q_after.real
            # Beam radius at the next waist = sqrt(λ * z_R_new / π)
            w_waist = math.sqrt(max(wavelength_mm * z_R_new / math.pi, 1e-10))
            # Half-angle divergence after this lens θ = λ/(π·w_waist) [rad]
            div_mrad = wavelength_mm / (math.pi * w_waist) * 1000.0
            stat.update({
                "w_out_mm": beam_width(q_after),
                "focal_length_mm": f,
                "z_R_after_mm": round(z_R_new, 3),
                "z_waist_mm": round(z_waist, 2),
                "w_waist_mm": round(w_waist, 5),
                "divergence_after_mrad": round(div_mrad, 4),
            })
        return stat

    N = 20  # sample points between consecutive optical elements

    result = []
    for si, seg_nodes in enumerate(raw_segs):
        wl = seg_wavelengths[si] if si < len(seg_wavelengths) else 532.0

        anchors = _resolve_beam_nodes(seg_nodes, comps_by_name)
        if len(anchors) < 2:
            continue

        pts_out, widths_out = [], []
        element_stats = []
        anchor_names = {n["ref"] for n in anchors if n["ref"]}

        # Emit first anchor, apply its ABCD
        a0 = anchors[0]
        pts_out.append([round(v, 2) for v in a0["pos"]])
        widths_out.append(beam_width(q))
        q_before_a0 = q
        if a0["comp"]:
            f0 = focal_length(a0["comp"])
            if f0:
                q = q / (1.0 - q / f0)
            element_stats.append(_make_element_stat(a0["comp"], q_before_a0, q))

        for ai in range(1, len(anchors)):
            prev_node, curr_node = anchors[ai - 1], anchors[ai]
            pos_prev = prev_node["pos"]
            pos_curr = curr_node["pos"]

            # Find intermediate optics on this gap (e.g. CollimLens between Laser and BS)
            ints = [(t, n, c) for t, n, c in
                    _find_components_on_segment(comps_by_name, pos_prev, pos_curr)
                    if n not in anchor_names]

            stops = []
            for _, _, ic in ints:
                center = _component_beam_point(ic)
                stops.append((ic, _project_point_to_line(center, pos_prev, pos_curr)))
            stops.append((curr_node["comp"], pos_curr))

            from_pos = pos_prev
            for stop_comp, stop_pos in stops:
                d = math.dist(stop_pos, from_pos)
                if d < 0.01:
                    continue
                # Sample N points from from_pos to stop_pos
                for s in range(1, N + 1):
                    tf = s / N
                    spt = [from_pos[j] + tf * (stop_pos[j] - from_pos[j]) for j in range(3)]
                    pts_out.append([round(v, 2) for v in spt])
                    widths_out.append(beam_width(q + tf * d))
                # Advance q: free space then lens (if any)
                q = q + d
                q_before_stop = q
                if stop_comp:
                    f = focal_length(stop_comp)
                    if f:
                        q = q / (1.0 - q / f)
                    element_stats.append(_make_element_stat(stop_comp, q_before_stop, q))
                from_pos = stop_pos

        # Half-angle divergence of the input beam (before any optics)
        div_input_mrad = round(wavelength_mm / (math.pi * w0_mm) * 1000.0, 3)

        info = {
            "w0_mm": w0_mm,
            "z_R0_mm": round(z_R0, 4),
            "divergence_input_mrad": div_input_mrad,
            "w_final_mm": widths_out[-1] if widths_out else w0_mm,
            "elements": element_stats,
        }
        result.append({"pts": pts_out, "widths": widths_out, "wavelength": wl, "info": info})

    return result


@app.get("/api/projects/<name>/beam/paraxial")
def get_paraxial_beam(name):
    """Gaussian beam width along the beam path (ABCD matrix propagation).
    Query param: w0 — initial beam waist radius in mm (default 0.0025 = 2.5 µm fiber)."""
    w0 = float(request.args.get("w0", 0.0025))
    stage = Usd.Stage.Open(project_setup(name))
    comps = []
    for prim in _component_prims(stage):
        x, y, z, rot_x, rot_y, rot_z = _placement_xform_values(prim)
        t_val = prim.GetAttribute("optics:type").Get()
        comps.append(dict(name=prim.GetName(), type=t_val,
                          x=round(x, 3), y=round(y, 3), z=round(z, 3),
                          rotX=round(rot_x, 3), rotY=round(rot_y, 3),
                          rotZ=round(rot_z, 3), attrs=_optics_attrs(prim)))
    comps_by_name = {c["name"]: c for c in comps}
    segments = _paraxial_segments(stage, comps_by_name, w0_mm=w0)
    return jsonify(segments=segments)


# -------------------------------------------------------------------------
# Static: serve the built React app (app/dist) in production; fall back to the
# plain-HTML MVP (web/) if it hasn't been built. Plus the generated glbs.
# -------------------------------------------------------------------------
APP_DIST = os.path.join(ROOT_DIR, "app", "dist")


@app.get("/")
def index():
    if os.path.exists(os.path.join(APP_DIST, "index.html")):
        return send_from_directory(APP_DIST, "index.html")
    return send_from_directory(WEB_DIR, "editor.html")


@app.get("/api/library/preview/<path:asset>")
def library_preview(asset):
    """One catalogue part's geometry, for a part-browser thumbnail.

    Deliberately one asset per request rather than a hi-res catalogue in the
    project payload: the browser draws each tile once and keeps the picture, so
    the several hundred kB of a hi asset is paid once and thrown away, instead
    of being carried by every project load.

    Served gzipped and cached. A hi asset is ~940 kB of vertex floats as JSON
    and the catalogue is 86 of them, so filling the part browser moved ~81 MB
    over the wire — which was the whole reason it took minutes, not the drawing.
    Float text compresses ~6x, and the bytes are identical for every user and
    every project, so they are built once and held.
    """
    if asset not in ol.component_library_assets(LIB_DIR):
        abort(404)
    render_mode = "hi" if request.args.get("renderMode") == "hi" else "lo"
    body = _library_preview_body(asset, render_mode)
    if body is None:
        abort(404)
    payload, compressed = body

    # Every browser sends gzip, but a curl or a test client may not, and a body
    # it cannot read is worse than a slow one.
    if compressed and "gzip" not in request.headers.get("Accept-Encoding", ""):
        payload, compressed = gzip.decompress(payload), False

    response = app.response_class(payload, mimetype="application/json")
    if compressed:
        response.headers["Content-Encoding"] = "gzip"
    # The catalogue's own key already changes when a part's CAD or photo does,
    # so a stale tile cannot outlive an import.
    response.headers["Vary"] = "Accept-Encoding"
    return response


# (asset, render_mode) -> (gzipped json, True). Bounded by the catalogue size;
# ~13 MB compressed for all 86 hi assets, against the ~81 MB it saves sending.
_PREVIEW_BODY_CACHE = {}
_PREVIEW_BODY_KEY = None


def _library_preview_body(asset, render_mode):
    """The response bytes for one preview, gzipped, built at most once."""
    global _PREVIEW_BODY_CACHE, _PREVIEW_BODY_KEY

    key = _library_preview_key()
    if _PREVIEW_BODY_KEY != key:
        # A part was re-imported: every cached body is now potentially stale.
        _PREVIEW_BODY_CACHE = {}
        _PREVIEW_BODY_KEY = key

    entry = _PREVIEW_BODY_CACHE.get((asset, render_mode))
    if entry is None:
        component = _build_library_preview(asset, render_mode)
        if component is None:
            return None
        raw = json.dumps({"component": component}).encode("utf-8")
        # Level 6 is ~44 ms for the largest asset and within a few percent of
        # the ratio at 9; the difference is not worth the CPU on a lab server.
        entry = (gzip.compress(raw, 6), True)
        _PREVIEW_BODY_CACHE[(asset, render_mode)] = entry
    return entry


@app.get("/api/library/photo/<path:component>")
def library_photo(component):
    """The optional real photograph of a catalogue part, for the part browser."""
    path = _library_photo_path(uu.get_component_name(component))
    if not path:
        abort(404)
    # `component` comes off the URL, so confirm the file really is inside the
    # catalogue before serving it rather than trusting the joined path.
    library_root = os.path.realpath(LIB_DIR)
    real_path = os.path.realpath(path)
    if os.path.commonpath((library_root, real_path)) != library_root:
        abort(404)
    return send_from_directory(
        os.path.dirname(real_path),
        os.path.basename(real_path),
        max_age=86400,
    )


@app.get("/model/<name>.glb")
def model(name):
    if not SAFE.match(name):
        abort(400)
    if os.path.exists(project_setup(name)):
        rebuild_glb_if_stale(name)      # editing routes no longer pre-build it
    return send_from_directory(BUILD_DIR, f"{name}.glb")


@app.get("/<path:f>")
def static_file(f):
    # built React assets/models first, else the old web/ MVP
    if os.path.exists(os.path.join(APP_DIST, f)):
        return send_from_directory(APP_DIST, f)
    return send_from_directory(WEB_DIR, f)


if __name__ == "__main__":
    print("OpticalTwin -> http://0.0.0.0:8000/")
    app.run(
        host="0.0.0.0",
        port=8000,
        debug=False,
        threaded=True,
        use_reloader=os.environ.get("OT_DEV_RELOAD") == "1",
    )
