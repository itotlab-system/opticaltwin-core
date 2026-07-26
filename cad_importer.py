"""Convert STEP CAD data into OpticalTwin hi.usda and lo.usda assets.

Examples:
    # Existing LA4380-A lens (backward-compatible default)
    python cad_importer.py

    # Generate a high-detail model for any other component
    python cad_importer.py cad/mirror/M1.step --type mirror \
        --source-forward-axis +X --attr diameter_mm=25.4 \
        --attr reflectivity=0.99 --color 0.85 0.85 0.9

    # Generate both high- and low-detail models
    python cad_importer.py cad/mirror/M1.step --type mirror --lod both

    # Rod: five CAD Mesh parts in hi, one metallic Cylinder in lo
    python cad_importer.py cad/Mount/ER1.5-Step.step --type rod --lod both \
        --source-forward-axis +Y

    # Generate every Rod STEP into components/Rod/<STEP name>/
    python cad_importer.py cad/Rod --type rod --lod both \
        --source-forward-axis +Y
"""

import argparse
import itertools
from dataclasses import dataclass
import math
from pathlib import Path
import re
import sys
from typing import Any

from scipy.spatial import ConvexHull, QhullError
from OCP.IFSelect import IFSelect_ReturnStatus
from OCP.STEPControl import STEPControl_Reader
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TopoDS import TopoDS_Shape, TopoDS_Compound
from OCP.BRep import BRep_Builder
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRep import BRep_Tool
from OCP.BRepTools import BRepTools
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS
from OCP.TopLoc import TopLoc_Location
from OCP.TopAbs import (
    TopAbs_FACE,
    TopAbs_REVERSED,
    TopAbs_SHELL,
    TopAbs_SOLID,
)
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDF import TDF_Label, TDF_LabelSequence
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.Quantity import Quantity_ColorRGBA
from OCP.XCAFApp import XCAFApp_Application
from OCP.XCAFDoc import (
    XCAFDoc_ColorType,
    XCAFDoc_DocumentTool,
    XCAFDoc_ShapeTool,
)
from pxr import Gf, Sdf, Usd, UsdGeom


ROOT_DIR = Path(__file__).resolve().parent

DEFAULT_COMPONENT_NAME = "LA4380-A-Step"
DEFAULT_DISPLAY_COLOR = (0.4, 0.7, 1.0)
FORWARD_AXES = ("+X", "-X", "+Y", "-Y", "+Z", "-Z")
LOD_NAMES = ("hi", "lo")
LOD_MESH_SETTINGS = {
    "hi": (0.1, 0.5),
    "lo": (2.0, 1.0),
}
LO_PROXY_MODES = (
    "auto",
    "primitive",
    "surface",
    "convex-hull",
    "mesh",
    "box",
    "cylinder",
)
DEFAULT_LO_TARGET_TRIANGLES = 2000
LO_TARGET_TRIANGLES_BY_TYPE = {
    "lens": 300,
}


@dataclass
class MeshPart:
    points: list[tuple[float, float, float]]
    face_vertex_indices: list[int]
    color: tuple[float, float, float] | None
    opacity: float | None = None
    group_name: str | None = None


@dataclass
class LoPalette:
    selected_colors: list[tuple[float, float, float]]
    color_mapping: dict[
        tuple[float, float, float],
        tuple[float, float, float],
    ]
    area_ratios: list[float]
    source_color_count: int


@dataclass
class SourceRegion:
    points: list[tuple[float, float, float]]
    indices: list[int]
    triangle_colors: list[tuple[float, float, float]]


@dataclass(frozen=True)
class LensProfile:
    kind: str
    flat_side: str | None


def usd_identifier(value: str) -> str:
    """Return a valid, readable USD prim identifier."""
    identifier = re.sub(r"[^A-Za-z0-9_]", "_", value.strip())
    if not identifier:
        return "Component"
    if identifier[0].isdigit():
        identifier = f"Component_{identifier}"
    return identifier


def parse_attr_value(value: str) -> Any:
    """Parse a CLI optics attribute value into a scalar USD-compatible value."""
    lowered = value.lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        return value


def parse_optics_attrs(items: list[str]) -> dict[str, Any]:
    attrs = {}
    for item in items:
        if "=" not in item:
            raise ValueError(
                f"光学属性は NAME=VALUE 形式で指定してください: {item}"
            )
        name, value = item.split("=", 1)
        name = name.removeprefix("optics:").strip()
        if not name:
            raise ValueError(f"光学属性名が空です: {item}")
        attrs[name] = parse_attr_value(value.strip())
    return attrs


def orient_point(
    point: tuple[float, float, float],
    source_forward_axis: str,
    source_origin: tuple[float, float, float] = (0.0, 0.0, 0.0),
    source_roll_deg: float = 0.0,
) -> tuple[float, float, float]:
    """Rotate a source forward axis onto OpticalTwin's +X convention."""
    x = point[0] - source_origin[0]
    y = point[1] - source_origin[1]
    z = point[2] - source_origin[2]
    transforms = {
        "+X": (x, y, z),
        "-X": (-x, -y, z),
        "+Y": (y, -x, z),
        "-Y": (-y, x, z),
        "+Z": (z, y, -x),
        "-Z": (-z, y, x),
    }
    try:
        oriented = transforms[source_forward_axis.upper()]
    except KeyError as exc:
        raise ValueError(
            f"source_forward_axis must be one of: {', '.join(FORWARD_AXES)}"
        ) from exc
    if source_roll_deg == 0.0:
        return oriented
    angle = math.radians(source_roll_deg)
    cosine = math.cos(angle)
    sine = math.sin(angle)
    return (
        oriented[0],
        cosine * oriented[1] - sine * oriented[2],
        sine * oriented[1] + cosine * oriented[2],
    )


def create_optics_attribute(prim, name: str, value: Any) -> None:
    """Create one custom optics:* attribute with an appropriate USD type."""
    if isinstance(value, bool):
        value_type = Sdf.ValueTypeNames.Bool
    elif isinstance(value, int):
        value_type = Sdf.ValueTypeNames.Int
    elif isinstance(value, float):
        value_type = Sdf.ValueTypeNames.Float
    else:
        value_type = Sdf.ValueTypeNames.String
    prim.CreateAttribute(f"optics:{name}", value_type).Set(value)


def load_step(step_path: Path) -> TopoDS_Shape:
    """
    STEPファイルを読み込み、OpenCascadeのShapeとして返す。
    """

    step_path = step_path.resolve()

    if not step_path.exists():
        raise FileNotFoundError(f"STEPファイルが見つかりません: {step_path}")

    if step_path.suffix.lower() not in {".step", ".stp"}:
        raise ValueError(f"STEPファイルではありません: {step_path}")

    reader = STEPControl_Reader()

    status = reader.ReadFile(str(step_path))

    if status != IFSelect_ReturnStatus.IFSelect_RetDone:
        raise RuntimeError(f"STEPファイルの読み込みに失敗しました: {step_path}")

    transferred_count = reader.TransferRoots()

    if transferred_count == 0:
        raise RuntimeError(
            f"STEPファイルからShapeを変換できませんでした: {step_path}"
        )

    shape = reader.OneShape()

    if shape.IsNull():
        raise RuntimeError(f"読み込んだShapeが空です: {step_path}")

    return shape


def combine_step_shapes(shapes: list[TopoDS_Shape]) -> TopoDS_Shape:
    """Combine independently downloaded optic and mount STEP shapes."""
    if not shapes:
        raise ValueError("結合するSTEP Shapeがありません")
    if len(shapes) == 1:
        return shapes[0]
    compound = TopoDS_Compound()
    builder = BRep_Builder()
    builder.MakeCompound(compound)
    for shape in shapes:
        builder.Add(compound, shape)
    return compound


def load_step_with_colors(step_path: Path):
    """Load STEP geometry and its XCAF presentation colors."""
    step_path = step_path.resolve()
    if not step_path.exists():
        raise FileNotFoundError(f"STEPファイルが見つかりません: {step_path}")
    if step_path.suffix.lower() not in {".step", ".stp"}:
        raise ValueError(f"STEPファイルではありません: {step_path}")

    # The document must stay alive while its shape/color tools are being used.
    XCAFApp_Application.GetApplication_s()
    document = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
    reader = STEPCAFControl_Reader()
    reader.SetColorMode(True)

    status = reader.ReadFile(str(step_path))
    if status != IFSelect_ReturnStatus.IFSelect_RetDone:
        raise RuntimeError(f"STEPファイルの読み込みに失敗しました: {step_path}")
    if not reader.Transfer(document):
        raise RuntimeError(
            f"STEPファイルをXCAFドキュメントへ変換できませんでした: {step_path}"
        )

    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    color_tool = XCAFDoc_DocumentTool.ColorTool_s(document.Main())
    labels = TDF_LabelSequence()
    shape_tool.GetFreeShapes(labels)
    if labels.Length() == 0:
        raise RuntimeError(f"STEPファイルにShapeがありません: {step_path}")
    if labels.Length() > 1:
        raise RuntimeError(
            "複数の独立したルートShapeを持つSTEPにはまだ対応していません"
        )

    shape = XCAFDoc_ShapeTool.GetShape_s(labels.Value(1))
    if shape.IsNull():
        raise RuntimeError(f"読み込んだShapeが空です: {step_path}")
    return shape, document, color_tool


def mesh_shape(
    shape: TopoDS_Shape,
    linear_deflection: float = 0.1,
    angular_deflection: float = 0.5,
) -> None:
    """
    TopoDS_Shapeの各面に三角形メッシュを生成する。

    linear_deflection:
        元のCAD形状とメッシュとの距離誤差。
        小さいほど細かいメッシュになる。

    angular_deflection:
        曲面を分割するときの角度誤差（ラジアン）。
        小さいほど細かいメッシュになる。
    """

    if shape.IsNull():
        raise ValueError("空のShapeはメッシュ化できません")

    # STEP may contain an existing triangulation. Remove it so the requested
    # hi/lo settings always determine the generated mesh density.
    BRepTools.Clean_s(shape)

    mesher = BRepMesh_IncrementalMesh(
        shape,
        linear_deflection,
        False,
        angular_deflection,
        False,
    )

    mesher.Perform()

    if not mesher.IsDone():
        raise RuntimeError("Shapeのメッシュ化に失敗しました")


def inspect_mesh(shape: TopoDS_Shape, verbose_faces: bool = False) -> None:
    """
    Shapeに生成された三角形メッシュを面ごとに確認する。
    """

    explorer = TopExp_Explorer(shape, TopAbs_FACE)

    face_count = 0
    total_nodes = 0
    total_triangles = 0

    while explorer.More():
        face_count += 1

        face = TopoDS.Face_s(explorer.Current())
        location = TopLoc_Location()

        triangulation = BRep_Tool.Triangulation_s(face, location)

        if triangulation is None:
            print(f"Face {face_count}: メッシュなし")
            explorer.Next()
            continue

        node_count = triangulation.NbNodes()
        triangle_count = triangulation.NbTriangles()

        total_nodes += node_count
        total_triangles += triangle_count

        if verbose_faces:
            print(
                f"Face {face_count}: "
                f"頂点数={node_count}, "
                f"三角形数={triangle_count}"
            )

        explorer.Next()

    print("--- メッシュ情報 ---")
    print(f"面の数: {face_count}")
    print(f"面ごとの頂点数の合計: {total_nodes}")
    print(f"三角形数の合計: {total_triangles}")


def extract_mesh_data(
    shape: TopoDS_Shape,
) -> tuple[list[tuple[float, float, float]], list[int]]:
    """
    Shapeに付与された三角形メッシュから、
    頂点座標と三角形インデックスを取り出す。

    Returns:
        points:
            [(x, y, z), ...] の頂点座標

        face_vertex_indices:
            3頂点ごとに1つの三角形を表すインデックス
    """

    points: list[tuple[float, float, float]] = []
    face_vertex_indices: list[int] = []

    explorer = TopExp_Explorer(shape, TopAbs_FACE)

    while explorer.More():
        face = TopoDS.Face_s(explorer.Current())
        location = TopLoc_Location()

        triangulation = BRep_Tool.Triangulation_s(face, location)

        if triangulation is None:
            explorer.Next()
            continue

        # このFaceの頂点がpoints内のどこから始まるか
        vertex_offset = len(points)

        # STEP内の配置・回転を頂点へ反映する変換
        transformation = location.Transformation()

        # Poly_Triangulationの頂点番号は1から始まる
        for node_index in range(1, triangulation.NbNodes() + 1):
            point = triangulation.Node(node_index)
            transformed_point = point.Transformed(transformation)

            points.append(
                (
                    transformed_point.X(),
                    transformed_point.Y(),
                    transformed_point.Z(),
                )
            )

        for triangle_index in range(
            1,
            triangulation.NbTriangles() + 1,
        ):
            triangle = triangulation.Triangle(triangle_index)

            node1, node2, node3 = triangle.Get()

            # OpenCascadeは1始まり、USDは0始まり
            index1 = vertex_offset + node1 - 1
            index2 = vertex_offset + node2 - 1
            index3 = vertex_offset + node3 - 1

            # 裏向きのFaceでは三角形の頂点順を反転する
            if face.Orientation() == TopAbs_REVERSED:
                index2, index3 = index3, index2

            face_vertex_indices.extend(
                [index1, index2, index3]
            )

        explorer.Next()

    if not points:
        raise RuntimeError("メッシュの頂点を取得できませんでした")

    if not face_vertex_indices:
        raise RuntimeError("メッシュの三角形を取得できませんでした")

    return points, face_vertex_indices


def face_color(color_tool, face, fallback_color):
    """Return a STEP face color, preferring surface then general color."""
    for color_type in (
        XCAFDoc_ColorType.XCAFDoc_ColorSurf,
        XCAFDoc_ColorType.XCAFDoc_ColorGen,
        XCAFDoc_ColorType.XCAFDoc_ColorCurv,
    ):
        color = Quantity_ColorRGBA()
        if color_tool.GetColor(face, color_type, color):
            rgb = color.GetRGB()
            return (float(rgb.Red()), float(rgb.Green()), float(rgb.Blue()))
    return fallback_color


def extract_colored_mesh_data(
    shape: TopoDS_Shape,
    color_tool,
    fallback_color: tuple[float, float, float] | None,
) -> list[MeshPart]:
    """Extract triangulation grouped by authored STEP face color."""
    groups: dict[tuple[float, float, float] | None, MeshPart] = {}
    explorer = TopExp_Explorer(shape, TopAbs_FACE)

    while explorer.More():
        face = TopoDS.Face_s(explorer.Current())
        location = TopLoc_Location()
        triangulation = BRep_Tool.Triangulation_s(face, location)
        if triangulation is None:
            explorer.Next()
            continue

        # Rounded keys merge insignificant floating-point differences while the
        # original normalized RGB value remains suitable for USD displayColor.
        raw_color = face_color(color_tool, face, fallback_color)
        color = (
            tuple(round(channel, 6) for channel in raw_color)
            if raw_color is not None
            else None
        )
        part = groups.setdefault(color, MeshPart([], [], color))
        vertex_offset = len(part.points)
        transformation = location.Transformation()

        for node_index in range(1, triangulation.NbNodes() + 1):
            point = triangulation.Node(node_index).Transformed(transformation)
            part.points.append((point.X(), point.Y(), point.Z()))

        for triangle_index in range(1, triangulation.NbTriangles() + 1):
            node1, node2, node3 = triangulation.Triangle(triangle_index).Get()
            indices = [
                vertex_offset + node1 - 1,
                vertex_offset + node2 - 1,
                vertex_offset + node3 - 1,
            ]
            if face.Orientation() == TopAbs_REVERSED:
                indices[1], indices[2] = indices[2], indices[1]
            part.face_vertex_indices.extend(indices)

        explorer.Next()

    parts = [part for part in groups.values() if part.face_vertex_indices]
    if not parts:
        raise RuntimeError("メッシュの三角形を取得できませんでした")
    return parts


def transfer_mesh_colors(
    target_parts: list[MeshPart],
    reference_parts: list[MeshPart],
) -> list[MeshPart]:
    """Transfer authored reference colors after automatic axis/bounds alignment."""
    import numpy as np
    from scipy.spatial import cKDTree

    colored_reference = [
        part for part in reference_parts if part.color is not None
    ]
    if not colored_reference:
        raise ValueError("参照STEPに転写可能な色情報がありません")

    target_points = np.asarray(
        [point for part in target_parts for point in part.points],
        dtype=float,
    )
    reference_points = np.asarray(
        [point for part in reference_parts for point in part.points],
        dtype=float,
    )

    def normalized(points):
        minimum = points.min(axis=0)
        size = np.maximum(points.max(axis=0) - minimum, 1e-9)
        return (points - minimum) / size

    target_normalized = normalized(target_points)
    reference_normalized = normalized(reference_points)
    reference_tree = cKDTree(reference_normalized)
    sample_step = max(1, len(target_normalized) // 5000)
    sample = target_normalized[::sample_step]
    best_score = float("inf")
    best_permutation = (0, 1, 2)
    best_flips = (False, False, False)
    for permutation in itertools.permutations(range(3)):
        permuted = sample[:, permutation]
        for flips in itertools.product((False, True), repeat=3):
            candidate = permuted.copy()
            for axis, flip in enumerate(flips):
                if flip:
                    candidate[:, axis] = 1.0 - candidate[:, axis]
            score = float(reference_tree.query(candidate, k=1)[0].mean())
            if score < best_score:
                best_score = score
                best_permutation = permutation
                best_flips = flips

    reference_centers = []
    reference_colors = []
    for part in colored_reference:
        points = normalized(reference_points)
        # Convert this part through the global reference bounds.
        all_minimum = reference_points.min(axis=0)
        all_size = np.maximum(reference_points.max(axis=0) - all_minimum, 1e-9)
        part_points = (np.asarray(part.points) - all_minimum) / all_size
        indices = np.asarray(part.face_vertex_indices).reshape(-1, 3)
        reference_centers.extend(part_points[indices].mean(axis=1))
        reference_colors.extend([part.color] * len(indices))
    color_tree = cKDTree(np.asarray(reference_centers))

    grouped: dict[
        tuple[str | None, tuple[float, float, float]],
        MeshPart,
    ] = {}
    target_minimum = target_points.min(axis=0)
    target_size = np.maximum(target_points.max(axis=0) - target_minimum, 1e-9)
    for part in target_parts:
        part_points = np.asarray(part.points)
        aligned = ((part_points - target_minimum) / target_size)[
            :, best_permutation
        ]
        for axis, flip in enumerate(best_flips):
            if flip:
                aligned[:, axis] = 1.0 - aligned[:, axis]
        triangles = np.asarray(part.face_vertex_indices).reshape(-1, 3)
        centers = aligned[triangles].mean(axis=1)
        nearest = color_tree.query(centers, k=1)[1]
        for triangle, color_index in zip(triangles, nearest):
            color = reference_colors[int(color_index)]
            key = (part.group_name, color)
            output = grouped.setdefault(
                key,
                MeshPart([], [], color, group_name=part.group_name),
            )
            offset = len(output.points)
            output.points.extend(
                tuple(float(value) for value in part_points[index])
                for index in triangle
            )
            output.face_vertex_indices.extend((offset, offset + 1, offset + 2))
    print(
        "色参照STEPとの自動位置合わせ: "
        f"軸={best_permutation}, 反転={best_flips}, 誤差={best_score:.5f}"
    )
    return list(grouped.values())


def collapse_to_one_color_per_group(parts: list[MeshPart]) -> list[MeshPart]:
    """Merge each component occurrence into one mesh using its dominant color."""
    import numpy as np

    grouped: dict[str | None, list[MeshPart]] = {}
    for part in parts:
        grouped.setdefault(part.group_name, []).append(part)

    collapsed = []
    for group_name, group_parts in grouped.items():
        color_areas: dict[tuple[float, float, float], float] = {}
        for part in group_parts:
            if part.color is None:
                continue
            points = np.asarray(part.points)
            triangles = np.asarray(part.face_vertex_indices).reshape(-1, 3)
            vertices = points[triangles]
            area = float(
                np.linalg.norm(
                    np.cross(
                        vertices[:, 1] - vertices[:, 0],
                        vertices[:, 2] - vertices[:, 0],
                    ),
                    axis=1,
                ).sum()
            )
            color_areas[part.color] = color_areas.get(part.color, 0.0) + area
        dominant_color = max(color_areas, key=color_areas.get)
        merged = MeshPart([], [], dominant_color, group_name=group_name)
        for part in group_parts:
            offset = len(merged.points)
            merged.points.extend(part.points)
            merged.face_vertex_indices.extend(
                index + offset for index in part.face_vertex_indices
            )
        collapsed.append(merged)
    return collapsed


def is_rod_component(component_type: str, root_prim_name: str) -> bool:
    """Return whether the requested asset uses the dedicated Rod pipeline."""
    return (
        component_type.lower() == "rod"
        or root_prim_name.lower() == "rod"
    )


def split_rod_hi_parts(parts: list[MeshPart]) -> list[MeshPart]:
    """Keep Rod CAD geometry intact while exposing exactly five USD meshes.

    The common Rod STEP layout contains one wide central body color region and
    two paired end regions.  Split each paired end region at the Rod center to
    reproduce Body, +inner, +outer, -inner, -outer.  For STEP files with a
    different color layout, group the original triangles into the same five
    longitudinal sections without changing any vertex positions.
    """
    if len(parts) == 5:
        return parts
    if not parts:
        raise ValueError("Rodのhi生成に使用できるMesh部品がありません")

    all_points = [point for part in parts for point in part.points]
    minimum, maximum = oriented_bounds(all_points, "+X")
    sizes = [
        maximum[axis] - minimum[axis]
        for axis in range(3)
    ]
    longitudinal_axis = max(range(3), key=sizes.__getitem__)
    transverse_axes = [
        axis for axis in range(3) if axis != longitudinal_axis
    ]
    center = (
        minimum[longitudinal_axis] + maximum[longitudinal_axis]
    ) / 2.0

    def bounds(part: MeshPart):
        return oriented_bounds(part.points, "+X")

    # The central shaft has the largest transverse envelope. End details can
    # extend farther longitudinally, so longitudinal span is not a safe key.
    body_index = max(
        range(len(parts)),
        key=lambda index: math.prod(
            bounds(parts[index])[1][axis] - bounds(parts[index])[0][axis]
            for axis in transverse_axes
        ),
    )

    def triangle_subset(
        part: MeshPart,
        keep_triangle,
    ) -> MeshPart | None:
        points: list[tuple[float, float, float]] = []
        indices: list[int] = []
        source = part.face_vertex_indices
        for offset in range(0, len(source), 3):
            triangle = source[offset:offset + 3]
            triangle_center = sum(
                part.points[index][longitudinal_axis]
                for index in triangle
            ) / 3.0
            if not keep_triangle(triangle_center):
                continue
            new_offset = len(points)
            points.extend(part.points[index] for index in triangle)
            indices.extend((new_offset, new_offset + 1, new_offset + 2))
        if not indices:
            return None
        return MeshPart(
            points,
            indices,
            part.color,
            opacity=part.opacity,
            group_name=part.group_name,
        )

    if len(parts) == 3:
        body = parts[body_index]
        end_parts = [
            part for index, part in enumerate(parts) if index != body_index
        ]
        # Order the paired regions from the shaft outwards.
        end_parts.sort(
            key=lambda part: max(
                abs(
                    (
                        bounds(part)[0][longitudinal_axis]
                        + bounds(part)[1][longitudinal_axis]
                    ) / 2.0
                    - center
                ),
                abs(bounds(part)[1][longitudinal_axis] - center),
            )
        )
        positive = [
            triangle_subset(part, lambda value: value >= center)
            for part in end_parts
        ]
        negative = [
            triangle_subset(part, lambda value: value < center)
            for part in end_parts
        ]
        result = [body, *positive, *negative]
        if len(result) == 5 and all(result):
            return [part for part in result if part is not None]

    # A colorless or differently-authored STEP still gets five Mesh prims.
    # Assign complete source triangles by longitudinal position; this changes
    # only prim grouping, never the high-detail CAD surface itself.
    triangle_records = []
    for part in parts:
        source = part.face_vertex_indices
        for offset in range(0, len(source), 3):
            triangle = source[offset:offset + 3]
            triangle_records.append((
                sum(
                    part.points[index][longitudinal_axis]
                    for index in triangle
                ) / 3.0,
                part,
                triangle,
            ))
    if len(triangle_records) < 5:
        raise ValueError("Rodのhiを5部品へ分けるのに十分な面がありません")

    triangle_records.sort(key=lambda record: record[0])
    groups: list[list[tuple[float, MeshPart, list[int]]]] = [
        [] for _ in range(5)
    ]
    for index, record in enumerate(triangle_records):
        group_index = min(index * 5 // len(triangle_records), 4)
        groups[group_index].append(record)

    output = []
    # Preserve the familiar center, +near, +far, -near, -far naming order.
    for group_index in (2, 3, 4, 1, 0):
        records = groups[group_index]
        result = MeshPart([], [], records[0][1].color)
        for _, part, triangle in records:
            new_offset = len(result.points)
            result.points.extend(part.points[index] for index in triangle)
            result.face_vertex_indices.extend(
                (new_offset, new_offset + 1, new_offset + 2)
            )
        output.append(result)
    return output


def assembly_leaf_shapes(document) -> list[tuple[str, TopoDS_Shape]]:
    """Return uniquely named, globally positioned leaf component occurrences."""
    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    roots = TDF_LabelSequence()
    shape_tool.GetFreeShapes(roots)
    occurrences: list[tuple[str, TopoDS_Shape]] = []
    name_counts: dict[str, int] = {}

    def label_name(label: TDF_Label) -> str:
        attribute = TDataStd_Name()
        if label.FindAttribute(TDataStd_Name.GetID_s(), attribute):
            return attribute.Get().ToExtString()
        return "Part"

    def visit(label: TDF_Label, parent_location: TopLoc_Location) -> None:
        definition = label
        local_location = TopLoc_Location()
        if shape_tool.IsReference_s(label):
            local_location = shape_tool.GetLocation_s(label)
            referred = TDF_Label()
            if shape_tool.GetReferredShape_s(label, referred):
                definition = referred
        location = parent_location.Multiplied(local_location)
        if shape_tool.IsAssembly_s(definition):
            components = TDF_LabelSequence()
            shape_tool.GetComponents_s(definition, components, False)
            for index in range(1, components.Length() + 1):
                visit(components.Value(index), location)
            return

        shape = shape_tool.GetShape_s(definition)
        if shape.IsNull():
            return
        base_name = usd_identifier(label_name(definition))
        name_counts[base_name] = name_counts.get(base_name, 0) + 1
        occurrence_name = (
            base_name
            if name_counts[base_name] == 1
            else f"{base_name}_{name_counts[base_name]:03d}"
        )
        occurrences.append((occurrence_name, shape.Moved(location)))

    for index in range(1, roots.Length() + 1):
        visit(roots.Value(index), TopLoc_Location())
    return occurrences


def combine_mesh_parts(
    parts: list[MeshPart],
) -> tuple[
    list[tuple[float, float, float]],
    list[int],
    list[tuple[float, float, float]],
]:
    """Combine colored parts while retaining one color label per triangle."""
    points = []
    indices = []
    triangle_colors = []
    for part in parts:
        offset = len(points)
        points.extend(part.points)
        indices.extend(index + offset for index in part.face_vertex_indices)
        triangle_colors.extend(
            [part.color] * (len(part.face_vertex_indices) // 3)
        )
    return points, indices, triangle_colors


def extract_source_regions(
    shape: TopoDS_Shape,
    color_tool,
    fallback_color: tuple[float, float, float],
    ignore_step_colors: bool,
) -> list[SourceRegion]:
    """Extract independently simplifiable solids, or shells for surface STEP."""
    region_shapes = []
    covered_faces = set()

    def face_hashes(region_shape):
        hashes = set()
        face_explorer = TopExp_Explorer(region_shape, TopAbs_FACE)
        while face_explorer.More():
            hashes.add(hash(face_explorer.Current()))
            face_explorer.Next()
        return hashes

    # Closed solids are the most useful structural regions.
    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    while explorer.More():
        solid = TopoDS.Solid_s(explorer.Current())
        hashes = face_hashes(solid)
        if hashes and hashes.isdisjoint(covered_faces):
            region_shapes.append(solid)
            covered_faces.update(hashes)
        explorer.Next()

    # Some vendor STEP assemblies mix solids with independent surface shells.
    explorer = TopExp_Explorer(shape, TopAbs_SHELL)
    while explorer.More():
        shell = TopoDS.Shell_s(explorer.Current())
        hashes = face_hashes(shell)
        if hashes and hashes.isdisjoint(covered_faces):
            region_shapes.append(shell)
            covered_faces.update(hashes)
        explorer.Next()

    # Preserve any standalone faces not owned by a solid or shell.
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = TopoDS.Face_s(explorer.Current())
        face_hash = hash(face)
        if face_hash not in covered_faces:
            region_shapes.append(face)
            covered_faces.add(face_hash)
        explorer.Next()

    if not region_shapes:
        region_shapes = [shape]

    regions = []
    for region_shape in region_shapes:
        if ignore_step_colors:
            points, indices = extract_mesh_data(region_shape)
            triangle_colors = [fallback_color] * (len(indices) // 3)
        else:
            parts = extract_colored_mesh_data(
                region_shape,
                color_tool,
                fallback_color,
            )
            points, indices, triangle_colors = combine_mesh_parts(parts)
        if indices:
            regions.append(SourceRegion(points, indices, triangle_colors))
    if not regions:
        raise RuntimeError("lo用の形状領域を取得できませんでした")
    return regions


def combine_source_regions(
    regions: list[SourceRegion],
) -> tuple[
    list[tuple[float, float, float]],
    list[int],
    list[tuple[float, float, float]],
]:
    points = []
    indices = []
    colors = []
    for region in regions:
        offset = len(points)
        points.extend(region.points)
        indices.extend(index + offset for index in region.indices)
        colors.extend(region.triangle_colors)
    return points, indices, colors


def triangle_area(
    point1: tuple[float, float, float],
    point2: tuple[float, float, float],
    point3: tuple[float, float, float],
) -> float:
    """Return a triangle's surface area."""
    ax = point2[0] - point1[0]
    ay = point2[1] - point1[1]
    az = point2[2] - point1[2]
    bx = point3[0] - point1[0]
    by = point3[1] - point1[1]
    bz = point3[2] - point1[2]
    cross_x = ay * bz - az * by
    cross_y = az * bx - ax * bz
    cross_z = ax * by - ay * bx
    return 0.5 * math.sqrt(
        cross_x * cross_x
        + cross_y * cross_y
        + cross_z * cross_z
    )


def color_distance(
    color1: tuple[float, float, float],
    color2: tuple[float, float, float],
) -> float:
    return math.sqrt(sum(
        (color1[channel] - color2[channel]) ** 2
        for channel in range(3)
    ))


def select_lo_palette(
    points: list[tuple[float, float, float]],
    indices: list[int],
    triangle_colors: list[tuple[float, float, float]],
    *,
    similar_color_distance: float = 0.08,
    dominant_ratio: float = 0.90,
    minimum_color_ratio: float = 0.05,
) -> LoPalette:
    """Select up to three major colors using true triangle surface area."""
    if len(triangle_colors) != len(indices) // 3:
        raise ValueError("三角形数と色ラベル数が一致しません")

    raw_areas: dict[tuple[float, float, float], float] = {}
    for triangle_index, color in enumerate(triangle_colors):
        offset = triangle_index * 3
        area = triangle_area(
            points[indices[offset]],
            points[indices[offset + 1]],
            points[indices[offset + 2]],
        )
        raw_areas[color] = raw_areas.get(color, 0.0) + area

    # Merge insignificant RGB variations before counting authored colors.
    clusters = []
    raw_to_cluster = {}
    for color, area in sorted(
        raw_areas.items(),
        key=lambda item: item[1],
        reverse=True,
    ):
        nearest_index = None
        nearest_distance = float("inf")
        for index, cluster in enumerate(clusters):
            distance = color_distance(color, cluster["color"])
            if distance < nearest_distance:
                nearest_index = index
                nearest_distance = distance
        if (
            nearest_index is None
            or nearest_distance > similar_color_distance
        ):
            clusters.append({
                "color": color,
                "weighted": [
                    color[channel] * area
                    for channel in range(3)
                ],
                "area": area,
                "raw_colors": [color],
            })
            raw_to_cluster[color] = len(clusters) - 1
        else:
            cluster = clusters[nearest_index]
            cluster["area"] += area
            for channel in range(3):
                cluster["weighted"][channel] += color[channel] * area
            cluster["color"] = tuple(
                cluster["weighted"][channel] / cluster["area"]
                for channel in range(3)
            )
            cluster["raw_colors"].append(color)
            raw_to_cluster[color] = nearest_index

    clusters.sort(key=lambda cluster: cluster["area"], reverse=True)
    raw_to_cluster = {
        raw_color: index
        for index, cluster in enumerate(clusters)
        for raw_color in cluster["raw_colors"]
    }
    total_area = sum(cluster["area"] for cluster in clusters)
    if total_area <= 0.0:
        total_area = float(sum(len(part["raw_colors"]) for part in clusters))
        for cluster in clusters:
            cluster["area"] = float(len(cluster["raw_colors"]))

    source_color_count = len(clusters)
    if source_color_count <= 5:
        maximum_colors = 1
    elif source_color_count <= 14:
        maximum_colors = 2
    else:
        maximum_colors = 3

    ratios = [cluster["area"] / total_area for cluster in clusters]
    if ratios and ratios[0] >= dominant_ratio:
        maximum_colors = 1

    selected_indices = [0]
    for index in range(1, min(maximum_colors, len(clusters))):
        if ratios[index] >= minimum_color_ratio:
            selected_indices.append(index)

    selected_colors = [
        tuple(clusters[index]["color"])
        for index in selected_indices
    ]
    selected_lookup = {
        cluster_index: selected_colors[selected_index]
        for selected_index, cluster_index in enumerate(selected_indices)
    }
    dominant_color = selected_colors[0]
    mapping = {
        raw_color: selected_lookup.get(cluster_index, dominant_color)
        for raw_color, cluster_index in raw_to_cluster.items()
    }
    return LoPalette(
        selected_colors=selected_colors,
        color_mapping=mapping,
        area_ratios=[ratios[index] for index in selected_indices],
        source_color_count=source_color_count,
    )


def split_mesh_by_palette(
    points: list[tuple[float, float, float]],
    indices: list[int],
    triangle_colors: list[tuple[float, float, float]],
    palette: LoPalette,
) -> list[MeshPart]:
    """Split one simplified mesh into at most three compact colored meshes."""
    grouped_triangles: dict[tuple[float, float, float], list[tuple[int, int, int]]] = {
        color: []
        for color in palette.selected_colors
    }
    for triangle_index, source_color in enumerate(triangle_colors):
        offset = triangle_index * 3
        color = palette.color_mapping[source_color]
        grouped_triangles[color].append((
            indices[offset],
            indices[offset + 1],
            indices[offset + 2],
        ))

    parts = []
    for color in palette.selected_colors:
        triangles = grouped_triangles[color]
        if not triangles:
            continue
        old_to_new = {}
        part_points = []
        part_indices = []
        for triangle in triangles:
            for old_index in triangle:
                if old_index not in old_to_new:
                    old_to_new[old_index] = len(part_points)
                    part_points.append(points[old_index])
                part_indices.append(old_to_new[old_index])
        parts.append(MeshPart(part_points, part_indices, color))
    return parts


def oriented_bounds(
    points: list[tuple[float, float, float]],
    source_forward_axis: str,
    source_origin: tuple[float, float, float] = (0.0, 0.0, 0.0),
    source_roll_deg: float = 0.0,
) -> tuple[
    tuple[float, float, float],
    tuple[float, float, float],
]:
    """Return the displayed bounds after applying the OpticalTwin orientation."""
    oriented = [
        orient_point(
            point,
            source_forward_axis,
            source_origin,
            source_roll_deg,
        )
        for point in points
    ]
    minimum = tuple(min(point[axis] for point in oriented) for axis in range(3))
    maximum = tuple(max(point[axis] for point in oriented) for axis in range(3))
    return minimum, maximum


def make_box_proxy(
    minimum: tuple[float, float, float],
    maximum: tuple[float, float, float],
) -> tuple[list[tuple[float, float, float]], list[int]]:
    """Create a 12-triangle box with exactly the requested bounds."""
    x0, y0, z0 = minimum
    x1, y1, z1 = maximum
    points = [
        (x0, y0, z0),
        (x1, y0, z0),
        (x1, y1, z0),
        (x0, y1, z0),
        (x0, y0, z1),
        (x1, y0, z1),
        (x1, y1, z1),
        (x0, y1, z1),
    ]
    indices = [
        0, 2, 1, 0, 3, 2,
        4, 5, 6, 4, 6, 7,
        0, 1, 5, 0, 5, 4,
        1, 2, 6, 1, 6, 5,
        2, 3, 7, 2, 7, 6,
        3, 0, 4, 3, 4, 7,
    ]
    return points, indices


def make_convex_hull_proxy(
    points: list[tuple[float, float, float]],
) -> tuple[list[tuple[float, float, float]], list[int]]:
    """Connect the outermost CAD vertices into a compact convex surface."""
    unique_points = list(dict.fromkeys(
        tuple(round(value, 9) for value in point)
        for point in points
    ))
    if len(unique_points) < 4:
        raise ValueError("凸包の生成には4点以上の頂点が必要です")
    try:
        hull = ConvexHull(unique_points)
    except QhullError as exc:
        raise ValueError("CAD頂点から3次元の凸包を生成できませんでした") from exc

    used_indices = sorted({
        int(index)
        for triangle in hull.simplices
        for index in triangle
    })
    old_to_new = {
        old_index: new_index
        for new_index, old_index in enumerate(used_indices)
    }
    hull_points = [unique_points[index] for index in used_indices]
    centroid = tuple(
        sum(point[axis] for point in hull_points) / len(hull_points)
        for axis in range(3)
    )
    indices = []
    for simplex in hull.simplices:
        triangle = [int(index) for index in simplex]
        a, b, c = (unique_points[index] for index in triangle)
        ab = tuple(b[axis] - a[axis] for axis in range(3))
        ac = tuple(c[axis] - a[axis] for axis in range(3))
        normal = (
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0],
        )
        face_center = tuple(
            (a[axis] + b[axis] + c[axis]) / 3.0
            for axis in range(3)
        )
        outward = tuple(
            face_center[axis] - centroid[axis]
            for axis in range(3)
        )
        if sum(normal[axis] * outward[axis] for axis in range(3)) < 0.0:
            triangle[1], triangle[2] = triangle[2], triangle[1]
        indices.extend(old_to_new[index] for index in triangle)
    return hull_points, indices


def make_convex_hull_ring_proxy(
    points: list[tuple[float, float, float]],
    aperture_mm: float,
    hole_center_yz: tuple[float, float] = (0.0, 0.0),
) -> tuple[list[tuple[float, float, float]], list[int]]:
    """Extrude the outer YZ convex hull while keeping a circular through-hole."""
    minimum, maximum = oriented_bounds(points, "+X")
    yz_points = list(dict.fromkeys(
        (round(point[1], 9), round(point[2], 9))
        for point in points
    ))
    try:
        profile_hull = ConvexHull(yz_points)
    except QhullError as exc:
        raise ValueError("絞りの外周凸包を生成できませんでした") from exc

    outer_profile = [
        yz_points[int(index)]
        for index in profile_hull.vertices
    ]
    cy, cz = hole_center_yz
    aperture_radius = aperture_mm / 2.0
    if aperture_radius <= 0.0:
        raise ValueError("絞り穴の直径は0より大きくしてください")
    closest_outer_radius = min(
        math.hypot(y - cy, z - cz)
        for y, z in outer_profile
    )
    if aperture_radius >= closest_outer_radius:
        raise ValueError("絞り穴が外周凸包より大きすぎます")

    inner_profile = []
    for y, z in outer_profile:
        angle = math.atan2(z - cz, y - cy)
        inner_profile.append((
            cy + aperture_radius * math.cos(angle),
            cz + aperture_radius * math.sin(angle),
        ))

    x0, x1 = minimum[0], maximum[0]
    count = len(outer_profile)
    ring_points = []
    for x in (x0, x1):
        ring_points.extend((x, y, z) for y, z in outer_profile)
    for x in (x0, x1):
        ring_points.extend((x, y, z) for y, z in inner_profile)

    outer_front = 0
    outer_back = count
    inner_front = count * 2
    inner_back = count * 3
    indices = []
    for index in range(count):
        following = (index + 1) % count
        of0, of1 = outer_front + index, outer_front + following
        ob0, ob1 = outer_back + index, outer_back + following
        inf0, inf1 = inner_front + index, inner_front + following
        inb0, inb1 = inner_back + index, inner_back + following
        indices.extend([
            # Outer wall.
            of0, ob0, ob1,
            of0, ob1, of1,
            # Front annulus.
            of0, of1, inf1,
            of0, inf1, inf0,
            # Back annulus.
            ob0, inb1, ob1,
            ob0, inb0, inb1,
            # Inner wall, wound toward the opening.
            inf0, inb1, inb0,
            inf0, inf1, inb1,
        ])
    return ring_points, indices


def make_cylinder_proxy(
    minimum: tuple[float, float, float],
    maximum: tuple[float, float, float],
    segments: int,
    aperture_mm: float | None = None,
) -> tuple[list[tuple[float, float, float]], list[int]]:
    """Create an X-axis elliptical cylinder or iris ring with exact bounds."""
    x0, y0, z0 = minimum
    x1, y1, z1 = maximum
    cy = (y0 + y1) / 2.0
    cz = (z0 + z1) / 2.0
    ry = (y1 - y0) / 2.0
    rz = (z1 - z0) / 2.0
    ring = aperture_mm is not None and aperture_mm > 0.0

    points: list[tuple[float, float, float]] = []
    for x in (x0, x1):
        for index in range(segments):
            angle = 2.0 * math.pi * index / segments
            points.append((
                x,
                cy + ry * math.cos(angle),
                cz + rz * math.sin(angle),
            ))

    inner_offset = len(points)
    if ring:
        inner_radius = min(aperture_mm / 2.0, ry * 0.95, rz * 0.95)
        for x in (x0, x1):
            for index in range(segments):
                angle = 2.0 * math.pi * index / segments
                points.append((
                    x,
                    cy + inner_radius * math.cos(angle),
                    cz + inner_radius * math.sin(angle),
                ))
    else:
        points.extend([(x0, cy, cz), (x1, cy, cz)])

    indices: list[int] = []
    for index in range(segments):
        following = (index + 1) % segments
        front = index
        front_next = following
        back = segments + index
        back_next = segments + following

        # Outer wall.
        indices.extend([
            front, back_next, back,
            front, front_next, back_next,
        ])

        if ring:
            inner_front = inner_offset + index
            inner_front_next = inner_offset + following
            inner_back = inner_offset + segments + index
            inner_back_next = inner_offset + segments + following
            # Front and back annular faces plus the inner wall.
            indices.extend([
                front, inner_front_next, front_next,
                front, inner_front, inner_front_next,
                back, back_next, inner_back_next,
                back, inner_back_next, inner_back,
                inner_front, inner_back, inner_back_next,
                inner_front, inner_back_next, inner_front_next,
            ])
        else:
            front_center = 2 * segments
            back_center = front_center + 1
            indices.extend([
                front_center, front_next, front,
                back_center, back, back_next,
            ])

    return points, indices


def cluster_mesh(
    points: list[tuple[float, float, float]],
    indices: list[int],
    triangle_colors: list[tuple[float, float, float]],
    resolution: int,
) -> tuple[
    list[tuple[float, float, float]],
    list[int],
    list[tuple[float, float, float]],
]:
    """Simplify a triangle mesh by merging vertices into a regular 3D grid."""
    minimum = tuple(min(point[axis] for point in points) for axis in range(3))
    maximum = tuple(max(point[axis] for point in points) for axis in range(3))
    size = tuple(maximum[axis] - minimum[axis] for axis in range(3))

    clusters: dict[tuple[int, int, int], list[float]] = {}
    point_keys = []
    for point in points:
        key = tuple(
            min(
                resolution,
                int(
                    (point[axis] - minimum[axis])
                    / size[axis]
                    * resolution
                ),
            )
            if size[axis] > 0.0
            else 0
            for axis in range(3)
        )
        point_keys.append(key)
        aggregate = clusters.setdefault(key, [0.0, 0.0, 0.0, 0.0])
        aggregate[0] += point[0]
        aggregate[1] += point[1]
        aggregate[2] += point[2]
        aggregate[3] += 1.0

    key_to_index = {}
    simplified_points = []
    for key, aggregate in clusters.items():
        key_to_index[key] = len(simplified_points)
        count = aggregate[3]
        simplified_points.append((
            aggregate[0] / count,
            aggregate[1] / count,
            aggregate[2] / count,
        ))

    remap = [key_to_index[key] for key in point_keys]
    simplified_indices = []
    simplified_colors = []
    seen_triangles = set()
    for triangle_index, offset in enumerate(range(0, len(indices), 3)):
        triangle = (
            remap[indices[offset]],
            remap[indices[offset + 1]],
            remap[indices[offset + 2]],
        )
        if len(set(triangle)) < 3:
            continue
        identity = tuple(sorted(triangle))
        if identity in seen_triangles:
            continue
        seen_triangles.add(identity)
        simplified_indices.extend(triangle)
        simplified_colors.append(triangle_colors[triangle_index])

    if not simplified_indices:
        raise RuntimeError("loメッシュの簡略化結果が空になりました")

    # Drop clusters no surviving triangle references. Bounds must be matched
    # using only vertices that will actually be authored to the USD meshes.
    old_to_new = {}
    compact_points = []
    compact_indices = []
    for old_index in simplified_indices:
        if old_index not in old_to_new:
            old_to_new[old_index] = len(compact_points)
            compact_points.append(simplified_points[old_index])
        compact_indices.append(old_to_new[old_index])
    return compact_points, compact_indices, simplified_colors


def match_bounds(
    points: list[tuple[float, float, float]],
    target_minimum: tuple[float, float, float],
    target_maximum: tuple[float, float, float],
) -> list[tuple[float, float, float]]:
    """Scale and translate a simplified mesh back onto the hi mesh bounds."""
    minimum = tuple(min(point[axis] for point in points) for axis in range(3))
    maximum = tuple(max(point[axis] for point in points) for axis in range(3))
    result = []
    for point in points:
        matched = []
        for axis in range(3):
            source_size = maximum[axis] - minimum[axis]
            target_size = target_maximum[axis] - target_minimum[axis]
            if source_size > 0.0:
                value = (
                    (point[axis] - minimum[axis])
                    / source_size
                    * target_size
                    + target_minimum[axis]
                )
            else:
                value = (target_minimum[axis] + target_maximum[axis]) / 2.0
            matched.append(value)
        result.append(tuple(matched))
    return result


def simplify_surface_mesh(
    points: list[tuple[float, float, float]],
    indices: list[int],
    triangle_colors: list[tuple[float, float, float]],
    target_triangles: int,
) -> tuple[
    list[tuple[float, float, float]],
    list[int],
    list[tuple[float, float, float]],
]:
    """Preserve a small hi mesh or adaptively cluster a large one."""
    if len(indices) // 3 <= target_triangles:
        return points, indices, triangle_colors

    target_minimum = tuple(
        min(point[axis] for point in points)
        for axis in range(3)
    )
    target_maximum = tuple(
        max(point[axis] for point in points)
        for axis in range(3)
    )
    best = None
    low = 2
    high = 128
    while low <= high:
        resolution = (low + high) // 2
        candidate = cluster_mesh(
            points,
            indices,
            triangle_colors,
            resolution,
        )
        triangle_count = len(candidate[1]) // 3
        if triangle_count <= target_triangles:
            best = candidate
            low = resolution + 1
        else:
            high = resolution - 1

    if best is None:
        best = cluster_mesh(points, indices, triangle_colors, 2)
    simplified_points, simplified_indices, simplified_colors = best
    return (
        match_bounds(simplified_points, target_minimum, target_maximum),
        simplified_indices,
        simplified_colors,
    )


def mesh_surface_area(
    points: list[tuple[float, float, float]],
    indices: list[int],
) -> float:
    return sum(
        triangle_area(
            points[indices[offset]],
            points[indices[offset + 1]],
            points[indices[offset + 2]],
        )
        for offset in range(0, len(indices), 3)
    )


def simplify_surface_regions(
    regions: list[SourceRegion],
    source_forward_axis: str,
    target_triangles: int,
    source_origin: tuple[float, float, float] = (0.0, 0.0, 0.0),
    source_roll_deg: float = 0.0,
) -> tuple[
    list[tuple[float, float, float]],
    list[int],
    list[tuple[float, float, float]],
]:
    """Distribute the polygon budget so major separate shapes stay recognizable."""
    oriented_regions = [
        SourceRegion(
            [
                orient_point(
                    point,
                    source_forward_axis,
                    source_origin,
                    source_roll_deg,
                )
                for point in region.points
            ],
            region.indices,
            region.triangle_colors,
        )
        for region in regions
    ]
    areas = [
        mesh_surface_area(region.points, region.indices)
        for region in oriented_regions
    ]
    # Square-root weighting gives a lens barrel, display panel, or connector
    # more representation than pure area-proportional allocation would.
    weights = [math.sqrt(max(area, 1e-12)) for area in areas]
    total_weight = sum(weights)

    simplified_regions = []
    for region, weight in zip(oriented_regions, weights):
        original_triangles = len(region.indices) // 3
        budget = max(
            12,
            round(target_triangles * weight / total_weight),
        )
        budget = min(original_triangles, budget)
        points, indices, colors = simplify_surface_mesh(
            region.points,
            region.indices,
            region.triangle_colors,
            budget,
        )
        simplified_regions.append(SourceRegion(points, indices, colors))
    return combine_source_regions(simplified_regions)


def lo_proxy_kind(component_type: str, requested: str) -> str:
    """Resolve the automatic proxy primitive for one component type."""
    del component_type
    return "primitive" if requested == "auto" else requested


def set_gprim_appearance(
    gprim,
    color: tuple[float, float, float],
    opacity: float,
    *,
    double_sided: bool = False,
) -> None:
    """Author the lightweight viewport appearance shared by analytic prims."""
    gprim.CreateDisplayColorAttr([Gf.Vec3f(*color)])
    gprim.CreateDisplayOpacityAttr([opacity])
    if double_sided:
        gprim.CreateDoubleSidedAttr(True)


def analyze_lens_profile(
    oriented_points: list[tuple[float, float, float]],
) -> LensProfile:
    """Classify an X-axis lens from the radial extent at both X endpoints."""
    minimum, maximum = oriented_bounds(oriented_points, "+X")
    center_y = (minimum[1] + maximum[1]) / 2.0
    center_z = (minimum[2] + maximum[2]) / 2.0
    radius_y = max((maximum[1] - minimum[1]) / 2.0, 1e-9)
    radius_z = max((maximum[2] - minimum[2]) / 2.0, 1e-9)
    tolerance = max((maximum[0] - minimum[0]) * 0.01, 1e-4)

    def endpoint_is_flat(side: str) -> bool:
        endpoint_points = [
            point
            for point in oriented_points
            if (
                point[0] <= minimum[0] + tolerance
                if side == "min"
                else point[0] >= maximum[0] - tolerance
            )
        ]
        if len(endpoint_points) < 3:
            return False
        radial_extent = max(
            ((point[1] - center_y) / radius_y) ** 2
            + ((point[2] - center_z) / radius_z) ** 2
            for point in endpoint_points
        )
        return radial_extent >= 0.8

    min_flat = endpoint_is_flat("min")
    max_flat = endpoint_is_flat("max")
    if min_flat != max_flat:
        return LensProfile("planoConvex", "min" if min_flat else "max")
    if not min_flat and not max_flat:
        return LensProfile("biconvex", None)
    return LensProfile("plano", "both")


def add_primitive_transform(
    gprim,
    translate: tuple[float, float, float],
    scale: tuple[float, float, float] | None = None,
) -> None:
    xformable = UsdGeom.Xformable(gprim.GetPrim())
    xformable.AddTranslateOp().Set(Gf.Vec3d(*translate))
    if scale is not None:
        xformable.AddScaleOp().Set(Gf.Vec3d(*scale))


def add_zero_xyz_rotation(xformable: UsdGeom.Xformable) -> None:
    """Author editable XYZ rotations with neutral initial values."""
    xformable.AddRotateXOp().Set(0.0)
    xformable.AddRotateYOp().Set(0.0)
    xformable.AddRotateZOp().Set(0.0)


def write_lo_primitives(
    oriented_points: list[tuple[float, float, float]],
    output_path: Path,
    *,
    component_type: str,
    root_prim_name: str,
    optics_attrs: dict[str, Any],
    display_color: tuple[float, float, float],
    display_opacity: float,
) -> None:
    """Write a non-Mesh lo model from USD analytic primitives."""
    minimum, maximum = oriented_bounds(oriented_points, "+X")
    size = tuple(maximum[axis] - minimum[axis] for axis in range(3))
    center = tuple(
        (maximum[axis] + minimum[axis]) / 2.0
        for axis in range(3)
    )
    primitive_attrs = dict(optics_attrs)
    primitive_attrs.update({
        "centerX_mm": center[0],
        "centerY_mm": center[1],
        "centerZ_mm": center[2],
        "sizeX_mm": size[0],
        "sizeY_mm": size[1],
        "sizeZ_mm": size[2],
    })

    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    stage = Usd.Stage.CreateNew(str(output_path))
    if stage is None:
        raise RuntimeError(
            f"USD Stageを作成できませんでした: {output_path}"
        )
    UsdGeom.SetStageMetersPerUnit(stage, 0.001)
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.z)
    root_prim_name = usd_identifier(root_prim_name)
    root_prim = UsdGeom.Xform.Define(stage, f"/{root_prim_name}")
    stage.SetDefaultPrim(root_prim.GetPrim())
    add_zero_xyz_rotation(UsdGeom.Xformable(root_prim.GetPrim()))
    root = root_prim.GetPrim()
    root.CreateAttribute("optics:type", Sdf.ValueTypeNames.Token).Set(
        "mount"
        if is_rod_component(component_type, root_prim_name)
        else component_type
    )

    component_kind = component_type.lower()
    if is_rod_component(component_type, root_prim_name):
        radius_y = size[1] / 2.0
        radius_z = size[2] / 2.0
        radius = max(radius_y, radius_z)
        body = UsdGeom.Cylinder.Define(
            stage, f"/{root_prim_name}/Body"
        )
        body.CreateAxisAttr(UsdGeom.Tokens.x)
        body.CreateRadiusAttr(radius)
        body.CreateHeightAttr(size[0])
        add_primitive_transform(
            body,
            center,
            (
                1.0,
                radius_y / max(radius, 1e-9),
                radius_z / max(radius, 1e-9),
            ),
        )
        set_gprim_appearance(body, display_color, display_opacity)
        primitive_attrs.update({
            "length_mm": size[0],
            "diameterY_mm": size[1],
            "diameterZ_mm": size[2],
        })
    elif component_kind == "lens":
        radius_y = size[1] / 2.0
        radius_z = size[2] / 2.0
        radius = max(radius_y, radius_z)
        profile = analyze_lens_profile(oriented_points)
        requested_shape = str(optics_attrs.get("lensShape", "")).lower()
        if requested_shape in {"biconvex", "plano-convex", "planoconvex"}:
            profile = LensProfile(
                "biconvex"
                if requested_shape == "biconvex"
                else "planoConvex",
                profile.flat_side,
            )

        if profile.kind == "biconvex":
            convex = UsdGeom.Sphere.Define(
                stage, f"/{root_prim_name}/RugbyBall"
            )
            convex.CreateRadiusAttr(1.0)
            convex.GetPrim().CreateAttribute(
                "optics:spherePortion", Sdf.ValueTypeNames.Token
            ).Set("full")
            add_primitive_transform(
                convex,
                center,
                (size[0] / 2.0, radius_y, radius_z),
            )
            set_gprim_appearance(
                convex,
                display_color,
                display_opacity,
                double_sided=True,
            )
            primitive_attrs.update({
                "lensShape": "biconvex",
                "diameter_mm": max(size[1], size[2]),
                "thickness_mm": size[0],
            })
        elif profile.kind == "planoConvex":
            radial_edge_points = [
                point
                for point in oriented_points
                if math.sqrt(
                    (
                        (point[1] - center[1])
                        / max(radius_y, 1e-9)
                    ) ** 2
                    + (
                        (point[2] - center[2])
                        / max(radius_z, 1e-9)
                    ) ** 2
                ) >= 0.97
            ]
            flat_side = profile.flat_side or "min"
            flat_x = minimum[0] if flat_side == "min" else maximum[0]
            if flat_side == "min":
                edge_x = max(
                    (point[0] for point in radial_edge_points),
                    default=center[0],
                )
                edge_x = min(max(edge_x, minimum[0]), maximum[0])
                sphere_portion = "positiveX"
                curved_tip_x = maximum[0]
            else:
                edge_x = min(
                    (point[0] for point in radial_edge_points),
                    default=center[0],
                )
                edge_x = min(max(edge_x, minimum[0]), maximum[0])
                sphere_portion = "negativeX"
                curved_tip_x = minimum[0]
            edge_thickness = min(abs(edge_x - flat_x), size[0])
            edge_thickness = max(edge_thickness, size[0] * 0.01)
            sag = max(abs(curved_tip_x - edge_x), size[0] * 0.01)

            body = UsdGeom.Cylinder.Define(
                stage, f"/{root_prim_name}/EdgeThickness"
            )
            body.CreateAxisAttr(UsdGeom.Tokens.x)
            body.CreateRadiusAttr(radius)
            body.CreateHeightAttr(edge_thickness)
            body.GetPrim().CreateAttribute(
                "optics:capSide", Sdf.ValueTypeNames.Token
            ).Set("negativeX" if flat_side == "min" else "positiveX")
            add_primitive_transform(
                body,
                (
                    (flat_x + edge_x) / 2.0,
                    center[1],
                    center[2],
                ),
                (
                    1.0,
                    radius_y / max(radius, 1e-9),
                    radius_z / max(radius, 1e-9),
                ),
            )
            set_gprim_appearance(
                body,
                display_color,
                display_opacity,
                double_sided=True,
            )

            convex = UsdGeom.Sphere.Define(
                stage, f"/{root_prim_name}/RugbyBallHalf"
            )
            convex.CreateRadiusAttr(1.0)
            convex.GetPrim().CreateAttribute(
                "optics:spherePortion", Sdf.ValueTypeNames.Token
            ).Set(sphere_portion)
            convex.CreateExtentAttr([
                Gf.Vec3f(0.0, -1.0, -1.0),
                Gf.Vec3f(1.0, 1.0, 1.0),
            ] if sphere_portion == "positiveX" else [
                Gf.Vec3f(-1.0, -1.0, -1.0),
                Gf.Vec3f(0.0, 1.0, 1.0),
            ])
            add_primitive_transform(
                convex,
                (edge_x, center[1], center[2]),
                (sag, radius_y, radius_z),
            )
            set_gprim_appearance(
                convex,
                display_color,
                display_opacity,
                double_sided=True,
            )
            primitive_attrs.update({
                "lensShape": "planoConvex",
                "flatSide": flat_side,
                "diameter_mm": max(size[1], size[2]),
                "thickness_mm": size[0],
                "edgeThickness_mm": edge_thickness,
                "convexSag_mm": sag,
                "convexBaseX_mm": edge_x,
            })
        else:
            body = UsdGeom.Cylinder.Define(
                stage, f"/{root_prim_name}/LensDisc"
            )
            body.CreateAxisAttr(UsdGeom.Tokens.x)
            body.CreateRadiusAttr(radius)
            body.CreateHeightAttr(size[0])
            add_primitive_transform(
                body,
                center,
                (
                    1.0,
                    radius_y / max(radius, 1e-9),
                    radius_z / max(radius, 1e-9),
                ),
            )
            set_gprim_appearance(
                body,
                display_color,
                display_opacity,
                double_sided=True,
            )
            primitive_attrs.update({
                "lensShape": "plano",
                "diameter_mm": max(size[1], size[2]),
                "thickness_mm": size[0],
            })
    elif component_kind == "polarizer":
        # A polarizer is represented by a transparent analytic disc.  Using
        # the same measured X thickness and Y/Z radii as hi keeps LOD
        # switching spatially stable without retaining the CAD mesh.
        radius_y = size[1] / 2.0
        radius_z = size[2] / 2.0
        radius = max(radius_y, radius_z)
        disc = UsdGeom.Cylinder.Define(
            stage, f"/{root_prim_name}/PolarizerDisc"
        )
        disc.CreateAxisAttr(UsdGeom.Tokens.x)
        disc.CreateRadiusAttr(radius)
        disc.CreateHeightAttr(size[0])
        add_primitive_transform(
            disc,
            center,
            (
                1.0,
                radius_y / max(radius, 1e-9),
                radius_z / max(radius, 1e-9),
            ),
        )
        set_gprim_appearance(disc, display_color, display_opacity)
        primitive_attrs.update({
            "diameter_mm": max(size[1], size[2]),
            "thickness_mm": size[0],
        })
    elif component_kind == "laser":
        # Keep a large laser system recognizable without carrying its screws,
        # lettering, electronics, and connector meshes into lo.  The housing
        # and output barrel share the measured envelope, so changing LOD does
        # not move or resize the component.
        output_length = min(max(size[0] * 0.1, 4.0), size[0] * 0.25)
        body_size_x = max(size[0] - output_length, size[0] * 0.5)
        body_min_x = minimum[0]
        body_max_x = maximum[0] - output_length
        body_center_x = (body_min_x + body_max_x) / 2.0

        body = UsdGeom.Cube.Define(stage, f"/{root_prim_name}/Housing")
        body.CreateSizeAttr(1.0)
        add_primitive_transform(
            body,
            (body_center_x, center[1], center[2]),
            (body_size_x, size[1], size[2]),
        )
        set_gprim_appearance(body, display_color, 1.0)

        output_radius = min(size[1], size[2]) * 0.13
        output = UsdGeom.Cylinder.Define(
            stage, f"/{root_prim_name}/Output"
        )
        output.CreateAxisAttr(UsdGeom.Tokens.x)
        output.CreateRadiusAttr(output_radius)
        output.CreateHeightAttr(output_length)
        add_primitive_transform(
            output,
            (
                maximum[0] - output_length / 2.0,
                0.0,
                0.0,
            ),
        )
        set_gprim_appearance(output, (0.05, 0.05, 0.05), 1.0)
        primitive_attrs.update({
            "bodySizeX_mm": body_size_x,
            "outputDiameter_mm": output_radius * 2.0,
            "outputLength_mm": output_length,
        })
    elif component_kind == "slm":
        panel_thickness = float(
            optics_attrs.get(
                "screenThickness_mm",
                min(max(size[0] * 0.005, 0.2), 1.0),
            )
        )
        # Keep the active screen at the optical origin and start the housing
        # immediately behind it. Otherwise an envelope-sized red Cube hides
        # the screen inside itself.
        body_min_x = panel_thickness / 2.0
        body_max_x = maximum[0]
        if body_max_x <= body_min_x:
            body_min_x = minimum[0]
        body_size_x = body_max_x - body_min_x
        body_center_x = (body_min_x + body_max_x) / 2.0
        # The SLM's local origin is the active screen center. This keeps the
        # optical +X axis passing through the display rather than the housing
        # bounding-box center.
        panel_center_x = 0.0
        panel_center_y = 0.0
        panel_center_z = 0.0
        panel_size_y = min(
            float(optics_attrs.get(
                "screenWidth_mm",
                optics_attrs.get("activeWidth_mm", size[1] * 0.5),
            )),
            size[1],
        )
        panel_size_z = min(
            float(optics_attrs.get(
                "screenHeight_mm",
                optics_attrs.get("activeHeight_mm", size[2] * 0.5),
            )),
            size[2],
        )

        body = UsdGeom.Cube.Define(stage, f"/{root_prim_name}/Housing")
        body.CreateSizeAttr(1.0)
        add_primitive_transform(
            body,
            (body_center_x, center[1], center[2]),
            (body_size_x, size[1], size[2]),
        )
        set_gprim_appearance(body, (0.65, 0.06, 0.05), 1.0)

        panel = UsdGeom.Cube.Define(stage, f"/{root_prim_name}/Display")
        panel.CreateSizeAttr(1.0)
        add_primitive_transform(
            panel,
            (panel_center_x, panel_center_y, panel_center_z),
            (panel_thickness, panel_size_y, panel_size_z),
        )
        set_gprim_appearance(panel, (0.32, 0.34, 0.37), 1.0)
        primitive_attrs.update({
            "bodyCenterX_mm": body_center_x,
            "bodySizeX_mm": body_size_x,
            "panelX_mm": panel_center_x,
            "panelY_mm": panel_center_y,
            "panelZ_mm": panel_center_z,
            "panelThickness_mm": panel_thickness,
        })
    elif component_kind == "iris":
        radius = min(size[1], size[2]) / 2.0
        body = UsdGeom.Cylinder.Define(stage, f"/{root_prim_name}/Housing")
        body.CreateAxisAttr(UsdGeom.Tokens.x)
        body.CreateRadiusAttr(radius)
        body.CreateHeightAttr(size[0])
        add_primitive_transform(body, center)
        set_gprim_appearance(body, display_color, 1.0)
        primitive_attrs.update({
            "outerDiameter_mm": radius * 2.0,
            "thickness_mm": size[0],
        })
    else:
        body = UsdGeom.Cube.Define(stage, f"/{root_prim_name}/Bounds")
        body.CreateSizeAttr(1.0)
        add_primitive_transform(body, center, size)
        set_gprim_appearance(body, display_color, display_opacity)

    for name, value in primitive_attrs.items():
        create_optics_attribute(root, name, value)
    stage.GetRootLayer().Save()


def write_lo_proxy(
    source_points: list[tuple[float, float, float]],
    source_indices: list[int],
    source_triangle_colors: list[tuple[float, float, float]],
    source_regions: list[SourceRegion],
    output_path: Path,
    *,
    component_type: str,
    root_prim_name: str,
    source_forward_axis: str,
    source_origin: tuple[float, float, float],
    source_roll_deg: float,
    optics_attrs: dict[str, Any],
    display_opacity: float,
    proxy_kind: str,
    segments: int,
    target_triangles: int,
) -> tuple[
    int,
    tuple[float, float, float],
    tuple[float, float, float],
    LoPalette,
]:
    """Write a tiny proxy that keeps the hi mesh's bounds and local origin."""
    minimum, maximum = oriented_bounds(
        source_points,
        source_forward_axis,
        source_origin,
        source_roll_deg,
    )
    oriented_points = [
        orient_point(
            point,
            source_forward_axis,
            source_origin,
            source_roll_deg,
        )
        for point in source_points
    ]
    palette = select_lo_palette(
        oriented_points,
        source_indices,
        source_triangle_colors,
    )
    if proxy_kind == "primitive":
        write_lo_primitives(
            oriented_points,
            output_path,
            component_type=component_type,
            root_prim_name=root_prim_name,
            optics_attrs=optics_attrs,
            display_color=palette.selected_colors[0],
            display_opacity=display_opacity,
        )
        return 0, minimum, maximum, palette
    if proxy_kind == "surface":
        points, indices, triangle_colors = simplify_surface_regions(
            source_regions,
            source_forward_axis,
            target_triangles,
            source_origin,
            source_roll_deg,
        )
        mesh_parts = split_mesh_by_palette(
            points,
            indices,
            triangle_colors,
            palette,
        )
    elif proxy_kind == "convex-hull":
        if "iris" in component_type.lower():
            aperture = float(optics_attrs.get("aperture_mm", 4.0))
            points, indices = make_convex_hull_ring_proxy(
                oriented_points,
                aperture,
            )
        else:
            points, indices = make_convex_hull_proxy(oriented_points)
        mesh_parts = None
    elif proxy_kind == "cylinder":
        aperture = None
        if "iris" in component_type.lower():
            aperture = float(
                optics_attrs.get(
                    "aperture_mm",
                    min(maximum[1] - minimum[1], maximum[2] - minimum[2]) * 0.15,
                )
            )
        points, indices = make_cylinder_proxy(
            minimum,
            maximum,
            segments,
            aperture,
        )
        mesh_parts = None
    elif proxy_kind == "box":
        points, indices = make_box_proxy(minimum, maximum)
        mesh_parts = None
    else:
        raise ValueError(f"未対応のloプロキシです: {proxy_kind}")

    write_usda_mesh(
        points,
        indices,
        output_path,
        component_type=component_type,
        root_prim_name=root_prim_name,
        source_forward_axis="+X",
        optics_attrs=optics_attrs,
        display_color=palette.selected_colors[0],
        display_opacity=display_opacity,
        mesh_parts=mesh_parts,
    )
    return len(indices) // 3, minimum, maximum, palette


def write_usda_mesh(
    points: list[tuple[float, float, float]],
    face_vertex_indices: list[int],
    output_path: Path,
    *,
    component_type: str,
    root_prim_name: str = "Component",
    source_forward_axis: str = "+X",
    source_origin: tuple[float, float, float] = (0.0, 0.0, 0.0),
    source_roll_deg: float = 0.0,
    optics_attrs: dict[str, Any] | None = None,
    display_color: tuple[float, float, float] = DEFAULT_DISPLAY_COLOR,
    display_opacity: float = 1.0,
    mesh_parts: list[MeshPart] | None = None,
) -> None:
    """
    頂点座標と三角形インデックスからUsdGeom.Meshを作成し、
    USDAファイルとして保存する。
    """

    if not points:
        raise ValueError("頂点データが空です")

    if not face_vertex_indices:
        raise ValueError("三角形インデックスが空です")

    if len(face_vertex_indices) % 3 != 0:
        raise ValueError(
            "三角形インデックス数は3の倍数である必要があります"
        )

    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    stage = Usd.Stage.CreateNew(str(output_path))

    if stage is None:
        raise RuntimeError(
            f"USD Stageを作成できませんでした: {output_path}"
        )
    
    UsdGeom.SetStageMetersPerUnit(stage, 0.001)
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.z)
    
    root_prim_name = usd_identifier(root_prim_name)
    root_prim = UsdGeom.Xform.Define(stage, f"/{root_prim_name}")
    stage.SetDefaultPrim(root_prim.GetPrim())
    add_zero_xyz_rotation(UsdGeom.Xformable(root_prim.GetPrim()))

    # server.py discovers every placed component through optics:type.
    root = root_prim.GetPrim()
    root.CreateAttribute("optics:type", Sdf.ValueTypeNames.Token).Set(
        "mount"
        if is_rod_component(component_type, root_prim_name)
        else component_type
    )
    for name, value in (optics_attrs or {}).items():
        create_optics_attribute(root, name, value)

    parts = mesh_parts or [MeshPart(points, face_vertex_indices, display_color)]
    group_prims: dict[str, UsdGeom.Xform] = {}
    for part in parts:
        if part.group_name and part.group_name not in group_prims:
            group_name = usd_identifier(part.group_name)
            group_prim = UsdGeom.Xform.Define(
                stage,
                f"/{root_prim_name}/{group_name}",
            )
            add_zero_xyz_rotation(UsdGeom.Xformable(group_prim.GetPrim()))
            group_prims[part.group_name] = group_prim

    group_mesh_counts: dict[str | None, int] = {}
    for index, part in enumerate(parts):
        group_mesh_counts[part.group_name] = (
            group_mesh_counts.get(part.group_name, 0) + 1
        )
        group_part_count = sum(
            candidate.group_name == part.group_name
            for candidate in parts
        )
        group_index = group_mesh_counts[part.group_name]
        mesh_name = (
            "CADMesh"
            if group_part_count == 1
            else f"CADMesh_{group_index:03d}"
        )
        parent_path = f"/{root_prim_name}"
        if part.group_name:
            parent_path += f"/{usd_identifier(part.group_name)}"
        mesh = UsdGeom.Mesh.Define(stage, f"{parent_path}/{mesh_name}")
        usd_points = [
            Gf.Vec3f(*orient_point(
                point,
                source_forward_axis,
                source_origin,
                source_roll_deg,
            ))
            for point in part.points
        ]
        mesh.CreatePointsAttr(usd_points)
        triangle_count = len(part.face_vertex_indices) // 3
        mesh.CreateFaceVertexCountsAttr([3] * triangle_count)
        mesh.CreateFaceVertexIndicesAttr(part.face_vertex_indices)
        mesh.CreateSubdivisionSchemeAttr().Set(UsdGeom.Tokens.none)
        mesh.CreateDoubleSidedAttr().Set(True)
        if part.color is not None:
            mesh.CreateDisplayColorAttr([part.color])
        mesh.CreateDisplayOpacityAttr([
            display_opacity if part.opacity is None else part.opacity
        ])
        mesh.CreateExtentAttr(UsdGeom.PointBased.ComputeExtent(usd_points))

    stage.GetRootLayer().Save()

    if not output_path.exists():
        raise RuntimeError(
            f"USDAファイルが生成されませんでした: {output_path}"
        )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "STEPファイルをOpticalTwin用のhi.usda/lo.usdaへ変換します。"
        )
    )
    parser.add_argument(
        "step_paths",
        nargs="*",
        type=Path,
        help=(
            "入力STEPファイル。複数指定すると光学部品とマウントを"
            "同じ座標系で結合します（省略時はLA4380-A-Step）"
        ),
    )
    parser.add_argument(
        "--component-name",
        help="components/以下のディレクトリ名（省略時はSTEPのファイル名）",
    )
    parser.add_argument(
        "--lod",
        choices=(*LOD_NAMES, "both"),
        default="hi",
        help="生成する詳細度（既定値: hi）",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="出力先。--lod hiまたはloの場合のみ指定できます",
    )
    parser.add_argument(
        "--hi-linear-deflection",
        type=float,
        default=LOD_MESH_SETTINGS["hi"][0],
        metavar="MM",
        help="hiメッシュの曲面に対する距離許容誤差（既定値: 0.1 mm）",
    )
    parser.add_argument(
        "--hi-angular-deflection",
        type=float,
        default=LOD_MESH_SETTINGS["hi"][1],
        metavar="RAD",
        help="hiメッシュの曲面に対する角度許容誤差（既定値: 0.5 rad）",
    )
    parser.add_argument(
        "--lo-linear-deflection",
        type=float,
        default=LOD_MESH_SETTINGS["lo"][0],
        metavar="MM",
        help="--lo-proxy mesh時の距離許容誤差（既定値: 2.0 mm）",
    )
    parser.add_argument(
        "--lo-angular-deflection",
        type=float,
        default=LOD_MESH_SETTINGS["lo"][1],
        metavar="RAD",
        help="--lo-proxy mesh時の角度許容誤差（既定値: 1.0 rad）",
    )
    parser.add_argument(
        "--lo-proxy",
        choices=LO_PROXY_MODES,
        default="auto",
        help=(
            "loの形状。autoはUSD基本形状のみのprimitiveを使用します。"
            "convex-hullはCADの最外頂点を結んだ簡略Meshを作ります"
        ),
    )
    parser.add_argument(
        "--lo-segments",
        type=int,
        default=96,
        metavar="N",
        help="--lo-proxy cylinderの円周分割数（既定値: 96）",
    )
    parser.add_argument(
        "--lo-target-triangles",
        type=int,
        default=None,
        metavar="N",
        help=(
            "surfaceプロキシの目標三角形数"
            "（既定値: lens=300、その他=2000）"
        ),
    )
    parser.add_argument(
        "--type",
        dest="component_type",
        help=(
            "部品種別（STEPパス指定時は必須。"
            "例: lens, mirror, camera, rod）"
        ),
    )
    parser.add_argument(
        "--root-prim",
        help="USDのdefaultPrim名（省略時はtypeから生成）",
    )
    parser.add_argument(
        "--source-forward-axis",
        type=str.upper,
        choices=FORWARD_AXES,
        default="+Z",
        help="STEPモデルの前方向・光軸。出力時に+Xへ合わせます",
    )
    parser.add_argument(
        "--source-origin",
        nargs=3,
        type=float,
        default=(0.0, 0.0, 0.0),
        metavar=("X", "Y", "Z"),
        help=(
            "出力原点へ合わせるSTEP座標。画面や光学面の中心を指定します"
        ),
    )
    parser.add_argument(
        "--source-roll-deg",
        type=float,
        default=0.0,
        metavar="DEG",
        help="+Xへ向きを合わせた後の光軸周りの回転角度",
    )
    parser.add_argument(
        "--attr",
        action="append",
        default=[],
        metavar="NAME=VALUE",
        help="追加のoptics属性。複数回指定できます",
    )
    parser.add_argument(
        "--color",
        nargs=3,
        type=float,
        default=DEFAULT_DISPLAY_COLOR,
        metavar=("R", "G", "B"),
        help="STEPに色がない面の0〜1 RGB表示色",
    )
    parser.add_argument(
        "--color-reference-step",
        type=Path,
        help=(
            "hi生成時、色のない入力STEPへ形状が近い参照STEPの"
            "面色を自動位置合わせして補完します"
        ),
    )
    parser.add_argument(
        "--preserve-step-parts",
        action="store_true",
        help="STEPアセンブリの末端部品を個別のXformとしてhiへ保持します",
    )
    parser.add_argument(
        "--opacity",
        type=float,
        default=1.0,
        help="0（透明）〜1（不透明）の表示不透明度",
    )
    parser.add_argument(
        "--metalness",
        type=float,
        default=None,
        help=(
            "0（非金属）〜1（金属）の光沢設定。"
            "Rodの既定値は0.9です"
        ),
    )
    parser.add_argument(
        "--roughness",
        type=float,
        default=None,
        help=(
            "0（滑らか）〜1（粗い）の光沢設定。"
            "Rodの既定値は0.08です"
        ),
    )
    parser.add_argument(
        "--ignore-step-colors",
        action="store_true",
        help="STEPの面色を無視し、--colorの単色で出力します",
    )
    parser.add_argument(
        "--verbose-faces",
        action="store_true",
        help="各Faceの頂点数・三角形数を表示します",
    )
    return parser


def main(argv: list[str] | None = None) -> None:
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    parser = build_parser()
    args = parser.parse_args(raw_argv)

    if args.component_type is None:
        if args.step_paths:
            parser.error("STEPパスを指定する場合は --type も指定してください")
        args.component_type = "lens"
    if len(args.step_paths) == 1 and args.step_paths[0].is_dir():
        step_directory = args.step_paths[0].resolve()
        if args.component_type.lower() != "rod":
            parser.error("STEPディレクトリの一括変換は--type rodで指定してください")
        if args.output is not None:
            parser.error("STEPディレクトリと--outputは同時に指定できません")
        if args.component_name is not None:
            parser.error(
                "STEPディレクトリでは--component-nameを指定できません"
            )
        step_files = sorted(
            path
            for path in step_directory.iterdir()
            if path.is_file() and path.suffix.lower() in (".step", ".stp")
        )
        if not step_files:
            parser.error(f"STEPファイルがありません: {step_directory}")
        directory_argument_index = next(
            (
                index
                for index, value in enumerate(raw_argv)
                if not value.startswith("-")
                and Path(value).expanduser().resolve() == step_directory
            ),
            None,
        )
        if directory_argument_index is None:
            parser.error("STEPディレクトリ引数を特定できませんでした")
        for step_file in step_files:
            child_argv = list(raw_argv)
            child_argv[directory_argument_index] = str(step_file)
            child_argv.extend([
                "--component-name",
                f"{step_directory.name}/{step_file.stem}",
            ])
            print(f"=== Rod一括変換: {step_file.name} ===")
            main(child_argv)
        return
    if not all(0.0 <= channel <= 1.0 for channel in args.color):
        parser.error("--colorの各値は0〜1で指定してください")
    if not 0.0 <= args.opacity <= 1.0:
        parser.error("--opacityは0〜1で指定してください")
    if args.metalness is not None and not 0.0 <= args.metalness <= 1.0:
        parser.error("--metalnessは0〜1で指定してください")
    if args.roughness is not None and not 0.0 <= args.roughness <= 1.0:
        parser.error("--roughnessは0〜1で指定してください")
    if args.output is not None and args.lod == "both":
        parser.error("--outputは--lod bothと同時に指定できません")
    if args.lo_segments < 12 or args.lo_segments % 4 != 0:
        parser.error("--lo-segmentsは12以上かつ4の倍数にしてください")
    if (
        args.lo_target_triangles is not None
        and args.lo_target_triangles < 100
    ):
        parser.error("--lo-target-trianglesは100以上にしてください")
    mesh_settings = {
        "hi": (args.hi_linear_deflection, args.hi_angular_deflection),
        "lo": (args.lo_linear_deflection, args.lo_angular_deflection),
    }
    for lod_name, (linear_deflection, angular_deflection) in mesh_settings.items():
        if linear_deflection <= 0.0:
            parser.error(
                f"--{lod_name}-linear-deflectionは0より大きくしてください"
            )
        if angular_deflection <= 0.0:
            parser.error(
                f"--{lod_name}-angular-deflectionは0より大きくしてください"
            )

    using_default_step = not args.step_paths
    if using_default_step:
        component_name = args.component_name or DEFAULT_COMPONENT_NAME
        step_paths = [(
            ROOT_DIR / "cad" / component_name / f"{component_name}.step"
        )]
    else:
        step_paths = args.step_paths
        component_name = args.component_name or step_paths[0].stem

    root_prim_name = args.root_prim or usd_identifier(args.component_type.title())
    optics_attrs = parse_optics_attrs(args.attr)
    rod_component = is_rod_component(
        args.component_type,
        root_prim_name,
    )
    if args.metalness is not None:
        optics_attrs["metalness"] = args.metalness
    elif rod_component:
        optics_attrs.setdefault("metalness", 0.9)
    if args.roughness is not None:
        optics_attrs["roughness"] = args.roughness
    elif rod_component:
        optics_attrs.setdefault("roughness", 0.08)
    lo_target_triangles = (
        args.lo_target_triangles
        if args.lo_target_triangles is not None
        else LO_TARGET_TRIANGLES_BY_TYPE.get(
            args.component_type.lower(),
            DEFAULT_LO_TARGET_TRIANGLES,
        )
    )

    # Preserve the existing no-argument LA4380-A lens metadata.
    if using_default_step and not args.attr and args.component_type == "lens":
        optics_attrs = {"diameter_mm": 25.4, "focalLength_mm": 100.0}

    loaded_sources = [
        load_step_with_colors(step_path)
        for step_path in step_paths
    ]
    source_shapes = [source[0] for source in loaded_sources]
    source_color_tools = [source[2] for source in loaded_sources]
    # Keep every XCAF document in loaded_sources alive until conversion ends;
    # its color tool owns the per-face presentation colors.
    shape = combine_step_shapes(source_shapes)
    part_occurrences = (
        assembly_leaf_shapes(loaded_sources[0][1])
        if args.preserve_step_parts and len(loaded_sources) == 1
        else []
    )
    reference_source = (
        load_step_with_colors(args.color_reference_step)
        if args.color_reference_step is not None
        else None
    )

    def all_source_regions(use_step_colors: bool):
        return [
            region
            for source_shape, source_color_tool in zip(
                source_shapes, source_color_tools
            )
            for region in extract_source_regions(
                source_shape,
                source_color_tool,
                tuple(args.color),
                args.ignore_step_colors or not use_step_colors,
            )
        ]

    def all_colored_mesh_parts(use_step_colors: bool):
        if use_step_colors and part_occurrences:
            parts = []
            source_color_tool = source_color_tools[0]
            for part_name, part_shape in part_occurrences:
                source_parts = extract_colored_mesh_data(
                    part_shape,
                    source_color_tool,
                    None,
                )
                for part in source_parts:
                    part.opacity = args.opacity
                    part.group_name = part_name
                parts.extend(source_parts)
            return parts

        parts = []
        for source_index, (source_shape, source_color_tool) in enumerate(zip(
            source_shapes, source_color_tools
        )):
            if use_step_colors:
                source_parts = extract_colored_mesh_data(
                    source_shape,
                    source_color_tool,
                    None,
                )
            else:
                source_points, source_indices = extract_mesh_data(source_shape)
                source_color = (
                    tuple(args.color)
                    if source_index == 0
                    else (0.0524, 0.0524, 0.0524)
                )
                source_parts = [
                    MeshPart(source_points, source_indices, source_color)
                ]
            # The first STEP is the optic; subsequent STEP files are mounts
            # and stay opaque even when the optic uses glass-like opacity.
            for part in source_parts:
                part.opacity = args.opacity if source_index == 0 else 1.0
                if len(source_shapes) > 1:
                    part.group_name = (
                        "Optic" if source_index == 0 else "Mount"
                    )
            parts.extend(source_parts)
        return parts

    effective_source_origin = tuple(args.source_origin)
    if rod_component and "--source-origin" not in raw_argv:
        # Vendor Rod STEP files are not consistently authored around (0,0,0).
        # Center the measured CAD envelope so placement and rotation use the
        # actual Rod center. An explicit --source-origin always wins.
        mesh_shape(shape, *mesh_settings["hi"])
        source_points = [
            point
            for region in all_source_regions(False)
            for point in region.points
        ]
        source_minimum, source_maximum = oriented_bounds(
            source_points,
            "+X",
        )
        effective_source_origin = tuple(
            (
                source_minimum[axis] + source_maximum[axis]
            ) / 2.0
            for axis in range(3)
        )

    print("STEPファイルの読み込みに成功しました")
    for step_path in step_paths:
        print(f"入力ファイル: {step_path}")
    print(f"Shape type: {shape.ShapeType()}")
    print(f"Shape is null: {shape.IsNull()}")

    lod_names = LOD_NAMES if args.lod == "both" else (args.lod,)
    hi_source_points = None
    hi_source_indices = None
    hi_source_triangle_colors = None
    hi_source_regions = None
    for lod_name in lod_names:
        linear_deflection, angular_deflection = mesh_settings[lod_name]
        output_path = args.output or (
            ROOT_DIR / "components" / component_name / f"{lod_name}.usda"
        )
        proxy_kind = lo_proxy_kind(args.component_type, args.lo_proxy)

        if lod_name == "lo" and proxy_kind != "mesh":
            if hi_source_points is None:
                hi_linear, hi_angular = mesh_settings["hi"]
                print(
                    "--- hiと一致する外形・中心を計測 "
                    f"(距離誤差={hi_linear} mm, "
                    f"角度誤差={hi_angular} rad) ---"
                )
                mesh_shape(shape, hi_linear, hi_angular)
                hi_source_regions = all_source_regions(False)
                (
                    hi_source_points,
                    hi_source_indices,
                    hi_source_triangle_colors,
                ) = combine_source_regions(hi_source_regions)
            else:
                # lo appearance is intentionally independent of STEP colors.
                hi_source_regions = all_source_regions(False)
                (
                    hi_source_points,
                    hi_source_indices,
                    hi_source_triangle_colors,
                ) = combine_source_regions(hi_source_regions)

            triangle_count, minimum, maximum, palette = write_lo_proxy(
                hi_source_points,
                hi_source_indices,
                hi_source_triangle_colors,
                hi_source_regions,
                output_path,
                component_type=args.component_type,
                root_prim_name=root_prim_name,
                source_forward_axis=args.source_forward_axis,
                source_origin=effective_source_origin,
                source_roll_deg=args.source_roll_deg,
                optics_attrs=optics_attrs,
                display_opacity=args.opacity,
                proxy_kind=proxy_kind,
                segments=args.lo_segments,
                target_triangles=lo_target_triangles,
            )
            size = tuple(
                maximum[axis] - minimum[axis]
                for axis in range(3)
            )
            center = tuple(
                (maximum[axis] + minimum[axis]) / 2.0
                for axis in range(3)
            )
            print(f"--- lo.usdaプロキシ: {proxy_kind} ---")
            print(f"外形寸法(X, Y, Z): {size}")
            print(f"外形中心(X, Y, Z): {center}")
            print(f"三角形数: {triangle_count}")
            print(
                "STEP主要色の面積比: "
                + ", ".join(
                    f"{ratio:.1%}"
                    for ratio in palette.area_ratios
                )
            )
            print(
                f"色数: {palette.source_color_count}"
                f" → {len(palette.selected_colors)}"
            )
            print("lo.usdaの生成に成功しました")
            print(f"出力ファイル: {output_path}")
            continue

        print(
            f"--- {lod_name}.usdaを生成 "
            f"(距離誤差={linear_deflection} mm, "
            f"角度誤差={angular_deflection} rad) ---"
        )
        mesh_shape(shape, linear_deflection, angular_deflection)
        print("Shapeのメッシュ化に成功しました")
        inspect_mesh(shape, verbose_faces=args.verbose_faces)

        mesh_parts = all_colored_mesh_parts(lod_name == "hi")
        if lod_name == "hi" and reference_source is not None:
            reference_shape, _, reference_color_tool = reference_source
            mesh_shape(
                reference_shape,
                linear_deflection,
                angular_deflection,
            )
            reference_parts = extract_colored_mesh_data(
                reference_shape,
                reference_color_tool,
                None,
            )
            mesh_parts = transfer_mesh_colors(mesh_parts, reference_parts)
            if args.preserve_step_parts:
                mesh_parts = collapse_to_one_color_per_group(mesh_parts)
        if lod_name == "hi" and rod_component:
            mesh_parts = split_rod_hi_parts(mesh_parts)
        points = [point for part in mesh_parts for point in part.points]
        face_vertex_indices = [
            index
            for part in mesh_parts
            for index in part.face_vertex_indices
        ]
        if lod_name == "hi":
            hi_source_regions = all_source_regions(True)
            (
                hi_source_points,
                hi_source_indices,
                hi_source_triangle_colors,
            ) = combine_source_regions(hi_source_regions)

        print("--- 抽出結果 ---")
        print(f"頂点数: {len(points)}")
        print(f"三角形数: {len(face_vertex_indices) // 3}")
        print(f"色数: {len(mesh_parts) if mesh_parts else 1}")

        write_usda_mesh(
            points,
            face_vertex_indices,
            output_path,
            component_type=args.component_type,
            root_prim_name=root_prim_name,
            source_forward_axis=args.source_forward_axis,
            source_origin=effective_source_origin,
            source_roll_deg=args.source_roll_deg,
            optics_attrs=optics_attrs,
            display_color=tuple(args.color),
            display_opacity=args.opacity,
            mesh_parts=mesh_parts,
        )

        print(f"{lod_name}.usdaの生成に成功しました")
        print(f"出力ファイル: {output_path}")



if __name__ == "__main__":
    main()
