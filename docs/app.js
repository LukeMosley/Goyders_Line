/* Goyder's Line rainfall widget. Vanilla JS + Leaflet, no build step.
   Data: data/manifest.json describes everything; grids are gzipped uint16 (see scripts/update_rainfall.py). */
(function () {
  'use strict';
  const DATA = 'data/';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  // Colour-blind-safe palettes: viridis (sequential, dry = yellow, wet = purple) and BrBG (diverging).
  const RAIN = ['#fde725', '#b5de2b', '#6ece58', '#35b779', '#1f9e89', '#26828e', '#31688e', '#3e4989', '#482878', '#440154'];
  const DIVERGE = ['#543005', '#8c510a', '#bf812d', '#dfc27d', '#f6e8c3', '#c7eae5', '#80cdc1', '#35978f', '#01665e', '#003c30'];
  const BREAKS = {
    monthly: [5, 10, 15, 25, 40, 60, 80, 100, 150],
    gsr: [100, 150, 200, 250, 300, 350, 400, 500, 600],
    annual: [150, 200, 250, 300, 350, 400, 500, 600, 800],
    pct: [40, 60, 80, 90, 100, 110, 120, 140, 160],
  };
  const ERA_STYLE = [{ color: '#111', label: 'black' }, { color: '#ff9f1c', label: 'gold' }];
  // All of South Australia (WA border to 141 E, NT border to the Limestone Coast).
  // Agricultural SA plus the Far North (Ceduna to the Vic border, Mt Gambier to the NT border).
  // Excludes the far-west Nullarbor/ocean so the farming country fills the map.
  const SA_BOUNDS = [[-38.12, 132.35], [-26.05, 141.02]];

  let M, G, map, rainLayer, lineGroup, isoGroup, townGroup, pickMarker, places = [], gyLines = [], southPoly = [];
  const cache = new Map();
  const S = { view: 'multi', year: null, month: null, len: 30, end: null, measure: 'annual', display: 'mm', baseline: '1991-2020',
    eraA: null, eraB: null, line: true, iso: true, iso250: false, towns: true, opacity: 0.75 };
  let current = null;
  let renderToken = 0;

  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, html) => { const e = document.createElement(tag); Object.assign(e, attrs); if (html != null) e.innerHTML = html; return e; };

  async function getJSON(p) { const r = await fetch(DATA + p); if (!r.ok) throw new Error(p + ' ' + r.status); return r.json(); }
  async function gunzip(buf) {
    const u8 = new Uint8Array(buf);
    if (!(u8[0] === 0x1f && u8[1] === 0x8b)) return u8;
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip')));
      return new Uint8Array(await ds.arrayBuffer());
    }
    return window.fflate.gunzipSync(u8);
  }
  function loadGrid(path, scale) {
    if (cache.has(path)) return cache.get(path);
    const p = (async () => {
      const r = await fetch(DATA + path);
      if (!r.ok) throw new Error('Missing data file ' + path);
      const raw = await gunzip(await r.arrayBuffer());
      const u16 = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
      const n = G.rows * G.cols, bands = [];
      for (let b = 0; b < u16.length / n; b++) {
        const f = new Float32Array(n);
        for (let i = 0; i < n; i++) { const v = u16[b * n + i]; f[i] = v === G.nodata ? NaN : v * scale; }
        bands.push(f);
      }
      return bands;
    })();
    cache.set(path, p);
    p.catch(() => cache.delete(path));
    return p;
  }
  const sumBands = (bands, idx) => {
    const n = G.rows * G.cols, out = new Float32Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (const b of idx) s += bands[b][i]; out[i] = s; }
    return out;
  };
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const yinfo = (y) => M.years[String(y)];
  const completeYears = () => Object.keys(M.years).map(Number).filter((y) => M.years[y].months === 12);
  const gsrYears = () => Object.keys(M.years).map(Number).filter((y) => M.years[y].gsrMonths);
  const monthlyYears = () => Object.keys(M.years).map(Number).filter((y) => M.years[y].monthly && M.years[y].months > 0);

  async function buildLayer() {
    const clim = await loadGrid('clim/' + S.baseline + '.bin.gz', M.scales.clim);
    const bl = S.baseline.replace('-', '\u2013');
    if (S.view === 'monthly') {
      const bands = await loadGrid('monthly/' + S.year + '.bin.gz', M.scales.monthly);
      return { values: bands[S.month - 1], base: clim[S.month - 1], kind: 'monthly',
        title: `Rain in ${MONTHS_LONG[S.month - 1]} ${S.year}`, short: `${MONTHS[S.month - 1]} ${S.year}`,
        baseLabel: `${MONTHS_LONG[S.month - 1]} average ${bl}` };
    }
    if (S.view === 'gsr') {
      const n = yinfo(S.year).gsrMonths, part = n < 7;
      const [v] = await loadGrid('gsr/' + S.year + '.bin.gz', M.scales.gsr);
      const lastM = MONTHS[3 + n - 1];
      return { values: v, base: sumBands(clim, range(3, 3 + n - 1)), kind: 'gsr',
        title: `Growing-season rain ${S.year} (Apr\u2013${lastM}${part ? ', so far' : ''})`, short: `Apr\u2013${lastM} ${S.year}`,
        baseLabel: `Apr\u2013${lastM} average ${bl}` };
    }
    if (S.view === 'annual') {
      const n = yinfo(S.year).months, part = n < 12;
      const [v] = await loadGrid('annual/' + S.year + '.bin.gz', M.scales.annual);
      return { values: v, base: sumBands(clim, range(0, n - 1)), kind: 'annual',
        title: part ? `Rain in ${S.year} so far (Jan\u2013${MONTHS[n - 1]})` : `Rain in ${S.year}`,
        short: part ? `Jan\u2013${MONTHS[n - 1]} ${S.year}` : `${S.year}`,
        baseLabel: part ? `Jan\u2013${MONTHS[n - 1]} average ${bl}` : `Annual average ${bl}` };
    }
    const isG = S.measure === 'gsr';
    const start = S.end - S.len + 1;
    const grids = await Promise.all(range(start, S.end).map((y) => loadGrid((isG ? 'gsr/' : 'annual/') + y + '.bin.gz', 1).then((b) => b[0])));
    const n = G.rows * G.cols, out = new Float32Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (const g of grids) s += g[i]; out[i] = s / grids.length; }
    return { values: out, base: isG ? sumBands(clim, range(3, 9)) : sumBands(clim, range(0, 11)), kind: isG ? 'gsr' : 'annual',
      title: `Average ${isG ? 'growing-season (Apr\u2013Oct)' : 'annual'} rain ${start}\u2013${S.end} (${S.len} years)`,
      short: `${start}\u2013${S.end} avg`,
      baseLabel: `${isG ? 'Apr\u2013Oct' : 'Annual'} average ${bl}` };
  }

  const classOf = (v, br) => { let i = 0; while (i < br.length && v >= br[i]) i++; return i; };
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const displayValue = (L, i) => {
    const v = L.values[i];
    if (S.display === 'pct') { const b = L.base[i]; return b > 0.5 ? (100 * v) / b : NaN; }
    return v;
  };

  // Mercator-aligned canvas so 5 km cells sit in the right place. Ocean / no-data stays fully transparent
  // so the overlay does not draw a rectangle over the sea.
  function renderImage(L) {
    const br = S.display === 'pct' ? BREAKS.pct : BREAKS[L.kind];
    const pal = (S.display === 'pct' ? DIVERGE : RAIN).map(hex);
    const { rows, cols, res, lonMin, latMax } = G;
    const north = latMax + res / 2, south = latMax - (rows - 1) * res - res / 2;
    const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const yN = merc(north), yS = merc(south);
    const H = rows * 2, W = cols;
    const cv = el('canvas', { width: W, height: H });
    const ctx = cv.getContext('2d'), img = ctx.createImageData(W, H);
    for (let j = 0; j < H; j++) {
      const y = yN - ((j + 0.5) / H) * (yN - yS);
      const lat = (360 / Math.PI) * Math.atan(Math.exp(y)) - 90;
      const r = Math.min(rows - 1, Math.max(0, Math.floor((north - lat) / res)));
      for (let c = 0; c < W; c++) {
        const o = (j * W + c) * 4;
        const lon = lonMin + c * res;
        const v = (lon > 141.01 || lon < 128.99) ? NaN : displayValue(L, r * cols + c);
        if (!Number.isFinite(v)) { img.data[o + 3] = 0; continue; }
        const p = pal[classOf(v, br)];
        img.data[o] = p[0]; img.data[o + 1] = p[1]; img.data[o + 2] = p[2]; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const bounds = [[south, lonMin - res / 2], [north, lonMin + (cols - 1) * res + res / 2]];
    return { url: cv.toDataURL('image/png'), bounds };
  }

  function drawLegend(L) {
    const pct = S.display === 'pct';
    const br = pct ? BREAKS.pct : BREAKS[L.kind], pal = pct ? DIVERGE : RAIN;
    const unit = pct ? '%' : 'mm';
    const ttl = pct ? `${L.title} as % of ${L.baseLabel.replace(/^.*average /, '')} average` : `${L.title} (mm)`;
    const n = pal.length;
    const ticks = br.map((b, i) => (i % 2 === 0 ? `<span style="left:${((i + 1) / n) * 100}%">${b}</span>` : '')).join('');
    const keys = [];
    if (S.line) keys.push(`<span class="key"><i style="border-color:#8B0000;box-shadow:0 0 0 1px #fff"></i>Goyder's Line (1865)</span>`);
    if (S.iso) {
      [S.eraA, S.eraB].forEach((e, k) => {
        if (e != null) keys.push(`<span class="key"><i style="border-color:${ERA_STYLE[k].color}"></i>${eraLabel(e)}: 300&nbsp;mm</span>`);
      });
    }
    if (S.iso250) keys.push(`<span class="key"><i style="border-color:#333;border-top-style:dashed"></i>250&nbsp;mm (optional)</span>`);
    $('legend').innerHTML = `<div class="ttl">${ttl}</div><div class="bar">${pal.map((c) => `<span style="background:${c}"></span>`).join('')}</div>` +
      `<div class="ticks">${ticks}<span style="left:100%">${unit}</span></div>` + (keys.length ? `<div class="keys">${keys.join('')}</div>` : '');
    const t = $('legend').querySelector('.ticks');
    if (t && t.firstChild) t.firstChild.style.transform = 'translateX(-50%)';
  }
  const eraLabel = (i) => M.isohyetEras[i].label;

  async function refresh() {
    const token = ++renderToken;
    writeHash();
    syncControls();
    $('status').textContent = 'Loading rainfall\u2026';
    try {
      const L = await buildLayer();
      if (token !== renderToken) return;
      current = L;
      const { url, bounds } = renderImage(L);
      if (rainLayer) rainLayer.setUrl(url).setBounds(bounds);
      else rainLayer = window.L.imageOverlay(url, bounds, { opacity: S.opacity, pane: 'rain', interactive: false, className: 'rain-img' }).addTo(map);
      drawLegend(L);
      drawIso();
      const lc = M.lastComplete;
      $('status').textContent = `Showing: ${L.title}. SILO data to the end of ${MONTHS_LONG[lc.month - 1]} ${lc.year}; updated ${M.updated}.`;
      if (pickMarker && pickMarker.isPopupOpen()) pickMarker.setPopupContent(popupHtml(pickMarker.getLatLng(), pickMarker.options.place));
    } catch (e) {
      console.error(e);
      if (token === renderToken) $('status').innerHTML = `<span class="err">Could not load rainfall data (${e.message}).</span>`;
    }
  }

  function option(v, t, sel) { return `<option value="${v}"${sel ? ' selected' : ''}>${t}</option>`; }
  function syncControls() {
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === S.view)));
    $('t-pct').checked = S.display === 'pct';
    $('pct-hint').hidden = S.display !== 'pct';
    const box = $('period-selects');
    let html = '';
    if (S.view === 'monthly') {
      const ys = monthlyYears();
      html += `<select id="sel-month" aria-label="Month">${MONTHS.map((m, i) => option(i + 1, m, i + 1 === S.month)).join('')}</select>`;
      html += `<select id="sel-year" aria-label="Year">${ys.slice().reverse().map((y) => option(y, y, y === S.year)).join('')}</select>`;
      $('time-hint').textContent = 'Use the arrows to step month by month.';
    } else if (S.view === 'gsr' || S.view === 'annual') {
      const ys = S.view === 'gsr' ? gsrYears() : Object.keys(M.years).map(Number);
      const label = (y) => {
        let t = String(y);
        if (S.view === 'annual' && yinfo(y).months < 12) t += ' (so far)';
        if (S.view === 'gsr' && yinfo(y).gsrMonths < 7) t += ' (so far)';
        return t;
      };
      html += `<select id="sel-year" aria-label="Year">${ys.slice().reverse().map((y) => option(y, label(y), y === S.year)).join('')}</select>`;
      $('time-hint').textContent = 'Use the arrows to step year by year.';
    } else {
      const cy = completeYears();
      html += `<select id="sel-end" aria-label="Years shown">${cy.filter((y) => y - S.len + 1 >= cy[0]).reverse().map((y) => option(y, `${y - S.len + 1}\u2013${y}`, y === S.end)).join('')}</select>`;
      $('time-hint').textContent = 'The map shows the average over this run of years. Change the length under More options.';
    }
    box.innerHTML = html;
    const on = (id, f) => { const e = $(id); if (e) e.onchange = () => { f(e.value); refresh(); }; };
    on('sel-month', (v) => (S.month = +v));
    on('sel-year', (v) => { S.year = +v; if (S.view === 'monthly') S.month = Math.min(S.month, yinfo(S.year).months); });
    on('sel-end', (v) => (S.end = +v));
    $('sel-measure').value = S.measure;
    $('sel-len').value = String(S.len);
    $('measure-wrap').style.display = $('len-wrap').style.display = S.view === 'multi' ? '' : 'none';
    $('prev').disabled = !canStep(-1); $('next').disabled = !canStep(1);
    $('t-line').checked = S.line; $('t-iso').checked = S.iso; $('t-iso250').checked = S.iso250; $('t-towns').checked = S.towns;
    $('eraA').value = S.eraA ?? ''; $('eraB').value = S.eraB ?? '';
    $('eraA').disabled = $('eraB').disabled = !(S.iso || S.iso250);
    $('baseline').value = S.baseline;
    $('opacity').value = String(S.opacity);
  }
  function stepState(dir) {
    const s = { ...S };
    if (s.view === 'monthly') {
      let m = s.month + dir, y = s.year;
      if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
      const yi = yinfo(y);
      if (!yi || !yi.monthly || m > yi.months) return null;
      s.month = m; s.year = y;
    } else if (s.view === 'multi') {
      const cy = completeYears(), e = s.end + dir;
      if (e > cy[cy.length - 1] || e - s.len + 1 < cy[0]) return null;
      s.end = e;
    } else {
      const ys = s.view === 'gsr' ? gsrYears() : Object.keys(M.years).map(Number);
      if (!ys.includes(s.year + dir)) return null;
      s.year += dir;
    }
    return s;
  }
  const canStep = (d) => !!stepState(d);
  function step(d) { const s = stepState(d); if (s) { Object.assign(S, s); refresh(); } }

  function setView(v) {
    const last = M.lastComplete;
    if (v === 'monthly' && (!S.year || !yinfo(S.year)?.monthly || S.view !== 'monthly')) { S.year = last.year; S.month = last.month; }
    if ((v === 'annual' || v === 'gsr') && (S.view === 'monthly' || S.view === 'multi' || !S.year)) {
      const ys = v === 'gsr' ? gsrYears() : completeYears();
      S.year = ys[ys.length - 1];
    }
    S.view = v; refresh();
  }

  function prepLine(gj) {
    gyLines = gj.features.map((f) => f.geometry.coordinates);
    const a = gyLines[0], b = gyLines[1];
    const west = a[0], east = b[b.length - 1];
    southPoly = [...a, ...b, [143, east[1]], [143, -40], [128, -40], [128, west[1]], west];
  }
  function inPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function distKm(lat, lon) {
    const kx = 111.32 * Math.cos((lat * Math.PI) / 180), ky = 110.57;
    let best = Infinity;
    for (const line of gyLines) for (let i = 1; i < line.length; i++) {
      const ax = (line[i - 1][0] - lon) * kx, ay = (line[i - 1][1] - lat) * ky, bx = (line[i][0] - lon) * kx, by = (line[i][1] - lat) * ky;
      const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return best;
  }
  function cellIndex(lat, lon) {
    const r = Math.round((G.latMax - lat) / G.res), c = Math.round((lon - G.lonMin) / G.res);
    if (r < 0 || c < 0 || r >= G.rows || c >= G.cols) return -1;
    return r * G.cols + c;
  }
  function nearestPlace(lat, lon, maxKm) {
    let best = null, bd = maxKm;
    const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
    for (const p of places) { const d = Math.hypot((p[3] - lon) * kx, (p[2] - lat) * 110.57); if (d < bd) { bd = d; best = p; } }
    return best;
  }
  const fmt = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-AU') : '\u2013');
  function hasRain(lat, lng) {
    const i = cellIndex(lat, lng);
    return current && i >= 0 && Number.isFinite(current.values[i]);
  }
  function popupHtml(ll, place) {
    const { lat, lng } = ll;
    const near = nearestPlace(lat, lng, 8);
    const name = place ? `${place[0]} <small>${place[1]}</small>` : (near ? `Near ${near[0]}` : `${lat.toFixed(3)}, ${lng.toFixed(3)}`);
    if (!hasRain(lat, lng)) {
      return `<div class="pop"><h3>${name}</h3><p>This point is outside the mapped land area, so rainfall is not shown.</p></div>`;
    }
    const d = distKm(lat, lng), south = inPoly(lng, lat, southPoly);
    const side = d < 2 ? `<p>Right on Goyder's Line.</p>` :
      `<p class="${south ? 'side-s' : 'side-n'}">About <b>${fmt(d)} km ${south ? 'south' : 'north'}</b> of Goyder's Line (${south ? 'the cropping side' : 'the grazing side'}).</p>`;
    const i = cellIndex(lat, lng);
    const v = current.values[i], b = current.base[i];
    const rain = `<p>${current.title}:<br><span class="big">${fmt(v)} mm</span></p>` +
      (b > 0.5 ? `<p>${current.baseLabel}: ${fmt(b)} mm &rarr; <b>${fmt((100 * v) / b)}%</b> of average</p>` : '');
    return `<div class="pop"><h3>${name}</h3>${side}${rain}</div>`;
  }
  function pick(latlng, place) {
    if (pickMarker) map.removeLayer(pickMarker);
    pickMarker = window.L.circleMarker(latlng, { radius: 7, color: '#fff', weight: 2, fillColor: '#C2703D', fillOpacity: 1, place }).addTo(map);
    pickMarker.bindPopup(() => popupHtml(pickMarker.getLatLng(), place), { maxWidth: 280, autoPanPadding: [20, 20] }).openPopup();
  }

  let isoData = null;
  function drawIso() {
    isoGroup.clearLayers();
    if ((!S.iso && !S.iso250) || !isoData) return;
    const drawLevel = (mm, dashed) => {
      [S.eraA, S.eraB].forEach((e, k) => {
        if (e == null || e === '') return;
        const label = eraLabel(e);
        isoData.features.filter((f) => f.properties.era === label && f.properties.mm === mm).forEach((f) => {
          const latlngs = f.geometry.coordinates.map((l) => l.map(([x, y]) => [y, x]));
          const casing = dashed ? 4 : 5, weight = dashed ? 2 : 2.8;
          window.L.polyline(latlngs, { pane: 'iso', color: '#fff', weight: casing, opacity: 0.9, dashArray: dashed ? '7 6' : null, interactive: false }).addTo(isoGroup);
          window.L.polyline(latlngs, { pane: 'iso', color: ERA_STYLE[k].color, weight, dashArray: dashed ? '7 6' : null })
            .bindTooltip(`${mm} mm average annual rainfall, ${label}`, { sticky: true }).addTo(isoGroup);
        });
      });
    };
    // Draw the optional 250 mm line first so the default 300 mm line stays on top.
    if (S.iso250) drawLevel(250, true);
    if (S.iso) drawLevel(300, false);
  }
  function drawLine(gj) {
    window.L.geoJSON(gj, { pane: 'line', style: { color: '#fff', weight: 10, opacity: 0.95 }, interactive: false }).addTo(lineGroup);
    window.L.geoJSON(gj, { pane: 'line', style: { color: '#8B0000', weight: 5, opacity: 1 } })
      .bindTooltip("<b>Goyder's Line</b> (surveyed 1865)<br>Goyder's limit of reliable rainfall for cropping", { sticky: true }).addTo(lineGroup);
  }
  const MAJOR = ['Ceduna', 'Streaky Bay', 'Kimba', 'Port Lincoln', 'Whyalla', 'Port Augusta', 'Coober Pedy',
    'Hawker', 'Clare', 'Adelaide', 'Murray Bridge', 'Renmark', 'Keith', 'Mount Gambier', 'Kingscote', 'Oodnadatta'];
  let minorGroup;
  function drawTowns(loc) {
    const byName = new Map(loc.places.map((p) => [p[0], p]));
    minorGroup = window.L.layerGroup();
    loc.reference.forEach((n) => {
      const p = byName.get(n); if (!p) return;
      window.L.circleMarker([p[2], p[3]], { pane: 'towns', radius: 3.5, color: '#111', weight: 1, fillColor: '#fff', fillOpacity: 1 })
        .bindTooltip(n, { permanent: true, direction: 'right', offset: [4, 0], className: 'town-label' })
        .on('click', (e) => { window.L.DomEvent.stopPropagation(e); pick(e.latlng, p); })
        .addTo(MAJOR.includes(n) ? townGroup : minorGroup);
    });
    const upd = () => { if (S.towns && map.getZoom() >= 7.5) minorGroup.addTo(map); else map.removeLayer(minorGroup); };
    map.on('zoomend', upd); upd();
    townGroup.on('add remove', upd);
  }
  function toggle(layer, on) { if (on) layer.addTo(map); else map.removeLayer(layer); }

  function setupSearch() {
    const input = $('search'), list = $('search-results');
    let hits = [], sel = -1;
    const show = () => {
      list.innerHTML = hits.map((p, i) => `<li role="option" data-i="${i}" aria-selected="${i === sel}">${p[0]} <small>SA ${p[1]}</small></li>`).join('');
      list.hidden = !hits.length;
    };
    const choose = (p) => { input.value = p[0]; hits = []; show(); map.setView([p[2], p[3]], Math.max(map.getZoom(), 9)); pick([p[2], p[3]], p); };
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      sel = -1;
      if (q.length < 2) { hits = []; return show(); }
      const starts = [], contains = [];
      for (const p of places) {
        const n = p[0].toLowerCase();
        if (n.startsWith(q) || p[1].split('/').some((pc) => pc.startsWith(q))) starts.push(p);
        else if (n.includes(q)) contains.push(p);
        if (starts.length > 10) break;
      }
      hits = starts.concat(contains).slice(0, 10); show();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(hits.length - 1, sel + 1); show(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); show(); e.preventDefault(); }
      else if (e.key === 'Enter') { if (hits.length) choose(hits[Math.max(sel, 0)]); e.preventDefault(); }
      else if (e.key === 'Escape') { hits = []; show(); }
    });
    list.addEventListener('mousedown', (e) => { const li = e.target.closest('li'); if (li) { e.preventDefault(); choose(hits[+li.dataset.i]); } });
    input.addEventListener('blur', () => setTimeout(() => { hits = []; show(); }, 150));
  }

  const HASH_KEYS = ['view', 'year', 'month', 'len', 'end', 'measure', 'display', 'baseline', 'eraA', 'eraB', 'iso', 'iso250'];
  function writeHash() {
    const p = new URLSearchParams();
    HASH_KEYS.forEach((k) => {
      if (S[k] == null || S[k] === '') return;
      p.set(k, (typeof S[k] === 'boolean') ? (S[k] ? '1' : '0') : S[k]);
    });
    history.replaceState(null, '', '#' + p.toString());
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    HASH_KEYS.forEach((k) => {
      if (!p.has(k)) return;
      const v = p.get(k);
      if (k === 'iso' || k === 'iso250') S[k] = !(v === '0' || v === 'false' || v === '');
      else S[k] = ['year', 'month', 'len', 'end', 'eraA', 'eraB'].includes(k) ? (v === '' ? null : +v) : v;
    });
    if (new URLSearchParams(location.search).has('compact')) document.body.classList.add('compact');
  }
  function validateState() {
    const cy = completeYears(), last = M.lastComplete;
    if (!['monthly', 'gsr', 'annual', 'multi'].includes(S.view)) S.view = 'multi';
    if (![5, 10, 20, 30].includes(S.len)) S.len = 30;
    if (!S.end || !cy.includes(S.end) || S.end - S.len + 1 < cy[0]) S.end = cy[cy.length - 1];
    if (!M.baselines.includes(S.baseline)) S.baseline = M.baselines[M.baselines.length - 1];
    if (S.view === 'monthly') { const yi = yinfo(S.year); if (!yi || !yi.monthly) { S.year = last.year; S.month = last.month; } S.month = Math.min(Math.max(1, S.month || 1), yinfo(S.year).months); }
    if (S.view === 'annual' && !yinfo(S.year)) S.year = cy[cy.length - 1];
    if (S.view === 'gsr' && !(yinfo(S.year) || {}).gsrMonths) { const g = gsrYears(); S.year = g[g.length - 1]; }
    const ne = M.isohyetEras.length;
    if (S.eraA == null || S.eraA >= ne) S.eraA = 0;
    if (S.eraB == null || S.eraB >= ne) S.eraB = M.isohyetEras.findIndex((e) => /^Last 30/.test(e.label));
    if (!['mm', 'pct'].includes(S.display)) S.display = 'mm';
    S.iso = S.iso !== false && S.iso !== 0 && S.iso !== '0';
    S.iso250 = S.iso250 === true || S.iso250 === 1 || S.iso250 === '1';
  }

  function fitSA() {
    map.invalidateSize();
    map.fitBounds(SA_BOUNDS, { paddingTopLeft: [4, 8], paddingBottomRight: [8, 88], animate: false });
  }

  let baseLayers = { osm: null, sat: null };

  const SITE_URL = 'https://lukemosley.github.io/Goyders_Line/';
  const isIOS = () => /iP(ad|hone|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function viewTitle(L) {
    const pct = S.display === 'pct';
    return pct ? `${L.title} as % of ${L.baseLabel.replace(/^.*average /, '')} average` : L.title;
  }
  function exportFilename() {
    const bits = ['goyders-line'];
    if (S.view === 'monthly') bits.push('monthly', `${S.year}-${String(S.month).padStart(2, '0')}`);
    else if (S.view === 'annual') bits.push('annual', String(S.year));
    else if (S.view === 'gsr') bits.push('gsr', String(S.year));
    else bits.push(S.measure === 'gsr' ? 'average-gsr' : 'average-annual', `${S.end - S.len + 1}-${S.end}`);
    if (S.display === 'pct') bits.push('pct');
    return bits.join('_') + '.png';
  }
  function wrapText(ctx, text, maxWidth) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > maxWidth && line) { lines.push(line); line = w; }
      else line = t;
    }
    if (line) lines.push(line);
    return lines;
  }
  function toast(msg, ms) {
    let t = $('png-toast');
    if (!t) {
      t = el('div', { id: 'png-toast', className: 'png-toast', role: 'status' });
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.hidden = false;
    t.classList.add('show');
    clearTimeout(toast._tm);
    if (ms !== 0) toast._tm = setTimeout(() => { t.classList.remove('show'); t.hidden = true; }, ms || 4000);
  }
  function setExporting(on) {
    document.querySelectorAll('.png-btn, .png-control a').forEach((b) => {
      b.classList.toggle('busy', on);
      b.setAttribute('aria-busy', String(on));
      if (b.tagName === 'BUTTON' || b.tagName === 'A') {
        if (on) { if (!b.dataset.label) b.dataset.label = b.textContent; b.textContent = 'Saving\u2026'; }
        else if (b.dataset.label) b.textContent = b.dataset.label;
      }
    });
  }

  function waitForTiles(ms) {
    const limit = ms || 5000;
    return new Promise((resolve) => {
      const t0 = performance.now();
      const check = () => {
        let loading = 0;
        map.eachLayer((l) => {
          if (!l._tiles) return;
          Object.values(l._tiles).forEach((t) => {
            const img = t.el;
            if (img && img.tagName === 'IMG' && t.active && !img.complete) loading++;
          });
        });
        const rain = rainLayer && rainLayer.getElement();
        if (rain && !rain.complete) loading++;
        if (loading === 0 || performance.now() - t0 > limit) resolve();
        else setTimeout(check, 80);
      };
      check();
    });
  }

  function landSeaCanvas() {
    const { rows, cols } = G;
    const cv = el('canvas', { width: cols, height: rows });
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(cols, rows);
    const src = current && current.values;
    for (let i = 0; i < rows * cols; i++) {
      const o = i * 4;
      const land = src ? Number.isFinite(src[i]) : false;
      if (land) { img.data[o] = 230; img.data[o + 1] = 220; img.data[o + 2] = 200; img.data[o + 3] = 255; }
      else { img.data[o] = 142; img.data[o + 1] = 182; img.data[o + 2] = 200; img.data[o + 3] = 255; }
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  function overlayRect(bounds, scale) {
    const sw = map.latLngToContainerPoint(bounds.getSouthWest());
    const ne = map.latLngToContainerPoint(bounds.getNorthEast());
    return { x: sw.x * scale, y: ne.y * scale, w: (ne.x - sw.x) * scale, h: (sw.y - ne.y) * scale };
  }

  async function paintBasemap(ctx, scale) {
    const mapRect = map.getContainer().getBoundingClientRect();
    const layers = [];
    map.eachLayer((l) => { if (l._tiles) layers.push(l); });
    layers.sort((a, b) => {
      const za = parseInt((a.getPane() && a.getPane().style.zIndex) || 200, 10);
      const zb = parseInt((b.getPane() && b.getPane().style.zIndex) || 200, 10);
      return za - zb;
    });
    const jobs = [];
    layers.forEach((layer) => {
      Object.values(layer._tiles).forEach((tile) => {
        const img = tile.el;
        if (!img || img.tagName !== 'IMG' || !img.complete || img.naturalWidth === 0) return;
        const r = img.getBoundingClientRect();
        if (r.right < mapRect.left || r.left > mapRect.right || r.bottom < mapRect.top || r.top > mapRect.bottom) return;
        jobs.push({ el: img, url: img.currentSrc || img.src, dx: r.left - mapRect.left, dy: r.top - mapRect.top, dw: r.width, dh: r.height });
      });
    });
    if (!jobs.length) return false;

    const W = map.getSize().x * scale, H = map.getSize().y * scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();

    const tryDom = () => {
      const t = document.createElement('canvas');
      t.width = t.height = 2;
      const c = t.getContext('2d');
      c.drawImage(jobs[0].el, 0, 0, 2, 2);
      c.getImageData(0, 0, 1, 1);
      jobs.forEach((j) => ctx.drawImage(j.el, j.dx * scale, j.dy * scale, j.dw * scale, j.dh * scale));
    };
    try {
      tryDom();
      ctx.restore();
      return true;
    } catch (e) { /* tainted — refetch with CORS */ }

    try {
      const bitmaps = await Promise.all(jobs.map(async (j) => {
        const r = await fetch(j.url, { mode: 'cors' });
        if (!r.ok) throw new Error('tile ' + r.status);
        return { bmp: await createImageBitmap(await r.blob()), j };
      }));
      bitmaps.forEach(({ bmp, j }) => {
        ctx.drawImage(bmp, j.dx * scale, j.dy * scale, j.dw * scale, j.dh * scale);
        if (bmp.close) bmp.close();
      });
      ctx.restore();
      return true;
    } catch (e) {
      ctx.restore();
      return false;
    }
  }

  function paintVectors(ctx, scale) {
    const isLL = (p) => p && (typeof p.lat === 'number' || typeof p.lat === 'function');
    const ringsOf = (latlngs) => {
      if (!latlngs || !latlngs.length) return [];
      if (isLL(latlngs[0])) return [latlngs];
      if (Array.isArray(latlngs[0]) && isLL(latlngs[0][0])) return latlngs;
      return latlngs.flatMap(ringsOf);
    };
    const stroke = (latlngs, color, width, dash) => {
      if (!latlngs || !latlngs.length) return;
      const rings = ringsOf(latlngs);
      ctx.beginPath();
      rings.forEach((ring) => {
        ring.forEach((ll, i) => {
          const p = map.latLngToContainerPoint(ll);
          const x = p.x * scale, y = p.y * scale;
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        });
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = width * scale;
      ctx.setLineDash((dash || []).map((d) => d * scale));
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.setLineDash([]);
    };
    const toLatLngs = (layer) => {
      if (layer.getLatLngs) return layer.getLatLngs();
      if (layer instanceof window.L.GeoJSON) {
        const acc = [];
        layer.eachLayer((l) => { if (l.getLatLngs) acc.push(l.getLatLngs()); });
        return acc;
      }
      return null;
    };
    // Isohyets (already include casing as separate polylines in isoGroup)
    if (isoGroup && map.hasLayer(isoGroup)) {
      isoGroup.eachLayer((l) => {
        const ll = toLatLngs(l);
        if (!ll) return;
        const st = l.options || {};
        stroke(ll, st.color || '#111', st.weight || 2.5, st.dashArray ? String(st.dashArray).split(/[,\s]+/).map(Number) : null);
      });
    }
    // Goyder's Line
    if (lineGroup && map.hasLayer(lineGroup) && S.line) {
      lineGroup.eachLayer((l) => {
        const walk = (ly) => {
          if (ly.eachLayer && !ly.getLatLngs) { ly.eachLayer(walk); return; }
          const ll = toLatLngs(ly);
          if (!ll) return;
          const st = ly.options || {};
          stroke(ll, st.color || '#8B0000', st.weight || 5, null);
        };
        walk(l);
      });
    }
    // Town markers + labels
    const drawTown = (ly) => {
      if (!ly.getLatLng) return;
      const ll = ly.getLatLng();
      const p = map.latLngToContainerPoint(ll);
      const x = p.x * scale, y = p.y * scale;
      const r = (ly.options.radius || 3.5) * scale;
      ctx.beginPath();
      ctx.arc(x, y, r + scale, 0, Math.PI * 2);
      ctx.fillStyle = ly.options.color || '#111';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = ly.options.fillColor || '#fff';
      ctx.fill();
      const tip = ly.getTooltip && ly.getTooltip();
      const text = tip && tip.getContent && tip.getContent();
      if (!text) return;
      const fs = 11 * scale;
      ctx.font = `700 ${fs}px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const padX = 3 * scale, padY = 1.5 * scale;
      const tw = ctx.measureText(text).width;
      const lx = x + 4 * scale + r, ly_ = y;
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1 * scale;
      const rx = 2 * scale;
      const bx = lx - padX, by = ly_ - fs / 2 - padY, bw = tw + padX * 2, bh = fs + padY * 2;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, rx);
      else ctx.rect(bx, by, bw, bh);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#111';
      ctx.fillText(text, lx, ly_);
    };
    if (S.towns && townGroup && map.hasLayer(townGroup)) townGroup.eachLayer(drawTown);
    if (S.towns && minorGroup && map.hasLayer(minorGroup)) minorGroup.eachLayer(drawTown);
  }

  function paintScaleBar(ctx, scale, originX, originY, mapW, mapH) {
    const maxCss = 100;
    const midY = map.getSize().y / 2;
    const mpp = map.distance(map.containerPointToLatLng([0, midY]), map.containerPointToLatLng([maxCss, midY])) / maxCss;
    const maxM = mpp * maxCss;
    const stops = [1, 2, 3, 5, 10, 20, 30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000,
      10000, 20000, 30000, 50000, 100000, 200000, 300000, 500000, 1000000];
    let metres = stops[0];
    for (const s of stops) if (s <= maxM) metres = s;
    const px = (metres / mpp) * scale;
    const label = metres >= 1000 ? `${metres / 1000} km` : `${metres} m`;
    const x = originX + 10 * scale, y = originY + mapH - 18 * scale;
    ctx.save();
    ctx.strokeStyle = '#111';
    ctx.fillStyle = '#111';
    ctx.lineWidth = 2 * scale;
    ctx.beginPath();
    ctx.moveTo(x, y - 5 * scale);
    ctx.lineTo(x, y);
    ctx.lineTo(x + px, y);
    ctx.lineTo(x + px, y - 5 * scale);
    ctx.stroke();
    ctx.font = `600 ${11 * scale}px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    const tw = ctx.measureText(label).width;
    ctx.fillRect(x + px / 2 - tw / 2 - 3 * scale, y - 20 * scale, tw + 6 * scale, 13 * scale);
    ctx.fillStyle = '#111';
    ctx.fillText(label, x + px / 2, y - 7 * scale);
    ctx.restore();
  }

  function paintLegendBox(ctx, L, scale, boxX, boxY, boxW) {
    const pct = S.display === 'pct';
    const br = pct ? BREAKS.pct : BREAKS[L.kind], pal = pct ? DIVERGE : RAIN;
    const unit = pct ? '%' : 'mm';
    const pad = 8 * scale;
    const barH = 10 * scale;
    const innerW = boxW - pad * 2;
    const keyFont = `${11 * scale}px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif`;
    const keys = [];
    if (S.line) keys.push({ color: '#8B0000', dash: false, text: "Goyder's Line (1865)" });
    if (S.iso) {
      [S.eraA, S.eraB].forEach((e, k) => {
        if (e != null) keys.push({ color: ERA_STYLE[k].color, dash: false, text: `${eraLabel(e)}: 300 mm` });
      });
    }
    if (S.iso250) keys.push({ color: '#333', dash: true, text: '250 mm (optional)' });
    ctx.font = keyFont;
    const keyLines = keys.map((k) => ({ k, lines: wrapText(ctx, k.text, innerW - 22 * scale) }));
    const keyH = keyLines.reduce((h, item) => h + item.lines.length * 13 * scale, 0);
    const boxH = pad + barH + 16 * scale + keyH + pad;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 1;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(boxX, boxY, boxW, boxH, 6 * scale); ctx.fill(); ctx.stroke(); }
    else { ctx.fillRect(boxX, boxY, boxW, boxH); ctx.strokeRect(boxX, boxY, boxW, boxH); }
    ctx.font = `${10 * scale}px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif`;
    const unitW = ctx.measureText(unit).width + 4 * scale;
    const barW = innerW - unitW;
    const barY = boxY + pad;
    const slot = barW / pal.length;
    pal.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(boxX + pad + i * slot, barY, slot, barH); });
    ctx.strokeStyle = '#666';
    ctx.strokeRect(boxX + pad, barY, barW, barH);
    ctx.fillStyle = '#2B2B2B';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    br.forEach((b, i) => {
      if (i % 2 !== 0) return;
      ctx.fillText(String(b), boxX + pad + ((i + 1) / pal.length) * barW, barY + barH + 2 * scale);
    });
    ctx.textAlign = 'left';
    ctx.fillText(unit, boxX + pad + barW + 3 * scale, barY + barH + 2 * scale);
    ctx.textAlign = 'left';
    ctx.font = keyFont;
    let ky = barY + barH + 16 * scale;
    keyLines.forEach((item) => {
      ctx.strokeStyle = item.k.color;
      ctx.lineWidth = 3 * scale;
      ctx.setLineDash(item.k.dash ? [5 * scale, 4 * scale] : []);
      ctx.beginPath();
      ctx.moveTo(boxX + pad, ky + 6 * scale);
      ctx.lineTo(boxX + pad + 18 * scale, ky + 6 * scale);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#5b5b5b';
      ctx.textBaseline = 'middle';
      item.lines.forEach((ln, i) => {
        ctx.fillText(ln, boxX + pad + 22 * scale, ky + 6 * scale + i * 13 * scale);
      });
      ky += item.lines.length * 13 * scale;
    });
    ctx.restore();
    return boxH;
  }

  function basemapCredit(basemapOk) {
    if (!basemapOk) return 'Basemap omitted (map tiles could not be included in this image).';
    if (baseLayers.osm && map.hasLayer(baseLayers.osm)) return 'Map tiles \u00a9 OpenStreetMap contributors.';
    return 'Imagery \u00a9 Esri, Maxar, Earthstar Geographics.';
  }

  async function buildPng() {
    if (!current || !map) throw new Error('The map is still loading.');
    await waitForTiles(5000);
    const size = map.getSize();
    const scale = 2;
    const mapW = Math.round(size.x * scale), mapH = Math.round(size.y * scale);
    // Probe header/footer heights by laying out text on a scratch context.
    const scratch = el('canvas', { width: 10, height: 10 }).getContext('2d');
    const title = viewTitle(current);
    scratch.font = `700 ${18 * scale}px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif`;
    const titleLines = wrapText(scratch, title, mapW - 32 * scale);
    const headerH = (14 + 22 + titleLines.length * 22 + 12) * scale;
    const credit = [
      'Rainfall: SILO, Queensland Government, CC BY 4.0 (summed, averaged and contoured).',
      "Goyder's Line: SA Department for Environment and Water.",
      basemapCredit(true),
      SITE_URL,
    ];
    scratch.font = `${10 * scale}px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif`;
    // footer sized after we know whether the basemap painted
    const mapCv = el('canvas', { width: mapW, height: mapH });
    const mctx = mapCv.getContext('2d');
    mctx.fillStyle = '#8eb6c8';
    mctx.fillRect(0, 0, mapW, mapH);

    const basemapOk = await paintBasemap(mctx, scale);
    if (!basemapOk) {
      const ls = landSeaCanvas();
      const { rows, res, lonMin, latMax, cols } = G;
      const north = latMax + res / 2, south = latMax - (rows - 1) * res - res / 2;
      const west = lonMin - res / 2, east = lonMin + (cols - 1) * res + res / 2;
      const r = overlayRect(window.L.latLngBounds([south, west], [north, east]), scale);
      mctx.drawImage(ls, r.x, r.y, r.w, r.h);
    }
    if (rainLayer) {
      const img = rainLayer.getElement();
      if (img && img.complete && img.naturalWidth) {
        const r = overlayRect(rainLayer.getBounds(), scale);
        mctx.globalAlpha = S.opacity;
        mctx.drawImage(img, r.x, r.y, r.w, r.h);
        mctx.globalAlpha = 1;
      }
    }
    paintVectors(mctx, scale);
    paintScaleBar(mctx, scale, 0, 0, mapW, mapH);
    const legendW = Math.min(260 * scale, mapW * 0.42);
    const tmpH = paintLegendBox(mctx, current, scale, mapW, 0, legendW); // measure? we'll draw at bottom-right
    // Redraw legend in the right place — first call above drew off-canvas; draw properly:
    // Clear the accidental off-canvas draw is unnecessary if x = mapW. Draw at bottom-right.
    const boxX = mapW - legendW - 10 * scale;
    const boxY = mapH - tmpH - 10 * scale;
    paintLegendBox(mctx, current, scale, boxX, Math.max(8 * scale, boxY), legendW);

    const creditLines = [
      'Rainfall: SILO, Queensland Government, CC BY 4.0 (summed, averaged and contoured).',
      "Goyder's Line: SA Department for Environment and Water.",
      basemapCredit(basemapOk),
      SITE_URL,
    ];
    scratch.font = `${10 * scale}px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif`;
    const footerLines = creditLines.flatMap((c) => wrapText(scratch, c, mapW - 32 * scale));
    const footerH = (16 + footerLines.length * 14 + 12) * scale;

    const out = el('canvas', { width: mapW, height: headerH + mapH + footerH });
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    // header
    ctx.fillStyle = '#1F5F6B';
    ctx.fillRect(0, 0, mapW, headerH);
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${12 * scale}px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText("Goyder's Line & SA rainfall", 16 * scale, 12 * scale);
    ctx.font = `700 ${18 * scale}px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif`;
    titleLines.forEach((ln, i) => ctx.fillText(ln, 16 * scale, (14 + 20 + i * 22) * scale));
    ctx.drawImage(mapCv, 0, headerH);
    // footer
    const fy = headerH + mapH;
    ctx.fillStyle = '#f4efe6';
    ctx.fillRect(0, fy, mapW, footerH);
    ctx.fillStyle = '#2B2B2B';
    ctx.font = `${10 * scale}px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif`;
    ctx.textBaseline = 'top';
    footerLines.forEach((ln, i) => ctx.fillText(ln, 16 * scale, fy + (10 + i * 14) * scale));
    const filename = exportFilename();
    const note = basemapOk ? '' : 'Basemap could not be included (tiles were blocked by the browser). A plain land and sea background was used instead.';
    return { canvas: out, filename, basemapOk, note, title };
  }

  function saveBlob(blob, filename, previewWin) {
    const url = URL.createObjectURL(blob);
    if (previewWin && !previewWin.closed) {
      try {
        previewWin.document.open();
        previewWin.document.write(`<!doctype html><meta charset="utf-8"><title>${filename}</title>` +
          `<body style="font:14px system-ui,sans-serif;margin:16px"><p>Long-press or right-click the image to save <b>${filename}</b>.</p>` +
          `<img alt="${filename}" src="${url}" style="max-width:100%;height:auto"></body>`);
        previewWin.document.close();
        return;
      } catch (e) { /* fall through */ }
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
  }

  async function startExport() {
    if (startExport._busy) return;
    startExport._busy = true;
    setExporting(true);
    toast('Preparing image\u2026', 0);
    const previewWin = isIOS() ? window.open('about:blank', '_blank') : null;
    try {
      const { canvas, filename, basemapOk, note } = await buildPng();
      const blob = await new Promise((res, rej) => canvas.toBlob((b) => b ? res(b) : rej(new Error('Could not make PNG')), 'image/png'));
      saveBlob(blob, filename, previewWin);
      toast(note ? ('Saved ' + filename + '. ' + note) : ('Saved ' + filename), note ? 7000 : 3500);
    } catch (e) {
      console.error(e);
      if (previewWin && !previewWin.closed) previewWin.close();
      toast('Could not save the image (' + (e.message || 'error') + ').', 6000);
    } finally {
      startExport._busy = false;
      setExporting(false);
    }
  }

  async function hookExport() {
    const { canvas, filename, basemapOk, note, title } = await buildPng();
    return { dataUrl: canvas.toDataURL('image/png'), filename, basemapOk, note, title, width: canvas.width, height: canvas.height };
  }

  function addPngButton() {
    const PngControl = window.L.Control.extend({
      options: { position: 'topright' },
      onAdd() {
        const wrap = window.L.DomUtil.create('div', 'leaflet-bar leaflet-control png-control');
        const btn = window.L.DomUtil.create('a', '', wrap);
        btn.href = '#';
        btn.role = 'button';
        btn.title = 'Save the current map as a PNG image';
        btn.setAttribute('aria-label', 'Save as PNG');
        btn.textContent = 'Save as PNG';
        window.L.DomEvent.disableClickPropagation(wrap);
        window.L.DomEvent.on(btn, 'click', (e) => { window.L.DomEvent.preventDefault(e); startExport(); });
        return wrap;
      }
    });
    // Add before the layers control so this sits at the top of the stack.
    new PngControl().addTo(map);
    document.querySelectorAll('#btn-png, #btn-png-mob').forEach((b) => { if (b) b.onclick = startExport; });
    window.__goyderExportPng = hookExport;
  }

  async function init() {
    readHash();
    M = await getJSON('manifest.json');
    G = M.grid;
    validateState();
    map = window.L.map('map', { zoomControl: false, minZoom: 5, maxZoom: 13, zoomSnap: 0.25, zoomDelta: 0.5, tap: true, attributionControl: true });
    window.L.control.zoom({ position: 'topleft' }).addTo(map);
    window.L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);
    map.createPane('rain').style.zIndex = 350;
    map.createPane('labels').style.zIndex = 360; map.getPane('labels').style.pointerEvents = 'none';
    map.createPane('iso').style.zIndex = 420;
    map.createPane('line').style.zIndex = 430;
    map.createPane('towns').style.zIndex = 440;
    const osm = window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, crossOrigin: 'anonymous', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' });
    const esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
    const sat = window.L.layerGroup([
      window.L.tileLayer(esri + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, crossOrigin: 'anonymous', attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' }),
      window.L.tileLayer(esri + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { pane: 'labels', maxZoom: 18, crossOrigin: 'anonymous', attribution: 'Labels &copy; Esri' }),
    ]);
    baseLayers = { osm, sat };
    // Save-as-PNG sits at the top of the right-hand controls; layers control is added after it.
    addPngButton();
    sat.addTo(map);
    window.L.control.layers({ 'Satellite': sat, 'Street map': osm }, null, { position: 'topright' }).addTo(map);
    fitSA();

    lineGroup = window.L.layerGroup(); isoGroup = window.L.layerGroup().addTo(map); townGroup = window.L.layerGroup();
    map.on('click', (e) => pick(e.latlng, null));
    window.addEventListener('resize', () => map.invalidateSize());

    document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => setView(b.dataset.view)));
    $('t-pct').onchange = (e) => { S.display = e.target.checked ? 'pct' : 'mm'; refresh(); };
    $('prev').onclick = () => step(-1); $('next').onclick = () => step(1);
    $('baseline').innerHTML = M.baselines.map((b) => option(b, b.replace('-', '\u2013') + ' average')).join('');
    $('baseline').onchange = (e) => { S.baseline = e.target.value; refresh(); };
    const eraOpts = '<option value="">(none)</option>' + M.isohyetEras.map((e, i) => option(i, e.label)).join('');
    $('eraA').innerHTML = eraOpts; $('eraB').innerHTML = eraOpts;
    $('eraA').onchange = (e) => { S.eraA = e.target.value === '' ? null : +e.target.value; refresh(); };
    $('eraB').onchange = (e) => { S.eraB = e.target.value === '' ? null : +e.target.value; refresh(); };
    $('sel-measure').onchange = (e) => { S.measure = e.target.value; refresh(); };
    $('sel-len').onchange = (e) => {
      S.len = +e.target.value;
      const cy = completeYears();
      S.end = Math.max(S.end, cy[0] + S.len - 1);
      if (S.end > cy[cy.length - 1]) S.end = cy[cy.length - 1];
      refresh();
    };
    $('t-line').onchange = (e) => { S.line = e.target.checked; toggle(lineGroup, S.line); current && drawLegend(current); };
    $('t-iso').onchange = (e) => { S.iso = e.target.checked; refresh(); };
    $('t-iso250').onchange = (e) => { S.iso250 = e.target.checked; refresh(); };
    $('t-towns').onchange = (e) => { S.towns = e.target.checked; toggle(townGroup, S.towns); };
    $('opacity').oninput = (e) => { S.opacity = +e.target.value; rainLayer && rainLayer.setOpacity(S.opacity); };
    const openBtn = $('open-options');
    if (openBtn) openBtn.onclick = () => {
      $('panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => $('search').focus(), 350);
    };
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input,select,textarea')) return;
      if (e.key === '[') step(-1); else if (e.key === ']') step(1);
    });

    const [gj, loc, iso] = await Promise.all([getJSON('goyders_line.geojson'), getJSON('localities.json'), getJSON('isohyets.geojson')]);
    prepLine(gj); drawLine(gj); lineGroup.addTo(map);
    places = loc.places; drawTowns(loc); townGroup.addTo(map);
    isoData = iso;
    setupSearch();
    await refresh();
    requestAnimationFrame(fitSA);
    setTimeout(fitSA, 250);
  }
  init().catch((e) => { console.error(e); $('status').innerHTML = `<span class="err">Sorry, the map failed to load (${e.message}).</span>`; });
})();
