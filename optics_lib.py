"""
optics_lib  --  reusable OpenUSD layout/planning library (Phase 1)
-----------------------------------------------------------------
A small toolkit for building optical-setup *layout* scenes in USD.

Scope is geometry & planning only -- NO optical physics. Beam paths are straight
planning polylines (they may fold at a mirror/beamsplitter, but that is a
geometric fold, not refraction/reflection simulation).

Conventions (must match every asset):
  * Units: millimetres (metersPerUnit = 0.001)
  * Up axis: Z
  * Optical axis: each optic's clear aperture faces +X by default; rotate about
    Z when placing it on a perpendicular arm. Beam height is Z = 0.
  * Custom attributes live in the "optics:" namespace.

Two halves:
  1. make_*(path, ...)   -> write a standalone reusable component asset (.usda)
  2. setup helpers        -> assemble a scene that References those assets,
                             snap placement to a 25 mm breadboard grid, and draw
                             the beam polyline.

Dimensions here are Thorlabs-standard PLACEHOLDERS (Ø1" = 25.4 mm optics, 30 mm
cage, typical cube/stage sizes). Refine with real part numbers later.
"""

import json
import os
from pxr import Usd, UsdGeom, Sdf, Gf

GRID_MM = 25.0          # breadboard hole spacing (metric M6 board)
BEAM_Z = 0.0            # beam height; components are centred on this plane
INCH = 25.4             # Ø1" optics


# ==========================================================================
# Asset authoring helpers
# ==========================================================================

def _new_asset_stage(path, default_prim_name):
    """Create a fresh single-asset stage with our unit/axis conventions."""
    stage = Usd.Stage.CreateNew(path)
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.z)
    UsdGeom.SetStageMetersPerUnit(stage, 0.001)  # millimetres
    prim = UsdGeom.Xform.Define(stage, f"/{default_prim_name}")
    stage.SetDefaultPrim(prim.GetPrim())
    return stage, prim.GetPrim()


def _attr(prim, name, value, vtype):
    prim.CreateAttribute(f"optics:{name}", vtype).Set(value)


_F = Sdf.ValueTypeNames.Float
_T = Sdf.ValueTypeNames.Token
_I = Sdf.ValueTypeNames.Int


# ==========================================================================
# Component library  --  each writes one reusable .usda asset
# Visuals are simple shapes; the value is correct dimensions + optics: data.
# ==========================================================================

def make_lens(path, diameter_mm=INCH, thickness_mm=5.0, focal_length_mm=100.0,
              color=(0.4, 0.7, 1.0)):
    stage, root = _new_asset_stage(path, "Lens")
    cyl = UsdGeom.Cylinder.Define(stage, "/Lens/Body")
    cyl.CreateRadiusAttr(diameter_mm / 2.0)
    cyl.CreateHeightAttr(thickness_mm)
    cyl.CreateAxisAttr(UsdGeom.Tokens.x)        # face perpendicular to +X beam
    cyl.CreateDisplayColorAttr([color])
    _attr(root, "type", "lens", _T)
    _attr(root, "diameter_mm", diameter_mm, _F)
    _attr(root, "focalLength_mm", focal_length_mm, _F)
    stage.GetRootLayer().Save()


def make_mirror(path, diameter_mm=INCH, thickness_mm=6.0):
    stage, root = _new_asset_stage(path, "Mirror")
    cyl = UsdGeom.Cylinder.Define(stage, "/Mirror/Body")
    cyl.CreateRadiusAttr(diameter_mm / 2.0)
    cyl.CreateHeightAttr(thickness_mm)
    cyl.CreateAxisAttr(UsdGeom.Tokens.x)
    cyl.CreateDisplayColorAttr([(0.85, 0.85, 0.9)])
    _attr(root, "type", "mirror", _T)
    _attr(root, "diameter_mm", diameter_mm, _F)
    _attr(root, "reflectivity", 0.99, _F)
    stage.GetRootLayer().Save()


def make_beamsplitter(path, cube_mm=INCH):
    """Cube beamsplitter (e.g. Thorlabs CM1-BS013). 4 ports along X/Y."""
    stage, root = _new_asset_stage(path, "Beamsplitter")
    cube = UsdGeom.Cube.Define(stage, "/Beamsplitter/Body")
    cube.CreateSizeAttr(1.0)
    UsdGeom.Xformable(cube).AddScaleOp().Set(Gf.Vec3f(cube_mm, cube_mm, cube_mm))
    cube.CreateDisplayColorAttr([(0.6, 0.8, 0.85)])
    # internal 45deg splitting interface, drawn as a thin diagonal plate
    diag = UsdGeom.Cube.Define(stage, "/Beamsplitter/Interface")
    diag.CreateSizeAttr(1.0)
    xf = UsdGeom.Xformable(diag)
    xf.AddRotateZOp().Set(45.0)
    xf.AddScaleOp().Set(Gf.Vec3f(cube_mm * 1.4, 0.5, cube_mm))
    diag.CreateDisplayColorAttr([(0.9, 0.9, 1.0)])
    _attr(root, "type", "beamsplitter", _T)
    _attr(root, "size_mm", cube_mm, _F)
    _attr(root, "splitRatio", 0.5, _F)
    stage.GetRootLayer().Save()


def make_polarizer(path, diameter_mm=INCH, thickness_mm=5.0, axis_deg=0.0):
    stage, root = _new_asset_stage(path, "Polarizer")
    cyl = UsdGeom.Cylinder.Define(stage, "/Polarizer/Body")
    cyl.CreateRadiusAttr(diameter_mm / 2.0)
    cyl.CreateHeightAttr(thickness_mm)
    cyl.CreateAxisAttr(UsdGeom.Tokens.x)
    cyl.CreateDisplayColorAttr([(0.3, 0.25, 0.4)])
    _attr(root, "type", "polarizer", _T)
    _attr(root, "diameter_mm", diameter_mm, _F)
    _attr(root, "transmissionAxis_deg", axis_deg, _F)
    stage.GetRootLayer().Save()


def make_slm(path, active_w_mm=15.36, active_h_mm=9.22,
             body_mm=(28.0, 64.0, 52.0)):
    """Reflective spatial light modulator. Reflective face is +X."""
    stage, root = _new_asset_stage(path, "SLM")
    bx, by, bz = body_mm
    body = UsdGeom.Cube.Define(stage, "/SLM/Body")
    body.CreateSizeAttr(1.0)
    UsdGeom.Xformable(body).AddScaleOp().Set(Gf.Vec3f(bx, by, bz))
    body.CreateDisplayColorAttr([(0.7, 0.1, 0.1)])      # red anodised housing
    # active panel sitting on the +X face
    panel = UsdGeom.Cube.Define(stage, "/SLM/ActiveArea")
    panel.CreateSizeAttr(1.0)
    pxf = UsdGeom.Xformable(panel)
    pxf.AddTranslateOp().Set(Gf.Vec3d(bx / 2.0, 0, 0))
    pxf.AddScaleOp().Set(Gf.Vec3f(1.0, active_w_mm, active_h_mm))
    panel.CreateDisplayColorAttr([(0.15, 0.15, 0.18)])
    _attr(root, "type", "slm", _T)
    _attr(root, "activeWidth_mm", active_w_mm, _F)
    _attr(root, "activeHeight_mm", active_h_mm, _F)
    _attr(root, "reflective", "true", _T)
    stage.GetRootLayer().Save()


def make_iris(path, outer_mm=INCH, aperture_mm=5.0, thickness_mm=4.0):
    """Iris diaphragm / Fourier-plane filter. Drawn as a ring + open centre."""
    stage, root = _new_asset_stage(path, "Iris")
    ring = UsdGeom.Cylinder.Define(stage, "/Iris/Ring")
    ring.CreateRadiusAttr(outer_mm / 2.0)
    ring.CreateHeightAttr(thickness_mm)
    ring.CreateAxisAttr(UsdGeom.Tokens.x)
    ring.CreateDisplayColorAttr([(0.1, 0.1, 0.1)])
    # bright marker for the open aperture
    hole = UsdGeom.Cylinder.Define(stage, "/Iris/Aperture")
    hole.CreateRadiusAttr(aperture_mm / 2.0)
    hole.CreateHeightAttr(thickness_mm + 0.5)
    hole.CreateAxisAttr(UsdGeom.Tokens.x)
    hole.CreateDisplayColorAttr([(0.9, 0.9, 0.2)])
    _attr(root, "type", "iris", _T)
    _attr(root, "aperture_mm", aperture_mm, _F)
    _attr(root, "outerDiameter_mm", outer_mm, _F)
    stage.GetRootLayer().Save()


def make_cylindrical_lens(path, width_mm=INCH, height_mm=INCH, thickness_mm=5.0,
                          focal_length_mm=100.0):
    """Cylindrical lens -- power in one axis only. Face is +X."""
    stage, root = _new_asset_stage(path, "CylLens")
    body = UsdGeom.Cube.Define(stage, "/CylLens/Body")
    body.CreateSizeAttr(1.0)
    UsdGeom.Xformable(body).AddScaleOp().Set(
        Gf.Vec3f(thickness_mm, width_mm, height_mm))
    body.CreateDisplayColorAttr([(0.5, 0.8, 0.9)])
    _attr(root, "type", "cylindrical_lens", _T)
    _attr(root, "focalLength_mm", focal_length_mm, _F)
    _attr(root, "powerAxis", "vertical", _T)
    stage.GetRootLayer().Save()


def make_eyepiece(path, barrel_mm=31.7, length_mm=80.0, focal_length_mm=21.0):
    stage, root = _new_asset_stage(path, "Eyepiece")
    cyl = UsdGeom.Cylinder.Define(stage, "/Eyepiece/Body")
    cyl.CreateRadiusAttr(barrel_mm / 2.0)
    cyl.CreateHeightAttr(length_mm)
    cyl.CreateAxisAttr(UsdGeom.Tokens.x)
    cyl.CreateDisplayColorAttr([(0.1, 0.1, 0.12)])
    _attr(root, "type", "eyepiece", _T)
    _attr(root, "focalLength_mm", focal_length_mm, _F)
    _attr(root, "barrelDiameter_mm", barrel_mm, _F)
    stage.GetRootLayer().Save()


def make_camera(path, body_mm=(60.0, 126.0, 96.0)):
    """Camera body. Sensor looks toward -X (back along the incoming beam)."""
    stage, root = _new_asset_stage(path, "Camera")
    bx, by, bz = body_mm
    body = UsdGeom.Cube.Define(stage, "/Camera/Body")
    body.CreateSizeAttr(1.0)
    UsdGeom.Xformable(body).AddScaleOp().Set(Gf.Vec3f(bx, by, bz))
    body.CreateDisplayColorAttr([(0.12, 0.12, 0.13)])
    _attr(root, "type", "camera", _T)
    _attr(root, "sensorWidth_mm", 35.6, _F)
    _attr(root, "sensorHeight_mm", 23.8, _F)
    stage.GetRootLayer().Save()


def make_detector(path, width_mm=12.0, height_mm=12.0, thickness_mm=2.0):
    """Flat sensor panel (e.g. photodiode/power meter head). Face is +X."""
    stage, root = _new_asset_stage(path, "Detector")
    body = UsdGeom.Cube.Define(stage, "/Detector/Body")
    body.CreateSizeAttr(1.0)
    UsdGeom.Xformable(body).AddScaleOp().Set(
        Gf.Vec3f(thickness_mm, width_mm, height_mm))
    body.CreateDisplayColorAttr([(0.15, 0.15, 0.15)])
    _attr(root, "type", "detector", _T)
    _attr(root, "width_mm", width_mm, _F)
    _attr(root, "height_mm", height_mm, _F)
    stage.GetRootLayer().Save()


def make_laser(path, body_mm=(80.0, 40.0, 40.0), wavelength_nm=532.0):
    """Fiber-coupled laser source. Emits along +X by default."""
    stage, root = _new_asset_stage(path, "Laser")
    bx, by, bz = body_mm
    body = UsdGeom.Cube.Define(stage, "/Laser/Body")
    body.CreateSizeAttr(1.0)
    UsdGeom.Xformable(body).AddScaleOp().Set(Gf.Vec3f(bx, by, bz))
    body.CreateDisplayColorAttr([(0.2, 0.2, 0.22)])
    # output aperture marker on +X face
    out = UsdGeom.Cylinder.Define(stage, "/Laser/Output")
    out.CreateRadiusAttr(3.0)
    out.CreateHeightAttr(6.0)
    out.CreateAxisAttr(UsdGeom.Tokens.x)
    UsdGeom.Xformable(out).AddTranslateOp().Set(Gf.Vec3d(bx / 2.0, 0, 0))
    out.CreateDisplayColorAttr([(0.1, 0.9, 0.2)])
    _attr(root, "type", "laser", _T)
    _attr(root, "wavelength_nm", wavelength_nm, _F)
    stage.GetRootLayer().Save()


# ==========================================================================
# Standard library  --  the lab's catalogue of parts, generated in one place.
# Maps a component identifier -> generator call. Each low-detail asset is written
# to components/<component>/lo.usda; hi.usda can be added beside it later.
# ==========================================================================

LIBRARY = {
    "Low_model/laser_fiber.usda":      (make_laser, {}),
    "Low_model/polarizer.usda":        (make_polarizer, {}),
    "Low_model/lens_collimating.usda": (make_lens, dict(focal_length_mm=50.0)),
    "Low_model/lens_imaging.usda":     (make_lens, dict(focal_length_mm=150.0)),
    "Low_model/lens_f100.usda":        (make_lens, dict(focal_length_mm=100.0)),
    "Low_model/beamsplitter_cube.usda": (make_beamsplitter, {}),
    "Low_model/slm.usda":              (make_slm, {}),
    "Low_model/iris_fourier.usda":     (make_iris, dict(aperture_mm=4.0)),
    "Low_model/lens_cylindrical.usda": (make_cylindrical_lens, dict(focal_length_mm=100.0)),
    "Low_model/eyepiece.usda":         (make_eyepiece, {}),
    "Low_model/camera.usda":           (make_camera, {}),
    "Low_model/mirror_1in.usda":       (make_mirror, {}),
    "Low_model/detector.usda":         (make_detector, {}),
}

def cad_library_assets(lib_dir=None):
    """Discover generated components whose hi.usda and lo.usda both exist."""
    lib_dir = lib_dir or os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "components",
    )
    standard_components = {
        os.path.splitext(asset)[0]
        for asset in LIBRARY
    }
    assets = set()
    if not os.path.isdir(lib_dir):
        return assets
    for directory, subdirectories, filenames in os.walk(lib_dir):
        relative_directory = os.path.relpath(directory, lib_dir)
        if relative_directory == ".":
            subdirectories[:] = [
                name
                for name in subdirectories
                if name not in standard_components
            ]
            continue
        if "hi.usda" not in filenames or "lo.usda" not in filenames:
            continue
        asset = relative_directory.replace(os.sep, "/")
        assets.add(f"{asset}.usda")
    return assets


def component_library_assets(lib_dir=None):
    """Return standard assets plus every generated hi/lo component pair."""
    generated = {
        asset for asset in cad_library_assets(lib_dir)
        if not asset.startswith("Breadboard/")
    }
    return sorted(set(LIBRARY) | generated)


def build_component_library(lib_dir):
    """(Re)generate every asset in LIBRARY into lib_dir. Safe to call repeatedly."""
    import os
    import usd_utility as uu
    os.makedirs(lib_dir, exist_ok=True)
    for fname, (fn, kw) in LIBRARY.items():
        path = uu.get_component_usda_path(lib_dir, fname)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if os.path.exists(path):
            os.remove(path)
        fn(path, **kw)
    return sorted(LIBRARY.keys())


# ==========================================================================
# Setup assembly helpers
# ==========================================================================

def new_setup_stage(path, root_name="OpticalSetup"):
    """Create a setup stage and return (stage, root_path)."""
    stage = Usd.Stage.CreateNew(path)
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.z)
    UsdGeom.SetStageMetersPerUnit(stage, 0.001)
    root = UsdGeom.Xform.Define(stage, f"/{root_name}")
    stage.SetDefaultPrim(root.GetPrim())
    return stage, f"/{root_name}"


def add_breadboard(stage, root_path, nx, ny, x0=0.0, y0=0.0, spacing=GRID_MM,
                   thickness_mm=12.0, hole_dia_mm=6.0,
                   asset_rel_path=None):
    """Add a breadboard slab plus a PointInstancer hole grid.

    Hole (i, j) sits at world (x0 + i*spacing, y0 + j*spacing). The slab top is
    at Z = BEAM_Z - 19 (board centred at -25, matching the project convention).
    """
    margin = spacing / 2.0
    w = (nx - 1) * spacing + 2 * margin
    d = (ny - 1) * spacing + 2 * margin
    cx = x0 + (nx - 1) * spacing / 2.0
    cy = y0 + (ny - 1) * spacing / 2.0
    board_top = BEAM_Z - 19.0
    board_cz = board_top - thickness_mm / 2.0

    if asset_rel_path:
        import usd_utility as uu
        board_xform = UsdGeom.Xform.Define(stage, f"{root_path}/Breadboard")
        board_prim = board_xform.GetPrim()
        board_prim.GetReferences().AddReference(
            uu.normalize_component_asset_ref(asset_rel_path)
        )
        board_prim.CreateAttribute(
            "optics:type", Sdf.ValueTypeNames.Token
        ).Set("breadboard")
        board_prim.CreateAttribute(
            "optics:fixedBoard", Sdf.ValueTypeNames.Bool
        ).Set(True)
        return board_xform

    board = UsdGeom.Cube.Define(stage, f"{root_path}/Breadboard")
    board.CreateSizeAttr(1.0)
    UsdGeom.Xformable(board).AddTransformOp().Set(
        Gf.Matrix4d().SetScale(Gf.Vec3d(w, d, thickness_mm))
        .SetTranslateOnly(Gf.Vec3d(cx, cy, board_cz)))
    board.CreateDisplayColorAttr([(0.18, 0.18, 0.2)])
    board_prim = board.GetPrim()
    board_prim.CreateAttribute(
        "optics:minSizeX", Sdf.ValueTypeNames.Double
    ).Set(float(w))
    board_prim.CreateAttribute(
        "optics:minSizeY", Sdf.ValueTypeNames.Double
    ).Set(float(d))
    board_prim.CreateAttribute(
        "optics:gridSpacing", Sdf.ValueTypeNames.Double
    ).Set(float(spacing))
    board_prim.CreateAttribute(
        "optics:gridOriginX", Sdf.ValueTypeNames.Double
    ).Set(float(x0))
    board_prim.CreateAttribute(
        "optics:gridOriginY", Sdf.ValueTypeNames.Double
    ).Set(float(y0))

    # hole grid as a PointInstancer (one prototype, many positions)
    pi = UsdGeom.PointInstancer.Define(stage, f"{root_path}/Holes")
    proto = UsdGeom.Cylinder.Define(stage, f"{root_path}/Holes/proto/Hole")
    proto.CreateRadiusAttr(hole_dia_mm / 2.0)
    proto.CreateHeightAttr(8.0)
    proto.CreateAxisAttr(UsdGeom.Tokens.z)
    proto.CreateDisplayColorAttr([(0.05, 0.05, 0.05)])
    pi.CreatePrototypesRel().AddTarget(f"{root_path}/Holes/proto/Hole")
    positions = []
    for i in range(nx):
        for j in range(ny):
            positions.append(Gf.Vec3f(x0 + i * spacing, y0 + j * spacing,
                                      board_top - 3.0))
    pi.CreatePositionsAttr(positions)
    pi.CreateProtoIndicesAttr([0] * len(positions))
    return board


def place(stage, root_path, name, asset_rel_path, x_mm, y_mm=0.0, z_mm=BEAM_Z,
          rotate_z_deg=0.0):
    """Reference a component asset into the setup at (x, y, z).

    asset_rel_path must be RELATIVE to the setup file (portability). Use
    rotate_z_deg to swing an optic's +X aperture onto a perpendicular arm.
    """
    if x_mm % GRID_MM or y_mm % GRID_MM:
        print(f"  ! {name}: ({x_mm},{y_mm}) is off the {GRID_MM:g}mm grid")
    import usd_utility as uu
    asset_rel_path = uu.normalize_component_asset_ref(asset_rel_path)
    prim = stage.OverridePrim(f"{root_path}/{name}")
    prim.GetReferences().AddReference(asset_rel_path)
    xf = UsdGeom.Xformable(prim)
    xf.AddTranslateOp().Set(Gf.Vec3d(x_mm, y_mm, z_mm))
    if rotate_z_deg:
        xf.AddRotateZOp().Set(rotate_z_deg)
    return prim


def add_beam(stage, root_path, segments, color=(1.0, 0.1, 0.1), width=1.0,
             wavelength_nm: float = 532.0):
    """Draw the planning beam as straight polylines.

    `segments` is a list of polylines; each polyline is a list of (x, y, z)
    points. Folds (at mirrors/beamsplitters) are just shared vertices between
    points -- geometry only, no physics.
    `wavelength_nm` is stored as metadata and drives the beam color in the UI.
    """
    beam = UsdGeom.BasisCurves.Define(stage, f"{root_path}/BeamPath")
    pts, counts = [], []
    for seg in segments:
        counts.append(len(seg))
        pts.extend(Gf.Vec3f(*p) for p in seg)
    beam.CreatePointsAttr(pts)
    beam.CreateCurveVertexCountsAttr(counts)
    beam.CreateTypeAttr(UsdGeom.Tokens.linear)
    beam.CreateWidthsAttr([width] * len(pts))
    beam.SetWidthsInterpolation(UsdGeom.Tokens.vertex)
    beam.CreateDisplayColorAttr([color])
    beam.GetPrim().CreateAttribute(
        "optics:beam:wavelength", Sdf.ValueTypeNames.Float).Set(float(wavelength_nm))
    return beam


def set_beam_path(stage, root_path, segments):
    """Record the beam as an ordered list of COMPONENT NAMES (not coordinates).

    `segments` is a list of polylines; each element is either a plain component
    name (string) or a dict {"ref": name, "pin": [x, y, z]} when the vertex is
    pinned to a fixed coordinate. The editor resolves the polyline from each
    component's live position (auto) or the stored pin (override).
    Folds are just a component that appears in more than one segment -- geometry
    only, no physics.
    """
    prim = stage.GetPrimAtPath(root_path)
    prim.CreateAttribute("optics:beamPath", Sdf.ValueTypeNames.String).Set(
        json.dumps(segments))


def summarize(setup_path):
    """Traverse a finished setup and print its optical components in place."""
    stage = Usd.Stage.Open(setup_path)
    print(f"\n=== {setup_path} ===")
    for prim in stage.Traverse():
        t = prim.GetAttribute("optics:type")
        if t and t.HasAuthoredValue():
            pos = prim.GetAttribute("xformOp:translate")
            p = pos.Get() if pos and pos.HasAuthoredValue() else None
            loc = f"({p[0]:.0f},{p[1]:.0f},{p[2]:.0f})" if p else "(?)"
            print(f"  {prim.GetName():14s} {t.Get():16s} {loc}")
