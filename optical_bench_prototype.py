"""
optical_bench_prototype.py  --  minimal Phase 0 demo (thin caller of optics_lib)
--------------------------------------------------------------------------------
The original Phase 0 proof: a breadboard, a few components referenced from the
library, and a straight planning beam. Kept as the smallest possible example of
the data model. The component-generation logic now lives in optics_lib.py; this
script is just a thin caller.

For the real lab setup see slm_imaging_setup.py.

Run:  python optical_bench_prototype.py
Out:  components/<component>/lo.usda, setups/optical_bench.usda
"""

import os
import optics_lib as ol
import usd_utility as uu

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
LIB_DIR = os.path.join(ROOT_DIR, "components")
SETUPS_DIR = os.path.join(ROOT_DIR, "setups")
os.makedirs(LIB_DIR, exist_ok=True)
os.makedirs(SETUPS_DIR, exist_ok=True)


def asset(name):
    return uu.get_component_usda_path(LIB_DIR, name)


def regen(path, fn, *args, **kw):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        os.remove(path)
    fn(path, *args, **kw)


# Library assets used by this demo.
regen(asset("lens_f100.usda"), ol.make_lens, focal_length_mm=100.0)
regen(asset("mirror_1in.usda"), ol.make_mirror)
regen(asset("detector.usda"), ol.make_detector)

# Assemble a simple linear setup.
setup_path = os.path.join(SETUPS_DIR, "optical_bench.usda")
if os.path.exists(setup_path):
    os.remove(setup_path)
stage, root = ol.new_setup_stage(setup_path, "OpticalBench")

# 12 x 12 holes on the 25 mm grid, origin at (0, -150) so the beam axis (Y=0)
# and the placements below land on holes.
ol.add_breadboard(stage, root, nx=14, ny=12, x0=0.0, y0=-150.0)


def ref(name):
    return uu.get_relative_component_usda_path(LIB_DIR, name, SETUPS_DIR)


ol.place(stage, root, "Lens_01",   ref("lens_f100.usda"),  50, 0)
ol.place(stage, root, "Lens_02",   ref("lens_f100.usda"), 150, 0)   # same asset reused
ol.place(stage, root, "Detector",  ref("detector.usda"),  300, 0)
ol.place(stage, root, "FoldMirror", ref("mirror_1in.usda"), 225, 0, rotate_z_deg=45)

ol.add_beam(stage, root, [[(0, 0, 0), (50, 0, 0), (150, 0, 0), (300, 0, 0)]])

stage.GetRootLayer().Save()

ol.summarize(setup_path)
print(f"\nWrote {setup_path}")
