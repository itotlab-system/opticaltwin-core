import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import optics_lib
import server
import usd_utility


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

    def test_server_converts_a_missing_rod_asset_from_cad_folder(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cad_directory = root / "cad" / "Rod"
            cad_directory.mkdir(parents=True)
            (cad_directory / "ER1-Step.step").touch()
            components_directory = root / "components"

            with (
                patch.object(server, "ROD_CAD_DIR", str(cad_directory)),
                patch.object(server, "LIB_DIR", str(components_directory)),
                patch("cad_importer.main") as convert,
            ):
                server._sync_rod_catalog()

            convert.assert_called_once_with([
                str(cad_directory / "ER1-Step.step"),
                "--type", "rod",
                "--lod", "both",
                "--component-name", "Rod/ER1-Step",
                "--source-forward-axis", "+Y",
            ])


if __name__ == "__main__":
    unittest.main()
