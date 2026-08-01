import os
import re


_LEGACY_COMPONENT_REF = re.compile(
    r"(?P<prefix>@(?:\.\./)+components/)(?P<component>[A-Za-z0-9_-]+)\.usda@"
)
_LEGACY_COMPONENT_ASSET_PATH = re.compile(
    r"(?P<prefix>(?:^|.*/)components/)(?P<component>[A-Za-z0-9_-]+)\.usda$"
)


def get_component_name(asset_or_component_name):
    """Return a component path relative to components/ from an asset id."""
    name = asset_or_component_name.replace("\\", "/").strip("/")
    parts = name.split("/")
    if name.endswith(".usda"):
        if len(parts) >= 2 and parts[-1] in ("hi.usda", "lo.usda"):
            return "/".join(parts[:-1])
        parts[-1] = os.path.splitext(parts[-1])[0]
        return "/".join(parts)
    return name


def get_component_usda_path(lib_dir, component_name, render_mode="lo"):
    component_name = get_component_name(component_name)
    return os.path.join(lib_dir, component_name, f"{render_mode}.usda")


def get_relative_component_usda_path(lib_dir, component_name, base_dir, render_mode="lo"):
    return os.path.relpath(
        get_component_usda_path(lib_dir, component_name, render_mode),
        base_dir,
    ).replace(os.sep, "/")


def normalize_component_asset_ref(asset_ref, render_mode="lo"):
    """Return a component reference path using components/<name>/<mode>.usda."""
    path = asset_ref.replace("\\", "/")
    return _LEGACY_COMPONENT_ASSET_PATH.sub(
        lambda m: f"{m.group('prefix')}{m.group('component')}/{render_mode}.usda",
        path,
    )


def normalize_component_references_in_usda(path, render_mode="lo"):
    """Update legacy components/<name>.usda references to components/<name>/<mode>.usda."""
    with open(path, "r") as f:
        original = f.read()

    updated = _LEGACY_COMPONENT_REF.sub(
        lambda m: f"{m.group('prefix')}{m.group('component')}/{render_mode}.usda@",
        original,
    )
    if updated == original:
        return False

    with open(path, "w") as f:
        f.write(updated)
    return True


def ensure_fixed_breadboard_reference(
    path,
    component_name="Breadboard/MB6060_M-Step",
):
    """Replace a legacy generated board with the fixed centred CAD asset."""
    from pxr import Sdf, Usd, UsdGeom

    stage = Usd.Stage.Open(str(path))
    if stage is None or not stage.GetDefaultPrim().IsValid():
        return False
    root_path = stage.GetDefaultPrim().GetPath()
    board_path = root_path.AppendChild("Breadboard")
    holes_path = root_path.AppendChild("Holes")
    board = stage.GetPrimAtPath(board_path)
    fixed = board.GetAttribute("optics:fixedBoard") if board else None
    references = str(board.GetMetadata("references")) if board else ""
    if (
        fixed and fixed.Get()
        and "Breadboard/" in references
        and "/lo.usda" in references
    ):
        return False

    if board:
        stage.RemovePrim(board_path)
    if stage.GetPrimAtPath(holes_path):
        stage.RemovePrim(holes_path)

    board = UsdGeom.Xform.Define(stage, board_path).GetPrim()
    project_dir = os.path.dirname(os.path.abspath(path))
    components_dir = os.path.join(
        os.path.dirname(os.path.dirname(project_dir)), "components"
    )
    asset_path = get_relative_component_usda_path(
        components_dir, f"{component_name}.usda", project_dir
    )
    board.GetReferences().AddReference(asset_path)
    board.CreateAttribute("optics:type", Sdf.ValueTypeNames.Token).Set(
        "breadboard"
    )
    board.CreateAttribute("optics:fixedBoard", Sdf.ValueTypeNames.Bool).Set(
        True
    )
    stage.GetRootLayer().Save()
    return True


def set_render_mode(stage, component_path, mode):
    from pxr import UsdGeom, Sdf

    if mode not in ("hi", "lo"):
        raise ValueError("mode must be 'hi' or 'lo'")

    component_prim = stage.GetPrimAtPath(component_path)
    hi_prim = stage.GetPrimAtPath(f"{component_path}/hi")
    lo_prim = stage.GetPrimAtPath(f"{component_path}/lo")

    if not component_prim.IsValid():
        raise ValueError(f"component not found: {component_path}")
    if not hi_prim.IsValid():
        raise ValueError(f"hi prim not found: {component_path}/hi")
    if not lo_prim.IsValid():
        raise ValueError(f"lo prim not found: {component_path}/lo")

    if mode == "hi":
        UsdGeom.Imageable(hi_prim).MakeVisible()
        UsdGeom.Imageable(lo_prim).MakeInvisible()
    else:
        UsdGeom.Imageable(hi_prim).MakeInvisible()
        UsdGeom.Imageable(lo_prim).MakeVisible()

    component_prim.CreateAttribute(
        "optics:renderMode",
        Sdf.ValueTypeNames.String
    ).Set(mode)
