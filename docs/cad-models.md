# Manufacturer CAD models

[← Back to the README](../README.md)

Out of the box, OpticalTwin draws parts as simple generated shapes, so the
*Simple* and *Detailed* views look the same. This page shows how to add the
manufacturer's own 3D model of a part you own, so the bench on screen looks like
the bench on your table.

**You download the models yourself.** No manufacturer CAD data is included in
this repository, and OpticalTwin never downloads it for you. Vendor STEP models
remain the property of their manufacturer; their terms generally allow use in
your own design work but not redistribution. You fetch each model from the
manufacturer's site, and OpticalTwin converts it on your machine.

## The flow at a glance

```
 1. Install the converter         pip install -r requirements-cad.txt   (once)
 2. Download the STEP file        from the part's page on the manufacturer's site
 3. Save it into cad/<Folder>/    the folder says what kind of part it is
 4. Open your project again       the file is converted, a few seconds per part
 5. ▦ Add a part → <Folder>       pick it and click on the board
 6. Switch to Detailed            see the full model
```

The example below adds a Thorlabs lens. Every part works the same way.

## 1. Install the converter, once

Stop the server (Ctrl+C), check that your environment is active (`(.venv)` at
the start of the prompt), and install:

```bash
pip install -r requirements-cad.txt
```

It is a large download, a few hundred MB. Then start the server again with
`python server.py`. This restart is needed only this once, so the server finds
the newly installed converter.

## 2. Download the STEP file

1. Open the part's page on the manufacturer's site, for example
   <https://www.thorlabs.com/thorproduct.cfm?partnumber=LA1417-AB>.
2. Find the CAD downloads for that part number. On Thorlabs pages they are
   in the part's row of the table, or under a *CAD* or *Documents* tab.
3. Choose the **STEP** format (`.step` or `.stp`). Some vendors ask you to
   accept their terms or sign in first; do that in the browser.
4. If the download is a `.zip`, extract it. You need the `.step` or `.stp` file
   inside.

## 3. Save it into the folder for its kind of part

Create a folder under `cad/` named after the kind of part, and save the file in
it. Name the file after the part number: that name is what the part browser
shows.

```
cad/
├── Lens/LA1417-AB.step
├── Mirror/BBSQ2-E02.step
└── Breadboard/MB6060_M-Step.step
```

On Windows, create the folder from the repository root with
`mkdir cad\Lens`, or in File Explorer.

The folder decides what the part *is*, which is how the beam knows that a mirror
folds it and a camera stops it. Only these folder names are read:

| Folder | Kind of part |
|---|---|
| `Laser` | laser source |
| `LED` | LED source |
| `Lens` | lens |
| `Mirror` | mirror |
| `Beam Splitter` | beamsplitter |
| `Polarizer` | polarizer |
| `Iris` | iris |
| `SLM` | spatial light modulator |
| `Detector` | detector or camera |
| `Breadboard` | breadboard |
| `Holder`, `Mount`, `Cage`, `Post`, `Rod` | mounting hardware |

A file in any other folder is ignored; see [Parts the folders do not
cover](#parts-the-folders-do-not-cover).

## 4. Open your project again

In the browser, go back to the project list and open your project, or reload
the page. New STEP files are converted while the project opens: a few seconds
per part, longer for a large one such as a camera body. You do not need to
restart the server for new files, only for installing the converter.

Converted parts are written to `components/<Folder>/<file name>/`, with a
detailed model and a light one for fast editing. Both `cad/` and `components/`
stay on your machine.

## 5. Put the part on the bench

1. Click **▦ Add a part** above the parts list on the left. The part browser
   opens over the bench.
2. Pick the folder name (*Lens* in this example) in the list of categories, or
   type the part number in the search box. Each tile shows a picture drawn from
   the model you added.
3. Click the tile. The browser closes and the part follows your cursor; click on
   the board where it should go. Parts dropped near a beam snap onto it.

A CAD part is added *next to* the generated parts already on your bench; it
does not replace them. To upgrade an existing bench, place the CAD part where
the generated one is, using the Inspector on the right to type the same
position, then select the generated part and delete it.

## 6. See the detail

Switch the view from **Simple** to **Detailed** in the toolbar. CAD parts now
show their full model; *Simple* keeps a lighter version that stays fast while
you move things. Generated parts look the same in both.

## Breadboards and lasers

- **A breadboard** in `cad/Breadboard/` replaces the generated board. Save the
  Thorlabs MB6060/M model as exactly `cad/Breadboard/MB6060_M-Step.step` to make
  it the default; every project, including existing ones, then uses that
  600 × 600 mm board centred on the origin. Other breadboard models in the
  folder can be chosen per project in the Inspector when nothing is selected.
- **A laser** in `cad/Laser/` takes the place of the generated laser in
  *Design from a laser*: new projects can start with your own laser model on
  the board. With several, you choose one by colour and model number.

## Start from the lab's parts list

`cad/SOURCES.toml` lists the parts our own library was built from: part numbers,
vendors and product pages, with no geometry. It is a useful shopping list even
if your bench differs. To see each part's page and the exact path to save its
file to:

```bash
python tools/fetch_cad.py --list
```

It prints, for each part you do not have yet, the page to open and where to save
the download. Follow steps 2 to 5 above for each one. Edit the manifest to match
the parts you own.

## Parts the folders do not cover

A part whose kind has no folder above (a resolution target, a camera with a
lens, a beam expander) is converted by hand, with its type given explicitly:

```bash
python -m opticaltwin.cad_importer cad/Target/R1L1S7P-Step.step --type target \
    --lod both --component-name Target/R1L1S7P-Step
```

The same command fixes a model that comes in facing the wrong way, sitting off
its optical axis, or too heavy to edit smoothly. See
[dev/ASSETS.md](dev/ASSETS.md) for the conversion and optimisation options.

## If nothing appears

| What you see | Cause and fix |
|---|---|
| The server prints "STEP file(s) … are not converted" | The converter is not installed, or was installed while the server was running. Run `pip install -r requirements-cad.txt` with the environment active, then restart the server. |
| An import error naming `OCP` | A different version of the converter is installed. Install the pinned one with `pip install -r requirements-cad.txt`. |
| The part is missing from the part browser | Check that the file is directly inside one of the folders above (not in a subfolder, and not still inside a `.zip`), and ends in `.step` or `.stp`. Then open the project again. |
| *Detailed* looks the same as *Simple* | The parts on the bench are still the generated ones. Add the CAD part from the part browser (step 5). |
