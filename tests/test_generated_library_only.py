"""The app must work with the generated parts library alone.

A public checkout has no manufacturer CAD: `components/` holds only what
`setup_projects.py` generates. The lab's own tree always has the CAD catalogue
beside it, so anything that quietly assumes a CAD part exists passes every
other test here and breaks for everyone outside the lab.
"""

import math

import pytest

from opticaltwin import optics_lib as ol
import server
import setup_projects
from backend import catalog, config


@pytest.fixture
def generated_only(tmp_path, monkeypatch):
    """A tree laid out like a fresh public checkout after setup_projects.py."""
    lib_dir = tmp_path / "components"
    projects_dir = tmp_path / "projects"
    projects_dir.mkdir()
    ol.build_component_library(str(lib_dir))
    monkeypatch.setattr(config, "LIB_DIR", str(lib_dir))
    monkeypatch.setattr(setup_projects, "LIB_DIR", str(lib_dir))
    monkeypatch.setattr(config, "PROJECTS_DIR", str(projects_dir))
    monkeypatch.setattr(setup_projects, "PROJECTS_DIR", str(projects_dir))
    # There is no cad/ to convert; the sync would look at the lab's real one.
    monkeypatch.setattr(catalog, "_sync_cad_catalog", lambda: None)
    server.app.config["TESTING"] = True
    with server.app.test_client() as client:
        yield client


def _board_size(payload):
    """Board width and depth in mm; NaN-free only when the board has geometry."""
    bbox = payload["board"]["bbox"]
    return (
        bbox["max"][0] - bbox["min"][0],
        bbox["max"][1] - bbox["min"][1],
    )


def _assert_board_is_drawable(payload):
    width, depth = _board_size(payload)
    # An unresolved board reports an empty box, max = -FLT_MAX: the viewport
    # frames that and shows nothing at all.
    assert math.isfinite(width) and math.isfinite(depth)
    assert width > 100 and depth > 100


def test_example_project_keeps_its_board_when_opened(generated_only):
    setup_projects.create_project("example", "slm_imaging")

    payload = generated_only.get("/api/projects/example").get_json()

    _assert_board_is_drawable(payload)
    # Opening it a second time reads what the first open left on disk.
    again = generated_only.get("/api/projects/example").get_json()
    _assert_board_is_drawable(again)


def test_new_blank_project_has_a_board(generated_only):
    created = generated_only.post(
        "/api/projects", json={"name": "fresh", "template": "blank"}
    )
    assert created.status_code == 200

    payload = generated_only.get("/api/projects/fresh").get_json()

    _assert_board_is_drawable(payload)


def test_step_file_without_the_converter_does_not_break_projects(
    tmp_path, monkeypatch, capsys
):
    """A STEP saved into cad/ before `cadquery-ocp` is installed.

    `tools/fetch_cad.py` puts files there, and the converter is an optional
    install, so this order is the likely one. The catalogue sync runs on every
    project load: failing there took every project down with it.
    """
    import builtins
    import sys

    import opticaltwin

    cad_dir = tmp_path / "cad" / "Lens"
    cad_dir.mkdir(parents=True)
    (cad_dir / "MyLens.step").write_text("ISO-10303-21;\n")
    monkeypatch.setattr(config, "LIB_DIR", str(tmp_path / "components"))
    # As on a machine where OCP was never installed. Refusing the import
    # itself, because another test may already have loaded the real package.
    real_import = builtins.__import__

    def import_without_ocp(name, *args, **kwargs):
        if name.split(".")[0] == "OCP":
            raise ModuleNotFoundError("No module named 'OCP'", name="OCP")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", import_without_ocp)
    monkeypatch.delitem(sys.modules, "opticaltwin.cad_importer", raising=False)
    monkeypatch.delattr(opticaltwin, "cad_importer", raising=False)

    catalog._sync_cad_catalog_group(str(cad_dir), "Lens", "lens", "AUTO")

    assert "requirements-cad.txt" in capsys.readouterr().out


def test_every_generated_part_is_drawn(generated_only):
    """Generated parts have one model each, and every one of them is drawn.

    A public checkout has no CAD at all; a part that silently drew nothing
    would leave the bench empty, with the beam still traced through it.
    """
    setup_projects.create_project("example", "slm_imaging")

    scene = generated_only.get("/api/projects/example").get_json()

    drawn = {
        c["name"] for c in scene["components"]
        if c.get("primitives") or c.get("meshes")
    }
    assert drawn == {c["name"] for c in scene["components"]}
    assert len(drawn) == 10


def test_a_new_design_can_start_from_the_generated_laser(generated_only):
    """Designing from a laser is the main way in; it must not need CAD.

    The picker only looked in the CAD `Laser/` folder, so a public checkout,
    which has a perfectly good generated laser, was never offered it.
    """
    listing = generated_only.get("/api/projects").get_json()
    assert "from_laser" in [t["key"] for t in listing["templates"]]
    [laser] = listing["lasers"]
    assert laser["wavelength_nm"] == 532
    assert laser["color"] == "green"

    created = generated_only.post("/api/projects", json={
        "name": "beam_first", "template": "from_laser",
        "laser": laser["asset"], "beamHeight": 75,
    })
    assert created.status_code == 200

    payload = generated_only.get("/api/projects/beam_first").get_json()
    [source] = payload["components"]
    assert source["type"] == "laser"
    assert payload["beam"], "the laser emits along the board"
    board = payload["board"]["bbox"]
    # The whole 80 mm body stands on the board, not half of it off the edge.
    assert source["x"] - 80 / 2 >= board["min"][0]
    assert source["x"] <= board["max"][0]
