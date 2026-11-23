"""Convert STEP CAD data into an OpticalTwin component model (model.usda).

Each component has exactly one model: components/<Group>/<Model>/model.usda.

Examples:
    # Existing LA4380-A lens (backward-compatible default)
    python -m opticaltwin.cad_importer

    # Convert any other component
    python -m opticaltwin.cad_importer cad/mirror/M1.step --type mirror \
        --source-forward-axis +X --attr diameter_mm=25.4 \
        --attr reflectivity=0.99 --color 0.85 0.85 0.9

    # Rod: five CAD Mesh parts (body, inner and outer ends)
    python -m opticaltwin.cad_importer cad/Rod/ER1.5-Step.step --type rod \
        --source-forward-axis +Y

    # Convert every Rod STEP into components/Rod/<STEP name>/
    python -m opticaltwin.cad_importer cad/Rod --type rod \
        --source-forward-axis +Y

    # Convert every Laser STEP; each CAD model's longitudinal axis is detected
    python -m opticaltwin.cad_importer cad/Laser --type laser \
        --source-forward-axis auto

    # An assembly whose STEP carries no colors: keep its leaves as named parts
    # and paint them. Unnamed leaves fall back to --color.
    python -m opticaltwin.cad_importer cad/SLM/EXULUS-SE1-Step.step --type slm \
        --preserve-step-parts --color 0.051269 0.051269 0.051269 \
        --part-color EEC4011_housing=0.62,0.09,0.10 \
        --part-color RDP551F_MODULE=0.32,0.34,0.37

    # A one-leaf assembly whose pieces come from STEP face colors instead: aim
    # at the meshes this writer names. Narrow rules first, broad ones after.
    python -m opticaltwin.cad_importer cad/Mount/ID25_M-Step.step --type iris \
        --mesh-color CADMesh_004=0.35,0.36,0.38 \
        --mesh-color CADMesh=0.051269,0.051269,0.051269 \
        --mesh-opacity CADMesh_004=0.2
"""

import argparse
import itertools
from dataclasses import dataclass
import math
from pathlib import Path
import re
import sys
from typing import Any

from OCP.IFSelect import IFSelect_ReturnStatus
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TopoDS import TopoDS_Shape, TopoDS_Compound
from OCP.BRep import BRep_Builder
from OCP.BRepGProp import BRepGProp
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
from OCP.GProp import GProp_GProps
from OCP.XCAFApp import XCAFApp_Application
from OCP.XCAFDoc import (
    XCAFDoc_ColorType,
    XCAFDoc_DocumentTool,
    XCAFDoc_ShapeTool,
)
from pxr import Gf, Sdf, Usd, UsdGeom


ROOT_DIR = Path(__file__).resolve().parent.parent  # the repository

DEFAULT_COMPONENT_NAME = "Lens/LA1417-AB-Step"
DEFAULT_DISPLAY_COLOR = (0.4, 0.7, 1.0)
FORWARD_AXES = ("+X", "-X", "+Y", "-Y", "+Z", "-Z")
MODEL_FILE = "model.usda"
# Surface tessellation tolerances: distance (mm) and angle (rad).
MESH_LINEAR_DEFLECTION_MM = 0.1
MESH_ANGULAR_DEFLECTION_RAD = 0.5


@dataclass
class MeshPart:
    points: list[tuple[float, float, float]]
    face_vertex_indices: list[int]
    color: tuple[float, float, float] | None
    opacity: float | None = None
    group_name: str | None = None
    mesh_name: str | None = None


@dataclass
class SourceRegion:
    points: list[tuple[float, float, float]]
    indices: list[int]
    triangle_colors: list[tuple[float, float, float]]


@dataclass(frozen=True)
class LaserEmissionProfile:
    offset_x: float
    front_x: float
    back_x: float
    center_y: float
    center_z: float
    diameter: float


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


def parse_part_colors(
    items: list[str],
) -> list[tuple[str, tuple[float, float, float]]]:
    """Parse --part-color NAME=R,G,B rules, keeping the order they were given.

    Order matters: the first rule whose name appears in a STEP leaf's name wins,
    so a broad rule can be listed after the narrow ones it would otherwise
    swallow.
    """
    rules = []
    for item in items:
        if "=" not in item:
            raise ValueError(
                f"部品色は NAME=R,G,B 形式で指定してください: {item}"
            )
        name, channels = item.split("=", 1)
        name = name.strip()
        if not name:
            raise ValueError(f"部品名が空です: {item}")
        try:
            color = tuple(
                float(channel) for channel in channels.replace(" ", "").split(",")
            )
        except ValueError:
            raise ValueError(f"色は0〜1の数値3つで指定してください: {item}") from None
        if len(color) != 3 or not all(0.0 <= channel <= 1.0 for channel in color):
            raise ValueError(f"色は0〜1の数値3つで指定してください: {item}")
        rules.append((name.lower(), color))
    return rules


def match_part_color(
    part_name: str,
    rules: list[tuple[str, tuple[float, float, float]]],
) -> tuple[float, float, float] | None:
    """Return the color for a STEP leaf, by case-insensitive substring match.

    Substring rather than exact: vendor assemblies name their leaves things like
    `EEC4011_housing_STEP`, and repeated occurrences gain a `_002` suffix, so
    pinning a rule to the whole name would miss all but the first.
    """
    lowered = part_name.lower()
    for name, color in rules:
        if name in lowered:
            return color
    return None


def parse_mesh_opacities(items: list[str]) -> list[tuple[str, float]]:
    """Parse --mesh-opacity NAME=VALUE rules, keeping the order they were given.

    Same first-match-wins ordering as parse_part_colors.
    """
    rules = []
    for item in items:
        if "=" not in item:
            raise ValueError(
                f"メッシュ不透明度は NAME=VALUE 形式で指定してください: {item}"
            )
        name, value = item.split("=", 1)
        name = name.strip()
        if not name:
            raise ValueError(f"メッシュ名が空です: {item}")
        try:
            opacity = float(value)
        except ValueError:
            raise ValueError(f"不透明度は0〜1の数値で指定してください: {item}") from None
        if not 0.0 <= opacity <= 1.0:
            raise ValueError(f"不透明度は0〜1の数値で指定してください: {item}")
        rules.append((name.lower(), opacity))
    return rules


def match_mesh_rule(mesh_name: str, rules: list[tuple[str, Any]]):
    """Return the first rule value whose name is a substring of mesh_name."""
    lowered = mesh_name.lower()
    for name, value in rules:
        if name in lowered:
            return value
    return None


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


def shape_solids(shape: TopoDS_Shape) -> list[TopoDS_Shape]:
    """Return the independent solid bodies contained in a STEP shape."""
    solids = []
    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    while explorer.More():
        solids.append(TopoDS.Solid_s(explorer.Current()))
        explorer.Next()
    return solids


def solid_volume(shape: TopoDS_Shape) -> float:
    """Return the exact CAD volume of a solid in cubic model units."""
    properties = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, properties)
    return float(properties.Mass())


def shape_shells(shape: TopoDS_Shape) -> list[TopoDS_Shape]:
    """Return every shell contained in a STEP shape."""
    shells = []
    explorer = TopExp_Explorer(shape, TopAbs_SHELL)
    while explorer.More():
        shells.append(TopoDS.Shell_s(explorer.Current()))
        explorer.Next()
    return shells


def shell_area(shape: TopoDS_Shape) -> float:
    """Return the exact surface area of a shell in square model units."""
    properties = GProp_GProps()
    BRepGProp.SurfaceProperties_s(shape, properties)
    return float(properties.Mass())


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
        raise RuntimeError("the file could not be read as a STEP model")
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
    # deflection settings always determine the generated mesh density.
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


def split_rod_parts(parts: list[MeshPart]) -> list[MeshPart]:
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
        raise ValueError("Rodの生成に使用できるMesh部品がありません")

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
        raise ValueError("Rodを5部品へ分けるのに十分な面がありません")

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
        # A large vendor assembly (Thorlabs DET100A2 ships 106 solids) can carry
        # a solid that triangulates to nothing. Skipping it keeps the other 105;
        # an input with no meshable region at all still raises below.
        try:
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
        except RuntimeError:
            continue
        if indices:
            regions.append(SourceRegion(points, indices, triangle_colors))
    if not regions:
        raise RuntimeError("形状領域を取得できませんでした")
    return regions


def measured_envelope_attrs(
    minimum: tuple[float, float, float],
    maximum: tuple[float, float, float],
    *,
    component_type: str,
    rod: bool,
    optics_attrs: dict[str, Any],
) -> dict[str, Any]:
    """Dimensions measured from the model's oriented envelope.

    The beam tracer reads these for a part's apertures and depth (centerX_mm,
    sizeX_mm, diameter_mm, thickness_mm, bodySizeX_mm, panelX_mm, ...), and the
    viewport for the placement ghost. Values the caller already authored (an
    --attr, a per-model default) win: only missing keys are returned.
    """
    size = tuple(maximum[axis] - minimum[axis] for axis in range(3))
    center = tuple((maximum[axis] + minimum[axis]) / 2.0 for axis in range(3))
    measured: dict[str, Any] = {
        "centerX_mm": center[0],
        "centerY_mm": center[1],
        "centerZ_mm": center[2],
        "sizeX_mm": size[0],
        "sizeY_mm": size[1],
        "sizeZ_mm": size[2],
    }
    kind = component_type.lower()
    if rod:
        measured.update({
            "length_mm": size[0],
            "diameterY_mm": size[1],
            "diameterZ_mm": size[2],
        })
    elif kind in ("lens", "polarizer"):
        measured.update({
            "diameter_mm": max(size[1], size[2]),
            "thickness_mm": size[0],
        })
    elif kind == "iris":
        measured.update({
            "outerDiameter_mm": min(size[1], size[2]),
            "thickness_mm": size[0],
        })
    elif kind == "laser":
        # The housing ends where the output barrel starts: at the measured
        # emission head when the laser has one, else a short default barrel.
        front = optics_attrs.get("emissionFrontX_mm")
        head = optics_attrs.get("emissionHeadLength_mm")
        diameter = optics_attrs.get("emissionDiameter_mm")
        measured_output = None not in (front, head, diameter)
        output_length = (
            float(head) if measured_output
            else min(max(size[0] * 0.1, 4.0), size[0] * 0.25)
        )
        output_front = float(front) if measured_output else maximum[0]
        measured.update({
            "bodySizeX_mm": max(
                output_front - output_length - minimum[0], size[0] * 0.5
            ),
            "outputDiameter_mm": (
                float(diameter) if measured_output
                else min(size[1], size[2]) * 0.26
            ),
            "outputLength_mm": output_length,
        })
    elif kind == "slm":
        # The local origin is the active screen; the housing starts right
        # behind it.
        panel_thickness = float(optics_attrs.get(
            "screenThickness_mm", min(max(size[0] * 0.005, 0.2), 1.0)
        ))
        body_min_x = panel_thickness / 2.0
        if maximum[0] <= body_min_x:
            body_min_x = minimum[0]
        measured.update({
            "bodyCenterX_mm": (body_min_x + maximum[0]) / 2.0,
            "bodySizeX_mm": maximum[0] - body_min_x,
            "panelX_mm": 0.0,
            "panelY_mm": 0.0,
            "panelZ_mm": 0.0,
            "panelThickness_mm": panel_thickness,
        })
    return {key: value for key, value in measured.items() if key not in optics_attrs}


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


def analyze_cylindrical_laser_emission(
    mesh_parts: list[MeshPart],
    source_forward_axis: str,
    source_origin: tuple[float, float, float],
    source_roll_deg: float,
) -> LaserEmissionProfile:
    """Locate the output barrel and its recessed on-axis emission surface."""
    oriented_parts = [
        [
            orient_point(
                point,
                source_forward_axis,
                source_origin,
                source_roll_deg,
            )
            for point in part.points
        ]
        for part in mesh_parts
        if part.points
    ]
    all_points = [
        point for part_points in oriented_parts for point in part_points
    ]
    _, overall_maximum = oriented_bounds(all_points, "+X")
    tolerance = max(
        (overall_maximum[0] - min(point[0] for point in all_points)) * 0.01,
        0.5,
    )
    candidates = []
    for points in oriented_parts:
        minimum, maximum = oriented_bounds(points, "+X")
        size_x = maximum[0] - minimum[0]
        size_y = maximum[1] - minimum[1]
        size_z = maximum[2] - minimum[2]
        transverse = max(size_y, size_z)
        if transverse < 5.0 or size_x < transverse * 3.0:
            continue
        if abs(size_y - size_z) > transverse * 0.15:
            continue
        if abs(maximum[0] - overall_maximum[0]) > tolerance:
            continue
        candidates.append((
            size_x / transverse,
            maximum[0],
            minimum[0],
            (minimum[1] + maximum[1]) / 2.0,
            (minimum[2] + maximum[2]) / 2.0,
            transverse,
        ))
    if not candidates:
        raise ValueError("出射用の円筒形Laserヘッドを特定できませんでした")
    (
        _,
        front_x,
        back_x,
        center_y,
        center_z,
        diameter,
    ) = max(candidates)

    # A hollow output barrel reaches the outer front plane only at its lip.
    # Prefer the closest mesh vertex to the barrel axis in the front quarter;
    # that vertex lies on the recessed emitting surface.  A plain capped
    # cylinder has no such inner vertex and correctly falls back to its tip.
    head_length = front_x - back_x
    axial_points = []
    for point in all_points:
        radial_distance = math.hypot(
            point[1] - center_y,
            point[2] - center_z,
        )
        if (
            point[0] >= front_x - min(head_length * 0.25, 15.0)
            and radial_distance <= diameter * 0.25
        ):
            axial_points.append((radial_distance, -point[0], point[0]))
    offset_x = front_x
    if axial_points:
        recessed_x = min(axial_points)[2]
        if recessed_x < front_x - diameter * 0.05:
            offset_x = recessed_x

    return LaserEmissionProfile(
        offset_x,
        front_x,
        back_x,
        center_y,
        center_z,
        diameter,
    )


def add_zero_xyz_rotation(
    xformable: UsdGeom.Xformable,
    *,
    rotate_x_deg: float = 0.0,
    rotate_y_deg: float = 0.0,
) -> None:
    """Author editable XYZ rotations, optionally with an initial Y rotation."""
    xformable.AddRotateXOp().Set(rotate_x_deg)
    xformable.AddRotateYOp().Set(rotate_y_deg)
    xformable.AddRotateZOp().Set(0.0)


def configure_generated_asset(
    output_path: Path,
    *,
    rotate_x_deg: float,
    rotate_y_deg: float,
    bottom_centered: bool,
) -> None:
    """Apply the shared model rotation and optional bottom-center origin."""
    stage = Usd.Stage.Open(str(output_path))
    if stage is None or not stage.GetDefaultPrim().IsValid():
        raise RuntimeError(f"Holder USDを開けませんでした: {output_path}")
    root = stage.GetDefaultPrim()
    xformable = UsdGeom.Xformable(root)
    ops = {op.GetOpName(): op for op in xformable.GetOrderedXformOps()}
    ops["xformOp:rotateX"].Set(rotate_x_deg)
    ops["xformOp:rotateY"].Set(rotate_y_deg)

    if bottom_centered:
        cache = UsdGeom.BBoxCache(
            Usd.TimeCode.Default(),
            [UsdGeom.Tokens.default_],
        )
        world_range = cache.ComputeWorldBound(root).ComputeAlignedRange()
        world_minimum = world_range.GetMin()
        world_maximum = world_range.GetMax()
        world_shift = Gf.Vec3d(
            -(world_minimum[0] + world_maximum[0]) / 2.0,
            -(world_minimum[1] + world_maximum[1]) / 2.0,
            -world_minimum[2],
        )
        root_matrix = xformable.ComputeLocalToWorldTransform(
            Usd.TimeCode.Default()
        )
        local_shift = root_matrix.GetInverse().TransformDir(world_shift)

        for child in root.GetChildren():
            child_xformable = UsdGeom.Xformable(child)
            if not child_xformable:
                continue
            translate_op = next(
                (
                    op
                    for op in child_xformable.GetOrderedXformOps()
                    if op.GetOpName() == "xformOp:translate"
                ),
                None,
            )
            if translate_op is None:
                translate_op = child_xformable.AddTranslateOp()
                current = Gf.Vec3d(0.0)
            else:
                current = Gf.Vec3d(translate_op.Get())
            translate_op.Set(current + local_shift)

    for axis in "XYZ":
        create_optics_attribute(root, f"rotationCenter{axis}_mm", 0.0)

    if bottom_centered:
        cache = UsdGeom.BBoxCache(
            Usd.TimeCode.Default(),
            [UsdGeom.Tokens.default_],
        )
        local_range = cache.ComputeLocalBound(root).ComputeAlignedRange()
        local_minimum = local_range.GetMin()
        local_maximum = local_range.GetMax()
        for axis, index in zip("XYZ", range(3)):
            create_optics_attribute(
                root,
                f"center{axis}_mm",
                (local_minimum[index] + local_maximum[index]) / 2.0,
            )
            create_optics_attribute(
                root,
                f"size{axis}_mm",
                local_maximum[index] - local_minimum[index],
            )
    stage.GetRootLayer().Save()


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
    mesh_color_rules: list[tuple[str, tuple[float, float, float]]] | None = None,
    mesh_opacity_rules: list[tuple[str, float]] | None = None,
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
    add_zero_xyz_rotation(
        UsdGeom.Xformable(root_prim.GetPrim()),
        rotate_x_deg=(
            0.0 if component_type.lower() == "post" else 90.0
        ),
        rotate_y_deg=(
            -90.0
            if component_type.lower() in {"holder", "post"}
            else 0.0
        ),
    )

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
    for part in parts:
        group_mesh_counts[part.group_name] = (
            group_mesh_counts.get(part.group_name, 0) + 1
        )
        group_part_count = sum(
            candidate.group_name == part.group_name
            for candidate in parts
        )
        group_index = group_mesh_counts[part.group_name]
        mesh_name = part.mesh_name or (
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
        # --mesh-color / --mesh-opacity address the mesh prims this loop names,
        # not the STEP leaves --part-color matches: a model whose pieces come
        # from face colors rather than from an assembly tree (an iris, whose
        # whole CAD is one leaf) has no leaf names to aim at.
        mesh_color = match_mesh_rule(mesh_name, mesh_color_rules or [])
        mesh_opacity = match_mesh_rule(mesh_name, mesh_opacity_rules or [])
        if mesh_color is not None:
            mesh.CreateDisplayColorAttr([mesh_color])
        elif part.color is not None:
            mesh.CreateDisplayColorAttr([part.color])
        mesh.CreateDisplayOpacityAttr([
            mesh_opacity
            if mesh_opacity is not None
            else display_opacity if part.opacity is None else part.opacity
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
            "STEPファイルをOpticalTwin用のmodel.usdaへ変換します。"
        )
    )
    parser.add_argument(
        "step_paths",
        nargs="*",
        type=Path,
        help=(
            "入力STEPファイル。複数指定すると光学部品とマウントを"
            "同じ座標系で結合します（省略時はLens/LA1417-AB-Step）"
        ),
    )
    parser.add_argument(
        "--component-name",
        help="components/以下のディレクトリ名（省略時はSTEPのファイル名）",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="出力先（省略時は components/<名前>/model.usda）",
    )
    parser.add_argument(
        "--linear-deflection",
        type=float,
        default=MESH_LINEAR_DEFLECTION_MM,
        metavar="MM",
        help="メッシュの曲面に対する距離許容誤差（既定値: 0.1 mm）",
    )
    parser.add_argument(
        "--angular-deflection",
        type=float,
        default=MESH_ANGULAR_DEFLECTION_RAD,
        metavar="RAD",
        help="メッシュの曲面に対する角度許容誤差（既定値: 0.5 rad）",
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
        choices=("AUTO", *FORWARD_AXES),
        default="+Z",
        help=(
            "STEPモデルの前方向・光軸。出力時に+Xへ合わせます。"
            "AUTOはCAD外形の最長軸を使用します"
        ),
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
            "色のない入力STEPへ形状が近い参照STEPの"
            "面色を自動位置合わせして補完します"
        ),
    )
    parser.add_argument(
        "--preserve-step-parts",
        action="store_true",
        help="STEPアセンブリの末端部品を個別のXformとして保持します",
    )
    parser.add_argument(
        "--preserve-step-solids",
        action="store_true",
        help=(
            "STEP内の独立したSolidを体積降順のCADMesh_001からの"
            "個別Meshとして保持します"
        ),
    )
    parser.add_argument(
        "--preserve-step-shells",
        action="store_true",
        help=(
            "STEP内のShellを表面積降順のCADMesh_001からの"
            "個別Meshとして保持します"
        ),
    )
    parser.add_argument(
        "--part-color",
        action="append",
        default=[],
        metavar="NAME=R,G,B",
        help=(
            "STEP末端部品ごとの0〜1 RGB表示色。名前は部分一致。"
            "--preserve-step-partsと併用します。複数回指定できます"
        ),
    )
    parser.add_argument(
        "--mesh-color",
        action="append",
        default=[],
        metavar="NAME=R,G,B",
        help=(
            "生成後のMesh名ごとの0〜1 RGB表示色（例: CADMesh_004=0,0,0）。"
            "名前は部分一致、先に書いた規則が優先。"
        ),
    )
    parser.add_argument(
        "--mesh-opacity",
        action="append",
        default=[],
        metavar="NAME=VALUE",
        help=(
            "生成後のMesh名ごとの0（透明）〜1（不透明）。"
            "名前は部分一致、先に書いた規則が優先。"
        ),
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
            print(
                f"=== {args.component_type.title()}一括変換: "
                f"{step_file.name} ==="
            )
            main(child_argv)
        return
    if not all(0.0 <= channel <= 1.0 for channel in args.color):
        parser.error("--colorの各値は0〜1で指定してください")
    if not 0.0 <= args.opacity <= 1.0:
        parser.error("--opacityは0〜1で指定してください")
    if args.part_color and not args.preserve_step_parts:
        # Without the leaf Xforms there are no part names to match against, so
        # the rules would be silently ignored.
        parser.error("--part-colorは--preserve-step-partsと併用してください")
    if args.part_color and args.ignore_step_colors:
        # --ignore-step-colors takes the branch that flattens the assembly into
        # one mesh, discarding the very names --part-color matches on.
        parser.error(
            "--part-colorと--ignore-step-colorsは同時に指定できません"
        )
    if args.metalness is not None and not 0.0 <= args.metalness <= 1.0:
        parser.error("--metalnessは0〜1で指定してください")
    if args.roughness is not None and not 0.0 <= args.roughness <= 1.0:
        parser.error("--roughnessは0〜1で指定してください")
    if args.linear_deflection <= 0.0:
        parser.error("--linear-deflectionは0より大きくしてください")
    if args.angular_deflection <= 0.0:
        parser.error("--angular-deflectionは0より大きくしてください")

    using_default_step = not args.step_paths
    if using_default_step:
        component_name = args.component_name or DEFAULT_COMPONENT_NAME
        step_paths = [(
            ROOT_DIR / "cad" / f"{component_name}.step"
        )]
    else:
        step_paths = args.step_paths
        component_name = args.component_name or step_paths[0].stem

    root_prim_name = args.root_prim or usd_identifier(args.component_type.title())
    optics_attrs = parse_optics_attrs(args.attr)
    part_color_rules = parse_part_colors(args.part_color)
    mesh_color_rules = parse_part_colors(args.mesh_color)
    mesh_opacity_rules = parse_mesh_opacities(args.mesh_opacity)
    lcp6x_component = (
        args.component_type.lower() == "mount"
        and Path(component_name).name.lower() == "lcp6x-step"
    )
    if lcp6x_component:
        optics_attrs.setdefault("loShape", "cross")
        optics_attrs.setdefault("crossBarWidth_mm", 10.0)
        optics_attrs.setdefault("beamApertureRadius_mm", 12.8016)
        optics_attrs.setdefault("rodHoleRadius_mm", 3.0099)
        optics_attrs.setdefault(
            "rodHoleOffsets_mm",
            (
                "[[0,-30,-30],[0,-30,30],[0,-15,-15],[0,-15,15],"
                "[0,15,-15],[0,15,15],[0,30,-30],[0,30,30]]"
            ),
        )
    rod_component = is_rod_component(
        args.component_type,
        root_prim_name,
    )
    holder_component = args.component_type.lower() == "holder"
    post_component = args.component_type.lower() == "post"
    breadboard_component = args.component_type.lower() == "breadboard"
    bottom_centered_component = holder_component or post_component
    holder_is_short = (
        Path(component_name).name.lower()
        in {"ph20e_m-step", "ph30e_m-step"}
    )
    holder_rotate_x = 90.0
    holder_rotate_y = -180.0 if holder_is_short else -90.0
    metal_component = (
        rod_component
        or args.component_type.lower() in {"mount", "post"}
    )
    if args.metalness is not None:
        optics_attrs["metalness"] = args.metalness
    elif metal_component:
        optics_attrs.setdefault("metalness", 0.9)
    if args.roughness is not None:
        optics_attrs["roughness"] = args.roughness
    elif metal_component:
        optics_attrs.setdefault("roughness", 0.08)

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

    def all_colored_mesh_parts(
        use_step_colors: bool,
        preserve_solids: bool = False,
        preserve_shells: bool = False,
    ):
        if preserve_shells or preserve_solids:
            parts = []
            mesh_index = 0
            for source_index, source_shape in enumerate(source_shapes):
                source_color = (
                    tuple(args.color)
                    if source_index == 0
                    else (0.0524, 0.0524, 0.0524)
                )
                shapes = sorted(
                    (
                        shape_shells(source_shape)
                        if preserve_shells
                        else shape_solids(source_shape)
                    ),
                    key=shell_area if preserve_shells else solid_volume,
                    reverse=True,
                )
                for preserved_shape in shapes:
                    shape_points, shape_indices = extract_mesh_data(
                        preserved_shape
                    )
                    parts.append(MeshPart(
                        shape_points,
                        shape_indices,
                        source_color,
                        opacity=(
                            args.opacity if source_index == 0 else 1.0
                        ),
                        mesh_name=f"CADMesh_{mesh_index + 1:03d}",
                    ))
                    mesh_index += 1
            if parts:
                return parts

        if use_step_colors and part_occurrences:
            parts = []
            source_color_tool = source_color_tools[0]
            for part_name, part_shape in part_occurrences:
                source_parts = extract_colored_mesh_data(
                    part_shape,
                    source_color_tool,
                    None,
                )
                override = match_part_color(part_name, part_color_rules)
                for part in source_parts:
                    part.opacity = args.opacity
                    part.group_name = part_name
                    if override is not None:
                        part.color = override
                    elif part.color is None and part_color_rules:
                        # A STEP with no presentation colors leaves every face
                        # at None, which writes a mesh with no displayColor at
                        # all -- the near-white default. Once the caller is
                        # hand-coloring this model, --color is the shade for
                        # everything they did not name.
                        part.color = tuple(args.color)
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

    effective_source_axis = args.source_forward_axis
    effective_source_origin = tuple(args.source_origin)
    effective_source_roll = args.source_roll_deg
    nested_laser = (
        args.component_type.lower() == "laser"
        and component_name.replace("\\", "/").lower().startswith("laser/")
    )
    if nested_laser and "--source-roll-deg" not in raw_argv:
        # The application coordinate convention otherwise displays vendor
        # Laser STEP data with a -90 degree roll.
        effective_source_roll = 90.0
    # Rod catalogue models intentionally use their envelope center as the
    # placement origin. Laser STEP files, however, already carry the optical
    # origin used by the legacy top-level assets. Re-centering only the nested
    # Laser catalogue shifted NPL64A by 3.063 mm and made its geometry miss
    # the beam even though both catalogue entries came from the same STEP.
    center_generated_component = (
        rod_component or bottom_centered_component or breadboard_component
    )
    if (
        effective_source_axis == "AUTO"
        or (
            center_generated_component
            and "--source-origin" not in raw_argv
        )
    ):
        # Vendor catalogue STEP files are not consistently authored around
        # (0,0,0), and Laser models do not consistently share a forward axis.
        mesh_shape(shape, args.linear_deflection, args.angular_deflection)
        source_points = [
            point
            for region in all_source_regions(False)
            for point in region.points
        ]
        source_minimum, source_maximum = oriented_bounds(
            source_points,
            "+X",
        )
        if effective_source_axis == "AUTO":
            source_size = [
                source_maximum[axis] - source_minimum[axis]
                for axis in range(3)
            ]
            longest_axis = max(
                range(3),
                key=source_size.__getitem__,
            )
            effective_source_axis = ("+X", "+Y", "+Z")[longest_axis]
        if (
            center_generated_component
            and "--source-origin" not in raw_argv
        ):
            if breadboard_component:
                oriented_points = [
                    orient_point(
                        point,
                        effective_source_axis,
                        (0.0, 0.0, 0.0),
                        effective_source_roll,
                    )
                    for point in source_points
                ]
                oriented_minimum, oriented_maximum = oriented_bounds(
                    oriented_points, "+X"
                )
                oriented_origin = (
                    (oriented_minimum[0] + oriented_maximum[0]) / 2.0,
                    (oriented_minimum[1] + oriented_maximum[1]) / 2.0,
                    oriented_maximum[2],
                )
                oriented_basis = [
                    orient_point(
                        basis,
                        effective_source_axis,
                        (0.0, 0.0, 0.0),
                        effective_source_roll,
                    )
                    for basis in (
                        (1.0, 0.0, 0.0),
                        (0.0, 1.0, 0.0),
                        (0.0, 0.0, 1.0),
                    )
                ]
                effective_source_origin = tuple(
                    sum(
                        oriented_basis[source_axis][oriented_axis]
                        * oriented_origin[oriented_axis]
                        for oriented_axis in range(3)
                    )
                    for source_axis in range(3)
                )
            else:
                effective_source_origin = tuple(
                    (
                        source_minimum[axis] + source_maximum[axis]
                    ) / 2.0
                    for axis in range(3)
                )

    if (
        nested_laser
        and Path(component_name).name.lower() == "pl251-step"
    ):
        laser_parts = all_colored_mesh_parts(True)
        emission = analyze_cylindrical_laser_emission(
            laser_parts,
            effective_source_axis,
            effective_source_origin,
            effective_source_roll,
        )
        if "--source-origin" not in raw_argv:
            # Translate the complete model (housing, cable, and output barrel)
            # so the detected barrel axis becomes the component's local +X
            # optical axis.  The inverse rotation maps the desired oriented
            # Y/Z origin back into the source STEP coordinate system.
            oriented_basis = [
                orient_point(
                    basis,
                    effective_source_axis,
                    (0.0, 0.0, 0.0),
                    effective_source_roll,
                )
                for basis in (
                    (1.0, 0.0, 0.0),
                    (0.0, 1.0, 0.0),
                    (0.0, 0.0, 1.0),
                )
            ]
            oriented_center = (0.0, emission.center_y, emission.center_z)
            source_center_delta = tuple(
                sum(
                    oriented_basis[source_axis][oriented_axis]
                    * oriented_center[oriented_axis]
                    for oriented_axis in range(3)
                )
                for source_axis in range(3)
            )
            effective_source_origin = tuple(
                effective_source_origin[axis] + source_center_delta[axis]
                for axis in range(3)
            )
            emission = analyze_cylindrical_laser_emission(
                laser_parts,
                effective_source_axis,
                effective_source_origin,
                effective_source_roll,
            )
        optics_attrs.update({
            "emissionOffset_mm": emission.offset_x,
            "emissionFrontX_mm": emission.front_x,
            "emissionHeadLength_mm": emission.front_x - emission.back_x,
            "emissionRecessDepth_mm": emission.front_x - emission.offset_x,
            "emissionCenterY_mm": emission.center_y,
            "emissionCenterZ_mm": emission.center_z,
            "emissionDiameter_mm": emission.diameter,
        })
    elif (
        nested_laser
        and Path(component_name).name.lower() == "npl64a-step"
    ):
        # NPL64A's emitting surface is the recessed circular face. The CAD
        # envelope continues to X=69.775 mm on unrelated parts, so the generic
        # sizeX/2 fallback leaves the beam floating 11.769 mm in front.
        optics_attrs.setdefault("emissionOffset_mm", 58.00558)
        optics_attrs.setdefault("emissionCenterY_mm", 0.0)
        optics_attrs.setdefault("emissionCenterZ_mm", 0.0)
        optics_attrs.setdefault("pulseWidth_ns", 10)
        optics_attrs.setdefault("wavelength_nm", 640)

    print("STEPファイルの読み込みに成功しました")
    for step_path in step_paths:
        print(f"入力ファイル: {step_path}")
    print(f"Shape type: {shape.ShapeType()}")
    print(f"Shape is null: {shape.IsNull()}")

    linear_deflection = args.linear_deflection
    angular_deflection = args.angular_deflection
    output_path = args.output or (
        ROOT_DIR / "components" / component_name / MODEL_FILE
    )
    print(
        f"--- {MODEL_FILE}を生成 "
        f"(距離誤差={linear_deflection} mm, "
        f"角度誤差={angular_deflection} rad) ---"
    )
    mesh_shape(shape, linear_deflection, angular_deflection)
    print("Shapeのメッシュ化に成功しました")
    inspect_mesh(shape, verbose_faces=args.verbose_faces)

    use_step_colors = not args.ignore_step_colors
    mesh_parts = all_colored_mesh_parts(
        use_step_colors,
        preserve_solids=(
            args.preserve_step_solids
        ),
        preserve_shells=(
            args.preserve_step_shells
        ),
    )
    if reference_source is not None:
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
    if rod_component:
        mesh_parts = split_rod_parts(mesh_parts)
        positive_inner_points = [
            orient_point(
                point,
                effective_source_axis,
                effective_source_origin,
                effective_source_roll,
            )
            for point in mesh_parts[1].points
        ]
        negative_inner_points = [
            orient_point(
                point,
                effective_source_axis,
                effective_source_origin,
                effective_source_roll,
            )
            for point in mesh_parts[3].points
        ]
        _, positive_inner_maximum = oriented_bounds(
            positive_inner_points,
            "+X",
        )
        negative_inner_minimum, _ = oriented_bounds(
            negative_inner_points,
            "+X",
        )
        optics_attrs["rodEndMinX_mm"] = negative_inner_minimum[0]
        optics_attrs["rodEndMaxX_mm"] = positive_inner_maximum[0]
    points = [point for part in mesh_parts for point in part.points]
    face_vertex_indices = [
        index
        for part in mesh_parts
        for index in part.face_vertex_indices
    ]

    print("--- 抽出結果 ---")
    print(f"頂点数: {len(points)}")
    print(f"三角形数: {len(face_vertex_indices) // 3}")
    print(f"色数: {len(mesh_parts) if mesh_parts else 1}")

    envelope_minimum, envelope_maximum = oriented_bounds(
        points,
        effective_source_axis,
        effective_source_origin,
        effective_source_roll,
    )
    optics_attrs.update(measured_envelope_attrs(
        envelope_minimum,
        envelope_maximum,
        component_type=args.component_type,
        rod=rod_component,
        optics_attrs=optics_attrs,
    ))

    write_usda_mesh(
        points,
        face_vertex_indices,
        output_path,
        component_type=args.component_type,
        root_prim_name=root_prim_name,
        source_forward_axis=effective_source_axis,
        source_origin=effective_source_origin,
        source_roll_deg=effective_source_roll,
        optics_attrs=optics_attrs,
        display_color=tuple(args.color),
        display_opacity=args.opacity,
        mesh_parts=mesh_parts,
        mesh_color_rules=mesh_color_rules,
        mesh_opacity_rules=mesh_opacity_rules,
    )
    configure_generated_asset(
        output_path,
        rotate_x_deg=(
            holder_rotate_x
            if holder_component
            else 0.0
            if post_component or breadboard_component
            else 90.0
        ),
        rotate_y_deg=(
            holder_rotate_y
            if holder_component
            else -90.0 if post_component else 0.0
        ),
        bottom_centered=bottom_centered_component,
    )

    print(f"{MODEL_FILE}の生成に成功しました")
    print(f"出力ファイル: {output_path}")



if __name__ == "__main__":
    main()
