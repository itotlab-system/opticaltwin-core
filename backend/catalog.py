"""Keeping CAD-derived catalogue assets in step with the STEP files in cad/."""

import os
import threading

from backend import config

_CAD_CATALOG_SYNC_LOCK = threading.Lock()

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
            outputs = [
                os.path.join(component_dir, "hi.usda"),
                os.path.join(component_dir, "lo.usda"),
            ]
            source_mtime = os.path.getmtime(step_path)
            if any(
                not os.path.isfile(output)
                or os.path.getmtime(output) < source_mtime
                for output in outputs
            ):
                stale_steps.append((step_path, stem))

        if not stale_steps:
            return
        from opticaltwin import cad_importer

        for step_path, stem in stale_steps:
            source_axis = source_forward_axis
            extra_arguments = []
            if group_name == "Breadboard":
                extra_arguments = [
                    "--source-roll-deg", "90",
                    "--lo-proxy", "box",
                    "--color", "0.72", "0.74", "0.78",
                    "--lo-color", "0.72", "0.74", "0.78",
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
                # An objective, not a bare element: no surface to fit a lens
                # primitive to, and its barrel is black rather than glass.
                extra_arguments = [
                    "--source-origin", "-33.36", "0", "0",
                    "--lo-proxy", "cylinder",
                    "--lo-color", "0.12", "0.12", "0.13",
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
                # Same family as MVL7000: a C-mount objective, so a cylinder
                # proxy and a black barrel rather than a glass disc. The STEP
                # already sits on its optical axis with the C-mount thread at
                # +X, which is the end that faces the sensor/DMD.
                source_axis = "+X"
                extra_arguments = [
                    "--lo-proxy", "cylinder",
                    # The STEP carries no face colors, so hi would fall back to
                    # the glass-blue default on what is an anodized black
                    # barrel. 0.051269 is the black the cage plates, post
                    # holders and iris already read out of their own STEP
                    # files; no metalness/roughness, so it lands on the
                    # viewport's matte default like they do.
                    "--ignore-step-colors",
                    "--color", "0.051269", "0.051269", "0.051269",
                    "--lo-color", "0.051269", "0.051269", "0.051269",
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
                    "--lo-proxy", "cylinder",
                    "--ignore-step-colors",
                    "--color", "0.051269", "0.051269", "0.051269",
                    "--lo-color", "0.051269", "0.051269", "0.051269",
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
                    # --color, not --lo-color: a mount's lo is a decimated
                    # mesh rather than a proxy, and --lo-color is only applied
                    # on the proxy path, which is why the LMR30 beside it is
                    # still glass-blue in lo. Only lo is repainted -- hi reads
                    # the STEP's own face colors, and this is just the
                    # fallback for faces that have none.
                    "--color", "0.051269", "0.051269", "0.051269",
                    # The narrowest of its five bores -- the ø5.842 through
                    # hole -- is what actually passes the beam.
                    "--attr", "beamApertureRadius_mm=2.921",
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
            cad_importer.main([
                step_path,
                "--type", component_type,
                "--lod", "both",
                "--component-name", f"{group_name}/{stem}",
                # "=" rather than a separate element: argparse reads a bare
                # "-Z" as an unknown option, not as this option's value.
                f"--source-forward-axis={source_axis}",
                *extra_arguments,
            ])

def _sync_cad_catalog():
    """Synchronize every element category authored under cad/."""
    groups = (
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
    for group_name, component_type, source_axis in groups:
        _sync_cad_catalog_group(
            os.path.join(config.ROOT_DIR, "cad", group_name),
            group_name,
            component_type,
            source_axis,
        )
