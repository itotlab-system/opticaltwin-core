"""One model per part: components/<Group>/<Model>/model.usda.

There used to be two levels of detail per part (hi.usda / lo.usda) and the
generated parts lived in Low_model/. Projects saved then must still open, so
their references are rewritten on open; and the one model must carry what the
beam tracer used to read from the lo file.
"""

import importlib.util

import pytest
from pxr import Usd

from opticaltwin import beam_tracer
from opticaltwin import usd_utility as uu

requires_ocp = pytest.mark.skipif(
    importlib.util.find_spec("OCP") is None, reason="requires cadquery-ocp"
)


@pytest.mark.parametrize("legacy, current", [
    ("@../../components/Lens/LA1417-AB-Step/lo.usda@",
     "@../../components/Lens/LA1417-AB-Step/model.usda@"),
    ("@../../components/Lens/LA1417-AB-Step/hi.usda@",
     "@../../components/Lens/LA1417-AB-Step/model.usda@"),
    # Group folders can contain spaces.
    ("@../../components/Beam Splitter/BS013-Step/lo.usda@",
     "@../../components/Beam Splitter/BS013-Step/model.usda@"),
    ("@../../components/Low_model/lens_f100/lo.usda@",
     "@../../components/Generic/lens_f100/model.usda@"),
    # The flat layout from before per-component folders.
    ("@../components/lens_f100.usda@",
     "@../components/lens_f100/model.usda@"),
])
def test_legacy_references_are_rewritten_on_open(tmp_path, legacy, current):
    layer = tmp_path / "setup.usda"
    layer.write_text(f"#usda 1.0\nover \"Part\" (\n    references = {legacy}\n)\n{{\n}}\n")

    assert uu.normalize_component_references_in_usda(str(layer)) is True
    assert current in layer.read_text()
    # Already current: a second open leaves the file alone.
    assert uu.normalize_component_references_in_usda(str(layer)) is False


def test_asset_ids_resolve_to_the_one_model():
    assert uu.get_component_usda_path("/c", "Lens/LA1417-AB-Step.usda") == (
        "/c/Lens/LA1417-AB-Step/model.usda"
    )
    # An old id still finds the part where it lives now.
    assert uu.get_component_name("Low_model/lens_f100.usda") == "Generic/lens_f100"
    assert uu.get_component_name("Lens/X/lo.usda") == "Lens/X"


def test_generated_parts_are_written_to_the_generic_group(tmp_path):
    from opticaltwin import optics_lib

    optics_lib.build_component_library(str(tmp_path))

    model = tmp_path / "Generic" / "lens_f100" / "model.usda"
    assert model.is_file()
    assert not list(tmp_path.rglob("lo.usda")) and not list(tmp_path.rglob("hi.usda"))
    # Generic parts are not CAD-derived, even though they now share the layout.
    assert optics_lib.cad_library_assets(str(tmp_path)) == set()
    stage = Usd.Stage.Open(str(model))
    assert stage.GetDefaultPrim().GetAttribute("optics:type").Get() == "lens"


@requires_ocp
def test_importer_measures_the_envelope_and_keeps_authored_values():
    from opticaltwin.cad_importer import measured_envelope_attrs

    attrs = measured_envelope_attrs(
        (-2.0, -10.0, -5.0), (2.0, 10.0, 5.0),
        component_type="lens", rod=False,
        optics_attrs={"diameter_mm": 25.4},
    )
    assert attrs["sizeX_mm"] == 4.0 and attrs["sizeY_mm"] == 20.0
    assert attrs["centerX_mm"] == 0.0
    assert attrs["thickness_mm"] == 4.0
    # An authored value wins over the measured one.
    assert "diameter_mm" not in attrs


def _mount(model_rotation):
    """A 100 x 10 x 10 mm envelope, long along the model's own Y."""
    return {
        "name": "Mount", "type": "mount",
        "x": 0.0, "y": 0.0, "z": 0.0, "rotX": 0.0, "rotY": 0.0, "rotZ": 0.0,
        "modelRotation": model_rotation, "rotationCenter": [0.0, 0.0, 0.0],
        "attrs": {
            "sizeX_mm": 10.0, "sizeY_mm": 100.0, "sizeZ_mm": 10.0,
            "centerX_mm": 0.0, "centerY_mm": 0.0, "centerZ_mm": 0.0,
        },
    }


def test_envelope_box_follows_the_model_rotation():
    """The envelope is measured in the model's frame, before its root rotation.

    Turned 90 degrees about X, a mount long along its own Y stands along Z: a
    beam passing 30 mm beside it in Y must not be stopped by the unrotated box.
    """
    origin, direction = [-50.0, 30.0, 0.0], [1.0, 0.0, 0.0]

    assert beam_tracer._model_box_hit(origin, direction, _mount([0.0, 0.0, 0.0]))
    assert beam_tracer._model_box_hit(origin, direction, _mount([90.0, 0.0, 0.0])) is None
    # ... and the same beam 30 mm up in Z now meets it.
    assert beam_tracer._model_box_hit(
        [-50.0, 0.0, 30.0], direction, _mount([90.0, 0.0, 0.0])
    )


def test_missing_generated_parts_are_rebuilt_on_load(tmp_path, monkeypatch):
    """A library from before Generic/ existed heals itself on the next open."""
    from backend import catalog, config

    monkeypatch.setattr(config, "LIB_DIR", str(tmp_path))
    catalog._ensure_generic_library()

    assert (tmp_path / "Generic" / "lens_f100" / "model.usda").is_file()
