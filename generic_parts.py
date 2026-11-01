"""Generic placeholder parts: a part the catalogue does not have yet.

A real bench always has something the catalogue lacks -- the lab has 86 CAD
parts and one mirror. Rebuilding a bench from a photo would leave a hole for
each of them, so instead the user drops a placeholder: pick what it *does*
(its role), give it a rough size and a label, and carry on.

The role is what matters: the beam tracer treats a placeholder by its
`optics:type`, so a placeholder mirror still folds the beam and a placeholder
camera still stops it. The shape follows from the role (a lens is a disc, a
camera is a box), so there is no shape to choose.

Placeholders are authored INLINE in the project layer -- a prim with a sized
Cube or Cylinder child -- rather than referencing a library asset: there is no
asset to reference, and every instance has its own size. `optics:generic`
marks them, so the server can tell them from catalogue parts, and
`optics:requestPart` flags the ones whose real CAD the dev team should add.

Units are millimetres; the clear aperture faces +X like every other part.
"""

from pxr import Gf, Sdf, UsdGeom


# role -> (optics:type, shape, default size X/Y/Z mm, colour)
# X is along the beam (thickness), Y across it, Z up.
ROLES = {
    "laser": ("laser", "box", (120.0, 40.0, 40.0), (0.85, 0.2, 0.2)),
    "lens": ("lens", "disc", (6.0, 25.4, 25.4), (0.55, 0.75, 1.0)),
    "mirror": ("mirror", "disc", (6.0, 25.4, 25.4), (0.85, 0.85, 0.92)),
    "beamsplitter": ("beamsplitter", "box", (25.4, 25.4, 25.4), (0.6, 0.8, 0.95)),
    "iris": ("iris", "disc", (8.0, 40.0, 40.0), (0.25, 0.25, 0.28)),
    "camera": ("camera", "box", (60.0, 45.0, 45.0), (0.2, 0.45, 0.8)),
    "block": ("target", "box", (25.0, 25.0, 25.0), (0.55, 0.55, 0.6)),
}

SIZE_RANGE_MM = (1.0, 600.0)
TEXT_MAX_LEN = 80


def clean_size(raw, role):
    """Three positive sizes in mm, defaulted from the role, clamped to range."""
    default = ROLES[role][2]
    low, high = SIZE_RANGE_MM
    out = []
    for i in range(3):
        try:
            value = float(raw[i])
        except (TypeError, ValueError, IndexError, KeyError):
            value = default[i]
        if value != value:          # NaN
            value = default[i]
        out.append(min(high, max(low, value)))
    return tuple(out)


def clean_text(raw):
    if not isinstance(raw, str):
        return ""
    return " ".join(raw.split())[:TEXT_MAX_LEN]


def _set(prim, name, value, value_type):
    attr = prim.GetAttribute(f"optics:{name}")
    if not attr:
        attr = prim.CreateAttribute(f"optics:{name}", value_type, custom=True)
    attr.Set(value)


def author(stage, path, role, size, label="", model="", request_part=False):
    """Define a placeholder at `path` (no transform yet) and return its prim.

    The caller places it, exactly as it would a referenced catalogue part.
    """
    if role not in ROLES:
        raise ValueError(f"unknown role: {role}")
    optics_type, shape, _, color = ROLES[role]
    sx, sy, sz = size
    prim = UsdGeom.Xform.Define(stage, path).GetPrim()
    _set(prim, "type", optics_type, Sdf.ValueTypeNames.Token)
    _set(prim, "generic", True, Sdf.ValueTypeNames.Bool)
    _set(prim, "genericRole", role, Sdf.ValueTypeNames.Token)
    _set(prim, "label", clean_text(label), Sdf.ValueTypeNames.String)
    _set(prim, "modelNumber", clean_text(model), Sdf.ValueTypeNames.String)
    _set(prim, "requestPart", bool(request_part), Sdf.ValueTypeNames.Bool)
    # The tracer reads these to size the part's active area and housing.
    for key, value in (("sizeX_mm", sx), ("sizeY_mm", sy), ("sizeZ_mm", sz)):
        _set(prim, key, float(value), Sdf.ValueTypeNames.Double)
    if shape == "disc":
        _set(prim, "diameter_mm", float(min(sy, sz)), Sdf.ValueTypeNames.Double)
        _set(prim, "width_mm", float(sy), Sdf.ValueTypeNames.Double)
        _set(prim, "height_mm", float(sz), Sdf.ValueTypeNames.Double)
    if role == "iris":
        _set(prim, "aperture_mm", float(min(sy, sz)) * 0.5, Sdf.ValueTypeNames.Double)
    if role == "laser":
        _set(prim, "wavelength_nm", 532, Sdf.ValueTypeNames.Int)
    if role == "block":
        _set(prim, "beamBehavior", "block", Sdf.ValueTypeNames.Token)

    body_path = f"{path}/Body"
    if shape == "disc":
        body = UsdGeom.Cylinder.Define(stage, body_path)
        body.CreateRadiusAttr(float(min(sy, sz)) / 2.0)
        body.CreateHeightAttr(float(sx))
        body.CreateAxisAttr(UsdGeom.Tokens.x)
    else:
        body = UsdGeom.Cube.Define(stage, body_path)
        body.CreateSizeAttr(1.0)
        body.AddScaleOp().Set(Gf.Vec3f(float(sx), float(sy), float(sz)))
    body.CreateDisplayColorAttr([Gf.Vec3f(*color)])
    if role in ("lens", "beamsplitter"):
        body.CreateDisplayOpacityAttr([0.45])
    return prim


def is_generic(prim):
    attr = prim.GetAttribute("optics:generic")
    return bool(attr and attr.HasAuthoredValue() and attr.Get())
