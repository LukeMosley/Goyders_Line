# Goyder's Line

Tools for exploring **Goyder's Line**, the line of "reliable rainfall" that South Australia's
Surveyor-General George Woodroffe Goyder (1826–1898) mapped in late 1865, during the 1863–66 drought
(published 1866). South of the line was judged suitable for cropping and north of it only for grazing.
It roughly follows the 250–300 mm average annual rainfall zone.

The repository contains:

| Folder | What it is |
|---|---|
| `docs/` | **Static map widget** (HTML + vanilla JS + Leaflet, no build step). Intended for GitHub Pages and embedding in an `<iframe>`. |
| `docs/data/` | Pre-processed SILO rainfall grids, baselines, isohyets and a `manifest.json` that the widget reads. |
| `scripts/update_rainfall.py` | Data pipeline: downloads SILO gridded monthly rainfall and rebuilds `docs/data/`. |
| `scripts/build_localities.py` | Builds the SA town/postcode list for the "Find my town" search. |
| `ci/update-rainfall.yml` | GitHub Action that runs the pipeline monthly (copy into `.github/workflows/` to enable). |
| `app.py` | The original Streamlit prototype (monthly rainfall 2015–2026 over Goyder's Line). |

## The map widget (`docs/`)

What it shows:

* **Month**: any month from 1991 to the latest complete month.
* **Growing season**: April–October total for any year since 1889 (labelled "so far" during the season).
* **Year**: calendar-year total for any year since 1889 (year to date for the current year).
* **Long-term average**: average annual or growing-season rainfall over 5, 10, 20 or 30 years ending in any year.
* **% of average**: switches any view to a percentage of the 1961–1990 or 1991–2020 average (brown = drier, teal = wetter).
* **250 mm and 300 mm rainfall lines** (average annual isohyets) for two chosen periods (1890–1919, 1920–1949,
  1950–1979, 1961–1990, 1991–2020, last 30 years, last 10 years), drawn with Goyder's Line so you can see whether
  the rainfall boundary has moved.
* **Find my town** (SA localities and postcodes) and **click/tap anywhere** to see how far north or south of
  Goyder's Line the point is, its rainfall for the current view, and the long-term average.
* Street map (OpenStreetMap, default) or satellite basemap, labelled reference towns, colour-blind-safe palettes
  (viridis; BrBG for anomalies), and a legend with tick marks.
* Controls are in a left-hand panel, in a simple order: find your town, choose what to show, pick the time. Advanced choices (the average period, how many years, the 250/300 mm line dates, shading) sit under **More options**, with sensible defaults. The default basemap is satellite imagery with place names, and a street map is one click away.
* The view is saved in the URL hash (e.g. `#view=annual&year=2019&display=pct`), so you can link to or embed a
  specific map. Add `?compact` to hide the introduction text.

Run it locally: `cd docs && python -m http.server 8000`, then open http://localhost:8000.

### Embedding

Once GitHub Pages is enabled (Settings → Pages → *Deploy from a branch* → `main` / `/docs`), the widget will be at
`https://lukemosley.github.io/Goyders_Line/`. The layout is a left-hand panel (about 320–340 px) with the map filling
the rest of the window, so the whole of South Australia fits on a typical laptop. On phones the map sits first
(about 65% of the screen height) with the controls underneath. Embed it with:

```html
<iframe src="https://lukemosley.github.io/Goyders_Line/"
        title="Goyder's Line and South Australian rainfall map"
        class="goyder-map" loading="lazy"
        style="width:100%;height:720px;border:0;display:block"></iframe>
<style>@media (max-width:699px){.goyder-map{height:1200px!important}}</style>
```

720 px high is enough on a desktop or laptop because the map uses almost the full iframe height. On a phone the
iframe needs to be taller (about 1100 px) so the map and the controls below it both fit. The page is static, so it
never "sleeps" (unlike Streamlit Community Cloud), loads in about a second, and works full-width on phones.
`docs/embed-example.html` shows the snippet on a test page.

### How the data are built

`scripts/update_rainfall.py` reads SILO's yearly NetCDF files of gridded monthly rainfall
(`https://s3-ap-southeast-2.amazonaws.com/silo-open-data/Official/annual/monthly_rain/YYYY.monthly_rain.nc`, 0.05° ≈ 5 km).
It clips each file to 129–141 °E and 26.0–38.3 °S (the whole of South Australia, including the Far North and
the Limestone Coast), then writes:

* `annual/YYYY.bin.gz` and `gsr/YYYY.bin.gz`: calendar-year and April–October totals for **every year from 1889**.
* `monthly/YYYY.bin.gz`: 12 monthly grids for **1991 onward** only. Older months are used for the totals and baselines
  but aren't kept as monthly maps, to keep the repository small.
* `clim/1961-1990.bin.gz` and `clim/1991-2020.bin.gz`: mean monthly rainfall for each baseline. Annual and
  season baselines are sums of these, so "% of average" also works for part-years.
* `isohyets.geojson`: 250 mm and 300 mm contours of mean annual rainfall for each period (lightly smoothed).
* `manifest.json`: grid geometry, available years and months, baselines and periods. The widget reads this, so years
  are never hard-coded.

Grids are little-endian `uint16` (row 0 = north, 65535 = no data) and gzip-compressed. The widget decompresses them
in the browser. Altogether they take about 18 MB, plus about 0.3 MB a month of new data.

```bash
pip install -r scripts/requirements-data.txt
python scripts/update_rainfall.py          # monthly update (refreshes the current and previous year, ~25 MB download)
python scripts/update_rainfall.py --full   # full rebuild from 1889 (~1.9 GB download, cached in .silo-cache/)
```

### Automatic monthly updates

`ci/update-rainfall.yml` runs the update on the 5th of each month (Adelaide time) and commits any new data, and
GitHub Pages then republishes the site. To turn it on, copy it to `.github/workflows/update-rainfall.yml` on `main`
(on GitHub: *Add file → Create new file*, paste it in, and commit), then check that *Settings → Actions → General →
Workflow permissions* allows **Read and write**. You can also start it by hand from the Actions tab (*Run workflow*).

## Data sources and attribution

* **Rainfall:** [SILO](https://www.longpaddock.qld.gov.au/silo/), Queensland Government (Long Paddock), licensed
  under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). *Changes made:* clipped to South Australia,
  summed to annual and growing-season totals, averaged into baselines and multi-year means, rounded to 1 mm and
  contoured into isohyets. SILO is interpolated from Bureau of Meteorology and other rain gauges. Station coverage
  in the north was sparse before about 1900, and SILO advises that its data aren't designed for formal
  climate-change detection, so treat the older isohyets as indicative.
* **Goyder's Line:** South Australian Department for Environment and Water (dataset `TOPO.GoydersLine`, digitised
  from the 1993 *Pastoral Areas of South Australia* map). Location SA lists its licence as "not yet determined", so
  credit DEW and check before reusing it outside this project.
* **Portrait of G. W. Goyder:** State Library of South Australia, B 496 (about 1895), no known copyright restrictions.
* **Town and postcode locations:** [GeoNames](https://www.geonames.org/) postal codes, CC BY 4.0.
* **Basemaps:** © OpenStreetMap contributors; satellite imagery © Esri, Maxar, Earthstar Geographics.
  For high traffic, consider a tile provider with a usage plan (OSM's public tiles are for light use).
* **Map library:** [Leaflet](https://leafletjs.com) 1.9.4 and [fflate](https://github.com/101arrowz/fflate)
  (both bundled in `docs/vendor/`, BSD-2 and MIT licences).

## Streamlit prototype

`app.py` is the original Streamlit app (`streamlit run app.py`). It shows monthly SILO rainfall images for 2015–2026
from `rainfall_overlays/`. Those images are not updated automatically. The static widget above replaces it.
