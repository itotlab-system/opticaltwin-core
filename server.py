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
import hmac
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
ROD_CAD_DIR = os.path.join(ROOT_DIR, "cad", "Rod")
Z_MAX_MM = 300.0        # component height ceiling; mirrors the app's drag limit
os.makedirs(BUILD_DIR, exist_ok=True)
_ROD_SYNC_LOCK = threading.Lock()


def _sync_rod_catalog():
    """Generate missing or stale nested Rod assets from cad/Rod STEP files."""
    if not os.path.isdir(ROD_CAD_DIR):
        return
    with _ROD_SYNC_LOCK:
        stale_steps = []
        for filename in sorted(os.listdir(ROD_CAD_DIR)):
            step_path = os.path.join(ROD_CAD_DIR, filename)
            stem, extension = os.path.splitext(filename)
            if (
                not os.path.isfile(step_path)
                or extension.lower() not in (".step", ".stp")
            ):
                continue
            component_dir = os.path.join(LIB_DIR, "Rod", stem)
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
            cad_importer.main([
                step_path,
                "--type", "rod",
                "--lod", "both",
                "--component-name", f"Rod/{stem}",
                "--source-forward-axis", "+Y",
            ])

# New projects only offer an empty breadboard, or a clone of project1's
# *current* 4f setup, for now (see #88): the demo templates (slm_imaging/
# two_lens) bake a static beam path that goes stale as soon as components
# move. tpl.TEMPLATES itself is untouched so existing tooling
# (setup_projects.py) keeps working. setup_projects.CLONE_TEMPLATES supplies
# the "4f_default" option, which is built by copying project1/setup.usda
# rather than replaying the buggy recipe.
NEW_PROJECT_TEMPLATE_KEYS = ("blank",)

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
    return jsonify(ok=False, error="パスワードが違います。"), 401


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
    if request.path.startswith("/api/"):
        # Scene geometry changes frequently while editing. Never let a browser
        # reuse beam data calculated before a component move or server reload.
        resp.headers["Cache-Control"] = "no-store"
    return resp


def project_setup(name):
    if not SAFE.match(name):
        abort(400, "bad project name")
    path = os.path.join(PROJECTS_DIR, name, "setup.usda")
    if not os.path.exists(path):
        abort(404, "no such project")
    uu.normalize_component_references_in_usda(path)
    return path


def _component_prims(stage):
    """Top-level placed components = prims that carry an optics:type."""
    out = []
    for prim in stage.Traverse():
        t = prim.GetAttribute("optics:type")
        if t and t.HasAuthoredValue() and prim.GetParent() == stage.GetDefaultPrim():
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


def _component_model_pose(stage, component_prim):
    """Return asset-authored rotations and the geometry center they pivot on.

    Project placement transforms live on the referencing prim and are handled
    separately by ``x/y/z/rotZ``.  These values come from the component asset
    itself, so editing xformOp:rotateX/Y/Z in hi.usda or lo.usda changes the
    model orientation without moving its center in the viewport.
    """
    rotations = []
    for axis in ("X", "Y", "Z"):
        attr = component_prim.GetAttribute(f"xformOp:rotate{axis}")
        rotations.append(
            float(attr.Get() or 0.0)
            if attr and attr.HasAuthoredValue()
            else 0.0
        )

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

    if component.get("type") == "laser":
        # CAD laser metadata describes the complete X extent including its
        # output barrel.  The beam starts at that positive-X face.
        size_x = attrs.get("sizeX_mm")
        if size_x is not None:
            result["emissionOffset_mm"] = float(size_x) / 2.0
        else:
            result["emissionOffset_mm"] = LASER_APERTURE_OFFSET_MM

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


def _library_previews():
    """CAD catalogue geometry used by the placement ghost before insertion."""
    previews = {}
    for asset in sorted(ol.cad_library_assets(LIB_DIR)):
        component_name = uu.get_component_name(asset)
        path = uu.get_component_usda_path(LIB_DIR, component_name)
        stage = Usd.Stage.Open(path)
        if stage is None or not stage.GetDefaultPrim().IsValid():
            continue
        root = stage.GetDefaultPrim()
        component = {
            "name": component_name,
            "type": root.GetAttribute("optics:type").Get(),
            "x": 0,
            "y": 0,
            "z": 0,
            "rotZ": 0,
            "attrs": _optics_attrs(root),
            "asset": asset,
            "cadDerived": True,
        }
        meshes = _component_meshes(stage, root)
        primitives = _component_primitives(stage, root)
        if meshes:
            component["meshes"] = meshes
        if primitives:
            component["primitives"] = primitives
        component.update(_component_model_pose(stage, root))
        component["physics"] = _beam_physics_metadata(component)
        previews[asset] = component
    return previews


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


def _component_beam_point(comp):
    """Return the optical centerline point for a component."""
    if comp.get("type") == "laser":
        a = math.radians(float(comp.get("rotZ", 0.0)))
        return [
            float(comp["x"]) + math.cos(a) * LASER_APERTURE_OFFSET_MM,
            float(comp["y"]) + math.sin(a) * LASER_APERTURE_OFFSET_MM,
            float(comp["z"]),
        ]
    return [float(comp["x"]), float(comp["y"]), float(comp["z"])]


def _component_forward(comp):
    a = math.radians(float(comp.get("rotZ", 0.0)))
    return [math.cos(a), math.sin(a), 0.0]


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
        if comp.get("type") == "laser" and name not in excluded
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

def _board(stage):
    """Breadboard extent + hole positions (for the fixed base + physical grid)."""
    holes, htop = [], None
    for prim in stage.Traverse():
        if prim.IsA(UsdGeom.PointInstancer):
            pi = UsdGeom.PointInstancer(prim)
            for p in pi.GetPositionsAttr().Get() or []:
                holes.append([round(p[0], 1), round(p[1], 1)])
                htop = float(p[2]) if htop is None else htop
    bbox = None
    for prim in stage.Traverse():
        if prim.GetName() == "Breadboard" and prim.IsA(UsdGeom.Cube):
            wb = UsdGeom.BBoxCache(Usd.TimeCode.Default(),
                                   [UsdGeom.Tokens.default_]).ComputeWorldBound(prim)
            r = wb.ComputeAlignedRange()   # world-space axis-aligned box
            mn, mx = r.GetMin(), r.GetMax()
            bbox = dict(min=[round(mn[0], 1), round(mn[1], 1), round(mn[2], 1)],
                        max=[round(mx[0], 1), round(mx[1], 1), round(mx[2], 1)])
    return dict(holes=holes, holeZ=htop, bbox=bbox)

def _xform_values(prim):
    xf = UsdGeom.Xformable(prim)
    x = y = z = rot = 0.0
    for op in xf.GetOrderedXformOps():
        n = op.GetOpName()
        if n == "xformOp:translate":
            v = op.Get()
            if v:
                x, y, z = float(v[0]), float(v[1]), float(v[2])
        elif n == "xformOp:rotateZ":
            rot = float(op.Get() or 0.0)
    return x, y, z, rot

def _board_top(stage):
    """Top surface z of the breadboard — components rest on or above it."""
    for prim in stage.Traverse():
        if prim.GetName() == "Breadboard" and prim.IsA(UsdGeom.Cube):
            wb = UsdGeom.BBoxCache(Usd.TimeCode.Default(),
                                   [UsdGeom.Tokens.default_]).ComputeWorldBound(prim)
            return float(wb.ComputeAlignedRange().GetMax()[2])
    return 0.0

def _clamp_z(stage, z):
    """Keep a component out of the board and inside the scene."""
    return min(Z_MAX_MM, max(_board_top(stage), float(z)))

def _set_xform(prim, x, y, z, rot):
    """Rewrite a component's translate (+ optional rotateZ) cleanly."""
    xf = UsdGeom.Xformable(prim)
    ops = {op.GetOpName(): op for op in xf.GetOrderedXformOps()}
    if "xformOp:translate" in ops:
        ops["xformOp:translate"].Set(Gf.Vec3d(x, y, z))
        t = ops["xformOp:translate"]
    else:
        t = xf.AddTranslateOp()
        t.Set(Gf.Vec3d(x, y, z))
    order = [t.GetOpName()]
    if "xformOp:rotateZ" in ops:
        ops["xformOp:rotateZ"].Set(float(rot))
        order.append("xformOp:rotateZ")
    elif rot:
        r = xf.AddRotateZOp()
        r.Set(float(rot))
        order.append(r.GetOpName())
    xf.SetXformOpOrder([op for op in xf.GetOrderedXformOps()
                        if op.GetOpName() in order])

def rebuild_glb(name):
    setup = project_setup(name)
    usd_to_web.convert(setup, os.path.join(BUILD_DIR, f"{name}.glb"))
    
# -------------------------------------------------------------------------
# API
# -------------------------------------------------------------------------
def _project_summary(name):
    """Lightweight info for the gallery: component count + the types present."""
    stage = Usd.Stage.Open(os.path.join(PROJECTS_DIR, name, "setup.usda"))
    types = [p.GetAttribute("optics:type").Get() for p in _component_prims(stage)]
    return dict(name=name, components=len(types), types=types)


def _project_components(stage, render_mode="lo"):
    if render_mode not in ("hi", "lo"):
        raise ValueError("render_mode must be 'hi' or 'lo'")
    comps = []
    cad_assets = ol.cad_library_assets(LIB_DIR)
    for prim in _component_prims(stage):
        x, y, z, rot = _xform_values(prim)
        t = prim.GetAttribute("optics:type").Get()
        asset = _component_asset_name(prim)
        geometry_stage = stage
        geometry_root = prim
        attrs = _optics_attrs(prim)
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
                         rotZ=round(rot, 3), attrs=_optics_attrs(prim),
                         asset=asset,
                         cadDerived=asset in cad_assets,
                         renderMode=render_mode)
        component["attrs"] = attrs
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


def _pins(stage):
    attr = stage.GetDefaultPrim().GetAttribute("optics:pins")
    if not attr or not attr.HasAuthoredValue():
        return []
    try:
        pins = json.loads(attr.Get())
        return pins if isinstance(pins, list) else []
    except (TypeError, json.JSONDecodeError):
        return []


def _resolved_project_beam(stage, comps_by_name, beam_path):
    traced = beam_tracer.trace_lasers(
        list(comps_by_name.values()),
        aperture_offset_mm=LASER_APERTURE_OFFSET_MM,
    )
    if traced:
        return traced
    if beam_path:
        beam = _resolve_beam_path(stage, comps_by_name)
        return beam
    return _beam_segments(stage) + _laser_emission_segments(comps_by_name)


def _project_payload(name, stage, render_mode="lo"):
    _sync_rod_catalog()
    comps = _project_components(stage, render_mode)
    beam_path = _beam_path(stage)
    physics_comps = (
        comps
        if render_mode == "lo"
        else _project_components(stage, "lo")
    )
    comps_by_name = {c["name"]: c for c in physics_comps}
    return dict(name=name, components=comps,
                beam=_resolved_project_beam(stage, comps_by_name, beam_path),
                beamPath=beam_path,
                board=_board(stage), library=ol.component_library_assets(),
                libraryPreviews=_library_previews(),
                renderMode=render_mode,
                pins=_pins(stage))

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
            + [dict(key=k, label=v[1]) for k, v in setup_projects.CLONE_TEMPLATES.items()]
        ),
    )

@app.post("/api/projects")
def new_project():
    body = request.get_json(force=True)
    name = re.sub(r"[^A-Za-z0-9_\-]", "_", (body.get("name") or "").strip())
    template = body.get("template", "blank")
    if not name or not SAFE.match(name):
        abort(400, "invalid name")
    if template not in NEW_PROJECT_TEMPLATE_KEYS and template not in setup_projects.CLONE_TEMPLATES:
        abort(400, "unknown template")
    if os.path.exists(os.path.join(PROJECTS_DIR, name, "setup.usda")):
        abort(409, "project already exists")
    if not os.path.isdir(LIB_DIR) or not os.listdir(LIB_DIR):
        ol.build_component_library(LIB_DIR)   # ensure the catalogue exists
    setup_projects.create_project(name, template, overwrite=True)
    return jsonify(ok=True, name=name)

@app.post("/api/projects/<name>/remove")
def remove_project(name):
    if not SAFE.match(name):
        abort(400)
    import shutil
    d = os.path.join(PROJECTS_DIR, name)
    if not os.path.isdir(d):
        abort(404)
    shutil.rmtree(d)
    return jsonify(ok=True)

@app.get("/api/projects/<name>")
def get_project(name):
    stage = Usd.Stage.Open(project_setup(name)) #name="project名"で、このprojectからsetup.usdaをusda形式でstageに読み込む
    render_mode = request.args.get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")
    return jsonify(_project_payload(name, stage, render_mode))


@app.post("/api/projects/<name>/pins")
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


@app.post("/api/projects/<name>/components/<comp>")
def update_component(name, comp):
    if not SAFE.match(comp):
        abort(400)
    body = request.get_json(force=True)
    setup = project_setup(name)
    stage = Usd.Stage.Open(setup)
    prim = stage.GetPrimAtPath(f"{stage.GetDefaultPrim().GetPath()}/{comp}")
    if not prim or not prim.IsValid():
        abort(404, "no such component")
    x, y, z, rot = _xform_values(prim)
    _set_xform(prim,
               float(body.get("x", x)), float(body.get("y", y)),
               _clamp_z(stage, body.get("z", z)), float(body.get("rotZ", rot)))
    stage.GetRootLayer().Save()
    rebuild_glb(name)
    
    render_mode = body.get("renderMode", "lo")
    if render_mode not in ("hi", "lo"):
        abort(400, "renderMode must be hi or lo")
    payload = _project_payload(name, stage, render_mode)
    payload["ok"] = True
    return jsonify(payload)


@app.post("/api/projects/<name>/add")
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
    # ensure a unique prim name
    base, i = comp_name, 1
    while stage.GetPrimAtPath(f"{root}/{comp_name}").IsValid():
        i += 1
        comp_name = f"{base}_{i}"
    rel = uu.get_relative_component_usda_path(
        LIB_DIR,
        component_path,
        proj_dir,
    )
    ol.place(stage, root, comp_name, rel,
             float(body.get("x", 0)), float(body.get("y", 0)))
    stage.GetRootLayer().Save()
    rebuild_glb(name)
    
    return jsonify(ok=True, name=comp_name)


@app.post("/api/projects/<name>/delete/<comp>")
def delete_component(name, comp):
    if not SAFE.match(comp):
        abort(400)
    setup = project_setup(name)
    stage = Usd.Stage.Open(setup)
    path = f"{stage.GetDefaultPrim().GetPath()}/{comp}"
    if not stage.GetPrimAtPath(path).IsValid():
        abort(404)
    stage.RemovePrim(path)
    stage.GetRootLayer().Save()
    rebuild_glb(name)
    
    return jsonify(ok=True)


@app.post("/api/projects/<name>/beam/pin")
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
        x, y, z, rot = _xform_values(prim)
        t_val = prim.GetAttribute("optics:type").Get()
        comps.append(dict(name=prim.GetName(), type=t_val,
                          x=round(x, 3), y=round(y, 3), z=round(z, 3),
                          rotZ=round(rot, 3), attrs=_optics_attrs(prim)))
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


@app.get("/model/<name>.glb")
def model(name):
    if not SAFE.match(name):
        abort(400)
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
