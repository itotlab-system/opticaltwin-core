import os
from typing import TypedDict

import numpy as np
from pxr import Usd, UsdGeom, Gf

from opticaltwin import usd_utility as uu
from opticaltwin import beam_tracer

from backend import config

_ROD_SHOULDER_CACHE = {}

ROD_POSITIVE_INNER_THREAD = "CADMesh_002"
ROD_NEGATIVE_INNER_THREAD = "CADMesh_004"


class ModelPose(TypedDict):
    modelRotation: list[float]
    rotationCenter: list[float]

def _inherited_material_value(prim, component_prim, name):
    current = prim
    while current.IsValid():
        attr = current.GetAttribute(f"optics:{name}")
        if attr and attr.HasAuthoredValue():
            return float(attr.Get())
        if current == component_prim:
            break
        current = current.GetParent()
    return None

def _transform_points(points, matrix):
    # Gf.Matrix4d uses row vectors: p' = p * M.
    m = np.array(matrix, dtype=np.float64)
    if not np.allclose(m[:, 3], (0.0, 0.0, 0.0, 1.0)):
        raise ValueError(f"expected an affine transform, got last column {m[:, 3].tolist()}")
    return points @ m[:3, :3] + m[3, :3]

def _fan_triangles(counts, face_indices):
    counts = np.asarray(counts, dtype=np.int64)
    faces = np.asarray(face_indices, dtype=np.int64)
    if counts.size and (counts == 3).all() and faces.size == counts.size * 3:
        return faces.astype(np.int32)
    starts = np.concatenate(([0], np.cumsum(counts)[:-1]))
    per_face = np.maximum(counts - 2, 0)
    total = int(per_face.sum())
    if total == 0:
        return np.zeros(0, dtype=np.int32)
    first = np.repeat(starts, per_face)
    step = np.arange(total) - np.repeat(np.cumsum(per_face) - per_face, per_face) + 1
    triangles = np.stack(
        [faces[first], faces[first + step], faces[first + step + 1]], axis=1
    )
    return triangles.ravel().astype(np.int32)

def _component_mesh_arrays(stage, component_prim, *, transparent_points_only=False):
    meshes = []
    xcache = UsdGeom.XformCache()
    component_to_world = xcache.GetLocalToWorldTransform(component_prim)
    world_to_component = component_to_world.GetInverse()

    for prim in Usd.PrimRange(component_prim):
        if not prim.IsA(UsdGeom.Mesh):
            continue

        usd_mesh = UsdGeom.Mesh(prim)
        display_opacity = usd_mesh.GetDisplayOpacityAttr().Get() or [1.0]
        if transparent_points_only and not float(display_opacity[0]) < 1.0:
            continue
        points = usd_mesh.GetPointsAttr().Get() or []
        counts = usd_mesh.GetFaceVertexCountsAttr().Get() or []
        face_indices = usd_mesh.GetFaceVertexIndicesAttr().Get() or []
        if not points or not counts or not face_indices:
            continue

        mesh_to_world = xcache.GetLocalToWorldTransform(prim)
        world_points = _transform_points(np.asarray(points, dtype=np.float64), mesh_to_world)
        local_points = np.round(_transform_points(world_points, world_to_component), 6)

        if transparent_points_only:
            meshes.append({"points": local_points, "opacity": float(display_opacity[0])})
            continue

        triangles = _fan_triangles(counts, face_indices)

        display_color = usd_mesh.GetDisplayColorAttr().Get() or [(0.6, 0.7, 0.8)]
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

def _fresh_mesh_lists(meshes):
    out = []
    for mesh in meshes:
        data = dict(mesh)
        data["points"] = mesh["points"].tolist()
        if "indices" in mesh:
            data["indices"] = mesh["indices"].tolist()
        out.append(data)
    return out

def _component_meshes(stage, component_prim, *, transparent_points_only=False):
    return _fresh_mesh_lists(
        _component_mesh_arrays(
            stage, component_prim, transparent_points_only=transparent_points_only
        )
    )

def _component_primitives(stage, component_prim):
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
        # Gf matrices are row-vector, so row-major flattening is the column-major order THREE.Matrix4.fromArray() expects.
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
    if component_prim.GetName() != "Rod":
        return None

    positive = component_prim.GetChild(ROD_POSITIVE_INNER_THREAD)
    negative = component_prim.GetChild(ROD_NEGATIVE_INNER_THREAD)
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
    if not asset or not asset.lower().startswith("rod/"):
        return None
    component_name = uu.get_component_name(asset)
    path = uu.get_component_usda_path(config.LIB_DIR, component_name, "hi")
    if not os.path.isfile(path):
        return None
    lo_path = uu.get_component_usda_path(config.LIB_DIR, component_name, "lo")
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

def _component_model_pose(stage, component_prim) -> ModelPose:
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
    library_root = os.path.realpath(config.LIB_DIR)
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
    attrs = component.get("attrs", {})
    result = {}

    if component.get("type") in beam_tracer.EMITTER_TYPES:
        result["emissionOffset_mm"] = _laser_emission_offset(attrs)
        for key in ("emissionCenterY_mm", "emissionCenterZ_mm"):
            if attrs.get(key) is not None:
                result[key] = float(attrs[key])

    result.update(_optical_bounds_from_transparent_meshes(component.get("meshes", [])))
    return result

def _laser_emission_offset(attrs):
    if attrs.get("emissionOffset_mm") is not None:
        return float(attrs["emissionOffset_mm"])
    if attrs.get("sizeX_mm") is not None:
        return float(attrs["sizeX_mm"]) / 2.0
    return LASER_APERTURE_OFFSET_MM

def _optical_bounds_from_transparent_meshes(meshes):
    optical_points = [
        point
        for mesh in meshes
        if float(mesh.get("opacity", 1.0)) < 1.0
        for point in mesh.get("points", [])
    ]
    if not optical_points:
        return {}
    ys = [float(point[1]) for point in optical_points]
    zs = [float(point[2]) for point in optical_points]
    return {
        "activeCenterY_mm": (min(ys) + max(ys)) / 2.0,
        "activeCenterZ_mm": (min(zs) + max(zs)) / 2.0,
        "activeHalfY_mm": (max(ys) - min(ys)) / 2.0,
        "activeHalfZ_mm": (max(zs) - min(zs)) / 2.0,
    }

LASER_APERTURE_OFFSET_MM = 43.0

LASER_EMISSION_LENGTH_MM = 10000.0
