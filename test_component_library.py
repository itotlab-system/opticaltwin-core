import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pxr import Usd, UsdGeom

import optics_lib
import server
import usd_utility

# cad_importer imports the OpenCASCADE bindings at module level, and those are
# an optional extra (`pip install cadquery-ocp`) because they are large and only
# the STEP import path needs them. Patching anything inside cad_importer
# therefore imports OCP too, so tests that do must skip without it -- otherwise
# the documented test command fails on a clone that installed only the base
# requirements.
HAS_OCP = importlib.util.find_spec("OCP") is not None
requires_ocp = unittest.skipUnless(HAS_OCP, "requires cadquery-ocp")


class NestedComponentLibraryTests(unittest.TestCase):
    def test_nested_hi_lo_pair_is_discovered_as_grouped_asset(self):
        with tempfile.TemporaryDirectory() as directory:
            component = Path(directory) / "Rod" / "ER1-Step"
            component.mkdir(parents=True)
            (component / "hi.usda").touch()
            (component / "lo.usda").touch()

            self.assertEqual(
                optics_lib.cad_library_assets(directory),
                {"Rod/ER1-Step.usda"},
            )

    def test_nested_asset_resolves_to_nested_component_directory(self):
        self.assertEqual(
            usd_utility.get_component_name("Rod/ER1-Step.usda"),
            "Rod/ER1-Step",
        )
        self.assertEqual(
            usd_utility.get_component_usda_path(
                "/components",
                "Rod/ER1-Step.usda",
                "hi",
            ),
            "/components/Rod/ER1-Step/hi.usda",
        )

    @requires_ocp
    def test_server_converts_a_missing_rod_asset_from_cad_folder(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cad_directory = root / "cad" / "Rod"
            cad_directory.mkdir(parents=True)
            (cad_directory / "ER1-Step.step").touch()
            components_directory = root / "components"

            with (
                patch.object(server, "LIB_DIR", str(components_directory)),
                patch("cad_importer.main") as convert,
            ):
                server._sync_cad_catalog_group(
                    str(cad_directory),
                    "Rod",
                    "rod",
                    "+Y",
                )

            convert.assert_called_once_with([
                str(cad_directory / "ER1-Step.step"),
                "--type", "rod",
                "--lod", "both",
                "--component-name", "Rod/ER1-Step",
                "--source-forward-axis", "+Y",
            ])

    def test_asset_rotation_is_not_returned_as_placement_rotation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            asset_path = root / "lo.usda"
            asset = Usd.Stage.CreateNew(str(asset_path))
            asset_prim = UsdGeom.Xform.Define(asset, "/Part").GetPrim()
            asset.SetDefaultPrim(asset_prim)
            UsdGeom.Xformable(asset_prim).AddRotateXOp().Set(90)
            UsdGeom.Xformable(asset_prim).AddRotateZOp().Set(45)
            asset.GetRootLayer().Save()

            setup_path = root / "setup.usda"
            setup = Usd.Stage.CreateNew(str(setup_path))
            placed = setup.OverridePrim("/Setup/Part")
            placed.GetReferences().AddReference(str(asset_path))
            UsdGeom.Xformable(placed).AddTranslateOp().Set((10, 20, 30))
            setup.GetRootLayer().Save()

            self.assertEqual(
                server._placement_xform_values(placed),
                (10.0, 20.0, 30.0, 0.0, 0.0, 0.0),
            )
            self.assertEqual(
                server._component_model_pose(asset, asset_prim)["modelRotation"],
                [90.0, 0.0, 45.0],
            )


if __name__ == "__main__":
    unittest.main()
