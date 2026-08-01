"""Geometric laser tracing for the component metadata used by OpticalTwin.

The simulation is deliberately geometric: optical elements are represented by
their active plane, while opaque equipment uses an oriented bounding box.
Distances are millimetres and the optical table is Z-up.
"""

import json
import math


EPSILON_MM = 0.02
MAX_DISTANCE_MM = 10000.0
# Every hit counts against this, including the mounts and cage plates the beam
# merely flies through. The lab bench has 14 cage plates and 8 mounts on one
# arm, so a low budget made the ray give up mid-bench and report an escape --
# the camera at the end was never reached. Branch count is what actually costs
# time here, not depth.
MAX_INTERACTIONS = 64
MIN_INTENSITY = 0.001

TRANSMISSIVE_TYPES = {
    "lens",
    "cylindrical_lens",
    "eyepiece",
    "polarizer",
}


def _number(value, default):
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _add(a, b):
    return [a[i] + b[i] for i in range(3)]


def _sub(a, b):
    return [a[i] - b[i] for i in range(3)]


def _scale(v, amount):
    return [value * amount for value in v]


def _dot(a, b):
    return sum(a[i] * b[i] for i in range(3))


def _normalise(v):
    length = math.sqrt(_dot(v, v))
    if length < 1e-12:
        return [1.0, 0.0, 0.0]
    return _scale(v, 1.0 / length)


def _local_axes(comp):
    # Match Three.js' default Euler order (XYZ): local X, Y and Z transformed
    # by Rz * Ry * Rx. With rotX=rotY=0 this is exactly the legacy rotZ path.
    x = math.radians(_number(comp.get("rotX"), 0.0))
    y = math.radians(_number(comp.get("rotY"), 0.0))
    z = math.radians(_number(comp.get("rotZ"), 0.0))
    sx, cx = math.sin(x), math.cos(x)
    sy, cy = math.sin(y), math.cos(y)
    sz, cz = math.sin(z), math.cos(z)
    return (
        [cz * cy, sz * cy, -sy],
        [cz * sy * sx - sz * cx, sz * sy * sx + cz * cx, cy * sx],
        [cz * sy * cx + sz * sx, sz * sy * cx - cz * sx, cy * cx],
    )


def _center(comp):
    attrs = comp.get("attrs", {})
    x_axis, y_axis, z_axis = _local_axes(comp)
    result = [
        _number(comp.get("x"), 0.0),
        _number(comp.get("y"), 0.0),
        _number(comp.get("z"), 0.0),
    ]
    for axis, key in (
        (x_axis, "centerX_mm"),
        (y_axis, "centerY_mm"),
        (z_axis, "centerZ_mm"),
    ):
        result = _add(result, _scale(axis, _number(attrs.get(key), 0.0)))
    return result


def _placement_origin(comp):
    return [
        _number(comp.get("x"), 0.0),
        _number(comp.get("y"), 0.0),
        _number(comp.get("z"), 0.0),
    ]


def _optical_center(comp):
    """Return the active optical surface center, not the housing center."""
    if comp.get("type") != "slm":
        return _center(comp)
    attrs = comp.get("attrs", {})
    x_axis, y_axis, z_axis = _local_axes(comp)
    result = _placement_origin(comp)
    # Imported EXULUS assets provide panelX/Y/Z. The generated SLM has its
    # panel on the +X face of its 28 mm-deep housing.
    for axis, value in (
        (x_axis, attrs.get("panelX_mm", 14.0)),
        (y_axis, attrs.get("panelY_mm", 0.0)),
        (z_axis, attrs.get("panelZ_mm", 0.0)),
    ):
        result = _add(result, _scale(axis, _number(value, 0.0)))
    return result


def _local_point(comp, point):
    relative = _sub(point, _center(comp))
    return [_dot(relative, axis) for axis in _local_axes(comp)]


def _placement_local_point(comp, point):
    """Return local coordinates relative to the authored optical-axis origin."""
    relative = _sub(point, _placement_origin(comp))
    return [_dot(relative, axis) for axis in _local_axes(comp)]


def _first_attr(attrs, names, default):
    for name in names:
        if name in attrs:
            return _number(attrs[name], default)
    return float(default)


def _active_half_sizes(comp):
    """Return active half-width along local Y and local Z."""
    attrs = comp.get("attrs", {})
    physics = comp.get("physics", {})
    if "activeHalfY_mm" in physics and "activeHalfZ_mm" in physics:
        return (
            _number(physics["activeHalfY_mm"], 12.7),
            _number(physics["activeHalfZ_mm"], 12.7),
        )
    component_type = comp.get("type")
    if component_type == "mirror":
        return (
            _first_attr(attrs, ("width_mm", "diameter_mm", "sizeY_mm"), 25.4) / 2,
            _first_attr(attrs, ("height_mm", "diameter_mm", "sizeZ_mm"), 25.4) / 2,
        )
    if component_type == "slm":
        return (
            _first_attr(attrs, ("activeWidth_mm", "screenWidth_mm", "sizeY_mm"), 15.36) / 2,
            _first_attr(attrs, ("activeHeight_mm", "screenHeight_mm", "sizeZ_mm"), 9.22) / 2,
        )
    if component_type == "detector":
        return (
            _first_attr(attrs, ("width_mm", "sensorWidth_mm", "sizeY_mm"), 12.0) / 2,
            _first_attr(attrs, ("height_mm", "sensorHeight_mm", "sizeZ_mm"), 12.0) / 2,
        )
    if component_type == "camera":
        return (
            _first_attr(attrs, ("sensorWidth_mm", "sizeY_mm"), 35.6) / 2,
            _first_attr(attrs, ("sensorHeight_mm", "sizeZ_mm"), 23.8) / 2,
        )
    diameter = _first_attr(
        attrs,
        ("diameter_mm", "outerDiameter_mm", "barrelDiameter_mm"),
        25.4,
    )
    return diameter / 2, diameter / 2


def _plane_hit(origin, direction, comp):
    normal = _local_axes(comp)[0]
    center = _optical_center(comp)
    physics = comp.get("physics", {})
    _, y_axis, z_axis = _local_axes(comp)
    center = _add(center, _scale(
        y_axis, _number(physics.get("activeCenterY_mm"), 0.0)
    ))
    center = _add(center, _scale(
        z_axis, _number(physics.get("activeCenterZ_mm"), 0.0)
    ))
    denom = _dot(direction, normal)
    if abs(denom) < 1e-9:
        return None
    distance = _dot(_sub(center, origin), normal) / denom
    if distance <= EPSILON_MM:
        return None
    point = _add(origin, _scale(direction, distance))
    relative = _sub(point, center)
    local_y = _dot(relative, y_axis)
    local_z = _dot(relative, z_axis)
    half_y, half_z = _active_half_sizes(comp)
    if abs(local_y) > half_y or abs(local_z) > half_z:
        return None
    return distance, point, normal


def _beamsplitter_hit(origin, direction, comp):
    """Intersect the finite 45-degree internal splitting plane.

    A cube beamsplitter accepts beams through both its local X and Y faces.
    Treating it like the generic local-X optical plane makes a Y-directed
    beam parallel to the hit plane, so moving or rotating the BS can make
    splitting disappear.
    """
    x_axis, y_axis, z_axis = _local_axes(comp)
    normal = _normalise(_add(x_axis, y_axis))
    tangent = _normalise(_sub(x_axis, y_axis))
    center = _center(comp)
    physics = comp.get("physics", {})
    center = _add(center, _scale(
        tangent, _number(physics.get("activeCenterY_mm"), 0.0)
    ))
    center = _add(center, _scale(
        z_axis, _number(physics.get("activeCenterZ_mm"), 0.0)
    ))
    denom = _dot(direction, normal)
    if abs(denom) < 1e-9:
        return None
    distance = _dot(_sub(center, origin), normal) / denom
    if distance <= EPSILON_MM:
        return None
    point = _add(origin, _scale(direction, distance))
    relative = _sub(point, center)
    half_tangent, half_z = _active_half_sizes(comp)
    if (
        abs(_dot(relative, tangent)) > half_tangent
        or abs(_dot(relative, z_axis)) > half_z
    ):
        return None
    return distance, point, normal


def _box_half_sizes(comp):
    attrs = comp.get("attrs", {})
    component_type = comp.get("type")
    defaults = {
        "laser": (80.0, 40.0, 40.0),
        "camera": (60.0, 126.0, 96.0),
        "slm": (28.0, 64.0, 52.0),
    }.get(component_type, (25.4, 25.4, 25.4))
    return [
        _first_attr(attrs, ("sizeX_mm", "bodySizeX_mm", "thickness_mm"), defaults[0]) / 2,
        _first_attr(attrs, ("sizeY_mm", "width_mm"), defaults[1]) / 2,
        _first_attr(attrs, ("sizeZ_mm", "height_mm"), defaults[2]) / 2,
    ]


def _box_hit(origin, direction, comp):
    axes = _local_axes(comp)
    relative = _sub(origin, _center(comp))
    local_origin = [_dot(relative, axis) for axis in axes]
    local_direction = [_dot(direction, axis) for axis in axes]
    half_sizes = _box_half_sizes(comp)
    near, far = -math.inf, math.inf
    near_axis = 0
    near_sign = 1.0
    for i in range(3):
        if abs(local_direction[i]) < 1e-10:
            if abs(local_origin[i]) > half_sizes[i]:
                return None
            continue
        t1 = (-half_sizes[i] - local_origin[i]) / local_direction[i]
        t2 = (half_sizes[i] - local_origin[i]) / local_direction[i]
        enter, leave = min(t1, t2), max(t1, t2)
        if enter > near:
            near = enter
            near_axis = i
            near_sign = -1.0 if t1 < t2 else 1.0
        far = min(far, leave)
        if near > far:
            return None
    distance = near if near > EPSILON_MM else far
    if distance <= EPSILON_MM:
        return None
    point = _add(origin, _scale(direction, distance))
    return distance, point, _scale(axes[near_axis], near_sign)


def _mirror_hit(origin, direction, comp):
    """Intersect the two reflective faces of a finite-thickness mirror."""
    attrs = comp.get("attrs", {})
    center = _center(comp)
    normal, y_axis, z_axis = _local_axes(comp)
    thickness = _first_attr(attrs, ("thickness_mm", "sizeX_mm"), 6.0)
    half_y, half_z = _active_half_sizes(comp)
    candidates = []
    for side in (-1.0, 1.0):
        face_normal = _scale(normal, side)
        face_center = _add(center, _scale(normal, side * thickness / 2.0))
        denom = _dot(direction, face_normal)
        if abs(denom) < 1e-9:
            continue
        distance = _dot(_sub(face_center, origin), face_normal) / denom
        if distance <= EPSILON_MM:
            continue
        point = _add(origin, _scale(direction, distance))
        relative = _sub(point, face_center)
        if (
            abs(_dot(relative, y_axis)) <= half_y
            and abs(_dot(relative, z_axis)) <= half_z
        ):
            candidates.append((distance, point, face_normal, None))
    return min(candidates, key=lambda hit: hit[0]) if candidates else None


def _behavior(comp, hit_point):
    component_type = str(comp.get("type") or "")
    attrs = comp.get("attrs", {})
    explicit = attrs.get("beamBehavior")
    if explicit in {"reflect", "split", "transmit", "block"}:
        return explicit
    if component_type == "mirror":
        return "reflect"
    if component_type == "slm" and str(attrs.get("reflective", "")).lower() in {
        "true", "1",
    }:
        return "reflect"
    if component_type == "beamsplitter":
        return "split"
    if component_type in TRANSMISSIVE_TYPES:
        return "transmit"
    if component_type == "iris":
        aperture = _first_attr(attrs, ("aperture_mm",), 0.0) / 2
        local = _local_point(comp, hit_point)
        return "transmit" if math.hypot(local[1], local[2]) <= aperture else "block"
    if component_type == "mount":
        # Mount bounds can be asymmetric around their optical axis (notably
        # CM1-DCH_M-Step has centerZ_mm=-3.81). Aperture and rod-hole offsets
        # are authored from the placement/optical origin, not the housing
        # bounding-box center.
        local = _placement_local_point(comp, hit_point)
        central_radius = _number(attrs.get("beamApertureRadius_mm"), 0.0)
        aperture_axis = str(attrs.get("beamApertureAxis") or "X").upper()
        radial_axes = {
            "X": (1, 2),
            "Y": (0, 2),
            "Z": (0, 1),
        }.get(aperture_axis, (1, 2))
        if (
            central_radius > 0
            and math.hypot(
                local[radial_axes[0]],
                local[radial_axes[1]],
            ) <= central_radius
        ):
            return "transmit"
        hole_radius = _number(attrs.get("rodHoleRadius_mm"), 0.0)
        raw_offsets = attrs.get("rodHoleOffsets_mm")
        if hole_radius > 0 and isinstance(raw_offsets, str):
            try:
                offsets = json.loads(raw_offsets)
            except (TypeError, ValueError, json.JSONDecodeError):
                offsets = []
            for offset in offsets if isinstance(offsets, list) else []:
                if not isinstance(offset, list) or len(offset) != 3:
                    continue
                hole_y = _number(offset[1], 0.0)
                hole_z = _number(offset[2], 0.0)
                if math.hypot(local[1] - hole_y, local[2] - hole_z) <= hole_radius:
                    return "transmit"
        return "block"
    if "transparency" in attrs and _number(attrs["transparency"], 0.0) > 0:
        return "transmit"
    return "block"


def _intersection(origin, direction, comp):
    attrs = comp.get("attrs", {})
    if str(attrs.get("ignoreBeamCollision", "")).lower() in {"true", "1"}:
        return None
    component_type = str(comp.get("type") or "")
    if component_type == "mirror":
        return _mirror_hit(origin, direction, comp)
    if component_type == "beamsplitter":
        hit = _beamsplitter_hit(origin, direction, comp)
        return (*hit, None) if hit else None
    if component_type == "slm":
        active_hit = _plane_hit(origin, direction, comp)
        if active_hit:
            return (*active_hit, "reflect")
        housing_hit = _box_hit(origin, direction, comp)
        return (*housing_hit, "block") if housing_hit else None
    if component_type in ("camera", "detector"):
        # A sensor is an opaque body, not a bare plane. Testing only the active
        # area let the beam pass straight through the housing whenever it
        # arrived off-sensor -- or, as with a camera turned to face across the
        # bench, when its sensor plane was edge-on and could not be hit at all.
        # Either way the light stops here.
        active_hit = _plane_hit(origin, direction, comp)
        if active_hit:
            return (*active_hit, "block")
        housing_hit = _box_hit(origin, direction, comp)
        return (*housing_hit, "block") if housing_hit else None
    if component_type in (TRANSMISSIVE_TYPES | {"iris"}):
        hit = _plane_hit(origin, direction, comp)
    else:
        hit = _box_hit(origin, direction, comp)
    return (*hit, None) if hit else None


def _reflection(direction, normal):
    return _normalise(_sub(direction, _scale(normal, 2 * _dot(direction, normal))))


def _split_reflection(direction, comp):
    """Reflect on the cube's local 45-degree internal interface."""
    x_axis, y_axis, _ = _local_axes(comp)
    interface_normal = _normalise(_add(x_axis, y_axis))
    return _reflection(direction, interface_normal)


# Hardware that holds optics rather than acting on light. The beam is still
# traced against it (a beam that misses a bore is clipped), but it does not end
# a segment: "the stretch between the two lenses" is one thing to a user, not
# six slivers separated by mounts.
STRUCTURAL_TYPES = {
    "mount",
    "holder",
    "post",
    "cage",
    "breadboard",
}


def _collinear(a, b, tolerance=1e-3):
    """True when two legs continue in the same direction."""
    da = _normalise(_sub(a["pts"][1], a["pts"][0]))
    db = _normalise(_sub(b["pts"][1], b["pts"][0]))
    return _dot(da, db) > 1.0 - tolerance


def merge_structural(segments, components_by_name):
    """Fuse legs that only meet at a mount, holder or post.

    The tracer ends a leg at every hit, which is right for the physics but
    wrong for editing: the user thinks in stretches between optics. Only
    collinear legs meeting at a single structural part are joined, so a fold at
    a mirror or a split at a cube still ends a segment.
    """
    remaining = list(segments)
    merged = True
    while merged:
        merged = False
        # Index by the point each leg starts from, to find continuations.
        for i, leg in enumerate(remaining):
            junction = leg.get("to")
            comp = components_by_name.get(junction)
            if not junction or not comp:
                continue
            if comp.get("type") not in STRUCTURAL_TYPES:
                continue
            def continues_here(other):
                """Carries straight on from where this leg ended.

                A folded bench can send the beam back through the same mount at
                the same spot, so matching on the junction and the meeting point
                alone finds two candidates. Requiring the same direction picks
                out the through-going one and leaves the return leg alone.
                """
                gap = _sub(other["pts"][0], leg["pts"][1])
                return (
                    other.get("from") == junction
                    and _dot(gap, gap) < 1.0
                    and _collinear(leg, other)
                )

            successors = [
                j for j, other in enumerate(remaining)
                if j != i and continues_here(other)
            ]
            # Only an unambiguous straight-through continuation is safe to fuse.
            if len(successors) != 1:
                continue
            nxt = remaining[successors[0]]
            leg = dict(leg)
            leg["pts"] = [leg["pts"][0], nxt["pts"][1]]
            leg["to"] = nxt.get("to")
            leg["intensity"] = nxt.get("intensity", leg.get("intensity"))
            leg["key"] = segment_key(leg.get("from"), leg.get("to"))
            remaining = [
                leg if k == i else item
                for k, item in enumerate(remaining)
                if k != successors[0]
            ]
            merged = True
            break

    # Keys are rebuilt after fusing, so re-apply occurrence suffixes to keep
    # a folded path that revisits the same pair unambiguous.
    seen = {}
    for leg in remaining:
        pair = (leg.get("from"), leg.get("to"))
        occurrence = seen.get(pair, 0)
        seen[pair] = occurrence + 1
        leg["key"] = segment_key(pair[0], pair[1], occurrence)
    return remaining


def segment_key(from_name, to_name, occurrence=0):
    """Stable identifier for one leg of the beam.

    Keyed by the pair of components it spans rather than by index, so a leg
    keeps its identity when parts move or the trace re-runs. A folded bench can
    cross the same pair twice (out and back through a beamsplitter), so repeat
    crossings get an occurrence suffix; the traversal is deterministic, which
    makes that suffix stable too.
    """
    key = f"{from_name or '?'}>{to_name or '*'}"
    return key if occurrence == 0 else f"{key}#{occurrence}"


def is_laser_on(comp):
    """Whether a laser is switched on. Absent means on — a laser someone
    placed before this existed should still emit."""
    value = comp.get("attrs", {}).get("laserOn")
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip().lower() not in {"false", "0", "off", "no"}
    return bool(value)


def has_laser(components):
    """True when the scene contains a laser at all, on or off.

    A scene with a switched-off laser must show no beam, so callers need to
    tell "nothing emitted" apart from "nothing to emit from" — the latter is
    what makes an older hand-authored beam path worth falling back to.
    """
    return any(c.get("type") == "laser" for c in components)


def trace_lasers(components, aperture_offset_mm=43.0):
    """Return renderable beam segments emitted by all switched-on lasers."""
    segments = []
    for laser in components:
        if laser.get("type") != "laser" or not is_laser_on(laser):
            continue
        direction = _local_axes(laser)[0]
        emission_offset = _number(
            laser.get("physics", {}).get("emissionOffset_mm"),
            aperture_offset_mm,
        )
        physics = laser.get("physics", {})
        _, y_axis, z_axis = _local_axes(laser)
        origin = _add(
            _placement_origin(laser),
            _scale(direction, emission_offset),
        )
        origin = _add(origin, _scale(
            y_axis,
            _number(physics.get("emissionCenterY_mm"), 0.0),
        ))
        origin = _add(origin, _scale(
            z_axis,
            _number(physics.get("emissionCenterZ_mm"), 0.0),
        ))
        wavelength = _number(laser.get("attrs", {}).get("wavelength_nm"), 532.0)
        laser_name = laser.get("name")
        # How many times each from->to pair has already been crossed, so a
        # folded path that revisits a pair still gets unique keys.
        seen_pairs = {}

        def emit(start, end, intensity, from_name, to_name):
            pair = (from_name, to_name)
            occurrence = seen_pairs.get(pair, 0)
            seen_pairs[pair] = occurrence + 1
            segments.append(_segment(
                start, end, wavelength, intensity,
                from_name, to_name, occurrence,
            ))

        queue = [(origin, direction, 1.0, 0, {laser_name}, laser_name)]

        while queue:
            (ray_origin, ray_direction, intensity, depth,
             ignored, from_name) = queue.pop(0)
            if depth >= MAX_INTERACTIONS or intensity < MIN_INTENSITY:
                end = _add(ray_origin, _scale(ray_direction, MAX_DISTANCE_MM))
                emit(ray_origin, end, intensity, from_name, None)
                continue

            nearest = None
            nearest_comp = None
            for comp in components:
                if comp.get("name") in ignored:
                    continue
                hit = _intersection(ray_origin, ray_direction, comp)
                if hit and (nearest is None or hit[0] < nearest[0]):
                    nearest, nearest_comp = hit, comp

            if nearest is None:
                end = _add(ray_origin, _scale(ray_direction, MAX_DISTANCE_MM))
                emit(ray_origin, end, intensity, from_name, None)
                continue

            _, point, normal, behavior_override = nearest
            behavior = behavior_override or _behavior(nearest_comp, point)
            name = nearest_comp.get("name")
            emit(ray_origin, point, intensity, from_name, name)
            next_ignored = {name}
            if behavior == "reflect":
                reflectivity = _number(
                    nearest_comp.get("attrs", {}).get("reflectivity"), 1.0
                )
                reflected = _reflection(ray_direction, normal)
                queue.append((
                    _add(point, _scale(reflected, EPSILON_MM)),
                    reflected,
                    intensity * reflectivity,
                    depth + 1,
                    next_ignored,
                    name,
                ))
            elif behavior == "split":
                ratio = max(0.0, min(1.0, _number(
                    nearest_comp.get("attrs", {}).get("splitRatio"), 0.5
                )))
                reflected = _split_reflection(ray_direction, nearest_comp)
                queue.append((
                    _add(point, _scale(ray_direction, EPSILON_MM)),
                    ray_direction,
                    intensity * (1.0 - ratio),
                    depth + 1,
                    next_ignored,
                    name,
                ))
                queue.append((
                    _add(point, _scale(reflected, EPSILON_MM)),
                    reflected,
                    intensity * ratio,
                    depth + 1,
                    next_ignored,
                    name,
                ))
            elif behavior == "transmit":
                transparency = max(0.0, min(1.0, _number(
                    nearest_comp.get("attrs", {}).get("transparency"), 1.0
                )))
                queue.append((
                    _add(point, _scale(ray_direction, EPSILON_MM)),
                    ray_direction,
                    intensity * transparency,
                    depth + 1,
                    next_ignored,
                    name,
                ))
            # "block" intentionally has no continuation.
    return segments


def _segment(start, end, wavelength, intensity,
             from_name=None, to_name=None, occurrence=0):
    return {
        "pts": [
            [round(value, 3) for value in start],
            [round(value, 3) for value in end],
        ],
        "wavelength": wavelength,
        "intensity": round(max(0.0, min(1.0, intensity)), 6),
        # Identity of the leg: which two parts it spans, and a stable key the
        # client uses to hang a drawn width override on.
        "from": from_name,
        "to": to_name,
        "key": segment_key(from_name, to_name, occurrence),
    }
