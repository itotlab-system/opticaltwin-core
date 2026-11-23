"""A STEP file that cannot be converted must not take the app down with it.

The catalogue sync runs on every project load and converts whatever is new in
cad/. A single unreadable file (a truncated download, a .step that is really an
HTML error page) used to raise out of the sync, so every project answered 500
until someone found the file -- and the only clue was a traceback in the
server's terminal.
"""

import sys
import types

import pytest

import opticaltwin
import server
import setup_projects
from backend import catalog, config
from opticaltwin import optics_lib as ol


@pytest.fixture
def fake_importer(monkeypatch):
    """Stands in for opticaltwin.cad_importer; fails on files named Broken*."""
    calls = []

    def main(argv):
        step_path = argv[0]
        calls.append(step_path)
        if "Broken" in step_path:
            raise RuntimeError("the file could not be read as a STEP model")

    module = types.ModuleType("opticaltwin.cad_importer")
    module.main = main
    monkeypatch.setitem(sys.modules, "opticaltwin.cad_importer", module)
    monkeypatch.setattr(opticaltwin, "cad_importer", module, raising=False)
    monkeypatch.setattr(catalog, "_FAILED_CONVERSIONS", {})
    return calls


@pytest.fixture
def cad_tree(tmp_path, monkeypatch):
    mirror = tmp_path / "cad" / "Mirror"
    mirror.mkdir(parents=True)
    (mirror / "Broken-Step.step").write_text("not a STEP file\n")
    (mirror / "Good-Step.step").write_text("ISO-10303-21;\n")
    monkeypatch.setattr(config, "ROOT_DIR", str(tmp_path))
    monkeypatch.setattr(config, "LIB_DIR", str(tmp_path / "components"))
    return mirror


def test_one_bad_file_does_not_stop_the_others(fake_importer, cad_tree, capsys):
    catalog._sync_cad_catalog_group(str(cad_tree), "Mirror", "mirror", "AUTO")

    assert [p.rsplit("/", 1)[-1] for p in fake_importer] == [
        "Broken-Step.step", "Good-Step.step",
    ]
    out = capsys.readouterr().out
    assert "Could not convert" in out
    assert "Broken-Step.step" in out
    assert "cad/" in out and "move it out" in out


def test_a_failed_file_is_not_retried_on_every_load(fake_importer, cad_tree, capsys):
    catalog._sync_cad_catalog_group(str(cad_tree), "Mirror", "mirror", "AUTO")
    capsys.readouterr()
    fake_importer.clear()

    catalog._sync_cad_catalog_group(str(cad_tree), "Mirror", "mirror", "AUTO")

    assert not any("Broken" in p for p in fake_importer)
    assert capsys.readouterr().out == "", "reported once, not on every load"


def test_a_replaced_file_is_tried_again(fake_importer, cad_tree):
    import os

    catalog._sync_cad_catalog_group(str(cad_tree), "Mirror", "mirror", "AUTO")
    fake_importer.clear()
    broken = cad_tree / "Broken-Step.step"
    broken.write_text("a fresh download\n")
    later = os.path.getmtime(broken) + 10
    os.utime(broken, (later, later))

    catalog._sync_cad_catalog_group(str(cad_tree), "Mirror", "mirror", "AUTO")

    assert any("Broken" in p for p in fake_importer)


def test_projects_still_open_with_a_bad_file_in_cad(
    fake_importer, cad_tree, tmp_path, monkeypatch
):
    lib_dir = tmp_path / "components"
    projects_dir = tmp_path / "projects"
    projects_dir.mkdir()
    ol.build_component_library(str(lib_dir))
    monkeypatch.setattr(setup_projects, "LIB_DIR", str(lib_dir))
    monkeypatch.setattr(config, "PROJECTS_DIR", str(projects_dir))
    monkeypatch.setattr(setup_projects, "PROJECTS_DIR", str(projects_dir))
    setup_projects.create_project("example", "slm_imaging")
    server.app.config["TESTING"] = True

    with server.app.test_client() as client:
        response = client.get("/api/projects/example")

    assert response.status_code == 200
