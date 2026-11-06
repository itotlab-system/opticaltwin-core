"""Shared safety net for the backend tests.

Every test starts with the backend pointed at a throwaway projects/ and build
folder, no login, and an empty undo history. A test file's own fixture may
repoint these again (most do, to keep a handle on the folder); what this
guarantees is that a test which forgets cannot write into the lab's real
projects/ or web/_build/.

The catalogue (config.LIB_DIR) is deliberately left on the real components/:
many tests place real parts. A copied setup's relative `../../components/...`
references therefore need a components/ beside the throwaway projects/, so it
is linked in.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server  # noqa: E402
from backend import history  # noqa: E402
import setup_projects  # noqa: E402
from backend import config  # noqa: E402


@pytest.fixture(autouse=True)
def isolated_backend(tmp_path_factory, monkeypatch):
    root = tmp_path_factory.mktemp("backend")
    projects_dir = root / "projects"
    build_dir = root / "_build"
    projects_dir.mkdir()
    build_dir.mkdir()
    (root / "components").symlink_to(config.LIB_DIR)
    monkeypatch.setattr(config, "PROJECTS_DIR", str(projects_dir))
    # setup_projects keeps its own copy and writes new projects there, so the
    # two must move together: patching only config created projects in the
    # real tree that the server then could not find.
    monkeypatch.setattr(setup_projects, "PROJECTS_DIR", str(projects_dir))
    monkeypatch.setattr(config, "BUILD_DIR", str(build_dir))
    monkeypatch.setattr(config, "AUTH_PASSWORD", "")
    monkeypatch.setattr(history, "_HISTORY", {})
