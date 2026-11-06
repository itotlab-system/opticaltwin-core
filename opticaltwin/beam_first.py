"""Beam-first building: drop an optic ONTO the beam, fold the beam with a mirror.

Pure geometry on the dicts the server already hands the tracer (placement +
attrs + physics) and the traced beam legs. Nothing here is optics physics: a
part is centred on a straight planning line and turned so the tracer's own
reflection sends the beam the way the user asked.

Distances are millimetres, angles degrees, the table is Z-up.
"""

import math

from opticaltwin import beam_tracer


# How far (in plan) from a beam leg a drop still counts as "onto the beam".
# Wide enough to hit without aiming, narrow enough that a part dropped beside
# the beam on purpose stays where it was put.
SNAP_TO_BEAM_MM = 40.0

# Parts that sit IN the beam. Mounts, posts, holders, rods and cage plates are
# hardware around it; a laser is the beam's source, not something put on it.
SNAP_TYPES = {
    "lens", "cylindrical_lens", "eyepiece", "polarizer", "iris", "mirror",
    "beamsplitter", "camera", "detector", "slm", "target",
}

# Parts whose turn the user picks with the fold arrows.
FOLD_TYPES = {"mirror", "beamsplitter"}

TURNS = ("left", "right")


def _xy_length(v):
    return math.hypot(v[0], v[1])


def nearest_leg(beam, x, y, tolerance=SNAP_TO_BEAM_MM):
    """The beam leg closest in plan to (x, y), and the point on it.

    Returns (leg, point, direction) or None when nothing is within
    `tolerance`. `point` is 3-D: the leg's own height at that spot, so a part
    dropped on a beam lands at beam height, not on the board.
    """
    best = None
    for leg in beam or []:
        start, end = leg["pts"][0], leg["pts"][-1]
        span = [end[i] - start[i] for i in range(3)]
        plan = _xy_length(span)
        if plan < 1e-6:
            continue                    # a vertical leg has no plan footprint
        t = ((x - start[0]) * span[0] + (y - start[1]) * span[1]) / plan ** 2
        t = max(0.0, min(1.0, t))
        point = [start[i] + t * span[i] for i in range(3)]
        distance = math.hypot(x - point[0], y - point[1])
        if distance <= tolerance and (best is None or distance < best[0]):
            length = math.sqrt(sum(s * s for s in span))
            best = (distance, leg, point, [s / length for s in span])
    return None if best is None else best[1:]


def heading_deg(direction):
    """Plan heading of a direction, as a rotZ in degrees."""
    return math.degrees(math.atan2(direction[1], direction[0]))


def _turned(direction, turn):
    """`direction` turned 90° in plan: left is counter-clockwise from above."""
    sign = 1.0 if turn == "left" else -1.0
    return [-sign * direction[1], sign * direction[0], 0.0]


def _normalise_deg(angle):
    """Into (-180, 180], rounded so a fold writes 45, not 44.99999999."""
    angle = (angle + 180.0) % 360.0 - 180.0
    if angle <= -180.0:
        angle += 360.0
    return round(angle, 6) + 0.0


def fold_rot_z(component_type, incoming, turn):
    """The rotZ that makes a mirror or beamsplitter send `incoming` to `turn`.

    Reflection about a plane with normal n maps d to d' exactly when n is
    parallel to d' - d. The tracer takes a mirror's normal from its local +X,
    and a cube beamsplitter's from its local X+Y diagonal (45° on), so the
    two differ by that 45°. The normal is taken facing back up the beam, so a
    mirror shows its front face to the light.
    """
    if turn not in TURNS:
        raise ValueError(f"turn must be one of {TURNS}")
    plan = _xy_length(incoming)
    if plan < 1e-9:
        raise ValueError("a vertical beam cannot be folded in plan")
    d = [incoming[0] / plan, incoming[1] / plan, 0.0]
    out = _turned(d, turn)
    normal_deg = math.degrees(math.atan2(out[1] - d[1], out[0] - d[0]))
    if component_type == "beamsplitter":
        return _normalise_deg(normal_deg - 45.0)
    return _normalise_deg(normal_deg)


def optical_centre_offset(comp, rot_x, rot_y, rot_z):
    """Where the part's active surface sits relative to its origin at a pose.

    Optics are mostly modelled about their centre, but not all (an SLM's panel
    is on one face, CAD imports carry centreX/Y/Z offsets). Centring the
    *surface* on the beam, not the origin, is what keeps the beam hitting the
    part after it has been turned.
    """
    probe = dict(comp, x=0.0, y=0.0, z=0.0, rotX=rot_x, rotY=rot_y, rotZ=rot_z)
    return beam_tracer._optical_center(probe)


def origin_for(comp, point, rot_x, rot_y, rot_z):
    """The placement origin that puts the part's active surface at `point`."""
    offset = optical_centre_offset(comp, rot_x, rot_y, rot_z)
    return [point[i] - offset[i] for i in range(3)]


def incoming_leg(beam, name):
    """The beam leg that arrives at component `name`, if the beam reaches it."""
    for leg in beam or []:
        if leg.get("to") == name:
            return leg
    return None


def leg_direction(leg):
    start, end = leg["pts"][0], leg["pts"][-1]
    span = [end[i] - start[i] for i in range(3)]
    length = math.sqrt(sum(s * s for s in span)) or 1.0
    return [s / length for s in span]


def project_onto_line(point, origin, direction):
    """`point` dropped perpendicularly onto the line through origin along direction."""
    t = sum((point[i] - origin[i]) * direction[i] for i in range(3))
    return [origin[i] + t * direction[i] for i in range(3)]
