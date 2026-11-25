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
  const SA_BOUNDS = [[-38.2, 128.95], [-25.95, 141.05]];

  let M, G, map, rainLayer, lineGroup, isoGroup, townGroup, pickMarker, places = [], gyLines = [], southPoly = [];
  const cache = new Map();
  const S = { view: 'multi', year: null, month: null, len: 30, end: null, measure: 'annual', display: 'mm', baseline: '1991-2020',
    eraA: null, eraB: null, line: true, iso: true, towns: true, opacity: 0.75 };
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
        if (e != null) keys.push(`<span class="key"><i style="border-color:${ERA_STYLE[k].color}"></i>${eraLabel(e)}: 250&nbsp;mm solid, 300&nbsp;mm dashed</span>`);
      });
    }
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
    $('t-line').checked = S.line; $('t-iso').checked = S.iso; $('t-towns').checked = S.towns;
    $('eraA').value = S.eraA ?? ''; $('eraB').value = S.eraB ?? '';
    $('eraA').disabled = $('eraB').disabled = !S.iso;
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
    if (!S.iso || !isoData) return;
    [S.eraA, S.eraB].forEach((e, k) => {
      if (e == null || e === '') return;
      const label = eraLabel(e);
      isoData.features.filter((f) => f.properties.era === label).forEach((f) => {
        const dashed = f.properties.mm !== 250;
        const latlngs = f.geometry.coordinates.map((l) => l.map(([x, y]) => [y, x]));
        window.L.polyline(latlngs, { pane: 'iso', color: '#fff', weight: 5, opacity: 0.9, interactive: false }).addTo(isoGroup);
        window.L.polyline(latlngs, { pane: 'iso', color: ERA_STYLE[k].color, weight: 2.5, dashArray: dashed ? '7 6' : null })
          .bindTooltip(`${f.properties.mm} mm average annual rainfall, ${label}`, { sticky: true }).addTo(isoGroup);
      });
    });
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

  const HASH_KEYS = ['view', 'year', 'month', 'len', 'end', 'measure', 'display', 'baseline', 'eraA', 'eraB'];
  function writeHash() {
    const p = new URLSearchParams();
    HASH_KEYS.forEach((k) => { if (S[k] != null && S[k] !== '') p.set(k, S[k]); });
    history.replaceState(null, '', '#' + p.toString());
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    HASH_KEYS.forEach((k) => {
      if (!p.has(k)) return;
      const v = p.get(k);
      S[k] = ['year', 'month', 'len', 'end', 'eraA', 'eraB'].includes(k) ? (v === '' ? null : +v) : v;
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
  }

  function fitSA() {
    map.invalidateSize();
    map.fitBounds(SA_BOUNDS, { paddingTopLeft: [16, 20], paddingBottomRight: [20, 96], maxZoom: 7, animate: false });
  }

  async function init() {
    readHash();
    M = await getJSON('manifest.json');
    G = M.grid;
    validateState();
    map = window.L.map('map', { zoomControl: false, minZoom: 5, maxZoom: 13, zoomSnap: 0.5, tap: true, attributionControl: true });
    window.L.control.zoom({ position: 'topleft' }).addTo(map);
    window.L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);
    map.createPane('rain').style.zIndex = 350;
    map.createPane('labels').style.zIndex = 360; map.getPane('labels').style.pointerEvents = 'none';
    map.createPane('iso').style.zIndex = 420;
    map.createPane('line').style.zIndex = 430;
    map.createPane('towns').style.zIndex = 440;
    const osm = window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' });
    const esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
    const sat = window.L.layerGroup([
      window.L.tileLayer(esri + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' }),
      window.L.tileLayer(esri + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { pane: 'labels', maxZoom: 18, attribution: 'Labels &copy; Esri' }),
    ]);
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
