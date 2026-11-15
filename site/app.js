/* Tennis CourtCast map.
 *
 * Inland Empire courts come precomputed in data/forecast.json (built every
 * 2 hours by courtcast/build.py). Every other Southern California court comes
 * from courts-socal.json, and its forecast is fetched by this page, from the
 * viewer's browser, only for the courts on screen. Open-Meteo's free limit is
 * per visitor, so covering more area doesn't cost more.
 */
(() => {
  "use strict";

  const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
  const DARK = matchMedia("(prefers-color-scheme: dark)").matches;
  const LIVE_ZOOM = 10;        // at or above this zoom, courts on screen without a forecast get one fetched
  const LIVE_MAX = 120;        // most courts fetched per view (nearest the centre first)
  const MARKER_ZOOM = 8.5;     // full court markers once zoomed in this far...
  const MARKER_MAX = 150;      // ...and no more than this many courts are on screen (else dots, to stay fast)

  // Soft, Waze-like basemap colours. Applied on top of the OpenFreeMap "liberty" style.
  const BASEMAP = DARK
    ? { land: "#1d2733", park: "#21382c", landuse: "#212c38", water: "#173a52", road: "#344456", casing: "#18212b",
        major: "#56657a", majorCasing: "#18212b", rail: "#2c3846", label: "#b9c3cf", halo: "#1d2733", hills: 0.18 }
    : { land: "#f2efe9", park: "#cfe9bf", landuse: "#ebe7df", water: "#a8d8f0", road: "#ffffff", casing: "#dcd7cc",
        major: "#ffe28a", majorCasing: "#e3c463", rail: "#d6d1c7", label: "#5d5a54", halo: "#ffffff", hills: 0.3 };

  const BAND = {
    play: { label: "Good to play", face: "😀" },
    iffy: { label: "Iffy", face: "😐" },
    skip: { label: "Skip it", face: "🙁" },
  };

  // hour = slider position (index into DATA.times); base = index of the real current hour.
  const state = { layer: "play", hour: 0, base: 0, schools: false, selected: null };
  let DATA, map, PAL, weather;
  let COURTS = [];             // every court: Inland Empire (precomputed) + rest of SoCal (live)
  const byId = new Map();
  const markers = new Map();   // id -> { el, m } for courts currently drawn as full markers

  // ---------- small helpers ----------
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const clamp01 = (t) => Math.max(0, Math.min(1, t));
  const compass = (deg) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
  const hasFc = (ct) => Array.isArray(ct.s);
  const inRegion = (lat, lon) => { const R = DATA.region; return lat >= R.lat_min && lat <= R.lat_max && lon >= R.lon_min && lon <= R.lon_max; };

  // ---------- real time (always Pacific, wherever the viewer is) ----------
  const PT = "America/Los_Angeles";
  function pacificHourStamp(date = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: PT, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
    }).formatToParts(date).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
  }
  const clockText = () => new Date().toLocaleTimeString("en-US", { timeZone: PT, hour: "numeric", minute: "2-digit" });
  function nowIndex() {
    const stamp = pacificHourStamp();
    const i = DATA.times.indexOf(stamp);
    if (i >= 0) return i;
    return stamp < DATA.times[0] ? 0 : DATA.times.length - 1;
  }
  const nextDate = (d) => { const [y, m, day] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1, day + 1)).toISOString().slice(0, 10); };
  function dayWord(d) {
    const today = pacificHourStamp().slice(0, 10);
    if (d === today) return "Today";
    if (d === nextDate(today)) return "Tomorrow";
    const [y, m, day] = d.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  }
  function fmtTime(iso, short) {
    const [d, t] = iso.split("T");
    const h = Number(t.slice(0, 2));
    const hh = `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
    return short ? hh.replace(" ", "").toLowerCase() : `${dayWord(d)} ${hh}`;
  }

  // ---------- scoring (a copy of courtcast/score.py, using the same numbers from the data file) ----------
  const ramp = (v, r) => r.max_penalty * clamp01((v - r.start) / (r.full - r.start));
  function windBand(gust, wind) {
    const C = DATA.score;
    if (gust >= C.wind_skip_gust || wind >= C.wind_skip_sustained) return "skip";
    if (gust >= C.wind_iffy_gust || wind >= C.wind_iffy_sustained) return "iffy";
    return "play";
  }
  const bandOf = (s) => (s >= DATA.score.good_at ? "play" : s >= DATA.score.iffy_at ? "iffy" : "skip");
  function scoreHour(h) {
    const C = DATA.score;
    if (h.rain >= C.rain_stop) return [0, "skip", [`Raining (${h.rain.toFixed(2)} in/hr)`]];
    const pen = [];
    if (h.rain >= C.drizzle) pen.push([C.drizzle_penalty, "Drizzle"]);
    if (h.prev1 >= C.rain_stop) pen.push([C.wet_last_hour_penalty, "Courts wet (rain last hour)"]);
    else if (h.prev23 >= C.rain_stop) pen.push([C.wet_2_3h_penalty, "Courts drying (rain 2-3h ago)"]);
    pen.push([ramp(h.chance, C.rain_chance), `${h.chance.toFixed(0)}% rain chance`]);
    pen.push([ramp(h.gust, C.gusts), `Gusts ${h.gust.toFixed(0)} mph`]);
    pen.push([ramp(h.wind, C.wind), `Wind ${h.wind.toFixed(0)} mph`]);
    pen.push([ramp(h.temp, C.heat), `Hot (${h.temp.toFixed(0)}°F)`]);
    pen.push([ramp(h.temp, C.cold), `Cold (${h.temp.toFixed(0)}°F)`]);
    let score = Math.max(0, 10 - pen.reduce((s, p) => s + p[0], 0));
    const wb = windBand(h.gust, h.wind);
    if (wb === "skip") score = Math.min(score, C.wind_skip_cap);
    else if (wb === "iffy") score = Math.min(score, C.wind_iffy_cap);
    score = Math.round(score * 10) / 10;
    let why = pen.slice().sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? 1 : -1)).filter((p) => p[0] >= 0.75).slice(0, 2).map((p) => p[1]);
    if (wb !== "play" && !why.some((r) => r.startsWith("Gusts") || r.startsWith("Wind"))) why = [`Gusts ${h.gust.toFixed(0)} mph`, ...why.slice(0, 1)];
    return [score, bandOf(score), why];
  }

  // ---------- live forecasts from Open-Meteo (same model and units as build.py) ----------
  const liveCache = new Map();          // "lat,lon" (rounded) -> Promise of series aligned to DATA.times
  const cellKey = (lat, lon) => `${(Math.round(lat / 0.02) * 0.02).toFixed(2)},${(Math.round(lon / 0.02) * 0.02).toFixed(2)}`;

  function seriesFrom(res) {
    const H = res.hourly, at = new Map(H.time.map((t, i) => [t, i]));
    const v = (k, j) => (j >= 0 && H[k][j] != null ? H[k][j] : 0);
    const out = { s: [], b: [], wb: [], why: [], t: [], p: [], r: [], w: [], g: [], d: [] };
    DATA.times.forEach((time) => {
      const j = at.has(time) ? at.get(time) : -1;
      const h = { temp: v("temperature_2m", j), chance: v("precipitation_probability", j), rain: v("precipitation", j),
                  prev1: v("precipitation", j - 1), prev23: v("precipitation", j - 2) + v("precipitation", j - 3),
                  wind: v("wind_speed_10m", j), gust: v("wind_gusts_10m", j) };
      const [s, b, why] = scoreHour(h);
      out.s.push(s); out.b.push(b); out.why.push(why); out.wb.push(windBand(h.gust, h.wind));
      out.t.push(Math.round(h.temp)); out.p.push(Math.round(h.chance)); out.r.push(Math.round(h.rain * 1000) / 1000);
      out.w.push(Math.round(h.wind)); out.g.push(Math.round(h.gust)); out.d.push(Math.round(v("wind_direction_10m", j)));
    });
    return out;
  }

  async function fetchPoints(points) {   // points: [[lat, lon]] -> Open-Meteo results, same order
    const out = [];
    for (let i = 0; i < points.length; i += 50) {
      const chunk = points.slice(i, i + 50);
      const q = new URLSearchParams({
        latitude: chunk.map((p) => p[0].toFixed(4)).join(","), longitude: chunk.map((p) => p[1].toFixed(4)).join(","),
        hourly: "temperature_2m,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,wind_direction_10m",
        models: DATA.model, past_days: "1", forecast_days: "3", timezone: PT,
        temperature_unit: "fahrenheit", wind_speed_unit: "mph", precipitation_unit: "inch",
      });
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`);
      if (!r.ok) throw new Error(`forecast ${r.status}`);
      const d = await r.json();
      out.push(...(Array.isArray(d) ? d : [d]));
    }
    return out;
  }

  // Forecast series for a set of points, sharing one request per ~2 km cell and caching.
  function liveSeries(points) {
    const need = [], keys = points.map(([la, lo]) => cellKey(la, lo));
    keys.forEach((k, i) => { if (!liveCache.has(k) && !need.some((n) => n.k === k)) need.push({ k, p: points[i] }); });
    if (need.length) {
      const batch = fetchPoints(need.map((n) => n.p)).then((res) => res.map(seriesFrom));
      need.forEach((n, i) => liveCache.set(n.k, batch.then((all) => all[i])));
      batch.catch(() => need.forEach((n) => liveCache.delete(n.k)));   // allow a retry later
    }
    return Promise.all(keys.map((k) => liveCache.get(k)));
  }

  // Courts on screen without a forecast yet: fetch them (nearest the centre first).
  let loading = 0;
  async function loadVisible() {
    if (map.getZoom() < LIVE_ZOOM) return;
    const b = map.getBounds(), c = map.getCenter();
    const want = COURTS.filter((ct) => !hasFc(ct) && !ct.loading && (state.schools || ct.type !== "school") &&
      b.contains([ct.lon, ct.lat]))
      .sort((x, y) => Math.hypot(x.lat - c.lat, x.lon - c.lng) - Math.hypot(y.lat - c.lat, y.lon - c.lng))
      .slice(0, LIVE_MAX);
    const sel = state.selected && byId.get(state.selected);
    if (sel && !hasFc(sel) && !sel.loading && !want.includes(sel)) want.push(sel);
    if (!want.length) return;
    want.forEach((ct) => { ct.loading = true; });
    loading++; setStatus();
    try {
      const series = await liveSeries(want.map((ct) => [ct.lat, ct.lon]));
      want.forEach((ct, i) => Object.assign(ct, series[i]));
    } catch (e) {
      console.warn("live forecast:", e.message);
    } finally {
      want.forEach((ct) => { ct.loading = false; });
      loading--; setStatus();
      render();
    }
  }
  function setStatus() { $("live").hidden = loading === 0; }

  // Weather shading grid: precomputed for the Inland Empire, fetched for anywhere else on screen.
  let liveGridKey = null;
  async function loadGrid() {
    const c = map.getCenter();
    if (map.getZoom() < LIVE_ZOOM - 1 || inRegion(c.lat, c.lng)) {
      if (liveGridKey !== "ie") { liveGridKey = "ie"; buildWeather(DATA.grid.cells); renderWeather(); }
      return;
    }
    const b = map.getBounds(), n = 7;
    const lat0 = b.getSouth(), lat1 = b.getNorth(), lon0 = b.getWest(), lon1 = b.getEast();
    const key = [lat0, lat1, lon0, lon1].map((x) => x.toFixed(1)).join(",");
    if (key === liveGridKey) return;
    liveGridKey = key;
    const pts = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      pts.push([lat0 + (lat1 - lat0) * i / (n - 1), lon0 + (lon1 - lon0) * j / (n - 1)]);
    }
    try {
      const series = await liveSeries(pts);
      if (key !== liveGridKey) return;                    // the map moved on meanwhile
      buildWeather(pts.map(([lat, lon], i) => ({ lat: +lat.toFixed(4), lon: +lon.toFixed(4), ...series[i] })));
      renderWeather();
    } catch (e) { console.warn("live grid:", e.message); }
  }

  // ---------- icons ----------
  const ICON = {
    wind: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 6h8.2a2.2 2.2 0 1 0-2.1-2.9M1.5 10h11a2 2 0 1 1-1.9 2.6M1.5 8h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    rain: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8C8 1.8 3.5 7 3.5 10a4.5 4.5 0 0 0 9 0C12.5 7 8 1.8 8 1.8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    temp: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 9.4V3a1.5 1.5 0 0 1 3 0v6.4a3 3 0 1 1-3 0z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8" cy="11.8" r="1.2" fill="currentColor"/></svg>',
  };
  const SUN = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.2" fill="currentColor"/><g stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1"/></g></svg>';
  const MOON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.8 2.2a6 6 0 1 0 3 9.6 5 5 0 0 1-3-9.6z" fill="currentColor"/></svg>';

  // A top-down tennis court, coloured by how playable it is (green / amber / red; gray = loading).
  function courtSvg(band) {
    return `<svg class="court" viewBox="0 0 30 18" aria-hidden="true">
      <rect x=".75" y=".75" width="28.5" height="16.5" rx="3" fill="${PAL[band] || PAL.none}"/>
      <g fill="none" stroke="#fff" stroke-width="1.1" stroke-linecap="round">
        <rect x="3.5" y="3" width="23" height="12"/>
        <path d="M9.5 3V15M20.5 3V15M9.5 9H20.5"/>
        <path d="M15 1.8V16.2" stroke-width="1.8"/>
      </g>
    </svg>`;
  }

  // ---------- basemap softening ----------
  function softenBasemap() {
    const B = BASEMAP;
    for (const l of map.getStyle().layers) {
      const id = l.id;
      const paint = (prop, val) => { try { map.setPaintProperty(id, prop, val); } catch (_) { /* layer lacks prop */ } };
      const hide = () => map.setLayoutProperty(id, "visibility", "none");
      if (l.type === "background") paint("background-color", B.land);
      else if (id === "natural_earth") paint("raster-opacity", B.hills);
      else if (/^(building|poi_|boundary)|one_way|hatching|road_area_pattern|park_outline|path|pedestrian/.test(id)) hide();
      else if (id === "park" || /landcover_(wood|grass)/.test(id)) { paint("fill-color", B.park); paint("fill-outline-color", B.park); paint("fill-opacity", 0.85); }
      else if (id === "landuse_residential") paint("fill-opacity", 0);
      else if (/^landuse_|aeroway_fill|landcover_(sand|ice|wetland)/.test(id)) paint("fill-color", B.landuse);
      else if (id === "water") paint("fill-color", B.water);
      else if (/^waterway/.test(id)) paint("line-color", B.water);
      else if (l.type === "line" && l["source-layer"] === "transportation") {
        const major = /motorway/.test(id);
        if (/rail/.test(id)) paint("line-color", B.rail);
        else if (/casing/.test(id)) paint("line-color", major ? B.majorCasing : B.casing);
        else paint("line-color", major ? B.major : B.road);
      } else if (l.type === "symbol") {
        paint("text-color", B.label); paint("text-halo-color", B.halo); paint("text-halo-width", 1.5);
      }
    }
  }

  // ---------- weather shading: blue = rain, orange = wind, purple = both ----------
  // Court colours show playability; the shading shows *why* and *where*. Forecast
  // points are blended smoothly (bilinear interpolation) into a soft overlay.
  const RAIN_RGB = [47, 127, 224];
  const WIND_RGB = [232, 140, 58];
  const BOTH_RGB = [139, 92, 230];
  const RAIN_LIKELY = 40;    // % chance: a faint blue tint when rain is likely but none is forecast
  const SHOW = 0.12;         // intensity below this is treated as "none"
  const rainStrength = (inches, chance) =>
    inches >= 0.002 ? 0.35 + 0.65 * clamp01(inches / 0.08) : chance >= RAIN_LIKELY ? 0.2 : 0;
  const windStrength = (gust) =>
    gust >= DATA.bands.wind_iffy ? 0.3 + 0.7 * clamp01((gust - DATA.bands.wind_iffy) / (DATA.bands.wind_skip - DATA.bands.wind_iffy)) : 0;

  function buildWeather(cells) {
    const lats = [...new Set(cells.map((c) => c.lat))].sort((a, b) => a - b);
    const lons = [...new Set(cells.map((c) => c.lon))].sort((a, b) => a - b);
    const byKey = new Map(cells.map((c) => [`${c.lat},${c.lon}`, c]));
    const px = 24, W = (lons.length - 1) * px + 1, H = (lats.length - 1) * px + 1;
    weather = {
      lats, lons, W, H,
      rows: lats.map((la) => lons.map((lo) => byKey.get(`${la},${lo}`))),
      canvas: Object.assign(document.createElement("canvas"), { width: W, height: H }),
      coords: [[lons[0], lats.at(-1)], [lons.at(-1), lats.at(-1)], [lons.at(-1), lats[0]], [lons[0], lats[0]]],
    };
  }

  function renderWeather() {
    if (!weather || weather.rows.some((r) => r.some((c) => !c || !c.g))) return;
    const { rows, W, H, canvas, lats, lons, coords } = weather;
    const h = state.hour, nr = lats.length, nc = lons.length;
    const showRain = state.layer !== "wind", showWind = state.layer !== "rain";
    const rainV = rows.map((r) => r.map((c) => (showRain ? rainStrength(c.r[h], c.p[h]) : 0)));
    const windV = rows.map((r) => r.map((c) => (showWind ? windStrength(c.g[h]) : 0)));
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(W, H);
    const fadePx = W * 0.06;
    for (let y = 0; y < H; y++) {
      const fy = ((H - 1 - y) / (H - 1)) * (nr - 1);
      const r0 = Math.min(nr - 2, Math.floor(fy)), ty = fy - r0;
      for (let x = 0; x < W; x++) {
        const fx = (x / (W - 1)) * (nc - 1);
        const c0 = Math.min(nc - 2, Math.floor(fx)), tx = fx - c0;
        const lerp = (v) => v[r0][c0] * (1 - tx) * (1 - ty) + v[r0][c0 + 1] * tx * (1 - ty)
                          + v[r0 + 1][c0] * (1 - tx) * ty + v[r0 + 1][c0 + 1] * tx * ty;
        const rain = lerp(rainV), wind = lerp(windV);
        let rgb, a;
        if (rain >= SHOW && wind >= SHOW) { rgb = BOTH_RGB; a = Math.max(rain, wind); }
        else if (rain >= SHOW) { rgb = RAIN_RGB; a = rain; }
        else if (wind >= SHOW) { rgb = WIND_RGB; a = wind; }
        else continue;
        const edge = clamp01(Math.min(x, W - 1 - x, y, H - 1 - y) / fadePx);
        const i = (y * W + x) * 4;
        img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2];
        img.data[i + 3] = 255 * Math.min(0.55, a * 0.55) * edge;
      }
    }
    ctx.putImageData(img, 0, 0);
    const url = canvas.toDataURL();
    const src = map.getSource("weather");
    if (src) { src.updateImage({ url, coordinates: coords }); return; }
    map.addSource("weather", { type: "image", url, coordinates: coords });
    const firstLabel = map.getStyle().layers.find((l) => l.type === "symbol");
    map.addLayer({ id: "weather", type: "raster", source: "weather",
      paint: { "raster-resampling": "linear", "raster-fade-duration": 0 } }, firstLabel && firstLabel.id);
  }

  // ---------- courts: dots when zoomed out, full markers when zoomed in ----------
  // Drawing 1,500+ HTML markers would be slow on phones, so zoomed out every court
  // is a dot in one map layer; zoomed in, only courts on screen become markers.
  function courtBand(ct, h) {
    if (!hasFc(ct)) return "none";
    return state.layer === "wind" ? ct.wb[h] : ct.b[h];
  }
  function chipValue(ct, h) {
    if (!hasFc(ct)) return "…";
    if (state.layer === "wind") return `${ct.g[h]} mph`;
    if (state.layer === "rain") return ct.r[h] > 0 ? `${ct.r[h].toFixed(2)} in` : `${ct.p[h]}%`;
    return ct.s[h] >= 10 ? "10" : ct.s[h].toFixed(1);
  }
  function notability(ct, h) {
    if (ct.id === state.selected) return 1e6;
    if (!hasFc(ct)) return 0;
    const school = ct.type === "school" ? 0 : 1e5;
    if (state.layer === "wind") return school + ct.g[h];
    if (state.layer === "rain") return school + ct.r[h] * 1000 + ct.p[h];
    return school + ct.s[h] * 10;
  }
  const shown = (ct) => state.schools || ct.type !== "school";

  // Which courts get full markers right now: everything on screen, once zoomed in
  // far enough and there aren't too many of them. Everything else is a dot.
  function markerIds() {
    const b = map.getBounds(), pad = 0.02;
    const onScreen = COURTS.filter((ct) => shown(ct) && ct.lat > b.getSouth() - pad && ct.lat < b.getNorth() + pad &&
      ct.lon > b.getWest() - pad && ct.lon < b.getEast() + pad);
    const ids = new Set(map.getZoom() >= MARKER_ZOOM && onScreen.length <= MARKER_MAX ? onScreen.map((ct) => ct.id) : []);
    if (state.selected) ids.add(state.selected);
    return ids;
  }

  function renderDots(ids = markerIds()) {
    const h = state.hour;
    const feats = COURTS.filter((ct) => shown(ct) && !ids.has(ct.id)).map((ct) => ({
      type: "Feature", geometry: { type: "Point", coordinates: [ct.lon, ct.lat] },
      properties: { id: ct.id, color: PAL[courtBand(ct, h)] || PAL.none },
    }));
    map.getSource("dots").setData({ type: "FeatureCollection", features: feats });
  }

  function renderMarkers(want = markerIds()) {
    const h = state.hour;
    for (const [id, mk] of markers) if (!want.has(id)) { mk.m.remove(); markers.delete(id); }
    for (const id of want) {
      const ct = byId.get(id);
      let mk = markers.get(id);
      if (!mk) {
        const el = document.createElement("div");
        el.className = "court-marker";
        el.tabIndex = 0;
        el.addEventListener("click", (e) => { e.stopPropagation(); select(id); saveHash(); });
        el.addEventListener("keydown", (e) => { if (e.key === "Enter") { select(id); saveHash(); } });
        mk = { el, m: new maplibregl.Marker({ element: el, anchor: "top", offset: [0, -11] }).setLngLat([ct.lon, ct.lat]).addTo(map) };
        markers.set(id, mk);
      }
      const band = courtBand(ct, h);
      mk.el.classList.toggle("selected", state.selected === id);
      mk.el.setAttribute("aria-label", hasFc(ct) ? `${ct.name}: ${BAND[band].label}, ${ct.s[h]} out of 10` : `${ct.name}: loading forecast`);
      mk.el.innerHTML = `<div class="pin${ct.type === "school" ? " school" : ""}">${courtSvg(band)}</div><div class="lbl">${chipValue(ct, h)}</div><div class="nm">${ct.name}</div>`;
      mk.el.style.zIndex = String(10 + Math.round(notability(ct, h)));
    }
  }

  // ---------- court card ----------
  function select(id) {
    const ct = byId.get(id);
    if (!ct) return;
    state.selected = id;
    render();
    const card = $("card"), wrap = map.getContainer();
    const fullWidth = card.offsetWidth > wrap.offsetWidth * 0.7;
    const padding = fullWidth
      ? { top: 0, left: 0, right: 0, bottom: Math.min(card.offsetHeight + 12, wrap.offsetHeight * 0.7) }
      : { top: 0, bottom: 0, right: 0, left: card.offsetWidth + 24 };
    map.easeTo({ center: [ct.lon, ct.lat], zoom: Math.max(map.getZoom(), 12.5), padding, duration: 600 });
  }
  function closeCard() {
    state.selected = null;
    render();
    saveHash();
    map.easeTo({ padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 300 });
  }

  function renderCard() {
    const card = $("card");
    const ct = state.selected && byId.get(state.selected);
    if (!ct) { card.hidden = true; return; }
    const head = `<button class="x" aria-label="Close">×</button>
      <div class="head">${courtSvg(courtBand(ct, state.hour))}<div><h3>${ct.name}</h3><div class="muted small">${ct.city}${ct.type === "school" ? " · school courts, access varies" : ""}</div></div></div>`;
    if (!hasFc(ct)) {
      card.innerHTML = `${head}<p class="muted">Loading this court's forecast…</p>`;
    } else {
      const h = state.hour, b = ct.b[h];
      const why = ct.why[h].length ? ct.why[h].join(" · ") : "Nothing in the way";
      const strip = [];
      for (let i = h; i < Math.min(h + 12, DATA.times.length); i++) {
        const day = DATA.is_day[i];
        strip.push(`<div><span class="dn ${day ? "sun" : "moon"}" title="${day ? "Daylight" : "After dark"}">${day ? SUN : MOON}</span><i class="${ct.b[i]}" title="${fmtTime(DATA.times[i])}: ${ct.s[i]}"></i>${fmtTime(DATA.times[i], true)}</div>`);
      }
      card.innerHTML = `${head}
        <div class="verdict ${b}"><span class="face" aria-hidden="true">${BAND[b].face}</span>
          <div><strong>${BAND[b].label}</strong><span class="muted small">${fmtTime(DATA.times[h])} · ${why}</span></div>
          <span class="score">${ct.s[h].toFixed(1)}<small>/10</small></span></div>
        <div class="facts">
          <span>${ICON.temp} ${ct.t[h]}°F</span>
          <span>${ICON.wind} ${ct.w[h]} mph, gusts ${ct.g[h]} · from ${compass(ct.d[h])}</span>
          <span>${ICON.rain} ${ct.p[h]}% chance${ct.r[h] > 0 ? ` · ${ct.r[h]}″` : ""}</span>
        </div>
        <div class="muted small">Next 12 hours</div>
        <div class="strip">${strip.join("")}</div>
        <div class="best">${bestWindow(ct, h)}</div>`;
    }
    card.hidden = false;
    card.querySelector(".x").addEventListener("click", closeCard);
  }

  function bestWindow(ct, h) {
    let best = null;
    for (let i = h; i < Math.min(h + 11, DATA.times.length - 1); i++) {
      if (!DATA.is_day[i] || !DATA.is_day[i + 1]) continue;
      const avg = (ct.s[i] + ct.s[i + 1]) / 2;
      if (!best || avg > best.avg) best = { i, avg };
    }
    if (!best) return "🌙 No daylight in the next 12 hours";
    const end = DATA.times[best.i + 2] || DATA.times[best.i + 1];
    return `⭐ Best window: ${fmtTime(DATA.times[best.i])}–${fmtTime(end, true)} (${best.avg.toFixed(1)})`;
  }

  // ---------- legend + list ----------
  function renderLegend() {
    const B = DATA.bands;
    const rgba = (c, a) => `rgb(${c.join(" ")} / ${a})`;
    const sw = (bg, text) => `<span><b class="sw" style="background:${bg}"></b>${text}</span>`;
    const ramp_ = (c) => `linear-gradient(90deg, ${rgba(c, 0.12)}, ${rgba(c, 0.55)})`;
    let html;
    if (state.layer === "play") {
      html = `<div class="title">Playability score</div>
        <div class="keys"><span><i style="background:${PAL.play}"></i>Play</span><span><i style="background:${PAL.iffy}"></i>Iffy</span><span><i style="background:${PAL.skip}"></i>Skip it</span></div>
        <div class="keys">${sw(rgba(RAIN_RGB, 0.5), "Rain")}${sw(rgba(WIND_RGB, 0.5), "Wind")}${sw(rgba(BOTH_RGB, 0.5), "Both")}</div>`;
    } else if (state.layer === "wind") {
      html = `<div class="title">Wind gusts</div>
        <div class="keys"><span><i style="background:${PAL.play}"></i>0–${B.wind_iffy - 1}</span><span><i style="background:${PAL.iffy}"></i>${B.wind_iffy}–${B.wind_skip - 1}</span><span><i style="background:${PAL.skip}"></i>${B.wind_skip}+ mph</span></div>
        <div class="bar" style="background:${ramp_(WIND_RGB)}"></div>
        <div class="ends"><span>${B.wind_iffy} mph</span><span>${B.wind_skip}+ mph</span></div>`;
    } else {
      html = `<div class="title">Rain</div>
        <div class="bar" style="background:${ramp_(RAIN_RGB)}"></div>
        <div class="ends"><span>likely</span><span>sprinkle</span><span>heavy</span></div>`;
    }
    if (map.getZoom() < MARKER_ZOOM) html += `<div class="muted small" style="margin-top:4px">Zoom in to see each court's forecast</div>`;
    $("legend").innerHTML = html;
  }

  function renderList() {
    const h = state.hour;
    $("listTitle").textContent = `Best courts in view · ${fmtTime(DATA.times[h])}`;
    if (map.getZoom() < MARKER_ZOOM) {
      $("list").innerHTML = `<li class="hint">Zoom in to a city to see its courts' forecasts. ${COURTS.length.toLocaleString()} courts across Southern California.</li>`;
      return;
    }
    const b = map.getBounds();
    const items = COURTS.filter((c) => shown(c) && hasFc(c) && b.contains([c.lon, c.lat]))
      .sort((a, c) => c.s[h] - a.s[h] || a.g[h] - c.g[h] || a.name.localeCompare(c.name)).slice(0, 60);
    if (!items.length) { $("list").innerHTML = `<li class="hint">${loading ? "Loading forecasts…" : "No courts in view."}</li>`; return; }
    $("list").innerHTML = items.map((c) => {
      const band = c.b[h];
      const why = c.why[h].length ? c.why[h].join(" · ") : `Gusts ${c.g[h]} mph · ${c.p[h]}% rain · ${c.t[h]}°F`;
      return `<li tabindex="0" data-id="${c.id}">${courtSvg(band)}
        <div><div class="name">${c.name}</div><div class="sub">${c.city} · ${why}</div></div>
        <span class="num" aria-label="${BAND[band].label}, score">${c.s[h].toFixed(1)}</span></li>`;
    }).join("");
  }

  function render() {
    renderWeather();
    const ids = markerIds();
    renderDots(ids);
    renderMarkers(ids);
    renderCard();
    renderLegend();
    renderList();
    renderTime();
  }

  // ---------- time bar ----------
  function renderTime() {
    const h = state.hour, ahead = h - state.base;
    const dark = DATA.is_day[h] ? "" : "After dark · lit courts only";
    if (ahead === 0) {
      $("timeLabel").innerHTML = `<span class="live">Now</span> · ${clockText()}`;
      $("dayLabel").textContent = dark || "Today";
    } else {
      $("timeLabel").textContent = fmtTime(DATA.times[h]);
      $("dayLabel").textContent = `in ${ahead} hour${ahead === 1 ? "" : "s"}` + (dark ? ` · ${dark.toLowerCase()}` : "");
    }
    $("now").setAttribute("aria-pressed", String(ahead === 0));
  }

  function buildTimeline() {
    const slider = $("hour"), base = state.base, last = DATA.times.length - 1;
    slider.min = base;
    slider.max = last;
    const span = Math.max(1, last - base);
    const pos = (i) => (Math.min(last, Math.max(base, i)) - base) / span;
    const stops = [];
    for (let i = base; i <= last; i++) {
      const c = DATA.is_day[i] ? "var(--day)" : "var(--night)";
      stops.push(`${c} ${(pos(i - 0.5) * 100).toFixed(2)}% ${(pos(i + 0.5) * 100).toFixed(2)}%`);
    }
    $("track").style.background = `linear-gradient(90deg, ${stops.join(", ")})`;
    const ticks = [];
    for (let i = base + 1; i <= last; i++) {
      const [d, t] = DATA.times[i].split("T");
      const hr = Number(t.slice(0, 2));
      if (hr % 6) continue;
      const label = hr === 0 ? dayWord(d) : hr === 12 ? "12p" : hr < 12 ? `${hr}a` : `${hr - 12}p`;
      ticks.push(`<span class="${hr === 0 ? "day" : ""}" style="left: calc(var(--thumb) / 2 + ${pos(i).toFixed(4)} * (100% - var(--thumb)))">${label}</span>`);
    }
    $("ticks").innerHTML = ticks.join("");
  }

  function showUpdated() {
    const gen = new Date(DATA.generated_utc.replace("Z", ":00Z"));
    const ageH = (Date.now() - gen) / 3.6e6;
    const when = gen.toLocaleString("en-US", { timeZone: PT, weekday: "short", hour: "numeric", minute: "2-digit" });
    $("updated").textContent = ageH > 4 ? `⚠ Forecast is ${Math.floor(ageH)} hours old (updated ${when} PT)` : `Updated ${when} PT`;
  }

  function tick() {
    const nb = nowIndex();
    if (nb !== state.base) {
      const followingNow = state.hour === state.base;
      state.base = nb;
      if (followingNow || state.hour < nb) state.hour = nb;
      buildTimeline();
      $("hour").value = state.hour;
      render();
      saveHash();
    } else {
      renderTime();
    }
    showUpdated();
  }

  // Every 15 min (and when a phone comes back to the tab): pick up a newer forecast.
  async function refreshData() {
    try {
      const d = await (await fetch("data/forecast.json", { cache: "no-cache" })).json();
      if (d.generated_utc === DATA.generated_utc) return;
      const keep = DATA.times[state.hour];
      DATA = d;
      liveCache.clear();                                   // live forecasts must line up with the new hours
      setCourts(socal);
      liveGridKey = null;
      state.base = nowIndex();
      const i = DATA.times.indexOf(keep);
      state.hour = Math.max(state.base, i >= 0 ? i : state.base);
      buildTimeline();
      $("hour").value = state.hour;
      showUpdated();
      render();
      loadGrid();
      loadVisible();
    } catch (_) { /* offline or mid-deploy: try again next time */ }
  }

  // ---------- shareable links: #t=2026-11-16T14&layer=rain&court=day-creek-park ----------
  function setLayer(layer) {
    if (!["play", "wind", "rain"].includes(layer)) return;
    state.layer = layer;
    document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.layer === layer)));
  }
  function readHash() {
    const q = new URLSearchParams(location.hash.slice(1));
    if (q.get("layer")) setLayer(q.get("layer"));
    if (q.get("schools") === "1") { state.schools = true; $("schools").checked = true; }
    const t = q.get("t");
    const i = t ? DATA.times.findIndex((x) => x.startsWith(t)) : -1;
    state.hour = i >= state.base ? i : state.base;
    $("hour").value = state.hour;
    const court = q.get("court");
    if (court && byId.has(court)) state.selected = court;
  }
  function saveHash() {
    const q = new URLSearchParams();
    if (state.hour > state.base) q.set("t", DATA.times[state.hour].slice(0, 13));
    if (state.layer !== "play") q.set("layer", state.layer);
    if (state.schools) q.set("schools", "1");
    if (state.selected) q.set("court", state.selected);
    if (map && map.loaded()) {
      const c = map.getCenter();
      q.set("at", `${c.lat.toFixed(3)},${c.lng.toFixed(3)},${map.getZoom().toFixed(1)}`);
    }
    history.replaceState(null, "", q.toString() ? `#${q}` : location.pathname);
  }
  // "#at=lat,lon,zoom" from a shared link, if any.
  function hashView() {
    const at = new URLSearchParams(location.hash.slice(1)).get("at");
    const [lat, lon, zoom] = (at || "").split(",").map(Number);
    return Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(zoom) ? { center: [lon, lat], zoom } : null;
  }

  // ---------- wiring ----------
  function wire() {
    document.querySelectorAll(".seg button").forEach((btn) => btn.addEventListener("click", () => {
      setLayer(btn.dataset.layer); render(); saveHash();
    }));
    $("schools").addEventListener("change", (e) => { state.schools = e.target.checked; render(); saveHash(); loadVisible(); });
    const slider = $("hour");
    const setHour = (h) => {
      state.hour = Math.max(state.base, Math.min(DATA.times.length - 1, h));
      slider.value = state.hour; render(); saveHash();
    };
    slider.addEventListener("input", () => setHour(Number(slider.value)));
    $("prev").addEventListener("click", () => setHour(state.hour - 1));
    $("next").addEventListener("click", () => setHour(state.hour + 1));
    $("now").addEventListener("click", () => setHour(state.base));
    setInterval(tick, 30 * 1000);
    setInterval(refreshData, 15 * 60 * 1000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { tick(); refreshData(); } });
    const pick = (e) => { const li = e.target.closest("li[data-id]"); if (li) { select(li.dataset.id); saveHash(); } };
    $("list").addEventListener("click", pick);
    $("list").addEventListener("keydown", (e) => { if (e.key === "Enter") pick(e); });
    map.on("click", (e) => {
      // Tapping a dot (zoomed out) zooms in on that court; tapping empty map closes the card.
      const hit = map.queryRenderedFeatures(e.point, { layers: ["dots"] })[0];
      if (hit) { select(hit.properties.id); saveHash(); return; }
      if (state.selected) closeCard();
    });
    map.on("mouseenter", "dots", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "dots", () => { map.getCanvas().style.cursor = ""; });
    const names = () => map.getContainer().classList.toggle("show-names", map.getZoom() >= 12.5);
    map.on("zoom", names);
    names();
    // After the map stops moving: redraw what's on screen, then fetch forecasts it needs.
    let t = null;
    map.on("moveend", () => {
      const ids = markerIds();
      renderDots(ids); renderMarkers(ids); renderList(); renderLegend(); saveHash();
      clearTimeout(t);
      t = setTimeout(() => { loadGrid(); loadVisible(); }, 350);
    });
  }

  // Inland Empire courts (with forecasts) + the rest of SoCal (forecasts load live).
  let socal = [];
  function setCourts(list) {
    socal = list;
    const ie = DATA.courts.map((c) => ({ ...c, live: false }));
    const rest = list.filter((c) => !inRegion(c.lat, c.lon)).map((c) => ({ ...c, live: true }));
    const old = byId;
    COURTS = [...ie, ...rest];
    byId.clear();
    COURTS.forEach((c) => byId.set(c.id, c));
    void old;
  }

  function start(socalList) {
    PAL = { play: css("--play"), iffy: css("--iffy"), skip: css("--skip"), none: css("--muted") };
    setCourts(socalList);
    const pts = DATA.courts.filter((c) => c.type !== "school");
    const lons = pts.map((c) => c.lon), lats = pts.map((c) => c.lat);
    const view = hashView();   // a shared link's map position, else the Inland Empire
    map = new maplibregl.Map({
      container: "map",
      style: STYLE_URL,
      ...(view || {
        bounds: [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
        fitBoundsOptions: { padding: innerWidth < 760 ? { top: 60, bottom: 16, left: 14, right: 14 } : { top: 70, bottom: 40, left: 40, right: 40 } },
      }),
      attributionControl: { compact: true, customAttribution: 'Forecast: <a href="https://open-meteo.com/">Open-Meteo</a>' },
      dragRotate: false,
      pitchWithRotate: false,
      minZoom: 6.5,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.touchZoomRotate.disableRotation();
    map.on("error", (e) => console.warn("map:", e.error && e.error.message));
    map.on("idle", () => { document.body.dataset.mapReady = loading ? "" : "1"; });
    map.once("style.load", () => {
      softenBasemap();
      map.addSource("dots", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "dots", type: "circle", source: "dots", paint: {
        "circle-color": ["get", "color"], "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 2.5, 10, 5],
        "circle-stroke-color": DARK ? "#1f2833" : "#ffffff", "circle-stroke-width": 1, "circle-opacity": 0.9 } });
      liveGridKey = "ie";
      buildWeather(DATA.grid.cells);
      state.base = state.hour = nowIndex();
      buildTimeline();
      wire();
      readHash();
      render();
      if (state.selected) select(state.selected);
      loadVisible();
    });
  }

  Promise.all([
    fetch("data/forecast.json", { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    fetch("courts-socal.json").then((r) => (r.ok ? r.json() : { courts: [] })).catch(() => ({ courts: [] })),
  ]).then(([d, s]) => {
    DATA = d;
    showUpdated();
    start(s.courts || []);
  }).catch((err) => { $("updated").textContent = `Couldn't load the forecast (${err.message}).`; });
})();
