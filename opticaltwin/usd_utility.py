import os
import re


# Every component is one folder holding one model: components/<Group>/<Model>/model.usda.
MODEL_FILE = "model.usda"
# The generated parts (optics_lib.LIBRARY) live in this group.
GENERIC_GROUP = "Generic"

# Older layouts a project file may still reference, all rewritten to MODEL_FILE:
#   components/<name>.usda                  (flat, before per-component folders)
#   components/<Group>/<Model>/lo.usda|hi.usda  (two levels of detail)
#   components/Low_model/<name>/lo.usda     (the generated parts' old group)
_LEGACY_MODEL_FILES = ("hi.usda", "lo.usda")
_LEGACY_GENERIC_GROUP = "Low_model"

# Group folders may contain spaces ("Beam Splitter", "Laser Source").
_COMPONENT_REF = re.compile(
    r"(?P<prefix>@(?:\.\./)+components/)(?P<path>[A-Za-z0-9_./ -]+?\.usda)@"
)
_COMPONENT_ASSET_PATH = re.compile(
    r"(?P<prefix>(?:^|.*/)components/)(?P<path>[A-Za-z0-9_./ -]+?\.usda)$"
)


def get_component_name(asset_or_component_name):
    """Return a component path relative to components/ from an asset id.

    Accepts an asset id (``Lens/LA1417-AB-Step.usda``), a component folder, or
    a path to its model file, including the legacy ``hi.usda``/``lo.usda`` and
    ``Low_model/`` forms, so old references resolve to the current folder.
    """
    name = asset_or_component_name.replace("\\", "/").strip("/")
    parts = name.split("/")
    if name.endswith(".usda"):
        if len(parts) >= 2 and parts[-1] in (MODEL_FILE, *_LEGACY_MODEL_FILES):
            parts = parts[:-1]
        else:
            parts[-1] = os.path.splitext(parts[-1])[0]
    if len(parts) >= 2 and parts[0] == _LEGACY_GENERIC_GROUP:
        parts[0] = GENERIC_GROUP
    return "/".join(parts)


def get_component_usda_path(lib_dir, component_name):
    component_name = get_component_name(component_name)
    return os.path.join(lib_dir, component_name, MODEL_FILE)


def get_relative_component_usda_path(lib_dir, component_name, base_dir):
    return os.path.relpath(
        get_component_usda_path(lib_dir, component_name),
        base_dir,
    ).replace(os.sep, "/")


def _model_path(component_path):
    """``<anything>.usda`` under components/ -> ``<component>/model.usda``."""
    return f"{get_component_name(component_path)}/{MODEL_FILE}"


def normalize_component_asset_ref(asset_ref):
    """Return a component reference path using components/<name>/model.usda."""
    path = asset_ref.replace("\\", "/")
    return _COMPONENT_ASSET_PATH.sub(
        lambda m: f"{m.group('prefix')}{_model_path(m.group('path'))}",
        path,
    )


def normalize_component_references_in_usda(path):
    """Rewrite legacy component references in a layer to <name>/model.usda.

    Runs whenever a project is opened, so a project saved before the one-model
    layout keeps working. Returns True when the file was changed.
    """
    with open(path, "r") as f:
        original = f.read()

    updated = _COMPONENT_REF.sub(
        lambda m: f"{m.group('prefix')}{_model_path(m.group('path'))}@",
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
    """Replace a legacy generated board with the fixed centred CAD asset.

    Does nothing when the library has no such asset: a checkout without
    manufacturer CAD keeps the generated board it can actually draw, rather
    than trading it for a reference that resolves to nothing.
    """
    from pxr import Sdf, Usd, UsdGeom

    project_dir = os.path.dirname(os.path.abspath(path))
    components_dir = os.path.join(
        os.path.dirname(os.path.dirname(project_dir)), "components"
    )
    if not os.path.exists(
        get_component_usda_path(components_dir, f"{component_name}.usda")
    ):
        return False

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
        and f"/{MODEL_FILE}" in references
    ):
        return False

    if board:
        stage.RemovePrim(board_path)
    if stage.GetPrimAtPath(holes_path):
        stage.RemovePrim(holes_path)

    board = UsdGeom.Xform.Define(stage, board_path).GetPrim()
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

