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

DEFAULT_PROJECTS = [
    ("project1", "slm_imaging"),
]

# Templates built by copying an existing project's *current* setup.usda,
# rather than a Python recipe -- lets new projects start from whatever a
# reference project actually looks like today (hand-tuned positions, no
# stale baked-in beam path) instead of the original template recipe, which
# can drift out of sync with fixes applied directly to the reference
# project (see #88). Copying is safe here because projects/<source>/ and
# projects/<name>/ sit at the same depth, so the source's relative
# `../../components/...` references resolve unchanged in the copy.
CLONE_TEMPLATES = {
    "4f_default": ("project1", "4f imaging system (default)"),
}


def _create_project_from_clone(name, source_name, label, overwrite=False):
    proj_dir = os.path.join(PROJECTS_DIR, name)
    setup_path = os.path.join(proj_dir, "setup.usda")
    if os.path.exists(setup_path) and not overwrite:
        print(f"  skip {name}: setup.usda exists (use overwrite to rebuild)")
        return setup_path
    source_path = os.path.join(PROJECTS_DIR, source_name, "setup.usda")
    if not os.path.exists(source_path):
        raise SystemExit(f"Clone source project '{source_name}' not found.")
    os.makedirs(proj_dir, exist_ok=True)
    shutil.copyfile(source_path, setup_path)

    notes = os.path.join(proj_dir, "notes.md")
    if not os.path.exists(notes):
        with open(notes, "w") as f:
            f.write(f"# {name}\n\nTemplate: {label} (cloned from `{source_name}`)\n\n"
                    "Discussion / decisions for this setup:\n\n- \n")
    print(f"  built {name}: {setup_path}  ({label}, cloned from {source_name})")
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
        return _create_project_from_clone(name, source_name, label, overwrite)
    if template not in tpl.TEMPLATES:
        raise SystemExit(f"Unknown template '{template}'. "
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
    if len(argv) >= 3:
        create_project(argv[1], argv[2], overwrite=True)
    else:
        for name, template in DEFAULT_PROJECTS:
            create_project(name, template)


if __name__ == "__main__":
    main(sys.argv)
