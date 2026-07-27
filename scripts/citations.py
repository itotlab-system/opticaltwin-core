"""
scripts/citations.py  --  citation counts for this project's Zenodo DOIs
------------------------------------------------------------------------
Reads the concept DOI out of CITATION.cff, asks Zenodo which version DOIs
exist under it, and prints the citation / view / download counts that DataCite
and OpenAlex hold for each one.

Why two sources: DataCite is the registry that mints Zenodo DOIs, so its
counts appear first and are the primary number. OpenAlex counts citations from
the literature it has indexed, which is the figure people usually quote — but
a freshly minted DOI is simply absent there for days to weeks.

Run:  python scripts/citations.py                     # concept + all versions
      python scripts/citations.py --total             # + the sum across DOIs
      python scripts/citations.py --json              # machine readable
      python scripts/citations.py 10.5281/zenodo.123  # specific DOIs instead

Counts never merge upstream, so once a paper about the software exists its DOI
is a third, separate tally: pass it alongside the others with --total to see
where the project actually stands.

Set OPENALEX_MAILTO (or pass --mailto) to join OpenAlex's polite pool; no API
key is needed for either service. Stdlib only, no extra dependencies.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFF_PATH = os.path.join(ROOT_DIR, "CITATION.cff")
DATACITE_API = "https://api.datacite.org/dois/"
OPENALEX_API = "https://api.openalex.org/works/doi:"
ZENODO_API = "https://zenodo.org/api/records"
ZENODO_PAGE_SIZE = 25      # anonymous requests are rejected above this
TIMEOUT_S = 20


def fetch_json(url):
    """GET url as JSON. Returns None when the record does not exist (404)."""
    request = urllib.request.Request(url, headers={"User-Agent": "OpticalTwin-citations"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


def concept_doi_from_cff(path=CFF_PATH):
    """The top-level `doi:` field of CITATION.cff (the Zenodo concept DOI)."""
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            match = re.match(r"^doi:\s*(\S+)", line)
            if match:
                return match.group(1).strip("\"'")
    raise SystemExit(f"no top-level 'doi:' field in {path}")


def zenodo_versions(concept_doi):
    """Version DOIs published under a concept DOI, as [(doi, version), ...].

    Zenodo's concept record id is the numeric tail of the concept DOI, and every
    version carries it as `conceptrecid`.
    """
    concept_recid = concept_doi.rsplit(".", 1)[-1]
    versions, page = [], 1
    while True:
        query = urllib.parse.urlencode({
            "q": f"conceptrecid:{concept_recid}",
            "all_versions": "true",
            "size": ZENODO_PAGE_SIZE,
            "page": page,
        })
        hits = (fetch_json(f"{ZENODO_API}?{query}") or {}).get("hits", {}).get("hits", [])
        for hit in hits:
            doi = hit.get("doi")
            if doi:
                versions.append((doi, hit.get("metadata", {}).get("version") or "?"))
        if len(hits) < ZENODO_PAGE_SIZE:
            return versions
        page += 1


def datacite_metrics(doi):
    """DataCite counts for a DOI, or None when it is not registered there."""
    record = fetch_json(DATACITE_API + urllib.parse.quote(doi, safe=""))
    if not record:
        return None
    attrs = record["data"]["attributes"]
    return {
        "state": attrs.get("state"),
        "citations": attrs.get("citationCount"),
        "views": attrs.get("viewCount"),
        "downloads": attrs.get("downloadCount"),
    }


def openalex_metrics(doi, mailto=None):
    """OpenAlex counts for a DOI, or None while the DOI is not yet indexed."""
    url = OPENALEX_API + urllib.parse.quote(doi, safe="/.")
    if mailto:
        url += "?" + urllib.parse.urlencode({"mailto": mailto})
    work = fetch_json(url)
    if not work:
        return None
    return {
        "id": work.get("id"),
        "citations": work.get("cited_by_count"),
        "cited_by_url": work.get("cited_by_api_url"),
    }


def collect(dois, mailto=None):
    """Gather both sources for every DOI, preserving the given order."""
    rows = []
    for doi, label in dois:
        rows.append({
            "doi": doi,
            "kind": label,
            "datacite": datacite_metrics(doi),
            "openalex": openalex_metrics(doi, mailto),
        })
    return rows


def totals(rows):
    """Sum each source across the DOIs.

    Citation counts are recorded per DOI and are never merged upstream: a paper
    citing the version DOI does not raise the concept DOI's count, and a future
    paper about the software gets its own count again. Adding them up locally is
    the only way to see the whole picture.
    """
    def total(source, field):
        return sum((row[source] or {}).get(field) or 0 for row in rows)

    return {
        "datacite": {field: total("datacite", field)
                     for field in ("citations", "views", "downloads")},
        "openalex": {"citations": total("openalex", "citations")},
    }


def print_table(rows, show_total=False):
    header = f"{'DOI':<28} {'kind':<9} {'DataCite':<26} {'OpenAlex'}"
    print(header)
    print("-" * len(header))
    for row in rows:
        dc, oa = row["datacite"], row["openalex"]
        datacite = (
            f"cites {dc['citations']}  views {dc['views']}  dl {dc['downloads']}"
            if dc else "not registered"
        )
        openalex = f"cites {oa['citations']}" if oa else "not indexed yet"
        print(f"{row['doi']:<28} {row['kind']:<9} {datacite:<26} {openalex}")
    if show_total:
        summed = totals(rows)
        dc, oa = summed["datacite"], summed["openalex"]
        datacite = "cites {citations}  views {views}  dl {downloads}".format(**dc)
        kind = f"{len(rows)} DOIs"
        print("-" * len(header))
        print(f"{'TOTAL':<28} {kind:<9} {datacite:<26} cites {oa['citations']}")
    if any(row["openalex"] is None for row in rows):
        print("\nOpenAlex indexes new Zenodo DOIs after a delay of days to weeks;")
        print("until then DataCite is the number to quote.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("dois", nargs="*",
                        help="DOIs to look up (default: the concept DOI in "
                             "CITATION.cff plus every Zenodo version under it)")
    parser.add_argument("--mailto", default=os.environ.get("OPENALEX_MAILTO"),
                        help="contact address for OpenAlex's polite pool")
    parser.add_argument("--json", action="store_true", help="print raw JSON")
    parser.add_argument("--no-versions", action="store_true",
                        help="skip the per-version DOIs, concept DOI only")
    parser.add_argument("--total", action="store_true",
                        help="also print the sum across every DOI listed")
    args = parser.parse_args(argv)

    if args.dois:
        targets = [(doi, "given") for doi in args.dois]
    else:
        concept = concept_doi_from_cff()
        targets = [(concept, "concept")]
        if not args.no_versions:
            targets += [(doi, version) for doi, version in zenodo_versions(concept)
                        if doi != concept]

    rows = collect(targets, args.mailto)
    if args.json:
        payload = {"dois": rows}
        if args.total:
            payload["total"] = totals(rows)
        json.dump(payload, sys.stdout, indent=2)
        print()
    else:
        print_table(rows, args.total)


if __name__ == "__main__":
    main()
