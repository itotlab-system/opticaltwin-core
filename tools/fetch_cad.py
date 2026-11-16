"""
fetch_cad.py  --  download the manufacturer CAD models listed in cad/SOURCES.toml

No vendor CAD ships with OpticalTwin. This script reads the manifest of part
numbers and vendor links and fetches the models for the parts you own into
cad/, so `opticaltwin/cad_importer.py` has something to convert.

    python tools/fetch_cad.py --list      # each missing part: the page to open, where to save it
    python tools/fetch_cad.py --part ER1  # just one

You download the models yourself, in a browser: open the product page, download
the STEP file, and save it at the path shown. The server converts it the next
time a project is opened. An entry may carry a `step_url` for a vendor that
offers a stable direct link; running without --list fetches those, but the
manifest ships none -- most vendors do not offer one.

Nothing here circumvents a login, a licence click-through, or a robots rule. If
a vendor wants you to accept terms before downloading, do that in a browser.
"""

import argparse
import os
import sys
import tomllib
import urllib.error
import urllib.request

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAD_DIR = os.path.join(ROOT_DIR, "cad")
MANIFEST = os.path.join(CAD_DIR, "SOURCES.toml")

USER_AGENT = "OpticalTwin-fetch-cad/1.0 (+https://github.com/itotlab-system/opticaltwin-core)"


def load_manifest(path=MANIFEST):
    """Read SOURCES.toml and fold `defaults` into each part."""
    if not os.path.exists(path):
        raise SystemExit(f"manifest not found: {path}")
    with open(path, "rb") as f:
        data = tomllib.load(f)

    defaults = data.get("defaults", {})
    parts = []
    for entry in data.get("parts", []):
        part = dict(entry)
        for key, value in defaults.items():
            part.setdefault(key, value)
        # `product_page` is a template in defaults, a literal when overridden.
        page = part.get("product_page") or ""
        part["product_page"] = page.replace("{part}", part.get("part", ""))
        parts.append(part)
    return parts


# Folders the server converts by itself. Mirrors the groups in
# backend/catalog.py `_sync_cad_catalog`; tests/test_fetch_cad.py keeps them equal.
AUTO_FOLDERS = frozenset({
    "Beam Splitter", "Breadboard", "Cage", "Detector", "Holder", "Iris", "LED",
    "Laser", "Lens", "Mirror", "Mount", "Polarizer", "Post", "Rod", "SLM",
})


def target_path(part):
    return os.path.join(CAD_DIR, part["target"])


def converts_by_itself(part):
    return part["target"].split("/", 1)[0] in AUTO_FOLDERS


def print_manual_steps(part, indent="            "):
    """What to do by hand for one missing part."""
    page = part.get("product_page") or "(no page recorded; search the vendor's site)"
    print(f"{indent}1. open      {page}")
    print(f"{indent}2. save as   cad/{part['target']}")
    if not converts_by_itself(part):
        print(f"{indent}3. convert   by hand, not automatic for this folder;"
              " see the comment above it in cad/SOURCES.toml")


def download(url, dest):
    """Fetch `url` to `dest`, writing via a temp file so a failure leaves no stub."""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = response.read()
    if not payload:
        raise OSError("empty response")
    with open(tmp, "wb") as f:
        f.write(payload)
    os.replace(tmp, dest)
    return len(payload)


NEXT_STEPS = """
  Then, with the converter installed (pip install -r requirements-cad.txt),
  open your project again in the browser: new files are converted as it opens.
  The parts appear under "Add a part", in the category named after their folder.
  Step by step: docs/cad-models.md"""


def cmd_list(parts):
    have = missing = 0
    print(f"{len(parts)} parts in the manifest\n")
    for part in parts:
        present = os.path.exists(target_path(part))
        have += present
        missing += not present
        mark = "have" if present else "MISSING"
        print(f"  [{mark:>7}] {part['part']:<24} {part.get('type', '')}")
        if not present:
            print_manual_steps(part)
    print(f"\n  {have} present, {missing} missing")
    if missing:
        print(NEXT_STEPS)
    return 0


def cmd_fetch(parts, only=None, force=False):
    selected = [p for p in parts if not only or p["part"] == only]
    if only and not selected:
        raise SystemExit(f"no part named {only!r} in the manifest")

    notices = {p.get("license_note", "").strip() for p in selected}
    for notice in sorted(n for n in notices if n):
        print(notice + "\n")

    fetched = skipped = manual = failed = 0
    for part in selected:
        dest = target_path(part)
        if os.path.exists(dest) and not force:
            skipped += 1
            continue
        url = part.get("step_url")
        if not url:
            manual += 1
            print(f"  manual   {part['part']}")
            print_manual_steps(part, indent="           ")
            continue
        try:
            size = download(url, dest)
            fetched += 1
            print(f"  fetched  {part['part']:<24} {size / 1024:.0f} kB -> {part['target']}")
        except (urllib.error.URLError, OSError) as exc:
            failed += 1
            print(f"  FAILED   {part['part']:<24} {exc}")
            if part.get("product_page"):
                print(f"           try by hand: {part['product_page']}")

    print(f"\n  {fetched} fetched, {skipped} already present, "
          f"{manual} need a manual download, {failed} failed")
    if manual or fetched:
        print(NEXT_STEPS)
    return 1 if failed else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("--list", action="store_true",
                        help="show the manifest and which files are already present")
    parser.add_argument("--part", help="fetch a single part by its part number")
    parser.add_argument("--force", action="store_true",
                        help="re-download even if the file is already there")
    args = parser.parse_args(argv)

    parts = load_manifest()
    if args.list:
        return cmd_list(parts)
    return cmd_fetch(parts, only=args.part, force=args.force)


if __name__ == "__main__":
    sys.exit(main())
