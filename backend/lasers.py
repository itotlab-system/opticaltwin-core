"""Starting a project from a laser: the laser catalogue, colour names by
wavelength, and placing the first source."""

import os
import re

from pxr import Usd

from opticaltwin import optics_lib as ol
from opticaltwin import usd_utility as uu

from backend import config
from backend import library
from backend import scene
from backend.beam_edit import _traced_components
from backend.board import _board
from backend.library import _library_base_offset_mm
from backend.placement import _board_top, _clamp_z, _set_xform, _unique_component_name

# "Design from a laser": a blank board with the chosen laser already on it,
# its beam at the chosen height. Beam-first building starts here -- every
# optic is then dropped onto that beam (see beam_first.py).
FROM_LASER_TEMPLATE = "from_laser"

# "Start from a photo" is an empty board; the browser then opens the photo
# screen on it, and the bench is built from what is marked there.
FROM_PHOTO_TEMPLATE = "from_photo"

DEFAULT_BEAM_HEIGHT_MM = 100.0

BEAM_HEIGHT_RANGE_MM = (10.0, 300.0)

LASER_MARGIN_MM = 25.0

def _laser_assets():
    """Catalogue lasers, offered as the starting point of a new design."""
    return sorted(a for a in ol.component_library_assets()
                  if a.split("/", 1)[0] == "Laser")

# Colour names by wavelength, for people who think "the green laser", not
# "NPL52B". Boundaries are the usual textbook bands; past 750 nm it is
# infrared, which has no colour to see.
COLOR_BANDS_NM = (
    (450, "violet"), (495, "blue"), (570, "green"), (590, "yellow"),
    (620, "orange"), (750, "red"),
)

def _color_name(wavelength_nm):
    """'green' for 520 nm; None when the wavelength is not known."""
    if wavelength_nm is None:
        return None
    for upper, name in COLOR_BANDS_NM:
        if wavelength_nm < upper:
            return name
    return "infrared"

def _laser_option(asset):
    """A catalogue laser as the new-project picker shows it.

    Only what the catalogue actually says: a laser whose asset carries no
    optics:wavelength_nm gets no colour rather than a guessed one.
    """
    attrs = library._library_previews().get(asset, {}).get("attrs", {})
    wavelength = attrs.get("wavelength_nm")
    wavelength = int(round(float(wavelength))) if wavelength is not None else None
    model = os.path.basename(uu.get_component_name(asset))
    return dict(
        asset=asset,
        model=re.sub(r"-Step$", "", model),
        wavelength_nm=wavelength,
        color=_color_name(wavelength),
    )

def _laser_component_name(asset):
    """Green_Laser_520nm -- what the starting laser is called on the bench."""
    option = _laser_option(asset)
    if option["color"] is None:
        return f"Laser_{re.sub(r'[^A-Za-z0-9_]', '_', option['model'])}"
    return f"{option['color'].capitalize()}_Laser_{option['wavelength_nm']}nm"

def _place_starting_laser(project, laser_asset, beam_height):
    """Put the laser at the -X end of the board, beam along +X at beam_height."""
    setup = scene.project_setup(project)
    stage = Usd.Stage.Open(setup)
    root = str(stage.GetDefaultPrim().GetPath())
    component_path = uu.get_component_name(laser_asset)
    name = _unique_component_name(stage, root, _laser_component_name(laser_asset))
    rel = uu.get_relative_component_usda_path(
        config.LIB_DIR, component_path, os.path.dirname(setup))
    ol.place(stage, root, name, rel, 0.0, 0.0, _board_top(stage))
    laser = _traced_components(stage)[name]
    attrs = laser.get("attrs", {})
    board = _board(stage)
    # The laser's rear end sits one hole in from the board's -X edge.
    rear = float(attrs.get("centerX_mm", 0.0)) - float(attrs.get("sizeX_mm", 0.0)) / 2
    x = board["centerX"] - board["extentXNegative"] + LASER_MARGIN_MM - rear
    y = board["centerY"]
    beam_z = _board_top(stage) + beam_height
    z = beam_z - float(laser.get("physics", {}).get("emissionCenterZ_mm", 0.0))
    z = max(z, _board_top(stage) + _library_base_offset_mm(laser_asset))
    _set_xform(stage.GetPrimAtPath(f"{root}/{name}"), x, y, _clamp_z(stage, z),
               0.0, 0.0, 0.0)
    stage.GetRootLayer().Save()
    return name
