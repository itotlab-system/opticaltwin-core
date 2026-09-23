import importlib.util
import inspect
import tempfile
import unittest
from pathlib import Path

from pxr import Usd, UsdGeom

# The module under test needs the OpenCASCADE bindings, which are an optional
# extra (`pip install cadquery-ocp`) -- large, and only the STEP import path
# uses them. Import it only when they are present and skip the cases otherwise,
# so the documented test command passes on a base install. A module-level
# `raise SkipTest` would not do: unittest's loader treats that as an error when
# the module is named on the command line, rather than as a skip.
HAS_OCP = importlib.util.find_spec("OCP") is not None
requires_ocp = unittest.skipUnless(HAS_OCP, "requires cadquery-ocp")

if HAS_OCP:
    import cad_importer
    from cad_importer import (
        MeshPart,
        analyze_cylindrical_laser_emission,
        analyze_lens_profile,
        match_mesh_rule,
        match_part_color,
        parse_mesh_opacities,
        parse_part_colors,
        split_rod_hi_parts,
        write_lo_primitives,
        write_usda_mesh,
    )


def ring(x, radius=10.0):
    return [
        (x, radius, 0.0),
        (x, -radius, 0.0),
        (x, 0.0, radius),
        (x, 0.0, -radius),
    ]


@requires_ocp
class LensLoPrimitiveTests(unittest.TestCase):
    def _write(self, name, points):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / f"{name}.usda"
        write_lo_primitives(
            points,
            path,
            component_type="lens",
            root_prim_name="Lens",
            optics_attrs={},
            display_color=(0.4, 0.7, 1.0),
            display_opacity=0.35,
        )
        return Usd.Stage.Open(str(path))

    def test_plano_convex_uses_closed_cylinder_and_half_rugby_ball(self):
        points = ring(-2.0) + ring(0.0) + [(2.0, 0.0, 0.0)]
        self.assertEqual(
            analyze_lens_profile(points).kind,
            "planoConvex",
        )

        stage = self._write("plano", points)
        root = stage.GetDefaultPrim()
        cylinder = next(
            p for p in Usd.PrimRange(root) if p.IsA(UsdGeom.Cylinder)
        )
        sphere = next(
            p for p in Usd.PrimRange(root) if p.IsA(UsdGeom.Sphere)
        )
        self.assertTrue(UsdGeom.Cylinder(cylinder).GetDoubleSidedAttr().Get())
        self.assertEqual(
            cylinder.GetAttribute("optics:capSide").Get(),
            "negativeX",
        )
        self.assertEqual(
            sphere.GetAttribute("optics:spherePortion").Get(),
            "positiveX",
        )
        bounds = UsdGeom.BBoxCache(
            Usd.TimeCode.Default(), [UsdGeom.Tokens.default_]
        ).ComputeLocalBound(root).ComputeAlignedRange()
        for actual, expected in zip(bounds.GetMin(), (-2.0, -10.0, -10.0)):
            self.assertAlmostEqual(actual, expected)
        for actual, expected in zip(bounds.GetMax(), (2.0, 10.0, 10.0)):
            self.assertAlmostEqual(actual, expected)

    def test_plano_convex_supports_flat_face_on_positive_x(self):
        points = [(-2.0, 0.0, 0.0)] + ring(0.0) + ring(2.0)
        profile = analyze_lens_profile(points)
        self.assertEqual(profile.kind, "planoConvex")
        self.assertEqual(profile.flat_side, "max")

        stage = self._write("plano_reversed", points)
        root = stage.GetDefaultPrim()
        cylinder = next(
            p for p in Usd.PrimRange(root) if p.IsA(UsdGeom.Cylinder)
        )
        sphere = next(
            p for p in Usd.PrimRange(root) if p.IsA(UsdGeom.Sphere)
        )
        self.assertEqual(
            cylinder.GetAttribute("optics:capSide").Get(),
            "positiveX",
        )
        self.assertEqual(
            sphere.GetAttribute("optics:spherePortion").Get(),
            "negativeX",
        )

    def test_biconvex_uses_one_full_rugby_ball_with_exact_bounds(self):
        points = [(-2.0, 0.0, 0.0), (2.0, 0.0, 0.0)] + ring(0.0)
        self.assertEqual(
            analyze_lens_profile(points).kind,
            "biconvex",
        )

        stage = self._write("biconvex", points)
        root = stage.GetDefaultPrim()
        children = [
            p for p in Usd.PrimRange(root)
            if p.IsA(UsdGeom.Cylinder) or p.IsA(UsdGeom.Sphere)
        ]
        self.assertEqual(len(children), 1)
        self.assertTrue(children[0].IsA(UsdGeom.Sphere))
        self.assertEqual(
            children[0].GetAttribute("optics:spherePortion").Get(),
            "full",
        )
        bounds = UsdGeom.BBoxCache(
            Usd.TimeCode.Default(), [UsdGeom.Tokens.default_]
        ).ComputeLocalBound(root).ComputeAlignedRange()
        for actual, expected in zip(bounds.GetMin(), (-2.0, -10.0, -10.0)):
            self.assertAlmostEqual(actual, expected)
        for actual, expected in zip(bounds.GetMax(), (2.0, 10.0, 10.0)):
            self.assertAlmostEqual(actual, expected)


@requires_ocp
class RodGenerationTests(unittest.TestCase):
    def test_hi_is_split_into_five_mesh_parts(self):
        body = MeshPart(
            [(-10, -3, -3), (10, -3, -3), (10, 3, 3)],
            [0, 1, 2],
            (0.7, 0.7, 0.7),
        )
        inner = MeshPart(
            [
                (6, -1, -1), (8, -1, -1), (8, 1, 1),
                (-6, -1, -1), (-8, -1, -1), (-8, 1, 1),
            ],
            [0, 1, 2, 3, 4, 5],
            (0.9, 0.9, 0.9),
        )
        outer = MeshPart(
            [
                (8, -1.5, -1.5), (11, -1.5, -1.5), (11, 1.5, 1.5),
                (-8, -1.5, -1.5), (-11, -1.5, -1.5), (-11, 1.5, 1.5),
            ],
            [0, 1, 2, 3, 4, 5],
            (0.5, 0.5, 0.5),
        )
        result = split_rod_hi_parts([body, inner, outer])
        self.assertEqual(len(result), 5)
        self.assertEqual([part.color for part in result], [
            body.color,
            inner.color,
            outer.color,
            inner.color,
            outer.color,
        ])

    def test_lo_is_one_metallic_cylinder_with_mount_type(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "lo.usda"
            points = [
                (-10.0, -3.0, -2.5),
                (-10.0, 3.0, 2.5),
                (10.0, -3.0, -2.5),
                (10.0, 3.0, 2.5),
            ]
            write_lo_primitives(
                points,
                path,
                component_type="rod",
                root_prim_name="Rod",
                optics_attrs={"metalness": 0.9, "roughness": 0.08},
                display_color=(0.7, 0.7, 0.7),
                display_opacity=1.0,
            )
            stage = Usd.Stage.Open(str(path))
            root = stage.GetDefaultPrim()
            cylinders = [
                prim for prim in Usd.PrimRange(root)
                if prim.IsA(UsdGeom.Cylinder)
            ]
            self.assertEqual(root.GetAttribute("optics:type").Get(), "mount")
            self.assertAlmostEqual(
                root.GetAttribute("optics:metalness").Get(), 0.9
            )
            self.assertAlmostEqual(
                root.GetAttribute("optics:roughness").Get(), 0.08
            )
            self.assertEqual(len(cylinders), 1)
            self.assertEqual(
                UsdGeom.Cylinder(cylinders[0]).GetAxisAttr().Get(),
                UsdGeom.Tokens.x,
            )
            self.assertAlmostEqual(
                UsdGeom.Cylinder(cylinders[0]).GetHeightAttr().Get(),
                20.0,
            )
            self.assertAlmostEqual(
                root.GetAttribute("optics:rodEndMinX_mm").Get(),
                -10.0,
            )
            self.assertAlmostEqual(
                root.GetAttribute("optics:rodEndMaxX_mm").Get(),
                10.0,
            )


@requires_ocp
class LaserEmissionTests(unittest.TestCase):
    def test_nested_npl64a_keeps_vendor_origin_and_emission_surface(self):
        source = inspect.getsource(cad_importer.main)

        self.assertIn("center_generated_component = rod_component", source)
        self.assertNotIn(
            "center_generated_component = rod_component or nested_laser",
            source,
        )
        self.assertIn(
            'Path(component_name).name.lower() == "npl64a-step"',
            source,
        )
        self.assertIn(
            'optics_attrs.setdefault("emissionOffset_mm", 58.00558)',
            source,
        )

    def test_round_head_at_positive_x_defines_emission_center(self):
        unrelated = MeshPart(
            [(-20, -20, -5), (20, 20, 5), (0, 0, 0)],
            [0, 1, 2],
            (0.0, 0.0, 0.0),
        )
        head = MeshPart(
            [
                (40, -7, -1), (100, -7, -1), (100, 3, -1),
                (40, -7, 9), (100, 3, 9), (40, 3, 9),
            ],
            [0, 1, 2, 3, 4, 5],
            (0.8, 0.8, 0.8),
        )
        profile = analyze_cylindrical_laser_emission(
            [unrelated, head],
            "+X",
            (0.0, 0.0, 0.0),
            0.0,
        )
        self.assertEqual(profile.offset_x, 100)
        self.assertEqual(profile.front_x, 100)
        self.assertEqual(profile.back_x, 40)
        self.assertEqual(profile.center_y, -2)
        self.assertEqual(profile.center_z, 4)
        self.assertEqual(profile.diameter, 10)


@requires_ocp
class PartColorTests(unittest.TestCase):
    """--part-color paints named STEP leaves, for assemblies with no colors."""

    def test_matches_a_leaf_by_substring_and_ignores_case(self):
        rules = parse_part_colors(["EEC4011_housing=0.62,0.09,0.10"])
        # Vendor leaves carry suffixes (`_STEP`, and `_002` on repeats), so a
        # rule pinned to the whole name would match none of them.
        self.assertEqual(
            match_part_color("EEC4011_HOUSING_STEP", rules),
            (0.62, 0.09, 0.10),
        )
        self.assertIsNone(match_part_color("M3x8_torx_CTS_screw_STEP", rules))

    def test_first_matching_rule_wins(self):
        rules = parse_part_colors(["cover_left=1,0,0", "cover=0,1,0"])
        self.assertEqual(match_part_color("Cover_left_1_STEP", rules), (1.0, 0.0, 0.0))
        self.assertEqual(match_part_color("Cover_right_STEP", rules), (0.0, 1.0, 0.0))

    def test_rejects_malformed_rules(self):
        for bad in ("nocolor", "x=1,2", "x=1,2,3,4", "x=a,b,c", "=1,0,0", "x=2,0,0"):
            with self.subTest(rule=bad):
                with self.assertRaises(ValueError):
                    parse_part_colors([bad])

    def test_whitespace_around_the_channels_is_allowed(self):
        self.assertEqual(
            parse_part_colors(["mod = 0.3, 0.34, 0.37"]),
            [("mod", (0.3, 0.34, 0.37))],
        )


@requires_ocp
class MeshOverrideTests(unittest.TestCase):
    """--mesh-color / --mesh-opacity paint the meshes the writer itself names.

    The counterpart to --part-color, for a model whose pieces come from STEP
    face colors instead of an assembly tree: the ID25 iris is one leaf, so its
    aperture disc has no leaf name to aim a --part-color rule at.
    """

    def parts(self):
        return [
            MeshPart(ring(0.0), [0, 1, 2], (1.0, 1.0, 1.0)),
            MeshPart(ring(1.0), [0, 1, 2], (1.0, 0.0, 0.0)),
        ]

    def write(self, **kwargs):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        output = Path(directory.name) / "hi.usda"
        write_usda_mesh(
            ring(0.0),
            [0, 1, 2],
            output,
            component_type="iris",
            root_prim_name="Iris",
            mesh_parts=self.parts(),
            **kwargs,
        )
        stage = Usd.Stage.Open(str(output))
        return {
            prim.GetName(): (
                UsdGeom.Mesh(prim).GetDisplayColorAttr().Get()[0],
                UsdGeom.Mesh(prim).GetDisplayOpacityAttr().Get()[0],
            )
            for prim in stage.Traverse()
            if prim.IsA(UsdGeom.Mesh)
        }

    def test_a_broad_rule_repaints_every_mesh(self):
        meshes = self.write(
            mesh_color_rules=parse_part_colors(["CADMesh=0,0,0"]),
        )
        for name, (color, _) in meshes.items():
            with self.subTest(mesh=name):
                self.assertEqual(tuple(color), (0.0, 0.0, 0.0))

    def test_a_narrow_rule_listed_first_survives_the_broad_one(self):
        meshes = self.write(
            mesh_color_rules=parse_part_colors([
                "CADMesh_002=0.35,0.36,0.38",
                "CADMesh=0,0,0",
            ]),
            mesh_opacity_rules=parse_mesh_opacities(["CADMesh_002=0.2"]),
        )
        self.assertEqual(tuple(meshes["CADMesh_001"][0]), (0.0, 0.0, 0.0))
        self.assertEqual(meshes["CADMesh_001"][1], 1.0)
        # color3f is float32, so compare per channel rather than as a tuple.
        for channel, expected in zip(meshes["CADMesh_002"][0], (0.35, 0.36, 0.38)):
            self.assertAlmostEqual(channel, expected, places=6)
        self.assertAlmostEqual(meshes["CADMesh_002"][1], 0.2, places=6)

    def test_unmatched_meshes_keep_their_step_colors(self):
        meshes = self.write(
            mesh_color_rules=parse_part_colors(["CADMesh_002=0,0,1"]),
        )
        self.assertEqual(tuple(meshes["CADMesh_001"][0]), (1.0, 1.0, 1.0))

    def test_rejects_malformed_opacity_rules(self):
        for bad in ("noopacity", "x=", "x=abc", "=0.5", "x=1.5", "x=-0.1"):
            with self.subTest(rule=bad):
                with self.assertRaises(ValueError):
                    parse_mesh_opacities([bad])

    def test_opacity_rules_match_by_substring_first_wins(self):
        rules = parse_mesh_opacities(["CADMesh_004=0.2", "CADMesh=1"])
        self.assertEqual(match_mesh_rule("CADMesh_004", rules), 0.2)
        self.assertEqual(match_mesh_rule("CADMesh_001", rules), 1.0)
        self.assertIsNone(match_mesh_rule("Housing", rules))


if __name__ == "__main__":
    unittest.main()
