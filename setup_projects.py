"""
setup_projects.py  --  scaffold per-team project folders
---------------------------------------------------------
Creates projects/<name>/setup.usda from a template recipe. Each project is an
independent setup that References the shared components/ library; teams edit
their own setup in the web editor and sync via git.

Run:  python setup_projects.py            # create the default project(s)
      python setup_projects.py myproj slm_imaging   # one project from a template
"""

import os
import shutil
import sys
import optics_lib as ol
import templates as tpl
import usd_utility as uu

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
LIB_DIR = os.path.join(ROOT_DIR, "components")
PROJECTS_DIR = os.path.join(ROOT_DIR, "projects")
# Starting-point setups a new project can be copied from. Deliberately NOT
# `templates/`, which would shadow templates.py on import.
PROJECT_TEMPLATES_DIR = os.path.join(ROOT_DIR, "project_templates")

DEFAULT_PROJECTS = [
    ("project1", "slm_imaging"),
]

# Templates built by copying a stored setup.usda rather than replaying a Python
# recipe -- a new project starts from a real, hand-tuned bench with no stale
# baked-in beam path, which the original recipes drifted away from (see #88).
#
# The stored setups live in project_templates/, NOT in projects/. This used to
# clone `projects/project1`, and lab members renamed that project away through
# the app on 2026-08-03: the template then pointed at nothing, and creating a
# project from it failed. A template is not somebody's live bench -- it must not
# change under new projects, or vanish when its source is renamed.
#
# project_templates/<t>/ and projects/<name>/ sit at the same depth, so the
# stored setup's relative `../../components/...` references resolve unchanged in
# the copy. Refresh a template by copying a project's setup.usda over it.
CLONE_TEMPLATES = {
    "4f_default": ("4f_default", "4f imaging system (default)"),
}


def clone_source_path(template):
    """The setup.usda a clone template copies, or None if it isn't one."""
    entry = CLONE_TEMPLATES.get(template)
    if entry is None:
        return None
    return os.path.join(PROJECT_TEMPLATES_DIR, entry[0], "setup.usda")


def _create_project_from_clone(name, template, source_name, label,
                               overwrite=False):
    proj_dir = os.path.join(PROJECTS_DIR, name)
    setup_path = os.path.join(proj_dir, "setup.usda")
    if os.path.exists(setup_path) and not overwrite:
        print(f"  skip {name}: setup.usda exists (use overwrite to rebuild)")
        return setup_path
    source_path = clone_source_path(template)
    if not os.path.exists(source_path):
        # FileNotFoundError, not SystemExit: this runs inside a Flask request as
        # well as from the CLI, and SystemExit is a BaseException — Werkzeug
        # does not catch it, so the worker died and the browser got an empty
        # reply instead of an error it could show.
        raise FileNotFoundError(
            f"Template setup '{source_name}' not found at {source_path}."
        )
    os.makedirs(proj_dir, exist_ok=True)
    shutil.copyfile(source_path, setup_path)

    notes = os.path.join(proj_dir, "notes.md")
    if not os.path.exists(notes):
        with open(notes, "w") as f:
            f.write(f"# {name}\n\nTemplate: {label} (`{source_name}`)\n\n"
                    "Discussion / decisions for this setup:\n\n- \n")
    print(f"  built {name}: {setup_path}  ({label}, from {source_path})")
    return setup_path


def duplicate_project(source_name, name, projects_dir=None, overwrite=False):
    """Copy a whole project folder to a new name (#155).

    Everything comes along -- setup.usda, notes.md, anything else a team put
    in the folder. Safe for the same reason CLONE_TEMPLATES is: source and
    copy sit at the same depth, so the relative `../../components/...`
    references in setup.usda resolve unchanged.

    `projects_dir` overrides PROJECTS_DIR so callers (the server, tests) can
    point at their own tree.
    """
    projects_dir = projects_dir or PROJECTS_DIR
    source_dir = os.path.join(projects_dir, source_name)
    if not os.path.exists(os.path.join(source_dir, "setup.usda")):
        raise FileNotFoundError(f"Project '{source_name}' not found.")
    proj_dir = os.path.join(projects_dir, name)
    setup_path = os.path.join(proj_dir, "setup.usda")
    if os.path.exists(setup_path) and not overwrite:
        raise FileExistsError(f"Project '{name}' already exists.")
    shutil.copytree(source_dir, proj_dir, dirs_exist_ok=True)
    print(f"  copied {source_name} -> {name}: {setup_path}")
    return setup_path


def create_project(name, template, overwrite=False):
    if template in CLONE_TEMPLATES:
        source_name, label = CLONE_TEMPLATES[template]
        return _create_project_from_clone(name, template, source_name, label,
                                          overwrite)
    if template not in tpl.TEMPLATES:
        raise ValueError(f"Unknown template '{template}'. "
                         f"Choose from: {', '.join(list(tpl.TEMPLATES) + list(CLONE_TEMPLATES))}")
    proj_dir = os.path.join(PROJECTS_DIR, name)
    setup_path = os.path.join(proj_dir, "setup.usda")
    if os.path.exists(setup_path) and not overwrite:
        print(f"  skip {name}: setup.usda exists (use overwrite to rebuild)")
        return setup_path
    os.makedirs(proj_dir, exist_ok=True)

    def ref(asset):
        return uu.get_relative_component_usda_path(LIB_DIR, asset, proj_dir)

    if os.path.exists(setup_path):
        os.remove(setup_path)
    stage, root = ol.new_setup_stage(setup_path, "Setup")
    recipe, label = tpl.TEMPLATES[template]
    recipe(stage, root, ref)
    stage.GetRootLayer().Save()
    uu.normalize_component_references_in_usda(setup_path)

    notes = os.path.join(proj_dir, "notes.md")
    if not os.path.exists(notes):
        with open(notes, "w") as f:
            f.write(f"# {name}\n\nTemplate: {label} (`{template}`)\n\n"
                    "Discussion / decisions for this setup:\n\n- \n")
    print(f"  built {name}: {setup_path}  ({label})")
    return setup_path


def main(argv):
    print("Generating component library -> components/")
    ol.build_component_library(LIB_DIR)
    print("Scaffolding projects -> projects/")
    # create_project raises rather than exiting, so that the server can turn a
    # bad request into a response. The CLI is where exiting belongs.
    try:
        if len(argv) >= 3:
            create_project(argv[1], argv[2], overwrite=True)
        else:
            for name, template in DEFAULT_PROJECTS:
                create_project(name, template)
    except (FileNotFoundError, ValueError) as exc:
        raise SystemExit(str(exc))


if __name__ == "__main__":
    main(sys.argv)
