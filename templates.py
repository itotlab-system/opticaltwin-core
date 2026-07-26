"""
templates.py  --  named optical-setup recipes
----------------------------------------------
Each recipe builds a setup into an existing (stage, root) using a `ref` callable
that maps a component filename -> a path RELATIVE to the setup file (so the saved
.usda stays portable). Recipes only place References + transforms + a beam; the
component geometry lives in components/<component>/lo.usda (see
optics_lib.build_component_library).

A recipe is the *starting point* for a project. Teams then edit positions in the
web editor; USD remains the source of truth.
"""

import optics_lib as ol


def blank_bench(stage, root, ref):
    """Just a breadboard -- an empty bench to build on."""
    ol.add_breadboard(stage, root, nx=24, ny=14, x0=-100.0, y0=-150.0)


def two_lens(stage, root, ref):
    """Minimal linear demo: two lenses, a fold mirror, a detector."""
    ol.add_breadboard(stage, root, nx=16, ny=12, x0=0.0, y0=-150.0)
    ol.place(stage, root, "Lens_01",   ref("lens_f100.usda"),  50, 0)
    ol.place(stage, root, "Lens_02",   ref("lens_f100.usda"), 150, 0)
    ol.place(stage, root, "FoldMirror", ref("mirror_1in.usda"), 225, 0, rotate_z_deg=45)
    ol.place(stage, root, "Detector",  ref("detector.usda"),  300, 0)
    ol.add_beam(stage, root, [[(0, 0, 0), (50, 0, 0), (150, 0, 0), (300, 0, 0)]], wavelength_nm=532.0)
    # straight beam from the first optic to the detector (lenses are pass-through)
    ol.set_beam_path(stage, root, [["Lens_01", "Detector"]])


def slm_imaging(stage, root, ref):
    """The lab's reflective-SLM holographic imaging system (folded beam)."""
    ol.add_breadboard(stage, root, nx=28, ny=14, x0=-150.0, y0=-250.0)

    ol.place(stage, root, "Beamsplitter", ref("beamsplitter_cube.usda"), 0, 0)
    # input arm on -Y (optics rotated 90deg)
    ol.place(stage, root, "Laser",      ref("laser_fiber.usda"),      0, -200, rotate_z_deg=90)
    ol.place(stage, root, "Polarizer",  ref("polarizer.usda"),        0, -125, rotate_z_deg=90)
    ol.place(stage, root, "CollimLens", ref("lens_collimating.usda"), 0,  -50, rotate_z_deg=90)
    # SLM on -X, reflective face toward the cube
    ol.place(stage, root, "SLM",        ref("slm.usda"),            -75, 0)
    # imaging arm on +X
    ol.place(stage, root, "ImagingLens",   ref("lens_imaging.usda"),     125, 0)
    ol.place(stage, root, "FourierFilter", ref("iris_fourier.usda"),     200, 0)
    ol.place(stage, root, "CylLens",       ref("lens_cylindrical.usda"), 275, 0)
    ol.place(stage, root, "Eyepiece",      ref("eyepiece.usda"),         350, 0)
    ol.place(stage, root, "Camera",        ref("camera.usda"),           475, 0)

    ol.add_beam(stage, root, [
        [(0, -200, 0), (0, -125, 0), (0, -50, 0), (0, 0, 0), (-75, 0, 0)],
        [(-75, 0, 0), (0, 0, 0), (125, 0, 0), (200, 0, 0),
         (275, 0, 0), (350, 0, 0), (475, 0, 0)],
    ], color=(0.1, 0.9, 0.1), wavelength_nm=532.0)
    # Beam path = ANCHORS only: source (laser), direction-changers, sink. The
    # straight segments between them pass *through* the pass-through optics
    # (polarizer/lenses/iris/eyepiece) without bending. The cube is a
    # direction-changer in both arms -> the geometric fold at the beamsplitter.
    ol.set_beam_path(stage, root, [
        ["Laser", "Beamsplitter", "SLM"],
        ["SLM", "Beamsplitter", "Camera"],
    ])


# name -> (recipe, human label)
TEMPLATES = {
    "slm_imaging": (slm_imaging, "SLM holographic imaging"),
    "two_lens":    (two_lens,    "Two-lens demo bench"),
    "blank":       (blank_bench, "Blank breadboard"),
}
