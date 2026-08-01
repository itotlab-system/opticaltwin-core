import unittest
import os

import beam_tracer
import server
from pxr import Gf, Usd, UsdGeom


def component(name, component_type, x, y=0, rot_z=0, rot_x=0, rot_y=0, **attrs):
    return {
        "name": name,
        "type": component_type,
        "x": x,
        "y": y,
        "z": 0,
        "rotX": rot_x,
        "rotY": rot_y,
        "rotZ": rot_z,
        "attrs": attrs,
    }


class BeamTracerTests(unittest.TestCase):
    def test_laser_emits_from_authored_aperture_center(self):
        laser = component("Laser", "laser", 10, y=20)
        laser["z"] = 30
        laser["physics"] = {
            "emissionOffset_mm": 100,
            "emissionCenterY_mm": -2,
            "emissionCenterZ_mm": 4,
        }
        segments = beam_tracer.trace_lasers([laser])

        self.assertEqual(segments[0]["pts"][0], [110.0, 18.0, 34.0])

    def test_y_rotation_tilts_laser_and_keeps_legacy_z_rotation(self):
        tilted = beam_tracer.trace_lasers([
            component("Laser", "laser", 0, rot_y=30),
        ])
        legacy = beam_tracer.trace_lasers([
            component("Laser", "laser", 0, rot_z=90),
        ])

        self.assertGreater(tilted[0]["pts"][1][0], 0)
        self.assertLess(tilted[0]["pts"][1][2], 0)
        self.assertAlmostEqual(legacy[0]["pts"][1][0], 0, places=6)
        self.assertGreater(legacy[0]["pts"][1][1], 0)
        self.assertAlmostEqual(legacy[0]["pts"][1][2], 0, places=6)

    def test_mirror_at_45_degrees_reflects_by_90_degrees(self):
        segments = beam_tracer.trace_lasers([
            component("Laser", "laser", 0),
            component(
                "Mirror", "mirror", 100, rot_z=45,
                diameter_mm=25.4, reflectivity=0.99,
            ),
        ])

        self.assertEqual(len(segments), 2)
        self.assertAlmostEqual(segments[0]["pts"][1][0], 95.757, places=3)
        self.assertAlmostEqual(
            segments[1]["pts"][1][0], segments[0]["pts"][1][0], places=2
        )
        self.assertLess(segments[1]["pts"][1][1], 0)
        self.assertEqual(segments[1]["intensity"], 0.99)

    def test_mirror_reflects_from_both_physical_faces(self):
        front = beam_tracer.trace_lasers([
            component("Laser", "laser", 0),
            component("Mirror", "mirror", 100, thickness_mm=6, diameter_mm=25.4),
        ])
        back = beam_tracer.trace_lasers([
            component("Laser", "laser", 200, rot_z=180),
            component("Mirror", "mirror", 100, thickness_mm=6, diameter_mm=25.4),
        ])

        self.assertEqual(front[0]["pts"][1], [97.0, 0.0, 0.0])
        self.assertEqual(back[0]["pts"][1], [103.0, 0.0, 0.0])
        self.assertLess(front[1]["pts"][1][0], 97.0)
        self.assertGreater(back[1]["pts"][1][0], 103.0)

    def test_beamsplitter_creates_straight_and_perpendicular_rays(self):
        segments = beam_tracer.trace_lasers([
            component("Laser", "laser", 0),
            component(
                "Splitter", "beamsplitter", 100,
                size_mm=25.4, splitRatio=0.5,
            ),
        ])

        self.assertEqual(len(segments), 3)
        self.assertGreater(segments[1]["pts"][1][0], 100)
        self.assertLess(segments[2]["pts"][1][1], 0)
        self.assertEqual(segments[1]["intensity"], 0.5)

    def test_beamsplitter_splits_a_y_directed_beam_at_180_degrees(self):
        segments = beam_tracer.trace_lasers([
            component("Laser", "laser", 0, y=0, rot_z=90),
            component(
                "Splitter", "beamsplitter", 0, y=100, rot_z=180,
                size_mm=25.4, splitRatio=0.5,
            ),
        ])

        self.assertEqual(len(segments), 3)
        self.assertEqual(segments[0]["pts"][1], [0.0, 100.0, 0.0])
        self.assertEqual(
            sorted(segment["intensity"] for segment in segments[1:]),
            [0.5, 0.5],
        )
        self.assertLess(segments[2]["pts"][1][0], 0.0)
        self.assertEqual(segments[2]["intensity"], 0.5)

    def test_transmissive_lens_continues_until_detector(self):
        segments = beam_tracer.trace_lasers([
            component("Laser", "laser", 0),
            component("Lens", "lens", 100, diameter_mm=25.4),
            component("Detector", "detector", 150, width_mm=12, height_mm=12),
        ])

        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0]["pts"][1], [100.0, 0.0, 0.0])
        self.assertEqual(segments[1]["pts"][1], [150.0, 0.0, 0.0])

    def test_opaque_detector_stops_the_ray(self):
        segments = beam_tracer.trace_lasers([
            component("Laser", "laser", 0),
            component("Detector", "detector", 100, width_mm=12, height_mm=12),
        ])

        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["pts"][1], [100.0, 0.0, 0.0])

    def test_iris_transmits_only_inside_its_aperture(self):
        open_path = beam_tracer.trace_lasers([
            component("Laser", "laser", 0),
            component("Iris", "iris", 100, aperture_mm=4, outerDiameter_mm=25.4),
            component("Detector", "detector", 150, width_mm=12, height_mm=12),
        ])
        blocked_path = beam_tracer.trace_lasers([
            component("Laser", "laser", 0, y=3),
            component("Iris", "iris", 100, aperture_mm=4, outerDiameter_mm=25.4),
            component("Detector", "detector", 150, width_mm=12, height_mm=12),
        ])

        self.assertEqual(len(open_path), 2)
        self.assertEqual(len(blocked_path), 1)

    def test_mount_transmits_through_openings_and_blocks_its_frame(self):
        mount_attrs = {
            "sizeX_mm": 12.7,
            "sizeY_mm": 71.12,
            "sizeZ_mm": 71.12,
            "beamApertureRadius_mm": 24.638,
            "rodHoleRadius_mm": 3.0099,
            "rodHoleOffsets_mm": "[[0,-30,-30],[0,-30,30],[0,30,-30],[0,30,30]]",
        }
        central = beam_tracer.trace_lasers([
            component("Laser", "laser", 0),
            component("Mount", "mount", 100, **mount_attrs),
            component("Detector", "detector", 150, width_mm=12, height_mm=12),
        ])
        rod_hole_laser = component("Laser", "laser", 0, y=30)
        rod_hole_laser["z"] = 30
        rod_hole_detector = component(
            "Detector", "detector", 150, y=30,
            width_mm=12, height_mm=12,
        )
        rod_hole_detector["z"] = 30
        rod_hole = beam_tracer.trace_lasers([
            rod_hole_laser,
            {**component("Mount", "mount", 100, y=0, **mount_attrs), "z": 0},
            rod_hole_detector,
        ])
        frame = beam_tracer.trace_lasers([
            component("Laser", "laser", 0, y=27),
            component("Mount", "mount", 100, **mount_attrs),
        ])

        self.assertEqual(central[-1]["pts"][1], [150.0, 0.0, 0.0])
        self.assertEqual(rod_hole[-1]["pts"][1], [150.0, 30.0, 30.0])
        self.assertEqual(len(frame), 1)
        self.assertAlmostEqual(frame[0]["pts"][1][0], 93.65, places=3)

    def test_asymmetric_mount_aperture_uses_optical_origin_from_both_sides(self):
        mount_attrs = {
            "centerZ_mm": -3.81,
            "sizeX_mm": 38.1,
            "sizeY_mm": 38.1,
            "sizeZ_mm": 45.72,
            "beamApertureRadius_mm": 12.7,
        }

        def laser_at(x, rotation):
            laser = component("Laser", "laser", x, rot_z=rotation)
            laser["z"] = 12
            return laser

        front_detector = component(
            "Detector", "detector", 160, width_mm=12, height_mm=12
        )
        front_detector["z"] = 12
        back_detector = component(
            "Detector", "detector", 40, width_mm=12, height_mm=12
        )
        back_detector["z"] = 12
        mount = component("Mount", "mount", 100, **mount_attrs)

        front = beam_tracer.trace_lasers([
            laser_at(0, 0),
            mount,
            front_detector,
        ])
        back = beam_tracer.trace_lasers([
            laser_at(200, 180),
            mount,
            back_detector,
        ])

        self.assertEqual(front[-1]["pts"][1], [160.0, 0.0, 12.0])
        self.assertEqual(back[-1]["pts"][1], [40.0, 0.0, 12.0])

    def test_mount_can_transmit_through_a_y_axis_aperture(self):
        mount_attrs = {
            "centerZ_mm": -3.81,
            "sizeX_mm": 38.1,
            "sizeY_mm": 38.1,
            "sizeZ_mm": 45.72,
            "beamApertureAxis": "Y",
            "beamApertureRadius_mm": 12.7,
        }
        laser = component("Laser", "laser", 0, y=-100, rot_z=90)
        reverse_laser = component("Laser", "laser", 0, y=100, rot_z=-90)
        mount = component("Mount", "mount", 0, **mount_attrs)

        front = beam_tracer.trace_lasers([laser, mount])
        back = beam_tracer.trace_lasers([reverse_laser, mount])

        self.assertEqual(len(front), 2)
        self.assertEqual(len(back), 2)
        self.assertGreater(front[-1]["pts"][1][1], 0)
        self.assertLess(back[-1]["pts"][1][1], 0)

    def test_component_can_be_excluded_from_beam_collision(self):
        mount = component(
            "CM1_DCH_M_Step", "mount", 100,
            sizeX_mm=38.1,
            sizeY_mm=38.1,
            sizeZ_mm=45.72,
            ignoreBeamCollision=True,
        )

        segments = beam_tracer.trace_lasers([
            component("Laser", "laser", 0),
            mount,
        ])

        self.assertEqual(len(segments), 1)
        self.assertGreater(segments[0]["pts"][1][0], 100)

    def test_slm_screen_reflects_but_housing_blocks(self):
        screen_hit = beam_tracer.trace_lasers([
            component("Laser", "laser", 0),
            component(
                "SLM", "slm", 100,
                activeWidth_mm=15.36, activeHeight_mm=9.22,
                reflective=True,
            ),
        ])
        housing_hit = beam_tracer.trace_lasers([
            component("Laser", "laser", 0, y=20),
            component(
                "SLM", "slm", 100,
                activeWidth_mm=15.36, activeHeight_mm=9.22,
                reflective=True,
            ),
        ])

        self.assertEqual(len(screen_hit), 2)
        self.assertEqual(screen_hit[0]["pts"][1], [114.0, 0.0, 0.0])
        self.assertEqual(len(housing_hit), 1)
        self.assertEqual(housing_hit[0]["pts"][1], [86.0, 20.0, 0.0])


class RealComponentIntegrationTests(unittest.TestCase):
    def _placed_components(self, placements, render_mode="lo"):
        # These cases reference real assets out of components/, which is
        # generated rather than checked in -- and the CAD-derived ones
        # (PL251, EXULUS-HD2HP, BSW10R ...) only exist once someone has
        # supplied the manufacturer STEP files and run cad_importer.py.
        # Skip rather than fail when they are absent, so the documented test
        # command passes on a fresh clone. A missing reference resolves to an
        # empty prim, which surfaces as a confusing IndexError further down.
        missing = sorted({
            asset for _, asset, *_ in placements
            if not os.path.exists(os.path.join(server.LIB_DIR, asset, "lo.usda"))
        })
        if missing:
            self.skipTest(
                "needs generated components: " + ", ".join(missing)
                + " (run setup_projects.py; CAD-derived parts also need cad_importer.py)"
            )

        stage = Usd.Stage.CreateInMemory()
        root = UsdGeom.Xform.Define(stage, "/Setup").GetPrim()
        stage.SetDefaultPrim(root)
        for name, asset, x, y, rotation in placements:
            prim = stage.DefinePrim(f"/Setup/{name}", "Xform")
            prim.GetReferences().AddReference(os.path.join(
                server.LIB_DIR, asset, "lo.usda"
            ))
            xform = UsdGeom.Xformable(prim)
            xform.AddTranslateOp().Set(Gf.Vec3d(x, y, 0))
            if rotation:
                xform.AddRotateZOp().Set(rotation)
        return server._project_components(stage, render_mode)

    def test_real_standard_laser_and_mirror_assets_reflect(self):
        components = self._placed_components([
            ("Laser", "Low_model/laser_fiber", 0, 0, 0),
            ("Mirror", "Low_model/mirror_1in", 100, 0, 45),
        ])

        segments = server._resolved_project_beam(
            None, {c["name"]: c for c in components}, []
        )
        self.assertEqual([c["type"] for c in components], ["laser", "mirror"])
        self.assertEqual(len(segments), 2)
        self.assertAlmostEqual(segments[0]["pts"][1][0], 95.757, places=3)
        self.assertLess(segments[1]["pts"][1][1], 0)

    def test_mirror_geometry_and_placement_origin_are_thickness_centered(self):
        standard = self._placed_components([
            ("Mirror", "Low_model/mirror_1in", 100, 0, 0),
        ])[0]
        cad_lo = self._placed_components([
            ("Mirror", "Mirror/BBSQ2-E02-Step", 100, 0, 0),
        ])[0]
        cad_hi = self._placed_components([
            ("Mirror", "Mirror/BBSQ2-E02-Step", 100, 0, 0),
        ], render_mode="hi")[0]

        self.assertEqual(standard["primitives"][0]["matrix"][12], 0.0)
        self.assertEqual(cad_lo["primitives"][0]["matrix"][12], 0.0)
        xs = [
            point[0]
            for mesh in cad_hi["meshes"]
            for point in mesh["points"]
        ]
        self.assertAlmostEqual(max(xs), 3.0, places=3)
        self.assertAlmostEqual(min(xs), -3.0, places=3)

    def test_real_cad_laser_uses_its_actual_output_face(self):
        components = self._placed_components([
            ("Laser", "Laser/NPL64A-Step", 0, 0, 0),
            ("Mirror", "Mirror/BBSQ2-E02-Step", 150, 0, 45),
        ])

        segments = beam_tracer.trace_lasers(components)
        self.assertAlmostEqual(
            components[0]["physics"]["emissionOffset_mm"], 58.006, places=3
        )
        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0]["pts"][0], [58.006, 0.0, 0.0])
        self.assertAlmostEqual(segments[0]["pts"][1][0], 145.757, places=3)

    def test_pl251_emits_from_its_cylindrical_head_center(self):
        laser = self._placed_components([
            ("Laser", "Laser/PL251-Step", 0, 0, 0),
        ])[0]
        segments = beam_tracer.trace_lasers([laser])

        self.assertAlmostEqual(
            laser["physics"]["emissionOffset_mm"], 112.180, places=3
        )
        self.assertAlmostEqual(
            laser["physics"]["emissionCenterY_mm"], 0.0, places=3
        )
        self.assertAlmostEqual(
            laser["physics"]["emissionCenterZ_mm"], 0.0, places=3
        )
        self.assertEqual(
            [round(value, 3) for value in segments[0]["pts"][0]],
            [112.180, 0.0, 0.0],
        )

    def test_real_cad_beamsplitter_asset_splits(self):
        components = self._placed_components([
            ("Laser", "Low_model/laser_fiber", 0, 0, 0),
            ("Splitter", "Beam Splitter/BSW10R-Step", 100, 0, 0),
        ])

        segments = beam_tracer.trace_lasers(components)
        self.assertEqual(components[1]["type"], "beamsplitter")
        self.assertEqual(components[1]["attrs"]["sizeY_mm"], 25.0)
        self.assertEqual(components[1]["attrs"]["sizeZ_mm"], 36.0)
        self.assertEqual(len(segments), 3)
        self.assertEqual(
            sorted(segment["intensity"] for segment in segments[1:]),
            [0.5, 0.5],
        )
        self.assertLess(segments[2]["pts"][1][1], 0)

    def test_real_cad_slm_screen_and_red_housing_are_distinct(self):
        screen_components = self._placed_components([
            ("Laser", "Low_model/laser_fiber", -100, 0, 0),
            ("SLM", "SLM/EXULUS-HD2HP-Step", 0, 0, 0),
        ])
        housing_components = self._placed_components([
            ("Laser", "Low_model/laser_fiber", -100, 30, 0),
            ("SLM", "SLM/EXULUS-HD2HP-Step", 0, 0, 0),
        ])

        screen_segments = beam_tracer.trace_lasers(screen_components)
        housing_segments = beam_tracer.trace_lasers(housing_components)
        self.assertEqual(len(screen_segments), 2)
        self.assertEqual(screen_segments[0]["pts"][1], [0.0, 0.0, 0.0])
        self.assertEqual(len(housing_segments), 1)
        self.assertLess(housing_segments[0]["pts"][1][0], 1.0)


if __name__ == "__main__":
    unittest.main()
