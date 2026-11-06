"""The breadboard: its prims, hole spacing, extents and authored size."""

import math

from flask import abort
from pxr import Usd, UsdGeom, Gf, Sdf

from opticaltwin import optics_lib as ol

from backend.scene import _authored_float

BOARD_MODEL_ORDER = (
    "Breadboard/MB6060_M-Step.usda",
    "Breadboard/MB6090_M-Step.usda",
    "Breadboard/MB60120_M-Step.usda",
    "Breadboard/MB7575_M-Step.usda",
)

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
