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
        split_rod_hi_parts,
        write_lo_primitives,
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


if __name__ == "__main__":
    unittest.main()
