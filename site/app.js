/* Tennis CourtCast map: reads data/forecast.json (built by courtcast/build.py). */
(() => {
  "use strict";

  const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
  const DARK = matchMedia("(prefers-color-scheme: dark)").matches;

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
  let DATA, map, markers = [], field, PAL;

  // ---------- small helpers ----------
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const clamp01 = (t) => Math.max(0, Math.min(1, t));
  const bandOf = (s) => (s >= DATA.bands.play ? "play" : s >= DATA.bands.iffy ? "iffy" : "skip");
  const compass = (deg) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];

  // ---------- real time (always Pacific, wherever the viewer is) ----------
  const PT = "America/Los_Angeles";
  // The current Pacific hour in the same "YYYY-MM-DDTHH:00" form as DATA.times.
  function pacificHourStamp(date = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: PT, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
    }).formatToParts(date).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
  }
  const clockText = () => new Date().toLocaleTimeString("en-US", { timeZone: PT, hour: "numeric", minute: "2-digit" });
  // Where the real current hour sits in the forecast (the data can be ~2 h old).
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

  // Small line icons (emoji render in odd colours on some systems).
  const ICON = {
    wind: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 6h8.2a2.2 2.2 0 1 0-2.1-2.9M1.5 10h11a2 2 0 1 1-1.9 2.6M1.5 8h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    rain: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8C8 1.8 3.5 7 3.5 10a4.5 4.5 0 0 0 9 0C12.5 7 8 1.8 8 1.8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    temp: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 9.4V3a1.5 1.5 0 0 1 3 0v6.4a3 3 0 1 1-3 0z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8" cy="11.8" r="1.2" fill="currentColor"/></svg>',
  };

  // A top-down tennis court, coloured by how playable it is (green / amber / red).
  function courtSvg(band) {
    return `<svg class="court" viewBox="0 0 30 18" aria-hidden="true">
      <rect x=".75" y=".75" width="28.5" height="16.5" rx="3" fill="${PAL[band]}"/>
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
      else if (id === "natural_earth") paint("raster-opacity", B.hills);   // gentle hillshade for the mountains
      else if (/^(building|poi_|boundary)|one_way|hatching|road_area_pattern|park_outline|path|pedestrian/.test(id)) hide();
      else if (id === "park" || /landcover_(wood|grass)/.test(id)) { paint("fill-color", B.park); paint("fill-outline-color", B.park); paint("fill-opacity", 0.85); }
      else if (id === "landuse_residential") paint("fill-opacity", 0);
      else if (/^landuse_|aeroway_fill|landcover_(sand|ice|wetland)/.test(id)) paint("fill-color", B.landuse);
      else if (id === "water") paint("fill-color", B.water);
      else if (/^waterway/.test(id)) paint("line-color", B.water);
      else if (l.type === "line" && l["source-layer"] === "transportation") {
        const major = /motorway/.test(id);   // only freeways get colour, like Waze
        if (/rail/.test(id)) paint("line-color", B.rail);
        else if (/casing/.test(id)) paint("line-color", major ? B.majorCasing : B.casing);
        else paint("line-color", major ? B.major : B.road);
      } else if (l.type === "symbol") {
        paint("text-color", B.label);
        paint("text-halo-color", B.halo);
        paint("text-halo-width", 1.5);
      }
    }
  }

  // ---------- smooth condition field ----------
  // The forecast is a grid of ~3 km cells. We blend between neighbouring cells
  // (bilinear interpolation) and blur lightly, so the map shows soft "weather
  // blobs" instead of squares. Good conditions are fully transparent.
  function buildField() {
    const lats = [...new Set(DATA.grid.cells.map((c) => c.lat))].sort((a, b) => a - b);
    const lons = [...new Set(DATA.grid.cells.map((c) => c.lon))].sort((a, b) => a - b);
    const byKey = new Map(DATA.grid.cells.map((c) => [`${c.lat},${c.lon}`, c]));
    const rows = lats.map((la) => lons.map((lo) => byKey.get(`${la},${lo}`)));
    const px = 24;                                     // pixels per grid step
    const W = (lons.length - 1) * px + 1, H = (lats.length - 1) * px + 1;
    const raw = Object.assign(document.createElement("canvas"), { width: W, height: H });
    const out = Object.assign(document.createElement("canvas"), { width: W, height: H });
    field = {
      lats, lons, rows, W, H, raw, out,
      coords: [[lons[0], lats.at(-1)], [lons.at(-1), lats.at(-1)], [lons.at(-1), lats[0]], [lons[0], lats[0]]],
    };
  }

  // value -> [r, g, b, alpha 0..1] for the current layer
  function colorFor(v) {
    if (state.layer === "play") {                      // v = score; only trouble shows
      const a = clamp01((8 - v) / 5) * 0.4;
      return [...mix([250, 190, 70], [236, 110, 90], clamp01((6.5 - v) / 3)), a];   // soft amber -> coral
    }
    if (state.layer === "wind") {                      // v = gust mph
      const a = clamp01((v - 8) / 20) * 0.6;
      return [...mix([170, 228, 214], [13, 110, 92], clamp01((v - 10) / 22)), a];
    }
    if (v < 0.002) return [0, 0, 0, 0];               // v = rain inches this hour
    return [...mix([125, 178, 240], [16, 66, 129], clamp01(v / 0.1)), 0.3 + clamp01(v / 0.05) * 0.4];
  }

  function drawField() {
    const { rows, W, H, raw, out, lats, lons } = field;
    const key = { play: "s", wind: "g", rain: "r" }[state.layer];
    const h = state.hour, nr = lats.length, nc = lons.length;
    const vals = rows.map((r) => r.map((c) => c[key][h]));
    const ctx = raw.getContext("2d");
    const img = ctx.createImageData(W, H);
    const fadePx = W * 0.07;                           // soften the outer edge of the region
    for (let y = 0; y < H; y++) {
      const fy = ((H - 1 - y) / (H - 1)) * (nr - 1);
      const r0 = Math.min(nr - 2, Math.floor(fy)), ty = fy - r0;
      for (let x = 0; x < W; x++) {
        const fx = (x / (W - 1)) * (nc - 1);
        const c0 = Math.min(nc - 2, Math.floor(fx)), tx = fx - c0;
        const v = vals[r0][c0] * (1 - tx) * (1 - ty) + vals[r0][c0 + 1] * tx * (1 - ty)
                + vals[r0 + 1][c0] * (1 - tx) * ty + vals[r0 + 1][c0 + 1] * tx * ty;
        const [R, G, B, A] = colorFor(v);
        const edge = clamp01(Math.min(x, W - 1 - x, y, H - 1 - y) / fadePx);
        const i = (y * W + x) * 4;
        img.data[i] = R; img.data[i + 1] = G; img.data[i + 2] = B; img.data[i + 3] = 255 * A * edge;
      }
    }
    ctx.putImageData(img, 0, 0);
    const octx = out.getContext("2d");
    octx.clearRect(0, 0, W, H);
    octx.filter = "blur(5px)";
    octx.drawImage(raw, 0, 0);

    const url = out.toDataURL();
    const src = map.getSource("field");
    if (src) { src.updateImage({ url, coordinates: field.coords }); return; }
    map.addSource("field", { type: "image", url, coordinates: field.coords });
    const firstLabel = map.getStyle().layers.find((l) => l.type === "symbol");
    map.addLayer({ id: "field", type: "raster", source: "field",
      paint: { "raster-resampling": "linear", "raster-fade-duration": 0, "raster-opacity": 1 } }, firstLabel && firstLabel.id);
  }

  // ---------- court markers ----------
  function buildMarkers() {
    DATA.courts.forEach((ct) => {
      const el = document.createElement("div");
      el.className = "court-marker";
      el.tabIndex = 0;
      el.addEventListener("click", (e) => { e.stopPropagation(); select(ct.id); });
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") select(ct.id); });
      const m = new maplibregl.Marker({ element: el, anchor: "top", offset: [0, -11] }).setLngLat([ct.lon, ct.lat]);
      markers.push({ ct, el, m, shown: false });
    });
  }

  // The label under each court: score, gusts, or rain (amount if any, else chance).
  function chipValue(ct, h) {
    if (state.layer === "wind") return `${ct.g[h]} mph`;
    if (state.layer === "rain") return ct.r[h] > 0 ? `${ct.r[h].toFixed(2)} in` : `${ct.p[h]}%`;
    return ct.s[h] >= 10 ? "10" : ct.s[h].toFixed(1);
  }

  // How notable a court is for the current view; higher sits on top when markers overlap.
  function notability(ct, h) {
    if (ct.id === state.selected) return 1e6;
    const school = ct.type === "school" ? 0 : 1e5;
    if (state.layer === "wind") return school + ct.g[h];
    if (state.layer === "rain") return school + ct.r[h] * 1000 + ct.p[h];
    return school + ct.s[h] * 10;
  }

  function renderMarkers() {
    const h = state.hour;
    markers.forEach((mk) => {
      const { ct, el, m } = mk;
      const show = state.schools || ct.type !== "school";
      if (!show) { if (mk.shown) { m.remove(); mk.shown = false; } return; }
      // Wind view colours courts by wind alone; other views use the overall score.
      const b = state.layer === "wind" && ct.wb ? ct.wb[h] : ct.b[h];
      el.classList.toggle("selected", state.selected === ct.id);
      el.setAttribute("aria-label", `${ct.name}: ${BAND[b].label}, ${ct.s[h]} out of 10`);
      // Small court icon with the number beside it, always visible at every zoom.
      // Court icon (coloured by playability) on top; the number on a white label underneath.
      el.innerHTML = `<div class="pin${ct.type === "school" ? " school" : ""}">${courtSvg(b)}</div><div class="lbl">${chipValue(ct, h)}</div><div class="nm">${ct.name}</div>`;
      el.style.zIndex = String(Math.round(notability(ct, h)));
      if (!mk.shown) { m.addTo(map); mk.shown = true; }
    });
  }

  // ---------- court card ----------
  function select(id) {
    state.selected = id;
    render();   // draws the card first so we know how much map it covers
    const mk = markers.find((x) => x.ct.id === id);
    if (!mk) return;
    // Centre the court in the part of the map the card leaves visible:
    // above the card on phones (full-width sheet), right of it on desktop.
    const card = $("card"), wrap = map.getContainer();
    const fullWidth = card.offsetWidth > wrap.offsetWidth * 0.7;
    const padding = fullWidth
      ? { top: 0, left: 0, right: 0, bottom: Math.min(card.offsetHeight + 12, wrap.offsetHeight * 0.7) }
      : { top: 0, bottom: 0, right: 0, left: card.offsetWidth + 24 };
    map.easeTo({ center: [mk.ct.lon, mk.ct.lat], zoom: Math.max(map.getZoom(), 12.5), padding, duration: 600 });
  }

  // MapLibre keeps camera padding until it's reset, so clear it when the card closes.
  function closeCard() {
    state.selected = null;
    render();
    saveHash();
    map.easeTo({ padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 300 });
  }

  function renderCard() {
    const card = $("card");
    const ct = state.selected && DATA.courts.find((c) => c.id === state.selected);
    if (!ct) { card.hidden = true; return; }
    const h = state.hour, b = ct.b[h];
    const why = ct.why[h].length ? ct.why[h].join(" · ") : "Nothing in the way";
    const strip = [];
    for (let i = h; i < Math.min(h + 12, DATA.times.length); i++) {
      strip.push(`<div><i class="${ct.b[i]}${DATA.is_day[i] ? "" : " night"}" title="${fmtTime(DATA.times[i])}: ${ct.s[i]}"></i>${fmtTime(DATA.times[i], true)}</div>`);
    }
    card.innerHTML = `
      <button class="x" aria-label="Close">×</button>
      <div class="head">${courtSvg(b)}<div><h3>${ct.name}</h3><div class="muted small">${ct.city}${ct.type === "school" ? " · school courts, access varies" : ""}</div></div></div>
      <div class="verdict ${b}"><span class="face" aria-hidden="true">${BAND[b].face}</span>
        <div><strong>${BAND[b].label}</strong><span class="muted small">${fmtTime(DATA.times[h])} · ${why}</span></div>
        <span class="score">${ct.s[h].toFixed(1)}<small>/10</small></span></div>
      <div class="facts">
        <span>${ICON.temp} ${ct.t[h]}°F</span>
        <span>${ICON.wind} ${ct.w[h]} mph, gusts ${ct.g[h]} · from ${compass(ct.d[h])}</span>
        <span>${ICON.rain} ${ct.p[h]}% chance${ct.r[h] > 0 ? ` · ${ct.r[h]}″` : ""}</span>
      </div>
      <div class="muted small">Next 12 hours (faded = after dark)</div>
      <div class="strip">${strip.join("")}</div>
      <div class="best">${bestWindow(ct, h)}</div>`;
    card.hidden = false;
    card.querySelector(".x").addEventListener("click", closeCard);
  }

  // Best 2-hour daylight window in the next 12 hours (average score).
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
    const grad = (stops) => `linear-gradient(90deg, ${stops.map(([c, a]) => `rgb(${c.join(" ")} / ${a})`).join(", ")})`;
    let html;
    if (state.layer === "play") {
      html = `<div class="title">Playability score</div>
        <div class="keys"><span><i style="background:${PAL.play}"></i>Play</span><span><i style="background:${PAL.iffy}"></i>Iffy</span><span><i style="background:${PAL.skip}"></i>Skip it</span></div>
        <div class="muted small" style="margin-top:3px">Shaded areas = not great</div>`;
    } else if (state.layer === "wind") {
      html = `<div class="title">Wind gusts</div><div class="bar" style="background:${grad([[[170, 228, 214], 0.15], [[60, 170, 140], 0.7], [[13, 110, 92], 1]])}"></div>
        <div class="ends"><span>calm</span><span>15 mph</span><span>30+ mph</span></div>
        <div class="keys"><span><i style="background:${PAL.play}"></i>0–7</span><span><i style="background:${PAL.iffy}"></i>8–24</span><span><i style="background:${PAL.skip}"></i>25+ mph gusts</span></div>`;
    } else {
      html = `<div class="title">Rain this hour</div><div class="bar" style="background:${grad([[[125, 178, 240], 0.4], [[57, 135, 229], 0.8], [[16, 66, 129], 1]])}"></div>
        <div class="ends"><span>sprinkle</span><span>0.05″</span><span>0.1″+</span></div>`;
    }
    $("legend").innerHTML = html;
  }

  function renderList() {
    const h = state.hour;
    const items = DATA.courts
      .filter((c) => state.schools || c.type !== "school")
      .sort((a, b) => b.s[h] - a.s[h] || a.g[h] - b.g[h] || a.name.localeCompare(b.name));
    $("listTitle").textContent = `Best courts · ${fmtTime(DATA.times[h])}`;
    $("list").innerHTML = items.map((c) => {
      const b = c.b[h];
      const why = c.why[h].length ? c.why[h].join(" · ") : `Gusts ${c.g[h]} mph · ${c.p[h]}% rain · ${c.t[h]}°F`;
      return `<li tabindex="0" data-id="${c.id}">${courtSvg(b)}
        <div><div class="name">${c.name}</div><div class="sub">${c.city} · ${why}</div></div>
        <span class="num" aria-label="${BAND[b].label}, score">${c.s[h].toFixed(1)}</span></li>`;
    }).join("");
  }

  function render() {
    const h = state.hour;
    drawField();
    renderMarkers();
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

  // Slider runs from the real current hour to the end of the forecast. The bar is
  // shaded day/night and labelled every 6 hours, with the weekday at midnight.
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
      // Match the native thumb's travel: it moves between thumb/2 and width - thumb/2.
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

  // Every 30 s: keep the clock live and move "now" forward when the hour turns over.
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
      markers.forEach((mk) => { const c = d.courts.find((x) => x.id === mk.ct.id); if (c) mk.ct = c; });
      buildField();
      state.base = nowIndex();
      const i = DATA.times.indexOf(keep);
      state.hour = Math.max(state.base, i >= 0 ? i : state.base);
      buildTimeline();
      $("hour").value = state.hour;
      showUpdated();
      render();
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
    state.hour = i >= state.base ? i : state.base;   // a link to a time that already passed falls back to now
    $("hour").value = state.hour;
    const court = q.get("court");
    if (court && DATA.courts.some((c) => c.id === court)) state.selected = court;
  }
  function saveHash() {
    const q = new URLSearchParams();
    if (state.hour > state.base) q.set("t", DATA.times[state.hour].slice(0, 13));
    if (state.layer !== "play") q.set("layer", state.layer);
    if (state.schools) q.set("schools", "1");
    if (state.selected) q.set("court", state.selected);
    history.replaceState(null, "", q.toString() ? `#${q}` : location.pathname);
  }

  // ---------- wiring ----------
  function wire() {
    document.querySelectorAll(".seg button").forEach((btn) => btn.addEventListener("click", () => {
      setLayer(btn.dataset.layer); render(); saveHash();
    }));
    $("schools").addEventListener("change", (e) => { state.schools = e.target.checked; render(); saveHash(); });
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
    const pick = (e) => { const li = e.target.closest("li"); if (li) { select(li.dataset.id); saveHash(); } };
    $("list").addEventListener("click", pick);
    $("list").addEventListener("keydown", (e) => { if (e.key === "Enter") pick(e); });
    map.on("click", () => { if (state.selected) closeCard(); });
    // Names appear once you're zoomed in (numbers are always on the courts).
    const names = () => map.getContainer().classList.toggle("show-names", map.getZoom() >= 12.5);
    map.on("zoom", names);
    names();
  }

  function start() {
    PAL = {
      play: css("--play"), iffy: css("--iffy"), skip: css("--skip"),
      iffyRGB: hex(css("--iffy")), skipRGB: hex(css("--skip")),
    };
    const pts = DATA.courts.filter((c) => c.type !== "school");
    const lons = pts.map((c) => c.lon), lats = pts.map((c) => c.lat);
    map = new maplibregl.Map({
      container: "map",
      style: STYLE_URL,
      bounds: [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
      // Tighter margins on phones so the map opens more zoomed in and courts spread out.
      fitBoundsOptions: { padding: innerWidth < 760 ? { top: 60, bottom: 16, left: 14, right: 14 } : { top: 70, bottom: 40, left: 40, right: 40 } },
      attributionControl: { compact: true, customAttribution: 'Forecast: <a href="https://open-meteo.com/">Open-Meteo</a>' },
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.touchZoomRotate.disableRotation();
    map.on("error", (e) => console.warn("map:", e.error && e.error.message));
    map.on("idle", () => { document.body.dataset.mapReady = "1"; });  // lets tests know rendering finished
    // "style.load" fires once the style is ready; "load" would also wait for every
    // tile, which on a slow phone connection delays the court list for no reason.
    map.once("style.load", () => {
      softenBasemap();
      buildField();
      buildMarkers();
      state.base = state.hour = nowIndex();
      buildTimeline();
      wire();
      readHash();
      render();
      if (state.selected) select(state.selected);
    });
  }

  fetch("data/forecast.json", { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((d) => {
      DATA = d;
      showUpdated();
      start();
    })
    .catch((err) => { $("updated").textContent = `Couldn't load the forecast (${err.message}).`; });
})();
