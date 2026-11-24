"""Keeping CAD-derived catalogue assets in step with the STEP files in cad/."""

import os
import threading

from opticaltwin import optics_lib as ol
from opticaltwin import usd_utility as uu

from backend import config

_CAD_CATALOG_SYNC_LOCK = threading.Lock()

# The sync runs on every project load; say this once per folder, not each time.
_MISSING_CONVERTER_REPORTED = set()


def _report_missing_converter(step_count, cad_directory):
    if cad_directory in _MISSING_CONVERTER_REPORTED:
        return
    _MISSING_CONVERTER_REPORTED.add(cad_directory)
    print(
        f"  {step_count} STEP file(s) in {cad_directory} are not converted: "
        "the CAD converter is not installed. Run `pip install -r requirements-cad.txt` "
        "and restart the server."
    )


# STEP files that failed to convert: path -> the mtime of the version that
# failed. A failure is reported once and not retried on every project load;
# saving a new file over it (a later mtime) makes it eligible again.
_FAILED_CONVERSIONS = {}


def _report_failed_conversion(step_path, exc):
    shown = os.path.relpath(step_path, config.ROOT_DIR).replace(os.sep, "/")
    print(
        f"  Could not convert {shown}: {exc}\n"
        "  The file may be an incomplete download or not a STEP model. Download it\n"
        "  again, or move it out of cad/ (see docs/cad-models.md). Other parts and\n"
        "  projects are not affected."
    )

# cad/Mount parts whose STEP has no face colors but which are black on the
# bench (lower-case file stems).
UNCOLORED_BLACK_MOUNTS = frozenset({
    "xyt1_m-step",   # Thorlabs XY translation stage
    "rla300_m-step",  # Thorlabs dovetail rail
    "rc1-step",       # Thorlabs rail carrier
    "obt-300sh",      # Sigma Koki low-profile rail
    "obt-300sh-lms",  # ... with mm scale
    "obt-500sh",
    "obt-500sh-lms",
    "caa-40ls",       # Sigma Koki rail carrier
})


# cad/Cage plates whose bore is the STEP's Z axis -> beam aperture radius (mm),
# measured off the CAD.
Z_BORE_CAGE_PLATES = {
    "crm1t_m-step": 12.7,  # rotation mount, SM1 bore
    "cp32_m-step": 11.0,   # SM1-threaded cage plate, narrowest lip r = 11
}


def _sync_cad_catalog_group(
    cad_directory,
    group_name,
    component_type,
    source_forward_axis,
):
    """Generate missing or stale nested assets for one CAD catalogue group."""
    if not os.path.isdir(cad_directory):
        return
    with _CAD_CATALOG_SYNC_LOCK:
        stale_steps = []
        for filename in sorted(os.listdir(cad_directory)):
            step_path = os.path.join(cad_directory, filename)
            stem, extension = os.path.splitext(filename)
            if (
                not os.path.isfile(step_path)
                or extension.lower() not in (".step", ".stp")
            ):
                continue
            component_dir = os.path.join(config.LIB_DIR, group_name, stem)
            output = os.path.join(component_dir, uu.MODEL_FILE)
            source_mtime = os.path.getmtime(step_path)
            if _FAILED_CONVERSIONS.get(step_path) == source_mtime:
                continue
            if (
                not os.path.isfile(output)
                or os.path.getmtime(output) < source_mtime
            ):
                stale_steps.append((step_path, stem))

        if not stale_steps:
            return
        try:
            from opticaltwin import cad_importer
        except ModuleNotFoundError as exc:
            # The converter is an optional install. Without it the STEP files
            # simply stay unconverted; refusing to load the project over them
            # would take the whole app down for a part nobody has placed yet.
            if (exc.name or "").split(".")[0] != "OCP":
                raise
            _report_missing_converter(len(stale_steps), cad_directory)
            return

        for step_path, stem in stale_steps:
            source_axis = source_forward_axis
            extra_arguments = []
            if group_name == "Breadboard":
                extra_arguments = [
                    "--source-roll-deg", "90",
                    "--color", "0.72", "0.74", "0.78",
                    "--ignore-step-colors",
                    "--metalness", "1",
                    "--roughness", "1",
                ]
            elif group_name == "Cage" and stem.lower() == "lcp6x-step":
                source_axis = "+Z"
                extra_arguments = [
                    "--source-origin", "0", "0", "3",
                ]
            elif (
                group_name == "Polarizer"
                and stem.lower() == "lpvise100-a-step"
            ):
                source_axis = "+Z"
                extra_arguments = [
                    "--source-origin",
                    "1.5325228571327916",
                    "0.8399980422382267",
                    "-2.229373699137465",
                ]
            elif group_name == "Lens" and stem.lower() == "dlb-30-50pm":
                # AUTO reads the widest axis as the optical one, which for a
                # 30 mm biconvex disc is its diameter, not its thickness.
                source_axis = "+Y"
                extra_arguments = [
                    "--source-origin", "0", "-7.15", "0",
                    "--attr", "focalLength_mm=50",
                ]
            elif group_name == "Lens" and stem.lower() == "mvl7000-step":
                # An objective, not a bare element: its barrel is black rather
                # than glass.
                extra_arguments = [
                    "--source-origin", "-33.36", "0", "0",
                    "--attr", "barrelDiameter_mm=61.849",
                    "--attr", "sizeX_mm=173.044",
                    "--attr", "sizeY_mm=68.461",
                    "--attr", "sizeZ_mm=61.849",
                    "--attr", "centerX_mm=0.003",
                    "--attr", "centerY_mm=3.306",
                    "--attr", "centerZ_mm=0",
                    "--attr", "mount=C",
                ]
                source_axis = "+X"
            elif group_name == "Lens" and stem.lower() == "mvl12m23-step":
                # Same family as MVL7000: a C-mount objective with a black
                # barrel rather than a glass disc. The STEP
                # already sits on its optical axis with the C-mount thread at
                # +X, which is the end that faces the sensor/DMD.
                source_axis = "+X"
                extra_arguments = [
                    # The STEP carries no face colors, so it would fall back to
                    # the glass-blue default on what is an anodized black
                    # barrel. 0.051269 is the black the cage plates, post
                    # holders and iris already read out of their own STEP
                    # files; no metalness/roughness, so it lands on the
                    # viewport's matte default like they do.
                    "--ignore-step-colors",
                    "--color", "0.051269", "0.051269", "0.051269",
                    "--attr", "barrelDiameter_mm=38.24",
                    "--attr", "focalLength_mm=12",
                    "--attr", "mount=C",
                ]
            elif group_name == "Lens" and stem.lower() == "mvl12m1-step":
                # The 1" format sibling of the MVL12M23 above: same C-mount
                # objective treatment, same anodized black, thread at +X. Its
                # STEP is authored 40.894 mm off its own origin along the
                # optical axis, so unlike the MVL12M23 it needs recentering --
                # otherwise the whole barrel draws behind wherever it is
                # placed.
                source_axis = "+X"
                extra_arguments = [
                    "--source-origin", "-40.894", "0", "0",
                    "--ignore-step-colors",
                    "--color", "0.051269", "0.051269", "0.051269",
                    "--attr", "barrelDiameter_mm=44.61",
                    "--attr", "focalLength_mm=12",
                    "--attr", "mount=C",
                ]
            elif group_name == "SLM" and stem.lower() == "s440c-step":
                # Origin on the front face so the modulating plane, not the
                # middle of the board, is what gets positioned -- the same
                # convention the Exulus panel follows.
                source_axis = "-Z"
                extra_arguments = [
                    "--source-origin", "5.10", "7.69", "20.14",
                    "--attr", "activeWidth_mm=14.0",
                    "--attr", "activeHeight_mm=10.5",
                    "--attr", "reflective=1",
                    "--attr", "slmKind=DMD",
                ]
            elif group_name == "LED" and stem.lower() == "ledw7e-step":
                # Emission leaves the dome, which sits at the +X end of the
                # envelope once the leads trailing behind it are included.
                source_axis = "+Y"
                extra_arguments = [
                    "--source-origin", "0", "-9.2", "0",
                    "--attr", "wavelength_nm=0",
                    "--attr", "color=white",
                    "--attr", "emissionOffset_mm=17.8",
                    "--attr", "emissionCenterY_mm=0",
                    "--attr", "emissionCenterZ_mm=0",
                    "--attr", "beamBehavior=emit",
                ]
            elif group_name == "Mount" and stem.lower() == "lmr30_m-step":
                # Origin on the bore axis at mid-thickness, and rolled so the
                # mounting tab hangs below the optic where its post goes.
                extra_arguments = [
                    "--source-origin", "0", "0", "-5.08",
                    "--source-roll-deg", "90",
                    # A mount blocks the beam everywhere except its authored
                    # aperture, so the ring's ø30.1 bore has to be declared or
                    # the ray stops at the front face.
                    "--attr", "beamApertureRadius_mm=15.05",
                ]
            elif group_name == "Mount" and stem.lower() == "mlh7_m-step":
                # Mini-series fixed lens mount for a 6.35 mm optic. Same
                # treatment as the LMR30 above -- origin on the bore axis at
                # mid-thickness, rolled so the M3 tapped hole in its base
                # points down at the post -- but its STEP puts that axis at
                # (0.4159, 12.2563), not the origin, so it has to be named.
                extra_arguments = [
                    "--source-origin",
                    "0.415913", "12.256343", "11.760101",
                    "--source-roll-deg", "90",
                    # Black anodized, like the cage plates and post holders it
                    # sits among: the mount default of 0.9 renders it as
                    # chrome. Roughness stays at the mount default of 0.08,
                    # which is what LCP33B pairs with a matte metalness.
                    "--metalness", "0",
                    # The model reads the STEP's own face colors; this is
                    # just the fallback for faces that have none.
                    "--color", "0.051269", "0.051269", "0.051269",
                    # The narrowest of its five bores -- the ø5.842 through
                    # hole -- is what actually passes the beam.
                    "--attr", "beamApertureRadius_mm=2.921",
                ]
            elif group_name == "Cage" and stem.lower() in Z_BORE_CAGE_PLATES:
                # 30 mm cage plates whose STEP bore runs along its own Z. AUTO
                # picks a square face as the optical axis and lays them
                # sideways. A mount blocks the beam outside its declared
                # aperture, so the bore has to be named, as on CRM1LT.
                source_axis = "+Z"
                extra_arguments = [
                    "--attr",
                    f"beamApertureRadius_mm={Z_BORE_CAGE_PLATES[stem.lower()]}",
                ]
            elif group_name == "Mount" and stem.lower() in UNCOLORED_BLACK_MOUNTS:
                # Translation stage, rails and carriers whose STEP carries no
                # face colors, so every face took the importer's glass-blue
                # default and the mount metalness of 0.9 rendered them as
                # chrome. They are black anodized on the bench: same matte
                # black as MLH7 above. --ignore-step-colors because the importer
                # only applies --color through it when the STEP has no colors
                # at all; it also paints XYT1's few colored faces the same black.
                extra_arguments = [
                    "--metalness", "0",
                    "--color", "0.051269", "0.051269", "0.051269",
                    "--ignore-step-colors",
                ]
            elif group_name == "Detector" and stem.lower() == "det100a2-step":
                # Origin on the SM1 input aperture rather than the middle of
                # the housing, so the beam stops where the light enters.
                source_axis = "+Z"
                extra_arguments = [
                    "--source-origin", "0", "0", "-22.15",
                    "--source-roll-deg", "90",
                    "--attr", "sensorWidth_mm=11.3",
                    "--attr", "sensorHeight_mm=11.3",
                    "--attr", "apertureDiameter_mm=26.3",
                    "--attr", "beamBehavior=block",
                ]
            # One unreadable file (a truncated download, an HTML error page
            # saved as .step) must not fail the project load it runs inside:
            # that answered 500 for every project until the file was found.
            # SystemExit too, since the importer is a CLI and argparse exits.
            try:
                cad_importer.main([
                    step_path,
                    "--type", component_type,
                    "--component-name", f"{group_name}/{stem}",
                    # "=" rather than a separate element: argparse reads a bare
                    # "-Z" as an unknown option, not as this option's value.
                    f"--source-forward-axis={source_axis}",
                    *extra_arguments,
                ])
            except (Exception, SystemExit) as exc:
                _FAILED_CONVERSIONS[step_path] = os.path.getmtime(step_path)
                _report_failed_conversion(step_path, exc)

# The cad/ folders converted automatically: (folder, optics:type, source axis).
# tools/fetch_cad.py keeps its own copy of the folder names (AUTO_FOLDERS);
# tests/test_fetch_cad.py checks the two agree.
CAD_GROUPS = (
    ("Breadboard", "breadboard", "+X"),
    ("Beam Splitter", "beamsplitter", "AUTO"),
    ("Cage", "mount", "AUTO"),
    ("Detector", "detector", "+Z"),
    ("Holder", "holder", "AUTO"),
    ("Iris", "iris", "AUTO"),
    ("LED", "led", "+Y"),
    ("Laser", "laser", "AUTO"),
    ("Lens", "lens", "AUTO"),
    ("Mirror", "mirror", "AUTO"),
    ("Mount", "mount", "+Z"),
    ("Polarizer", "polarizer", "+Z"),
    ("Post", "post", "AUTO"),
    ("Rod", "rod", "+Y"),
    ("SLM", "slm", "AUTO"),
)


def _ensure_generic_library():
    """Write the generated parts if any is missing.

    They are what a checkout without manufacturer CAD draws, and a library
    built before they moved to components/Generic/ has none there: projects
    whose references were just rewritten to Generic/ would show empty parts
    until someone re-ran setup_projects.py.
    """
    missing = any(
        not os.path.isfile(uu.get_component_usda_path(config.LIB_DIR, asset))
        for asset in ol.LIBRARY
    )
    if missing:
        with _CAD_CATALOG_SYNC_LOCK:
            ol.build_component_library(config.LIB_DIR)


def _sync_cad_catalog():
    """Synchronize every element category authored under cad/."""
    _ensure_generic_library()
    for group_name, component_type, source_axis in CAD_GROUPS:
        _sync_cad_catalog_group(
            os.path.join(config.ROOT_DIR, "cad", group_name),
            group_name,
            component_type,
            source_axis,
        )
