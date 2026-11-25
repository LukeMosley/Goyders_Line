#!/usr/bin/env python3
"""Build docs/data/localities.json (SA towns/suburbs + postcodes) for the widget's
"Find my town" search. Run occasionally; it is not part of the monthly update.

Source: GeoNames Australian postal codes (https://download.geonames.org/export/zip/AU.zip),
CC BY 4.0. Coordinates are approximate locality centres.
"""
import io, json, sys, urllib.request, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
URL = "https://download.geonames.org/export/zip/AU.zip"
# Reference towns given permanent labels on the map (spread along and either side of Goyder's Line).
REFERENCE = ["Ceduna", "Streaky Bay", "Wudinna", "Kimba", "Cowell", "Port Lincoln", "Whyalla", "Port Augusta",
             "Quorn", "Hawker", "Leigh Creek", "Orroroo", "Peterborough", "Jamestown", "Port Pirie", "Kadina",
             "Burra", "Clare", "Eudunda", "Morgan", "Swan Reach", "Loxton", "Pinnaroo", "Murray Bridge", "Adelaide",
             "Keith", "Naracoorte", "Mount Gambier", "Renmark", "Tumby Bay", "Minnipa", "Snowtown"]


def main() -> int:
    raw = urllib.request.urlopen(URL, timeout=120).read()
    rows = zipfile.ZipFile(io.BytesIO(raw)).read("AU.txt").decode("utf-8").splitlines()
    places = {}
    for line in rows:
        f = line.split("\t")
        if f[4] != "SA" or not f[9]:
            continue
        name, pc, lat, lon = f[2].strip(), f[1], round(float(f[9]), 4), round(float(f[10]), 4)
        key = name.lower()
        if key in places:
            if pc not in places[key][1].split("/"):
                places[key][1] += "/" + pc
            continue
        places[key] = [name, pc, lat, lon]
    out = sorted(places.values(), key=lambda p: p[0])
    found = {p[0] for p in out}
    missing = [r for r in REFERENCE if r not in found]
    if missing:
        print("reference towns not found:", missing, file=sys.stderr)
    data = {"source": "GeoNames postal codes (CC BY 4.0)", "fields": ["name", "postcode", "lat", "lon"],
            "reference": [r for r in REFERENCE if r in found], "places": out}
    path = ROOT / "docs" / "data" / "localities.json"
    path.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False) + "\n")
    print(f"{len(out)} SA localities -> {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
