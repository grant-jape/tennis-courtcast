/* IE CourtCast map: reads data/forecast.json (built by courtcast/build.py). */
(() => {
  "use strict";

  // Sequential blue ramp, light -> dark (one hue for magnitude).
  const BLUES = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
  const BAND_LABEL = { play: "Play", iffy: "Iffy", skip: "Skip" };
  const LAYERS = {
    play: { title: "Playability score (0–10)" },
    wind: { title: "Wind gusts (mph)", key: "g", edges: [6, 10, 15, 20, 25, 30], fmt: (v) => `${v} mph` },
    // Amount comes from HRRR (3 km), so it shows where rain actually falls; the
    // chance comes from a coarser ensemble and is nearly flat across the region.
    rain: { title: "Forecast rain (inches per hour)", key: "r", edges: [0.005, 0.01, 0.02, 0.05, 0.1, 0.2],
            labels: ["trace", ".01", ".02", ".05", ".10", ".20+"] },
  };

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const state = { layer: "play", hour: 0, schools: false };
  let DATA, map, cells = [], arrows = [], pins = [];

  // ---------- helpers ----------
  const bin = (v, edges) => { let i = 0; while (i < edges.length && v >= edges[i]) i++; return i; };
  const bandOf = (s) => (s >= DATA.bands.play ? "play" : s >= DATA.bands.iffy ? "iffy" : "skip");
  const compass = (deg) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];

  function fmtTime(iso, short) {
    const [d, t] = iso.split("T");
    const [y, m, day] = d.split("-").map(Number);
    const h = Number(t.slice(0, 2));
    const wk = new Date(y, m - 1, day).toLocaleDateString("en-US", { weekday: "short" });
    const hh = `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
    return short ? hh.replace(" ", "").toLowerCase() : `${wk} ${hh}`;
  }

  function cellStyle(c) {
    const h = state.hour;
    if (state.layer === "play") {
      const b = bandOf(c.s[h]);
      // Good areas get a faint tint so trouble spots stand out.
      return { fillColor: css(`--${b}`), fillOpacity: b === "play" ? 0.1 : 0.42 };
    }
    const L = LAYERS[state.layer];
    const v = c[L.key][h];
    const i = bin(v, L.edges);
    // The lowest bin stays clear so calm / dry areas don't tint the whole map.
    return i === 0 ? { fillOpacity: 0 } : { fillColor: BLUES[i], fillOpacity: 0.5 };
  }

  // ---------- map ----------
  function initMap() {
    map = L.map("map", { zoomControl: true, attributionControl: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Forecast: <a href="https://open-meteo.com/">Open-Meteo</a>',
    }).addTo(map);

    const { step_lat: sl, step_lon: so } = DATA.grid;
    DATA.grid.cells.forEach((c) => {
      const r = L.rectangle([[c.lat - sl / 2, c.lon - so / 2], [c.lat + sl / 2, c.lon + so / 2]],
        { stroke: false, interactive: true });
      r.bindTooltip(() => cellTip(c), { sticky: true });
      r.addTo(map);
      cells.push({ c, r });
      const a = L.marker([c.lat, c.lon], { interactive: false, keyboard: false, icon: L.divIcon({ className: "arrow", html: "", iconSize: [18, 18] }) });
      arrows.push({ c, a });
    });

    DATA.courts.forEach((ct) => {
      const m = L.marker([ct.lat, ct.lon], { title: ct.name, riseOnHover: true });
      m.bindPopup(() => popupHtml(ct), { maxWidth: 300 });
      pins.push({ ct, m });
    });

    const b = L.latLngBounds(DATA.courts.filter((c) => c.type !== "school").map((c) => [c.lat, c.lon]));
    map.fitBounds(b.pad(0.08));
  }

  function cellTip(c) {
    const h = state.hour;
    const rain = c.r[h] > 0 ? `${c.r[h]} in rain (${c.p[h]}% chance)` : `${c.p[h]}% rain chance`;
    return `Score ${c.s[h].toFixed(1)} · gusts ${c.g[h]} mph from ${compass(c.d[h])} · ${rain} · ${c.t[h]}°F`;
  }

  function arrowSvg(c) {
    const h = state.hour, g = c.g[h];
    const size = 10 + Math.min(g, 35) / 35 * 10;          // longer arrow = stronger gusts
    const rot = (c.d[h] + 180) % 360;                      // direction is "from"; arrow points where it blows
    const ink = css("--ink");
    return `<svg width="18" height="18" viewBox="-9 -9 18 18" style="transform:rotate(${rot}deg)" aria-hidden="true">
      <line x1="0" y1="${size / 2}" x2="0" y2="${-size / 2}" stroke="${ink}" stroke-width="1.6" stroke-linecap="round"/>
      <path d="M-3 ${-size / 2 + 3} L0 ${-size / 2} L3 ${-size / 2 + 3}" fill="none" stroke="${ink}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  function popupHtml(ct) {
    const h = state.hour, b = ct.b[h];
    const why = ct.why[h].length ? ct.why[h].join(" · ") : "Nothing in the way";
    const strip = [];
    for (let i = h; i < Math.min(h + 12, DATA.times.length); i++) {
      const night = DATA.is_day[i] ? "" : " night";
      strip.push(`<div><i class="${ct.b[i]}${night}" title="${fmtTime(DATA.times[i])}: ${ct.s[i]}"></i>${fmtTime(DATA.times[i], true)}</div>`);
    }
    return `<div class="pop">
      <h3>${ct.name}</h3><div class="muted">${ct.city}${ct.type === "school" ? " · school courts, access varies" : ""}</div>
      <div class="head"><span class="pill ${b}">${ct.s[h].toFixed(1)}</span><div><strong>${BAND_LABEL[b]}</strong> at ${fmtTime(DATA.times[h])}<div class="why">${why}</div></div></div>
      <dl>
        <dt>Wind</dt><dd>${ct.w[h]} mph from ${compass(ct.d[h])}, gusts ${ct.g[h]}</dd>
        <dt>Rain</dt><dd>${ct.p[h]}% chance${ct.r[h] > 0 ? ` · ${ct.r[h]} in` : ""}</dd>
        <dt>Temp</dt><dd>${ct.t[h]}°F</dd>
      </dl>
      <div class="muted">Next 12 hours (faded = dark)</div>
      <div class="strip">${strip.join("")}</div>
      <div class="best">${bestWindow(ct, h)}</div>
    </div>`;
  }

  // Best 2-hour daylight window in the next 12 hours (average score).
  function bestWindow(ct, h) {
    let best = null;
    for (let i = h; i < Math.min(h + 11, DATA.times.length - 1); i++) {
      if (!DATA.is_day[i] || !DATA.is_day[i + 1]) continue;
      const avg = (ct.s[i] + ct.s[i + 1]) / 2;
      if (!best || avg > best.avg) best = { i, avg };
    }
    return best ? `Best daylight window: ${fmtTime(DATA.times[best.i])}–${fmtTime(DATA.times[best.i + 2] || DATA.times[best.i + 1])} (${best.avg.toFixed(1)})` : "No daylight hours in the next 12 hours";
  }

  // ---------- render ----------
  function render() {
    const h = state.hour;
    cells.forEach(({ c, r }) => r.setStyle(cellStyle(c)));

    arrows.forEach(({ c, a }) => {
      if (state.layer === "wind") {
        a.setIcon(L.divIcon({ className: "arrow", html: arrowSvg(c), iconSize: [18, 18] }));
        if (!map.hasLayer(a)) a.addTo(map);
      } else if (map.hasLayer(a)) map.removeLayer(a);
    });

    pins.forEach(({ ct, m }) => {
      const show = state.schools || ct.type !== "school";
      if (!show) { if (map.hasLayer(m)) map.removeLayer(m); return; }
      const b = ct.b[h], small = ct.type === "school";
      m.setIcon(L.divIcon({
        className: "", iconSize: small ? [22, 22] : [30, 30],
        html: `<div class="pin ${b}${small ? " school" : ""}" aria-label="${ct.name}: ${ct.s[h]} ${BAND_LABEL[b]}">${ct.s[h] >= 10 ? "10" : ct.s[h].toFixed(1)}</div>`,
      }));
      if (!map.hasLayer(m)) m.addTo(map);
      if (m.isPopupOpen()) m.setPopupContent(popupHtml(ct));
    });

    document.getElementById("timeLabel").textContent = fmtTime(DATA.times[h]) + (h === 0 ? " (now)" : "");
    document.getElementById("dayLabel").textContent = DATA.is_day[h] ? "" : "· after dark, lit courts only";
    renderLegend();
    renderList();
  }

  function renderLegend() {
    const L = LAYERS[state.layer];
    let sw;
    if (state.layer === "play") {
      sw = [["skip", `Skip &lt;${DATA.bands.iffy}`], ["iffy", `Iffy ${DATA.bands.iffy}–${DATA.bands.play}`], ["play", `Play ${DATA.bands.play}+`]]
        .map(([b, t]) => `<div class="sw" style="min-width:70px"><i style="background:${css(`--${b}`)}"></i><span>${t}</span></div>`);
    } else {
      sw = L.edges.map((e, i) => `<div class="sw"><i style="background:${BLUES[i + 1]}"></i><span>${L.labels ? L.labels[i] : e + (i === L.edges.length - 1 ? "+" : "")}</span></div>`);
    }
    document.getElementById("legend").innerHTML = `<div class="title">${L.title}</div><div class="row">${sw.join("")}</div>`;
  }

  function renderList() {
    const h = state.hour;
    const items = DATA.courts
      .filter((c) => state.schools || c.type !== "school")
      .sort((a, b) => b.s[h] - a.s[h] || a.g[h] - b.g[h] || a.name.localeCompare(b.name));
    document.getElementById("listTitle").textContent = `Best courts · ${fmtTime(DATA.times[h])}`;
    const ol = document.getElementById("list");
    ol.innerHTML = items.map((c) => {
      const b = c.b[h];
      const why = c.why[h].length ? c.why[h].join(" · ") : `Gusts ${c.g[h]} mph · ${c.p[h]}% rain · ${c.t[h]}°F`;
      return `<li tabindex="0" data-id="${c.id}"><span class="pill ${b}" aria-label="${BAND_LABEL[b]}">${c.s[h].toFixed(1)}</span>
        <div><div class="name">${c.name}</div><div class="sub">${c.city} · ${BAND_LABEL[b]} · ${why}</div></div></li>`;
    }).join("");
  }

  function focusCourt(id) {
    const p = pins.find((x) => x.ct.id === id);
    if (!p) return;
    map.setView(p.m.getLatLng(), Math.max(map.getZoom(), 13));
    p.m.openPopup();
  }

  // ---------- shareable links: #t=2026-11-16T14&layer=rain ----------
  function setLayer(layer) {
    if (!LAYERS[layer]) return;
    state.layer = layer;
    document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.layer === layer)));
  }
  function readHash() {
    const q = new URLSearchParams(location.hash.slice(1));
    if (q.get("layer")) setLayer(q.get("layer"));
    if (q.get("schools") === "1") { state.schools = true; document.getElementById("schools").checked = true; }
    const t = q.get("t");
    const i = t ? DATA.times.findIndex((x) => x.startsWith(t)) : -1;
    state.hour = i >= 0 ? i : 0;  // a stale link (time already passed) falls back to now
    document.getElementById("hour").value = state.hour;
  }
  function saveHash() {
    const q = new URLSearchParams();
    if (state.hour > 0) q.set("t", DATA.times[state.hour].slice(0, 13));
    if (state.layer !== "play") q.set("layer", state.layer);
    if (state.schools) q.set("schools", "1");
    history.replaceState(null, "", q.toString() ? `#${q}` : location.pathname);
  }

  // ---------- wiring ----------
  function wire() {
    document.querySelectorAll(".seg button").forEach((btn) => btn.addEventListener("click", () => {
      setLayer(btn.dataset.layer);
      render();
      saveHash();
    }));
    document.getElementById("schools").addEventListener("change", (e) => { state.schools = e.target.checked; render(); saveHash(); });
    const slider = document.getElementById("hour");
    slider.max = DATA.times.length - 1;
    const setHour = (h) => { state.hour = Math.max(0, Math.min(DATA.times.length - 1, h)); slider.value = state.hour; render(); saveHash(); };
    slider.addEventListener("input", () => setHour(Number(slider.value)));
    document.getElementById("prev").addEventListener("click", () => setHour(state.hour - 1));
    document.getElementById("next").addEventListener("click", () => setHour(state.hour + 1));
    document.getElementById("now").addEventListener("click", () => setHour(0));
    const list = document.getElementById("list");
    list.addEventListener("click", (e) => { const li = e.target.closest("li"); if (li) focusCourt(li.dataset.id); });
    list.addEventListener("keydown", (e) => { if (e.key === "Enter") { const li = e.target.closest("li"); if (li) focusCourt(li.dataset.id); } });
  }

  fetch("data/forecast.json", { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((d) => {
      DATA = d;
      const gen = new Date(d.generated_utc.replace("Z", ":00Z"));
      document.getElementById("updated").textContent =
        `Updated ${gen.toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit" })} PT`;
      initMap();
      wire();
      readHash();
      render();
    })
    .catch((err) => {
      document.getElementById("updated").textContent = `Couldn't load the forecast (${err.message}).`;
    });
})();
