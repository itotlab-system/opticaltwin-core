"""Tracing the planning beam through the placed parts, and the drawn shape of
each leg (width, length, colour). Geometry only -- no optical physics."""

import json
import math

from pxr import UsdGeom, Gf

from opticaltwin import beam_tracer

from backend.components import LASER_APERTURE_OFFSET_MM, LASER_EMISSION_LENGTH_MM

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
