# Manufacturer CAD models

[← Back to the README](../README.md)

**No manufacturer CAD data is included in this repository.** Vendor-supplied
STEP models remain the property of their manufacturer, and their licence terms
generally permit use in your own design work but not redistribution.

What ships instead is a manifest of *pointers*. `cad/SOURCES.toml` lists the
parts the lab's own component library was built from. It records part numbers,
vendors and catalogue links, and `tools/fetch_cad.py` reads it:

```bash
python tools/fetch_cad.py --list      # what the manifest holds, and what is missing
python tools/fetch_cad.py             # download the entries that have a direct link
python tools/fetch_cad.py --part ER1  # just one
```

Most entries have no direct link, because most vendors do not offer a stable
one; for those the script prints the product page so you can save the STEP by
hand. Then convert it:

```bash
pip install cadquery-ocp   # large; only the CAD import path needs it
python -m opticaltwin.cad_importer path/to/PART.step --type lens --lod both \
    --component-name MyPart
```

`cad/SOURCES.toml` is a good starting list even if your bench differs. Edit it
to match the parts you actually own. See [dev/ASSETS.md](dev/ASSETS.md) for the
full conversion and optimisation guide.
