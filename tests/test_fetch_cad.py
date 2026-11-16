"""tools/fetch_cad.py tells a newcomer what to download by hand, and where.

The manifest ships no direct links, so the script's whole job is the manual
instructions: which page to open, what path to save to, and whether the server
will convert that folder by itself.
"""

import importlib.util
import os

import pytest

from backend import catalog

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture
def fetch_cad(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location(
        "fetch_cad", os.path.join(ROOT, "tools", "fetch_cad.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "CAD_DIR", str(tmp_path / "cad"))
    return module


def _part(name, target):
    return {
        "part": name,
        "type": "lens",
        "target": target,
        "product_page": f"https://vendor.example/{name}",
    }


def test_the_script_knows_the_same_folders_the_server_converts(fetch_cad):
    assert fetch_cad.AUTO_FOLDERS == {folder for folder, _, _ in catalog.CAD_GROUPS}


def test_a_missing_part_says_which_page_to_open_and_where_to_save(fetch_cad, capsys):
    fetch_cad.cmd_list([_part("LA1417-AB", "Lens/LA1417-AB-Step.step")])

    out = capsys.readouterr().out
    assert "https://vendor.example/LA1417-AB" in out
    assert "cad/Lens/LA1417-AB-Step.step" in out
    assert "convert" not in out.split("Then,")[0], "Lens converts by itself"
    assert "docs/cad-models.md" in out


def test_a_folder_the_server_skips_is_flagged(fetch_cad, capsys):
    fetch_cad.cmd_list([_part("R1L1S7P", "Target/R1L1S7P-Step.step")])

    assert "by hand" in capsys.readouterr().out


def test_nothing_is_downloaded_without_a_step_url(fetch_cad, capsys, monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("no network access expected")

    monkeypatch.setattr(fetch_cad, "download", refuse)

    status = fetch_cad.cmd_fetch([_part("LA1417-AB", "Lens/LA1417-AB-Step.step")])

    assert status == 0
    assert "save as   cad/Lens/LA1417-AB-Step.step" in capsys.readouterr().out
