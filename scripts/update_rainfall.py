#!/usr/bin/env python3
"""Build / update the rainfall data used by the static Goyder's Line widget (docs/).

Source: SILO gridded monthly rainfall (0.05 deg, ~5 km), Queensland Government,
CC BY 4.0. One NetCDF file per year is read from SILO's public S3 bucket:
  https://s3-ap-southeast-2.amazonaws.com/silo-open-data/Official/annual/monthly_rain/YYYY.monthly_rain.nc

Changes we make to the SILO data (noted in the attribution): clipped to South
Australia's agricultural region, summed to calendar-year and growing-season
(Apr-Oct) totals, averaged into baselines, rounded and contoured.

Outputs (in --out, default docs/data):
  annual/YYYY.bin.gz    calendar-year total (year-to-date for the current year), 1 band, mm
  gsr/YYYY.bin.gz       growing-season (Apr-Oct) total (to date if the season is not over), 1 band, mm
  monthly/YYYY.bin.gz   12 monthly bands, mm, for years >= MONTHLY_FROM (missing months = no data)
  clim/AAAA-BBBB.bin.gz 12 bands: mean monthly rainfall for each baseline, 0.1 mm units
  isohyets.geojson      250 mm and 300 mm mean-annual rainfall lines for several eras
  manifest.json         what exists, grid geometry, scales; the widget reads this (nothing is hardcoded)

Grids: little-endian uint16, row 0 = northern edge, 65535 = no data (sea / outside SILO),
gzip-compressed with mtime=0 so unchanged data produce byte-identical files (no noisy commits).

Usage:
  python scripts/update_rainfall.py            # monthly update: refreshes the current and previous year
  python scripts/update_rainfall.py --full     # rebuild everything from 1889 (downloads ~1.9 GB, cached)
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import sys
import urllib.request
import warnings
from pathlib import Path

import contourpy
import netCDF4
import numpy as np

SILO_URL = "https://s3-ap-southeast-2.amazonaws.com/silo-open-data/Official/annual/monthly_rain/{year}.monthly_rain.nc"

# Grid window (SILO cell centres, 0.05 deg). Covers the whole of South Australia:
# WA border (129 E), NT border (26 S), the Limestone Coast (~ -38), and 141 E.
LON_MIN, LON_MAX = 129.0, 141.0
LAT_MIN, LAT_MAX = -38.3, -26.0
RES = 0.05
FIRST_YEAR = 1889          # first year of SILO data
MONTHLY_FROM = 1991        # monthly maps kept from here (older months only feed totals/baselines)
BASELINES = [(1961, 1990), (1991, 2020)]
ISOHYET_MM = [250, 300]
FIXED_ERAS = [(1890, 1919), (1920, 1949), (1950, 1979), (1961, 1990), (1991, 2020)]
NODATA = 65535
ROOT = Path(__file__).resolve().parent.parent


def today_adelaide() -> dt.date:
    return (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=9, minutes=30)).date()


def last_complete_month(today: dt.date) -> tuple[int, int]:
    """SILO publishes with ~1 day lag; the previous calendar month is complete."""
    first = today.replace(day=1)
    prev = first - dt.timedelta(days=1)
    return prev.year, prev.month


def download(year: int, cache: Path, force: bool) -> Path:
    cache.mkdir(parents=True, exist_ok=True)
    path = cache / f"{year}.monthly_rain.nc"
    if path.exists() and path.stat().st_size > 0 and not force:
        return path
    url = SILO_URL.format(year=year)
    print(f"  downloading {url}", flush=True)
    tmp = path.with_suffix(".part")
    with urllib.request.urlopen(url, timeout=300) as r, open(tmp, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    tmp.replace(path)
    return path


def read_year(path: Path) -> np.ndarray:
    """Return float32 array (12, rows, cols), north row first, NaN = no data/missing month."""
    with netCDF4.Dataset(path) as ds:
        lat = ds["lat"][:]
        lon = ds["lon"][:]
        r0 = int(np.argmin(abs(lat - LAT_MIN))); r1 = int(np.argmin(abs(lat - LAT_MAX))) + 1
        c0 = int(np.argmin(abs(lon - LON_MIN))); c1 = int(np.argmin(abs(lon - LON_MAX))) + 1
        var = ds["monthly_rain"]
        data = var[:, r0:r1, c0:c1]
        times = netCDF4.num2date(ds["time"][:], ds["time"].units, ds["time"].calendar)
    out = np.full((12,) + data.shape[1:], np.nan, dtype=np.float32)
    for i, t in enumerate(times):
        out[t.month - 1] = np.ma.filled(data[i].astype(np.float32), np.nan)[::-1, :]
    return out


def encode(bands: np.ndarray, scale: float) -> bytes:
    v = np.where(np.isfinite(bands), np.round(np.nan_to_num(bands) / scale), NODATA)
    v = np.clip(v, 0, NODATA).astype("<u2")
    return gzip.compress(v.tobytes(), compresslevel=9, mtime=0)


def decode(path: Path, scale: float, shape: tuple[int, int]) -> np.ndarray:
    v = np.frombuffer(gzip.decompress(path.read_bytes()), dtype="<u2").reshape((-1,) + shape)
    out = v.astype(np.float32) * scale
    out[v == NODATA] = np.nan
    return out


def write_if_changed(path: Path, data: bytes) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_bytes() == data:
        return False
    path.write_bytes(data)
    return True


def process_year(year: int, months: np.ndarray, n_months: int, out: Path) -> dict:
    """Write annual / gsr / monthly files for one year using its first n_months months."""
    m = months.copy()
    m[n_months:] = np.nan
    land = np.isfinite(months[0]) if n_months else np.zeros(months.shape[1:], bool)
    annual = np.where(land, np.nansum(m[:n_months], axis=0), np.nan)
    gsr_months = [i for i in range(3, 10) if i < n_months]  # Apr(3)..Oct(9)
    info = {"months": n_months}
    write_if_changed(out / "annual" / f"{year}.bin.gz", encode(annual[None], 1))
    if gsr_months:
        gsr = np.where(land, np.nansum(m[gsr_months], axis=0), np.nan)
        write_if_changed(out / "gsr" / f"{year}.bin.gz", encode(gsr[None], 1))
        info["gsrMonths"] = len(gsr_months)
    if year >= MONTHLY_FROM:
        write_if_changed(out / "monthly" / f"{year}.bin.gz", encode(m, 1))
        info["monthly"] = True
    return info


def smooth(a: np.ndarray, passes: int = 2) -> np.ndarray:
    """Light 3x3 NaN-aware box smoothing so contours aren't pixel-jagged."""
    for _ in range(passes):
        v = np.nan_to_num(a); w = np.isfinite(a).astype(np.float32)
        vp = np.pad(v, 1); wp = np.pad(w, 1)
        s = sum(vp[i:i + a.shape[0], j:j + a.shape[1]] for i in range(3) for j in range(3))
        n = sum(wp[i:i + a.shape[0], j:j + a.shape[1]] for i in range(3) for j in range(3))
        a = np.where(np.isfinite(a), s / np.maximum(n, 1), np.nan)
    return a


def isohyet_features(mean: np.ndarray, era: str, kind: str) -> list[dict]:
    rows, cols = mean.shape
    lats = LAT_MAX - np.arange(rows) * RES
    lons = LON_MIN + np.arange(cols) * RES
    z = smooth(mean)
    gen = contourpy.contour_generator(lons, lats, np.ma.masked_invalid(z), line_type="Separate")
    feats = []
    for level in ISOHYET_MM:
        lines = [l for l in gen.lines(level) if len(l) >= 12]  # drop tiny specks
        if not lines:
            continue
        coords = [[[round(float(x), 3), round(float(y), 3)] for x, y in l] for l in lines]
        feats.append({"type": "Feature",
                      "properties": {"era": era, "kind": kind, "mm": level},
                      "geometry": {"type": "MultiLineString", "coordinates": coords}})
    return feats


def last_available(years_info: dict) -> dict:
    """Latest month actually present in the data (SILO can lag a few days)."""
    y = max(int(k) for k, v in years_info.items() if v["months"] > 0)
    return {"year": y, "month": years_info[str(y)]["months"]}


def main() -> int:
    warnings.filterwarnings("ignore", message="Mean of empty slice")  # sea cells are all-NaN
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=ROOT / "docs" / "data")
    ap.add_argument("--cache", type=Path, default=ROOT / ".silo-cache", help="where SILO NetCDF files are kept")
    ap.add_argument("--full", action="store_true", help="rebuild every year and the baselines")
    ap.add_argument("--today", type=dt.date.fromisoformat, help="override today's date (testing)")
    args = ap.parse_args()

    out: Path = args.out
    today = args.today or today_adelaide()
    last_y, last_m = last_complete_month(today)
    manifest_path = out / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else None
    full = args.full or manifest is None
    years_info: dict[str, dict] = {} if full else manifest["years"]

    years = list(range(FIRST_YEAR, last_y + 1)) if full else sorted({last_y - 1, last_y})
    clim_acc = {b: [] for b in BASELINES}
    for y in years:
        print(f"{y}", flush=True)
        path = download(y, args.cache, force=y >= last_y - 1)  # recent years are revised by SILO
        months = read_year(path)
        n = 12 if y < last_y else last_m
        # Guard: only count months SILO actually has.
        while n and not np.isfinite(months[n - 1]).any():
            n -= 1
        years_info[str(y)] = process_year(y, months, n, out)
        for b in BASELINES:
            if b[0] <= y <= b[1]:
                clim_acc[b].append(months)

    rows = int(round((LAT_MAX - LAT_MIN) / RES)) + 1
    cols = int(round((LON_MAX - LON_MIN) / RES)) + 1
    shape = (rows, cols)

    if full:
        for (b0, b1), stack in clim_acc.items():
            clim = np.nanmean(np.stack(stack), axis=0)  # (12, rows, cols)
            write_if_changed(out / "clim" / f"{b0}-{b1}.bin.gz", encode(clim, 0.1))

    # Isohyets from stored annual grids (cheap; no re-download needed).
    complete = sorted(int(y) for y, i in years_info.items() if i["months"] == 12)
    latest = complete[-1]
    eras = [(a, b, f"{a}\u2013{b}", "fixed") for a, b in FIXED_ERAS]
    eras.append((latest - 29, latest, f"Last 30 years ({latest - 29}\u2013{latest})", "recent"))
    eras.append((latest - 9, latest, f"Last 10 years ({latest - 9}\u2013{latest})", "recent"))
    feats, era_list = [], []
    for a, b, label, kind in eras:
        grids = [decode(out / "annual" / f"{y}.bin.gz", 1, shape)[0] for y in range(a, b + 1)]
        mean = np.nanmean(np.stack(grids), axis=0)
        feats += isohyet_features(mean, label, kind)
        era_list.append({"label": label, "start": a, "end": b})
    write_if_changed(out / "isohyets.geojson",
                     json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")).encode())

    new_manifest = {
        "title": "Goyder's Line rainfall data",
        "source": "SILO gridded monthly rainfall, Queensland Government (Long Paddock), CC BY 4.0",
        "changes": "Clipped to SA, summed to annual and growing-season (Apr-Oct) totals, averaged, rounded to 1 mm, contoured.",
        "grid": {"lonMin": LON_MIN, "latMax": LAT_MAX, "res": RES, "rows": rows, "cols": cols,
                 "nodata": NODATA, "dtype": "uint16le", "rowOrder": "north-to-south"},
        "scales": {"annual": 1, "gsr": 1, "monthly": 1, "clim": 0.1},
        "firstYear": FIRST_YEAR,
        "monthlyFrom": MONTHLY_FROM,
        "lastComplete": last_available(years_info),
        "baselines": [f"{a}-{b}" for a, b in BASELINES],
        "isohyetEras": era_list,
        "isohyetLevels": ISOHYET_MM,
        "years": {k: years_info[k] for k in sorted(years_info, key=int)},
    }
    # Only bump 'updated' when the data actually changed.
    old = dict(manifest or {}); old_updated = old.pop("updated", None)
    new_manifest["updated"] = old_updated if old == new_manifest else today.isoformat()
    write_if_changed(manifest_path, (json.dumps(new_manifest, indent=1) + "\n").encode())
    lc = new_manifest["lastComplete"]
    print(f"done: data to {lc['year']}-{lc['month']:02d}, manifest updated {new_manifest['updated']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
