# Manufacturer CAD models

[← Back to the README](../README.md)

Out of the box, OpticalTwin draws parts as simple generated shapes. This page
shows how to add the manufacturer's own 3D model of a part you own, so the bench
on screen looks like the bench on your table.

**No manufacturer CAD data is included in this repository.** Vendor STEP models
remain the property of their manufacturer, and their licence terms generally
allow use in your own design work but not redistribution. You download the
models for your own parts; OpticalTwin converts them on your machine.

## Add a part in three steps

**1. Install the converter, once.** It is a large optional download.

```bash
pip install -r requirements-cad.txt
```

**2. Save the STEP file into the folder for its kind of part.** Download the
`.step` file from the manufacturer's product page and put it under `cad/`:

```
cad/Lens/LA1417-A.step
cad/Mirror/BBSQ2-E02.step
cad/Laser/PL251.step
```

The folder decides what the part *is*, which is how the beam knows a mirror
folds it and a camera stops it:

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
| `Detector` | detector |
| `Breadboard` | breadboard |
| `Holder`, `Mount`, `Cage`, `Post`, `Rod` | mounting hardware |

**3. Restart the server and open any project.** New STEP files are converted the
first time a project is opened, so that first load is slow, roughly ten seconds
per part. After that the part is in the part browser under its folder's name,
with a detailed model and a light one for fast editing.

Converted parts are written to `components/<Folder>/<file name>/`. Both `cad/`
and `components/` stay on your machine; neither is committed.

## What changes once you have CAD parts

- **A laser** in `cad/Laser/` takes the place of the generated laser in
  *Design from a laser*: new projects can start with your own laser model on
  the board. With several, you choose one by colour and model number.
- **A breadboard** in `cad/Breadboard/` replaces the generated board. Save the
  Thorlabs MB6060/M model as `cad/Breadboard/MB6060_M-Step.step` to make it the
  default; projects, including existing ones, then use that 600 × 600 mm board
  centred on the origin. Other breadboard models in the folder can be chosen per
  project in the Inspector.

## Start from the lab's parts list

`cad/SOURCES.toml` lists the parts our own library was built from: part numbers,
vendors and catalogue links, with no geometry. It is a useful starting list even
if your bench differs.

```bash
python tools/fetch_cad.py --list      # what the manifest holds, and what is missing
python tools/fetch_cad.py             # download the entries that have a direct link
python tools/fetch_cad.py --part ER1  # just one
```

Most entries have no direct link, because most vendors do not offer a stable
one. For those the script prints the product page so you can save the STEP by
hand, into the path shown. Edit the manifest to match the parts you own.

## If a part looks wrong

A model that comes in facing the wrong way, sitting off its optical axis or too
heavy to edit smoothly can be converted by hand with explicit options:

```bash
python -m opticaltwin.cad_importer path/to/PART.step --type lens --lod both \
    --component-name MyPart
```

See [dev/ASSETS.md](dev/ASSETS.md) for the conversion and optimisation options.

## If nothing appears

| What you see | Cause and fix |
|---|---|
| The server prints "STEP file(s) … are not converted" | The converter is not installed. Run `pip install -r requirements-cad.txt` and restart the server. |
| An import error naming `OCP` | A different version of the converter is installed. Install the pinned one with `pip install -r requirements-cad.txt`. |
| The part is missing from the part browser | Check that the file is directly inside one of the folders above and ends in `.step` or `.stp`, then open a project again. |
