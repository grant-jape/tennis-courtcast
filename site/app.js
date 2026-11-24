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
  let DATA, map, markers = [], weather, PAL;

  // ---------- small helpers ----------
  // Forecast files list each ~3 km square's forecast once ("cells"), and each court points at its
  // square. Give every court its square's hourly arrays (shared, not copied). Older files had them inline.
  const CELL_KEYS = ["s", "b", "wb", "why", "t", "p", "r", "w", "g", "d", "wc"];
  function hydrate(d) {
    if (d.cells) d.courts.forEach((c) => {
      const cell = d.cells[c.cell];
      if (cell) CELL_KEYS.forEach((k) => { if (cell[k]) c[k] = cell[k]; });
    });
    return d;
  }
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

  // Tiny day/night markers for the card's hour strip.
  const SUN = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.2" fill="currentColor"/><g stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1"/></g></svg>';
  const MOON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.8 2.2a6 6 0 1 0 3 9.6 5 5 0 0 1-3-9.6z" fill="currentColor"/></svg>';

  // A top-down tennis court, coloured by how playable it is (green / amber / red).
  // band "closed" = a gray court with a ✕: the court itself isn't playable.
  function courtSvg(band) {
    const x = band === "closed"
      ? '<path d="M9 4L21 14M21 4L9 14" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>' : "";
    return `<svg class="court" viewBox="0 0 30 18" aria-hidden="true">
      <rect x=".75" y=".75" width="28.5" height="16.5" rx="3" fill="${PAL[band]}"/>
      <g fill="none" stroke="#fff" stroke-width="1.1" stroke-linecap="round" opacity="${x ? 0.45 : 1}">
        <rect x="3.5" y="3" width="23" height="12"/>
        <path d="M9.5 3V15M20.5 3V15M9.5 9H20.5"/>
        <path d="M15 1.8V16.2" stroke-width="1.8"/>
      </g>${x}
    </svg>`;
  }

  // ---------- court status (from courts.csv: "" / "poor" / "closed") ----------
  const STATUS = {
    poor: { badge: "⚠", label: "Rough court", cls: "poor" },
    closed: { badge: "✕", label: "Not playable", cls: "closed" },
  };
  // Free Google Maps links (no API key): the park's place page (photos, reviews, directions) and Street View.
  const mapsUrl = (ct) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${ct.name}, ${ct.city}, CA`)}`;
  const streetUrl = (ct) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${ct.lat},${ct.lon}`;

  // ---------- accounts, votes, comments, favorites, court checks (Supabase) ----------
  // The publishable key is public by design. The database's row-level security decides who can
  // do what: everyone can read votes and comments; a signed-in player can only add, edit or
  // delete their own, and the database (not the browser) stamps who wrote it.
  const SB_URL = "https://bbdfrjgzuopnowrpetgh.supabase.co";
  const SB_KEY = "sb_publishable_1XK4mRoUxl2Ey5GzxX4nUQ_6RHTUsk3";
  // What the URL said when we landed: an email link (?code=…, ?reset=1) or an auth error.
  // Read before Supabase tidies the URL.
  const LANDED = (() => {
    const q = new URLSearchParams(location.search), hq = new URLSearchParams(location.hash.slice(1));
    return { code: q.has("code"), reset: q.get("reset") === "1", error: q.get("error_description") || hq.get("error_description") };
  })();
  // ?welcome (or #welcome) shows the welcome setup again, for testing or a fresh start.
  const FORCE_WELCOME = new URLSearchParams(location.search).has("welcome") || /(^|[#&])welcome(&|=|$)/.test(location.hash);
  // After Google sign-in we come back with ?code=…; put the map back where the player was.
  try {
    const back = sessionStorage.getItem("cc-return");
    if (back !== null && LANDED.code) {
      history.replaceState(null, "", location.pathname + location.search + back);
      sessionStorage.removeItem("cc-return");
    }
  } catch (_) { /* storage blocked: just land on the default view */ }
  const sb = window.supabase
    ? window.supabase.createClient(SB_URL, SB_KEY, { auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true } })
    : null;
  const community = {
    user: null, profile: null, stats: null, googleReady: false, emailReady: false,
    summary: new Map(), comments: new Map(), myVote: new Map(), loading: new Set(),
    favorites: new Set(), activity: new Map(), near: null,
  };
  // Settles once we know the signed-in player's ★ courts (or that there's no one signed in),
  // so the map can open on them.
  let mineDone;
  const mineReady = new Promise((ok) => { mineDone = ok; });
  const RATING = {
    great: { label: "Great", face: "👍" },
    okay: { label: "Okay", face: "👌" },
    poor: { label: "Poor", face: "👎" },
    unplayable: { label: "Not playable", face: "🚫" },
  };
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // The name we show: the profile's (editable), else what Google or the sign-up form gave us.
  function displayName(u = community.user) {
    if (!u) return "Player";
    const p = community.profile && community.profile.display_name;
    const m = u.user_metadata || {};
    return (p || m.full_name || m.name || (u.email || "").split("@")[0] || "Player").trim();
  }
  const firstName = (u) => displayName(u).split(" ")[0];
  function ago(ts) {
    const m = Math.round((Date.now() - new Date(ts)) / 60000);
    if (m < 2) return "just now";
    if (m < 60) return `${m}m ago`;
    if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
    return `${Math.round(m / 1440)}d ago`;
  }
  const store = {   // localStorage that never throws (private windows, blocked storage)
    get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* fine */ } },
  };
  // Courts you've hidden (kept in this browser). A hidden court stays on the map, faded and
  // underneath the others, and drops out of "best near you" and the counts. Tap it to unhide.
  const hiddenCourts = new Set((() => { try { return JSON.parse(store.get("cc-hidden") || "[]"); } catch (_) { return []; } })());
  const isHidden = (id) => hiddenCourts.has(id);
  function setHidden(id, on) {
    if (on) hiddenCourts.add(id); else hiddenCourts.delete(id);
    store.set("cc-hidden", JSON.stringify([...hiddenCourts]));
  }
  const readJSON = (k, fallback) => { try { const v = JSON.parse(store.get(k)); return v == null ? fallback : v; } catch (_) { return fallback; } };

  // Analytics: an event for Google Tag Manager (index.html loads it). GTM's own triggers decide what
  // goes on to Google Analytics. Never send names, emails, locations or court picks, only counts and choices.
  const track = (name, params = {}) => {
    try { (window.dataLayer = window.dataLayer || []).push({ event: name, ...params }); } catch (_) { /* never break the app */ }
  };

  // ---------- your preferences (welcome setup + Settings) ----------
  // Kept in this browser. Signed in, they're also saved to your account (Supabase user metadata),
  // so your text size and play style follow you to another phone or computer.
  const TEXT_SIZES = { md: "Standard", lg: "Large", xl: "Extra large" };
  // How much wind you'll play in. "calm" is the map's own rating (Play = gusts under 8 mph). The
  // others also count an hour as good when wind is the ONLY thing in the way and it's under your limit.
  const WIND_PREF = {
    calm: { label: "Calm only", sub: "Gusts under 8 mph", gust: 7, wind: 7 },
    some: { label: "A little is fine", sub: "Gusts up to 14 mph", gust: 14, wind: 11 },
    easy: { label: "Wind doesn't bother me", sub: "Gusts up to 20 mph", gust: 20, wind: 15 },
  };
  const PLAY_TIMES = {   // Pacific hours, [from, to)
    am: { label: "Mornings", sub: "6–11 AM", from: 6, to: 11 },
    mid: { label: "Midday", sub: "11 AM–4 PM", from: 11, to: 16 },
    pm: { label: "Evenings", sub: "4–9 PM", from: 16, to: 21 },
  };
  const prefs = {
    text: TEXT_SIZES[store.get("cc-text")] ? store.get("cc-text") : "md",
    wind: WIND_PREF[store.get("cc-wind")] ? store.get("cc-wind") : "calm",
    times: readJSON("cc-times", []).filter((t) => PLAY_TIMES[t]),
    name: (store.get("cc-name") || "").trim().slice(0, 40),
  };
  function applyTextSize() {
    if (prefs.text === "md") delete document.documentElement.dataset.text;
    else document.documentElement.dataset.text = prefs.text;
    document.querySelectorAll("[data-text]").forEach((b) => {
      if (b.tagName === "BUTTON") b.setAttribute("aria-pressed", String(b.dataset.text === prefs.text));
    });
    if (map) map.resize();
  }
  // Save one or more preferences: in this browser now, and to the account when signed in.
  function setPrefs(changes, { sync = true } = {}) {
    Object.assign(prefs, changes);
    store.set("cc-text", prefs.text);
    store.set("cc-wind", prefs.wind);
    store.set("cc-times", JSON.stringify(prefs.times));
    store.set("cc-name", prefs.name);
    if ("text" in changes) applyTextSize();
    if (sync && sb && community.user) {
      const { text, wind, times } = prefs;
      sb.auth.updateUser({ data: { cc_prefs: { text, wind, times } } }).catch(() => { /* kept on this device anyway */ });
    }
  }
  // Guests' ★ courts live in this browser; signing in moves them into the account.
  const localFavs = () => new Set(readJSON("cc-favs", []).filter((x) => typeof x === "string"));
  community.favorites = localFavs();

  // A court the group hasn't marked in courts.csv still gets flagged from recent reviews
  // (last 90 days), when at least two players agree and they outnumber everyone else:
  //   "Not playable" reviews  -> not playable (gray ✕)
  //   "Poor" + "Not playable" -> rough court (⚠)
  function applyStatuses() {
    DATA.courts.forEach((c) => {
      const s = community.summary.get(c.id);
      const n = (k) => (s && s[k]) || 0;
      const good = n("great") + n("okay");
      let crowd = "", note = "";
      if (n("unplayable") >= 2 && n("unplayable") > good + n("poor")) {
        crowd = "closed"; note = `${n("unplayable")} players said it's not playable recently`;
      } else if (n("poor") + n("unplayable") >= 2 && n("poor") + n("unplayable") > good) {
        crowd = "poor"; note = `${n("poor") + n("unplayable")} players rated it poor or not playable recently`;
      }
      c.eff = c.status || crowd;
      c.effNote = c.status ? c.note : note;
    });
  }

  async function initCommunity() {
    if (!sb) { mineDone(); return; }
    try {   // Each sign-in option appears once it's switched on in Supabase (no code change needed).
      const ext = (await (await fetch(`${SB_URL}/auth/v1/settings`, { headers: { apikey: SB_KEY } })).json()).external || {};
      community.googleReady = !!ext.google;
      community.emailReady = !!ext.email;
    } catch (_) { /* offline: the community parts stay read-only */ }
    const { data } = await sb.auth.getSession();
    community.user = (data.session && data.session.user) || null;
    await loadMine();
    mineDone();
    sb.auth.onAuthStateChange((event, session) => {
      const before = community.user && community.user.id;
      community.user = (session && session.user) || null;
      if (event === "PASSWORD_RECOVERY") setTimeout(() => openAccount("reset"), 0);
      if ((community.user && community.user.id) !== before) {
        community.comments.clear(); community.myVote.clear(); community.stats = null;
        // Supabase asks us not to call it from inside this callback, so load on the next tick.
        setTimeout(async () => { await loadMine(); renderAcctBtn(); renderMarkers(); renderList(); renderCard(); renderForYou(); }, 0);
      }
      renderAcctBtn();
      renderCard();
    });
    // Back from an email link or a failed sign-in: say what happened.
    if (LANDED.reset && community.user) openAccount("reset");
    else if (LANDED.error) openAccount("signin", LANDED.error);
    else if (LANDED.code && !community.user) openAccount("signin", "That link didn't sign you in on this browser. If you just confirmed your email, sign in below.");
    if (LANDED.reset || LANDED.error) history.replaceState(null, "", location.pathname + location.hash);
    renderAcctBtn();
    await Promise.all([loadSummary(), loadActivity()]);
    setInterval(loadActivity, 2 * 60 * 1000);
    autoLocate();
  }
  async function loadSummary() {
    const { data, error } = await sb.from("court_vote_summary").select("*");
    if (error) return;
    community.summary = new Map(data.map((r) => [r.court_id, r]));
    render();
  }
  // The signed-in player's own profile and favorite courts (private to them).
  async function loadMine() {
    const u = community.user;
    if (!u) { community.profile = null; community.favorites = localFavs(); return; }
    const [p, f] = await Promise.all([
      sb.from("profiles").select("display_name,created_at").eq("id", u.id).maybeSingle(),
      sb.from("favorite_courts").select("court_id").eq("user_id", u.id),
    ]);
    community.profile = p.data || null;
    community.favorites = new Set((f.data || []).map((r) => r.court_id));
    // Courts starred as a guest on this device: add them to the account, then clear the device copy.
    const fromGuest = [...localFavs()].filter((id) => !community.favorites.has(id));
    let moveFailed = false;
    if (fromGuest.length) {
      const { error } = await sb.from("favorite_courts").insert(fromGuest.map((court_id) => ({ court_id })));
      if (error) moveFailed = true;   // keep them on the device and try again next sign-in
      else {
        fromGuest.forEach((id) => community.favorites.add(id));
        toast(`★ ${fromGuest.length} court${fromGuest.length === 1 ? " is" : "s are"} now saved to your account.`);
      }
    }
    if (!moveFailed) store.set("cc-favs", "[]");
    // Preferences: the account's win if it has some (another device set them); else save this device's.
    const saved = (u.user_metadata || {}).cc_prefs;
    if (saved && typeof saved === "object") {
      setPrefs({
        text: TEXT_SIZES[saved.text] ? saved.text : prefs.text,
        wind: WIND_PREF[saved.wind] ? saved.wind : prefs.wind,
        times: Array.isArray(saved.times) ? saved.times.filter((t) => PLAY_TIMES[t]) : prefs.times,
      }, { sync: false });
    } else if (store.get("cc-onboarded")) setPrefs({});
  }
  // One court's comments, plus the signed-in player's own vote there.
  async function loadCourt(courtId, force) {
    if (!sb || community.loading.has(courtId) || (!force && community.comments.has(courtId))) return;
    community.loading.add(courtId);
    const [comments, mine] = await Promise.all([
      sb.from("court_comments").select("id,user_id,user_name,body,created_at")
        .eq("court_id", courtId).order("created_at", { ascending: true }).limit(100),
      community.user
        ? sb.from("court_votes").select("rating").eq("court_id", courtId).eq("user_id", community.user.id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    community.loading.delete(courtId);
    community.comments.set(courtId, comments.data || []);
    community.myVote.set(courtId, (mine.data && mine.data.rating) || null);
    if (state.selected === courtId) renderCard();
  }
  function signInGoogle() {
    try { sessionStorage.setItem("cc-return", location.hash); } catch (_) { /* fine */ }
    return sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } });
  }

  // ---------- Google's own sign-in button (Google Identity Services) ----------
  // The Google pop-up opens on tenniscourtcast.com and names it, instead of sending people through
  // our database's bbdfr….supabase.co address. Google hands back a signed ID token; Supabase checks
  // Google's signature (and our one-time nonce) and signs the player in. The client ID is public.
  const GOOGLE_CLIENT_ID = "608631987243-5b47ncaoob6bnukk05p82d78eohmnnoa.apps.googleusercontent.com";
  let gisLoading = null, gisNonce = null;
  function loadGis() {
    if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve(true);
    if (!gisLoading) gisLoading = new Promise((ok) => {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client?hl=en";
      s.async = true;
      s.onload = () => ok(!!(window.google && window.google.accounts && window.google.accounts.id));
      s.onerror = () => { gisLoading = null; ok(false); };
      document.head.appendChild(s);
      setTimeout(() => ok(false), 8000);   // blocked or very slow: use the fallback button
    });
    return gisLoading;
  }
  const sha256hex = async (text) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  async function mountGoogleButton() {
    const slot = $("acctBody").querySelector(".gsi");
    if (!slot) return;
    const fallback = $("acctBody").querySelector(".gbtn");
    const ok = await loadGis();
    if (!slot.isConnected) return;
    if (!ok || !window.crypto || !crypto.subtle) { slot.remove(); if (fallback) fallback.hidden = false; return; }
    // A fresh one-time value: Google stores its hash in the token, Supabase checks the original,
    // so a token copied from somewhere else can't be replayed.
    gisNonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))));
    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID, callback: onGoogleCredential, nonce: await sha256hex(gisNonce),
      ux_mode: "popup", auto_select: false, itp_support: true,
    });
    window.google.accounts.id.renderButton(slot, {
      type: "standard", theme: DARK ? "filled_black" : "outline", size: "large", shape: "pill",
      text: slot.dataset.text, logo_alignment: "center", width: Math.min(400, slot.clientWidth || 320), locale: "en",
    });
  }
  async function onGoogleCredential(resp) {
    const { error } = await sb.auth.signInWithIdToken({ provider: "google", token: resp.credential, nonce: gisNonce });
    if (error) { const m = $("acct").querySelector(".msg"); if (m) m.textContent = authError(error); return; }
    closeAccount();
    toast(`Signed in. Welcome, ${esc(firstName())}!`);
  }

  // ---------- sign in / create account / profile (one dialog, several screens) ----------
  // Google's standard "G" mark, used as Google's branding guidelines describe.
  const GOOGLE_G = `<svg class="g" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;
  const acct = { mode: "signin", note: "", email: "", confirmDelete: false };
  const home = () => location.origin + location.pathname;

  // Supabase error codes -> plain English.
  function authError(e) {
    const known = {
      invalid_credentials: "That email and password don't match.",
      email_not_confirmed: "Confirm your email first: check your inbox for the link.",
      user_already_exists: "There's already an account with that email. Try signing in.",
      email_exists: "There's already an account with that email. Try signing in.",
      weak_password: "Pick a stronger password (at least 8 characters, not a common one).",
      same_password: "That's your current password. Pick a new one.",
      email_address_not_authorized: "Email sign-up isn't open yet. Use Continue with Google for now.",
      email_address_invalid: "That email address doesn't look right.",
      over_email_send_rate_limit: "Too many emails went out just now. Try again later, or use Google.",
      over_request_rate_limit: "Too many tries. Wait a minute and try again.",
      validation_failed: "Check the email and password.",
    };
    return (e && known[e.code]) || (e && e.message) || "Something went wrong. Try again.";
  }

  function openAccount(mode, note) {
    const d = $("acct");
    if (!d || !sb) return;
    acct.mode = mode || (community.user ? "profile" : "signin");
    acct.note = note || "";
    acct.confirmDelete = false;
    renderAccount();
    if (!d.open) d.showModal();
    if (acct.mode === "profile") loadStats();
  }
  const closeAccount = () => { const d = $("acct"); if (d && d.open) d.close(); };
  async function loadStats() {
    const u = community.user;
    if (!u) return;
    const count = (t) => sb.from(t).select("*", { count: "exact", head: true }).eq("user_id", u.id);
    const [v, c, r] = await Promise.all([count("court_votes"), count("court_comments"), count("court_reports")]);
    community.stats = { votes: v.count || 0, comments: c.count || 0, reports: r.count || 0 };
    if (acct.mode === "profile" && $("acct").open) renderAccount();
  }

  function renderAccount() {
    const m = acct.mode, u = community.user;
    const note = acct.note ? `<div class="note">${esc(acct.note)}</div>` : "";
    // Google's official button goes in .gsi; the redirect button is the fallback if Google's script can't load.
    const google = community.googleReady
      ? `<div class="gsi" data-text="${m === "signup" ? "signup_with" : "continue_with"}"></div>
         <button type="button" class="gbtn" data-act="google" hidden>${GOOGLE_G}<span>Continue with Google</span></button>` : "";
    const or = google && community.emailReady ? '<div class="or"><span>or</span></div>' : "";
    const field = (label, name, type, auto, extra = "") =>
      `<label>${label}<input name="${name}" type="${type}" autocomplete="${auto}" required ${extra}></label>`;
    let html;
    if (m === "signin" || m === "signup") {
      const up = m === "signup";
      html = `<h2>${up ? "Create your account" : "Sign in"}</h2>
        <p class="muted small sub">${up ? "Keep your ★ courts and settings on every device, and comment, vote and report open courts." : "Welcome back to CourtCast."}</p>
        ${note}${google}${or}
        ${community.emailReady ? `<form data-form="${m}" novalidate>
          ${up ? field("Name", "name", "text", "name", `maxlength="40" value="${esc(prefs.name)}"`) : ""}
          ${field("Email", "email", "email", "email", `value="${esc(acct.email)}"`)}
          ${field("Password", "password", "password", up ? "new-password" : "current-password", 'minlength="8"')}
          ${up ? '<div class="muted small">At least 8 characters.</div>'
               : '<a href="#" class="small forgot" data-act="mode" data-mode="forgot">Forgot password?</a>'}
          <button class="primary" type="submit">${up ? "Create account" : "Sign in"}</button>
        </form>` : ""}
        <div class="msg small" aria-live="polite"></div>
        <div class="switch small">${up
          ? 'Already have an account? <a href="#" data-act="mode" data-mode="signin">Sign in</a>'
          : 'New to CourtCast? <a href="#" data-act="mode" data-mode="signup">Create an account</a>'}</div>
        <div class="muted small fine">${up ? 'By creating an account you agree to the <a href="terms.html">Terms</a>. ' : ""}How we use your info: <a href="privacy.html">Privacy</a></div>`;
    } else if (m === "forgot") {
      html = `<h2>Reset your password</h2>
        <p class="muted small sub">We'll email you a link to pick a new one.</p>${note}
        <form data-form="forgot" novalidate>${field("Email", "email", "email", "email", `value="${esc(acct.email)}"`)}
          <button class="primary" type="submit">Send reset link</button></form>
        <div class="msg small" aria-live="polite"></div>
        <div class="switch small"><a href="#" data-act="mode" data-mode="signin">Back to sign in</a></div>`;
    } else if (m === "check-email" || m === "check-reset") {
      const reset = m === "check-reset";
      html = `<h2>Check your email</h2>
        <p class="sub">${reset ? "If there's an account for" : "We sent a link to"} <b>${esc(acct.email)}</b>${reset
          ? ", a reset link is on its way." : ". Open it on this phone or computer to finish creating your account."}</p>
        <p class="muted small">Nothing after a few minutes? Check spam${reset ? "" : ', or <a href="#" data-act="resend">send it again</a>'}.</p>
        <div class="msg small" aria-live="polite"></div>
        <div class="switch small"><a href="#" data-act="mode" data-mode="signin">Back to sign in</a></div>`;
    } else if (m === "reset") {
      html = `<h2>Pick a new password</h2>${note}
        <form data-form="reset" novalidate>${field("New password", "password", "password", "new-password", 'minlength="8"')}
          <div class="muted small">At least 8 characters.</div>
          <button class="primary" type="submit">Save password</button></form>
        <div class="msg small" aria-live="polite"></div>`;
    } else {   // profile
      if (!u) { acct.mode = "signin"; return renderAccount(); }
      const name = displayName(), s = community.stats;
      const via = (u.app_metadata && u.app_metadata.provider) === "google" ? "Google" : "email and password";
      const since = new Date(u.created_at).toLocaleDateString("en-US", { month: "long", year: "numeric" });
      const favs = DATA.courts.filter((c) => community.favorites.has(c.id))
        .sort((a, b) => b.s[state.base] - a.s[state.base]);
      const favHtml = favs.length
        ? `<ul class="favs">${favs.map((c) => {
            const live = liveReport(c.id);
            const band = c.eff === "closed" ? "closed" : c.b[state.base];
            return `<li><button type="button" data-court="${c.id}">${courtSvg(band)}
              <span><b>${esc(c.name)}</b><span class="muted small">${esc(c.city)}${live && live.key ? ` · ${live.short} ${ago(live.at)}` : ""}</span></span>
              <span class="num">${c.eff === "closed" ? "—" : c.s[state.base].toFixed(1)}</span></button></li>`;
          }).join("")}</ul>`
        : '<p class="muted small">No favorites yet. Tap ☆ on a court to add it here.</p>';
      html = `<div class="phead">${avatar(name, "lg")}<div><h2>${esc(name)}</h2>
          <div class="muted small">${esc(u.email || "")} · signed in with ${via}</div>
          <div class="muted small">Member since ${since}</div></div></div>
        <form data-form="name" class="row" novalidate>
          <label>Display name<input name="name" maxlength="40" autocomplete="name" value="${esc(name)}" required></label>
          <button type="submit">Save</button></form>
        <div class="muted small">Your first name shows on your comments.</div>
        <h3>★ Your courts</h3>${favHtml}
        <h3>Your activity</h3>
        <p class="stats">${s ? `<b>${s.votes}</b> vote${s.votes === 1 ? "" : "s"} · <b>${s.comments}</b> comment${s.comments === 1 ? "" : "s"} · <b>${s.reports}</b> court check${s.reports === 1 ? "" : "s"}` : '<span class="muted">Loading…</span>'}</p>
        <button type="button" class="ghost wide" data-act="settings">⚙ Settings</button>
        <div class="msg small" aria-live="polite"></div>
        <div class="pfoot">
          <button type="button" class="ghost" data-act="signout">Sign out</button>
          <button type="button" class="danger" data-act="delete">${acct.confirmDelete ? "Tap again to delete everything" : "Delete account"}</button>
        </div>
        <div class="muted small fine"><a href="privacy.html">Privacy</a></div>`;
    }
    $("acctBody").innerHTML = html;
    mountGoogleButton();
  }

  async function onAccountClick(e) {
    const d = $("acct");
    if (e.target === d) { closeAccount(); return; }   // tap on the dimmed backdrop
    const t = e.target.closest("[data-act], [data-court]");
    if (!t || t.tagName === "FORM") return;
    const say = (text) => { const m = d.querySelector(".msg"); if (m) m.textContent = text; };
    if (t.dataset.court) { closeAccount(); select(t.dataset.court); saveHash(); return; }
    const act = t.dataset.act;
    if (act === "autocheck") { store.set("cc-autocheck", t.checked ? "on" : "off"); if (t.checked) autoLocate(true); return; }
    e.preventDefault();
    if (act === "close") closeAccount();
    else if (act === "settings") { closeAccount(); openSettings(); }
    else if (act === "mode") {
      const email = d.querySelector('input[name="email"]');
      if (email && email.value) acct.email = email.value.trim();
      acct.mode = t.dataset.mode; acct.note = ""; renderAccount();
    } else if (act === "google") {
      const { error } = await signInGoogle();
      if (error) say(authError(error));
    } else if (act === "resend") {
      const { error } = await sb.auth.resend({ type: "signup", email: acct.email, options: { emailRedirectTo: home() } });
      say(error ? authError(error) : "Sent. Check your inbox.");
    } else if (act === "signout") {
      await sb.auth.signOut();
      closeAccount();
      toast("Signed out.");
    } else if (act === "delete") {
      if (!acct.confirmDelete) { acct.confirmDelete = true; renderAccount(); return; }
      t.disabled = true;
      const { error } = await sb.rpc("delete_my_account");
      if (error) { t.disabled = false; say(`Couldn't delete your account: ${error.message}`); return; }
      await sb.auth.signOut({ scope: "local" });
      closeAccount();
      toast("Your account, votes, comments, favorites and court checks are deleted.");
    }
  }

  async function onAccountSubmit(e) {
    const form = e.target.closest("form[data-form]");
    if (!form) return;
    e.preventDefault();
    const d = $("acct"), say = (text) => { const m = d.querySelector(".msg"); if (m) m.textContent = text; };
    const val = (n) => { const i = form.querySelector(`[name="${n}"]`); return i ? i.value.trim() : ""; };
    const kind = form.dataset.form, button = form.querySelector('button[type="submit"]');
    const email = val("email"), password = form.querySelector('[name="password"]') ? form.querySelector('[name="password"]').value : "";
    if (email) acct.email = email;
    // Quick checks here; Supabase checks again on its side.
    if ("signin signup forgot".includes(kind) && !/^\S+@\S+\.\S+$/.test(email)) { say("Enter your email address."); return; }
    if ((kind === "signup" || kind === "reset") && password.length < 8) { say("Use at least 8 characters for your password."); return; }
    if ((kind === "signup" || kind === "name") && !val("name")) { say("Enter your name."); return; }
    button.disabled = true;
    say("");
    try {
      if (kind === "signin") {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) { say(authError(error)); return; }
        closeAccount();
        toast(`Signed in. Welcome back, ${esc(firstName())}!`);
      } else if (kind === "signup") {
        const { data, error } = await sb.auth.signUp({ email, password,
          options: { data: { full_name: val("name") }, emailRedirectTo: home() } });
        if (error) { say(authError(error)); return; }
        if (data.session) { closeAccount(); toast(`Welcome, ${esc(firstName())}!`); return; }   // no email check needed
        acct.mode = "check-email"; renderAccount();
      } else if (kind === "forgot") {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: `${home()}?reset=1` });
        if (error) { say(authError(error)); return; }
        acct.mode = "check-reset"; renderAccount();
      } else if (kind === "reset") {
        const { error } = await sb.auth.updateUser({ password });
        if (error) { say(authError(error)); return; }
        acct.mode = "profile"; renderAccount(); loadStats();
        say("Password updated.");
      } else if (kind === "name") {
        const name = val("name").slice(0, 40);
        const { error } = await sb.from("profiles").update({ display_name: name }).eq("id", community.user.id);
        if (error) { say(`Couldn't save: ${error.message}`); return; }
        community.profile = { ...(community.profile || {}), display_name: name };
        community.comments.clear();   // past comments were renamed too; reload them
        renderAcctBtn(); renderCard(); renderAccount();
        say("Saved.");
      }
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  }

  // Header button: "Sign in" when signed out, your initial + first name when signed in.
  function renderAcctBtn() {
    const b = $("acctBtn");
    if (!b) return;
    b.hidden = !sb || !(community.googleReady || community.emailReady || community.user);
    if (community.user) {
      b.innerHTML = `${avatar(displayName())}<span class="who">${esc(firstName())}</span>`;
      b.setAttribute("aria-label", "Your profile");
    } else {
      b.textContent = "Sign in";
      b.setAttribute("aria-label", "Sign in or create an account");
    }
  }

  // ---------- favorite courts ----------
  async function toggleFavorite(id, { quiet = false } = {}) {
    const on = community.favorites.has(id);
    if (!on && isHidden(id)) setHidden(id, false);   // starring a hidden court brings it back
    const flip = () => { if (on) community.favorites.add(id); else community.favorites.delete(id); };
    if (on) community.favorites.delete(id); else community.favorites.add(id);   // show it right away
    renderMarkers(); renderList(); renderCard(); renderForYou();
    if (!on) track("favorite_add", { signed_in: !!community.user });
    if (!community.user) {   // guest: kept in this browser, no account needed
      store.set("cc-favs", JSON.stringify([...community.favorites]));
      // Once, after the first star: the reason to sign up, at the moment it matters.
      if (!on && !quiet && sb && (community.googleReady || community.emailReady) && !store.get("cc-favnudge")) {
        store.set("cc-favnudge", "1");
        track("signup_prompt", { from: "favorite" });
        toast('★ Saved on this device. <button type="button" class="link" data-act="signup">Create a free account</button> to keep your courts on every device.', { ms: 10000 });
      }
      return;
    }
    const { error } = on
      ? await sb.from("favorite_courts").delete().eq("user_id", community.user.id).eq("court_id", id)
      : await sb.from("favorite_courts").insert({ court_id: id });
    if (error) { flip(); renderMarkers(); renderList(); renderCard(); toast(`Couldn't save: ${esc(error.message)}`); }
  }

  // ---------- court checks: "how many courts are open right now?" ----------
  const OPEN = {
    none: { label: "All courts taken", short: "Full", btn: "All taken", cls: "full" },
    one: { label: "1 court open", short: "1 open", btn: "1 open", cls: "few" },
    some: { label: "2+ courts open", short: "Open", btn: "2+ open", cls: "open" },
    all: { label: "All courts open", short: "All open", btn: "All open", cls: "open" },
  };
  // Live reports come from court_activity(): the latest report per court in the last 90 minutes,
  // and how many players are there now (only when 2+, so nobody is singled out).
  async function loadActivity() {
    if (!sb) return;
    const { data, error } = await sb.rpc("court_activity");
    if (error) return;
    community.activity = new Map(data.map((r) => [r.court_id, r]));
    renderMarkers(); renderList(); renderCard();
  }
  // A report counts fully for 30 minutes, then fades out by 90: a set or two of tennis.
  function liveReport(id) {
    if (state.hour !== state.base) return null;   // live reports are about now, not the future
    const a = community.activity.get(id);
    if (!a) return null;
    const out = { here: a.here_now || 0 };
    if (!a.open_courts) return out.here ? out : null;
    const mins = (Date.now() - new Date(a.reported_at)) / 60000;
    if (mins > 90) return out.here ? out : null;
    return { ...out, ...OPEN[a.open_courts], key: a.open_courts, at: a.reported_at, reports: a.reports,
      weight: mins <= 30 ? 1 : 1 - (mins - 30) / 60 };
  }

  // No live report? Guess from the time of week, the weather and the court count.
  // These weights are judgment calls; real reports will replace them over time.
  function busyGuess(ct, h) {
    const [d, t] = DATA.times[h].split("T");
    const hr = Number(t.slice(0, 2));
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay(), weekend = dow === 0 || dow === 6;
    if (ct.type === "school" && !weekend && hr >= 7 && hr < 16) {
      return { level: "quiet", label: "Likely closed (school hours)", why: "school day" };
    }
    if (hr >= 22 || hr < 6) return { level: "quiet", label: "Likely quiet", why: "late night" };
    let pts = 0;
    const why = [];
    if (weekend && hr >= 8 && hr < 11) { pts += 2; why.push("weekend morning"); }
    else if (weekend && hr >= 11 && hr < 14) { pts += 1; why.push("weekend midday"); }
    else if (weekend && hr >= 16 && hr < 19) { pts += 1; why.push("weekend evening"); }
    else if (!weekend && hr >= 17 && hr < 20) { pts += 2; why.push("after work"); }
    else if (!weekend && hr >= 7 && hr < 9) { pts += 0.5; why.push("early morning"); }
    else why.push(weekend ? "weekend" : "weekday");
    const s = ct.s[h];
    if (s >= 8) { pts += 1; why.push("great weather"); }
    else if (s < 4) { pts -= 2; why.push("bad weather"); }
    if (ct.courts) {
      if (ct.courts <= 2) { pts += 1; why.push(`only ${ct.courts} court${ct.courts === 1 ? "" : "s"}`); }
      else if (ct.courts >= 6) { pts -= 1; why.push(`${ct.courts} courts`); }
    }
    const level = pts >= 3 ? "busy" : pts >= 1.5 ? "maybe" : "quiet";
    return { level, label: { busy: "Likely busy", maybe: "Could be busy", quiet: "Likely quiet" }[level], why: why.join(", ") };
  }

  // Close enough to report: within NEAR_M of the court, with a fix good to MAX_ACCURACY_M.
  // 200 m covers a big park's court block; phone GPS outdoors is usually within 5-50 m.
  const NEAR_M = 200, MAX_ACCURACY_M = 150, NEAR_FOR_MS = 30 * 60 * 1000;
  const isNear = (id) => !!(community.near && community.near.id === id && Date.now() - community.near.at < NEAR_FOR_MS);
  function meters(aLat, aLon, bLat, bLon) {   // haversine: distance over the earth's surface
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  const autoCheckOn = () => store.get("cc-autocheck") !== "off";
  let lastAuto = 0, lastPing = { id: null, at: 0 };

  // Find the court you're standing at. Your coordinates never leave the phone:
  // only "this court, now" is sent, and only when you're signed in.
  async function locate(manual) {
    if (!navigator.geolocation) { if (manual) toast("This browser can't share your location."); return; }
    if (manual) toast("Finding your court…", { ms: 15000 });
    let pos;
    try {
      pos = await new Promise((ok, fail) => navigator.geolocation.getCurrentPosition(ok, fail,
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }));
    } catch (err) {
      if (manual) toast(err.code === 1
        ? "Location is blocked for this site. Allow it in your browser settings to check in."
        : "Couldn't get your location. Try again in a moment.");
      return;
    }
    const { latitude, longitude, accuracy } = pos.coords;
    let best = null;
    for (const c of DATA.courts) {
      const m = meters(latitude, longitude, c.lat, c.lon);
      if (!best || m < best.m) best = { c, m };
    }
    if (accuracy > MAX_ACCURACY_M) {
      if (manual) toast(`Your location is too rough (±${Math.round(accuracy)} m) to tell which court you're at. Turn on precise location and try again.`);
      return;
    }
    if (!best || best.m > NEAR_M) {
      community.near = null;
      renderCard();
      if (manual) toast(best ? `No court within ${NEAR_M} m. Nearest is ${esc(best.c.name)}, ${(best.m / 1609).toFixed(1)} mi away.` : "No courts found.");
      return;
    }
    community.near = { id: best.c.id, at: Date.now() };
    pingPresence(best.c.id);
    if (manual) {
      hideToast();
      select(best.c.id); saveHash();
      const r = $("card").querySelector(".report");
      if (r) r.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else if (state.selected !== best.c.id && !dismissedHere(best.c.id)) {
      askAtCourt(best.c);
    } else renderCard();
  }
  // Opening the site at a court asks right away, but only if location is already allowed:
  // we never pop a permission prompt the player didn't ask for.
  async function autoLocate(force) {
    if (!autoCheckOn() || !navigator.permissions || !navigator.geolocation) return;
    if (!force && Date.now() - lastAuto < 5 * 60 * 1000) return;
    try { if ((await navigator.permissions.query({ name: "geolocation" })).state !== "granted") return; } catch (_) { return; }
    lastAuto = Date.now();
    locate(false);
  }
  function pingPresence(id) {
    if (!community.user || (lastPing.id === id && Date.now() - lastPing.at < 10 * 60 * 1000)) return;
    lastPing = { id, at: Date.now() };
    sb.rpc("ping_court", { p_court_id: id });
  }
  const dismissedHere = (id) => Date.now() - Number(store.get(`cc-notnow-${id}`) || 0) < 2 * 3600 * 1000;
  const reportButtons = (id) => `<div class="rbtns">${Object.entries(OPEN).map(([k, v]) =>
    `<button type="button" class="${v.cls}" data-report="${k}" data-court="${id}">${v.btn}</button>`).join("")}</div>`;
  function askAtCourt(ct) {
    toast(`<div><b>You're at ${esc(ct.name)}.</b> How many courts are open?</div>${reportButtons(ct.id)}
      <a href="#" class="small" data-act="notnow" data-court="${ct.id}">Not now</a>`, { sticky: true });
  }
  async function sendReport(id, k) {
    if (!community.user) { openAccount("signin", "Sign in to report open courts. It keeps the reports honest."); return; }
    if (!isNear(id)) { toast("Check in at the court first, so reports come from people who are there."); return; }
    const { error } = await sb.rpc("report_court", { p_court_id: id, p_open: k });
    if (error) { toast(`Couldn't send your report: ${esc(error.message)}`); return; }
    toast(`Thanks! Everyone can now see "${OPEN[k].label}" at ${esc(DATA.courts.find((c) => c.id === id).name)}.`);
    community.stats = null;
    await loadActivity();
  }

  // "Courts right now" in the court card: a live report if there is one, else a guess.
  function crowdHtml(ct) {
    if (ct.eff === "closed") return "";
    const now = state.hour === state.base, live = liveReport(ct.id);
    const here = live && live.here ? ` · ${live.here} players here now` : "";
    let head;
    if (live && live.key) {
      head = `<div class="crowd-now ${live.cls}" style="opacity:${(0.5 + 0.5 * live.weight).toFixed(2)}">
        <b>${live.label}</b><span class="muted small">Reported ${ago(live.at)}${live.reports > 1 ? ` · ${live.reports} reports` : ""}${here}</span></div>`;
    } else {
      const g = busyGuess(ct, state.hour);
      head = `<div class="crowd-guess ${g.level}"><b>${g.label}</b>
        <span class="muted small">${now ? "No reports lately · " : ""}A guess from: ${g.why}${here}</span></div>`;
    }
    const ask = !now ? "" : isNear(ct.id)
      ? `<div class="report"><div class="small"><b>You're here.</b> How many courts are open?</div>${reportButtons(ct.id)}</div>`
      : `<div class="muted small">At the court? <a href="#" data-act="locate">Check in</a> to tell everyone how many are open.</div>`;
    return `<div class="crowd"><div class="ctitle"><strong>${now ? "Courts right now" : `How busy at ${fmtTime(DATA.times[state.hour], true)}?`}</strong></div>${head}${ask}</div>`;
  }

  // ---------- small pop-up message ----------
  let toastTimer;
  function toast(html, opts = {}) {
    const el = $("toast");
    if (!el) return;
    el.innerHTML = `<div class="tbody">${html}</div><button type="button" class="tx" data-act="toast-close" aria-label="Dismiss">×</button>`;
    el.hidden = false;
    clearTimeout(toastTimer);
    if (!opts.sticky) toastTimer = setTimeout(hideToast, opts.ms || 5000);
  }
  function hideToast() { const el = $("toast"); if (el) el.hidden = true; clearTimeout(toastTimer); }

  // Court condition: a horizontal bar per choice, length = share of the votes (last 90 days).
  // Colours carry meaning (green good ... red not playable), and every bar is also labelled.
  const VOTE_COLOR = { great: "var(--play)", okay: "var(--okay)", poor: "var(--iffy)", unplayable: "var(--skip)" };
  function votesHtml(ct) {
    const s = community.summary.get(ct.id) || {};
    const total = Object.keys(RATING).reduce((a, k) => a + (s[k] || 0), 0);
    const mine = community.myVote.get(ct.id);
    const rows = Object.entries(RATING).map(([k, v]) => {
      const n = s[k] || 0;
      const pct = total ? Math.round((n / total) * 100) : 0;
      return `<button class="vbar${mine === k ? " mine" : ""}" data-vote="${k}" aria-pressed="${mine === k}"
          aria-label="${v.label}: ${n} vote${n === 1 ? "" : "s"}${mine === k ? ", your vote" : ""}">
        <span class="vl">${v.face} ${v.label}</span>
        <span class="vt"><i style="width:${pct}%;background:${VOTE_COLOR[k]}"></i></span>
        <span class="vn">${n}</span></button>`;
    }).join("");
    const canSignIn = community.googleReady || community.emailReady;
    const hint = community.user ? (mine ? "Tap a bar to change your vote · tap yours again to remove it" : "Tap a bar to vote")
      : canSignIn ? "Sign in to vote" : "";
    return `<div class="votes"><div class="ctitle"><strong>Court condition</strong>
        <span class="muted small">${total} vote${total === 1 ? "" : "s"} · last 90 days</span></div>
      ${rows}${hint ? `<div class="muted small vhint">${hint}</div>` : ""}</div>`;
  }

  // Comments, Instagram-style: initial, bold name, text, time; add one at the bottom.
  const avatar = (name, size) => `<span class="av${size ? ` ${size}` : ""}" aria-hidden="true">${esc(((name || "?").trim()[0] || "?").toUpperCase())}</span>`;
  function commentsHtml(ct) {
    const list = community.comments.get(ct.id);
    const me = community.user;
    const items = (list || []).map((c) => `<li>${avatar(c.user_name)}<div class="cbody">
        <b>${esc(c.user_name || "Player")}</b> ${esc(c.body)}
        <div class="muted small">${ago(c.created_at)}${me && c.user_id === me.id ? ` · <a href="#" data-del="${esc(c.id)}">Delete</a>` : ""}</div>
      </div></li>`).join("");
    const add = me ? `<form class="add" data-act="comment">${avatar(firstName(me))}
        <input name="body" maxlength="300" placeholder="Add a comment…" autocomplete="off" aria-label="Add a comment">
        <button type="submit">Post</button></form>` : "";
    return `<div class="comments"><div class="ctitle"><strong>Comments</strong>
        <span class="muted small">${list && list.length ? list.length : ""}</span></div>
      ${list ? (items ? `<ul>${items}</ul>` : '<div class="muted small empty">No comments yet. Nets, cracks, lights, crowds?</div>')
        : '<div class="muted small empty">Loading…</div>'}
      ${add}</div>`;
  }

  function communityHtml(ct) {
    if (!sb) return "";
    const account = community.user
      ? `<div class="muted small acct">Signed in as ${esc(firstName())} · <a href="#" data-act="profile">Profile</a> · <a href="privacy.html">Privacy</a></div>`
      : community.googleReady || community.emailReady
        ? `<button class="signin" data-act="signin">Sign in to vote, comment and report</button>
           <div class="muted small acct"><a href="privacy.html">Privacy</a></div>`
        : `<div class="muted small acct">Voting and comments are coming soon · <a href="privacy.html">Privacy</a></div>`;
    return `<div class="community">${votesHtml(ct)}${commentsHtml(ct)}<div class="msg small" aria-live="polite"></div>${account}</div>`;
  }

  // Clicks inside the court card and the pop-up message.
  async function onCommunityClick(e) {
    const t = e.target.closest("[data-act], [data-vote], [data-del], [data-report]");
    if (!t || t.tagName === "FORM") return;
    if (t.dataset.act === "hide" || t.dataset.act === "unhide") {   // works signed out, too
      e.preventDefault();
      if (t.closest("#toast")) hideToast();
      hideCourt(t.dataset.court || state.selected, t.dataset.act === "hide");
      return;
    }
    if (t.dataset.act === "fav") {   // works signed out, too (kept in this browser)
      e.preventDefault();
      await toggleFavorite(t.dataset.court || state.selected);
      return;
    }
    if (t.dataset.act === "signup") {
      e.preventDefault();
      if (t.closest("#toast")) hideToast();
      openAccount("signup");
      return;
    }
    if (!sb) return;
    e.preventDefault();
    const box = t.closest(".community"), msg = box && box.querySelector(".msg");
    const say = (text) => { if (msg) msg.textContent = text; else toast(esc(text)); };
    const courtId = t.dataset.court || state.selected;
    const act = t.dataset.act;
    if (t.dataset.report) {
      if (t.closest("#toast")) hideToast();
      await sendReport(courtId, t.dataset.report);
    } else if (t.dataset.vote) {
      if (!community.user) { openAccount("signin", "Sign in to vote on court conditions."); return; }
      const k = t.dataset.vote, prev = community.myVote.get(courtId);
      const { error } = prev === k   // tapping your current vote again removes it
        ? await sb.from("court_votes").delete().eq("court_id", courtId).eq("user_id", community.user.id)
        : await sb.from("court_votes").upsert({ court_id: courtId, rating: k }, { onConflict: "court_id,user_id" });
      if (error) { say(`Couldn't save your vote: ${error.message}`); return; }
      community.myVote.set(courtId, prev === k ? null : k);
      await loadSummary();
    } else if (t.dataset.del) {
      const { error } = await sb.from("court_comments").delete().eq("id", t.dataset.del);
      if (error) { say(`Couldn't delete: ${error.message}`); return; }
      await loadCourt(courtId, true);
    } else if (act === "locate") {
      await locate(true);
    } else if (act === "signin") {
      openAccount("signin");
    } else if (act === "profile") {
      openAccount("profile");
    } else if (act === "toast-close") {
      hideToast();
    } else if (act === "notnow") {
      store.set(`cc-notnow-${courtId}`, String(Date.now()));
      hideToast();
    }
  }

  async function onCommentSubmit(e) {
    const form = e.target.closest('form[data-act="comment"]');
    if (!form || !sb) return;
    e.preventDefault();
    const input = form.querySelector("input"), button = form.querySelector("button");
    const body = input.value.trim().slice(0, 300);
    if (!body) return;
    button.disabled = true;
    const { error } = await sb.from("court_comments").insert({ court_id: state.selected, body });
    button.disabled = false;
    if (error) {
      const msg = form.closest(".community").querySelector(".msg");
      if (msg) msg.textContent = `Couldn't post: ${error.message}`;
      return;
    }
    input.value = "";
    community.stats = null;
    await loadCourt(state.selected, true);
    const ul = $("card").querySelector(".comments ul");
    if (ul) ul.scrollTop = ul.scrollHeight;   // show the new comment
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

  // ---------- weather shading: blue = rain, orange = wind, purple = both ----------
  // Court colours show playability; the shading shows *why* and *where*.
  // The ~3 km forecast cells are blended smoothly (bilinear interpolation) into
  // a soft overlay. Darker = heavier rain / stronger gusts. Where both happen the
  // area gets its own solid colour (purple, the group's pick), which reads more
  // easily than stripes or a blend of blue and orange.
  const RAIN_RGB = [47, 127, 224];
  const WIND_RGB = [232, 140, 58];
  const BOTH_RGB = [139, 92, 230];
  const RAIN_LIKELY = 40;    // % chance: a faint blue tint when rain is likely but none is forecast
  const SHOW = 0.12;         // intensity below this is treated as "none"

  // 0..1 strength of each kind of weather at one grid cell.
  const rainStrength = (inches, chance) =>
    inches >= 0.002 ? 0.35 + 0.65 * clamp01(inches / 0.08) : chance >= RAIN_LIKELY ? 0.2 : 0;
  const windStrength = (gust) =>
    gust >= DATA.bands.wind_iffy ? 0.3 + 0.7 * clamp01((gust - DATA.bands.wind_iffy) / (DATA.bands.wind_skip - DATA.bands.wind_iffy)) : 0;

  function buildWeather() {
    const G = DATA.grid;
    let lats, lons, rows;
    if (G.nlat) {
      // Even steps across the region; the build skips points far from any court (ocean, mountains),
      // and those count as "no weather" so the shading fades out there.
      const n = DATA.times.length, none = { r: new Array(n).fill(0), p: new Array(n).fill(0), g: new Array(n).fill(0) };
      lats = Array.from({ length: G.nlat }, (_, i) => G.lat0 + i * G.step_lat);
      lons = Array.from({ length: G.nlon }, (_, j) => G.lon0 + j * G.step_lon);
      rows = lats.map(() => lons.map(() => none));
      G.cells.forEach((c) => { rows[c.i][c.j] = c; });
    } else {   // older forecast files: a full grid of points
      lats = [...new Set(G.cells.map((c) => c.lat))].sort((a, b) => a - b);
      lons = [...new Set(G.cells.map((c) => c.lon))].sort((a, b) => a - b);
      const byKey = new Map(G.cells.map((c) => [`${c.lat},${c.lon}`, c]));
      rows = lats.map((la) => lons.map((lo) => byKey.get(`${la},${lo}`)));
    }
    const px = 24;                                    // canvas pixels per grid step
    const W = (lons.length - 1) * px + 1, H = (lats.length - 1) * px + 1;
    weather = {
      lats, lons, W, H, rows,
      canvas: Object.assign(document.createElement("canvas"), { width: W, height: H }),
      coords: [[lons[0], lats.at(-1)], [lons.at(-1), lats.at(-1)], [lons.at(-1), lats[0]], [lons[0], lats[0]]],
    };
  }

  function renderWeather() {
    const { rows, W, H, canvas, lats, lons, coords } = weather;
    const h = state.hour, nr = lats.length, nc = lons.length;
    const showRain = state.layer !== "wind", showWind = state.layer !== "rain";
    const rainV = rows.map((r) => r.map((c) => (showRain ? rainStrength(c.r[h], c.p[h]) : 0)));
    const windV = rows.map((r) => r.map((c) => (showWind ? windStrength(c.g[h]) : 0)));
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(W, H);
    const fadePx = W * 0.06;                          // soften the outer edge of the region
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
        if (rain >= SHOW && wind >= SHOW) { rgb = BOTH_RGB; a = Math.max(rain, wind); }   // both
        else if (rain >= SHOW) { rgb = RAIN_RGB; a = rain; }
        else if (wind >= SHOW) { rgb = WIND_RGB; a = wind; }
        else continue;
        const edge = clamp01(Math.min(x, W - 1 - x, y, H - 1 - y) / fadePx);
        const i = (y * W + x) * 4;
        img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2];
        img.data[i + 3] = 255 * Math.min(0.55, a * 0.55) * edge;   // capped so courts stay in front
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

  // ---------- court markers ----------
  // Every court on screen is a court pin with its score, at every zoom (never a plain dot). Where
  // pins overlap, the most notable (best score for the view) sits on top. Only courts on screen
  // (plus a margin) are added to the map, so panning stays smooth.
  function buildMarkers() {
    DATA.courts.forEach((ct) => {
      const el = document.createElement("div");
      el.className = "court-marker";
      el.tabIndex = 0;
      el.addEventListener("click", (e) => { e.stopPropagation(); select(ct.id); saveHash(); });
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") { select(ct.id); saveHash(); } });
      const m = new maplibregl.Marker({ element: el, anchor: "top", offset: [0, -11] }).setLngLat([ct.lon, ct.lat]);
      markers.push({ ct, el, m, shown: false });
    });
    map.addSource("near-ring", { type: "geojson", data: ringFeature() });
    map.addLayer({ id: "near-ring", type: "line", source: "near-ring",
      paint: { "line-color": css("--accent"), "line-width": 2, "line-opacity": 0.55, "line-dasharray": [2, 2] } });
  }
  const bandAt = (ct, h) => (ct.eff === "closed" ? "closed" : state.layer === "wind" && ct.wb ? ct.wb[h] : ct.b[h]);

  // The label under each court: score, gusts, or rain (amount if any, else chance).
  function chipValue(ct, h) {
    if (ct.eff === "closed") return "Closed";
    const warn = ct.eff === "poor" ? "⚠ " : "";
    if (state.layer === "wind") return `${warn}${ct.g[h]} mph`;
    if (state.layer === "rain") return warn + (ct.r[h] > 0 ? `${ct.r[h].toFixed(2)} in` : `${ct.p[h]}%`);
    return warn + (ct.s[h] >= 10 ? "10" : ct.s[h].toFixed(1));
  }

  // How notable a court is for the current view; higher sits on top when markers overlap.
  function notability(ct, h) {
    if (ct.id === state.selected) return 1e6;
    if (isHidden(ct.id)) return -5;                    // hidden courts sit underneath everything
    if (ct.eff === "closed") return 0;                 // closed courts sink under the others
    const school = ct.type === "school" ? 0 : 1e5;
    if (state.layer === "wind") return school + ct.g[h];
    if (state.layer === "rain") return school + ct.r[h] * 1000 + ct.p[h];
    return school + ct.s[h] * 10;
  }

  function renderMarkers() { renderPins(); renderRing(); renderFilter(); }
  function renderRing() { const src = map.getSource("near-ring"); if (src) src.setData(ringFeature()); }
  function renderPins() {
    const h = state.hour, mode = filterMode();
    const bb = map.getBounds(), dLat = (bb.getNorth() - bb.getSouth()) * 0.2, dLon = (bb.getEast() - bb.getWest()) * 0.2;
    markers.forEach((mk) => {
      const { ct, el, m } = mk;
      const inView = ct.lat > bb.getSouth() - dLat && ct.lat < bb.getNorth() + dLat
        && ct.lon > bb.getWest() - dLon && ct.lon < bb.getEast() + dLon;
      const show = visible(ct, mode) && (ct.id === state.selected || inView);
      if (!show) { if (mk.shown) { m.remove(); mk.shown = false; } return; }
      // Wind view colours courts by wind alone; other views use the overall score.
      // A closed court is gray with a ✕ whatever the weather.
      const b = bandAt(ct, h);
      el.classList.toggle("selected", state.selected === ct.id);
      el.classList.toggle("hidden-court", isHidden(ct.id) && state.selected !== ct.id);
      el.setAttribute("aria-label", ct.eff === "closed" ? `${ct.name}: not playable` :
        `${ct.name}: ${BAND[b].label}, ${ct.s[h]} out of 10${ct.eff === "poor" ? ", rough court" : ""}${isHidden(ct.id) ? ", hidden by you" : ""}`);
      // Small court icon with the number beside it, always visible at every zoom.
      // Court icon (coloured by playability) on top; the number on a white label underneath.
      // A live "how many are open" report puts a dot on the court (red full, amber 1 open, green open);
      // your favorites get a small star.
      const live = liveReport(ct.id);
      const dot = live && live.key ? `<span class="ldot ${live.cls}" title="${live.label}, ${ago(live.at)}"></span>` : "";
      const star = community.favorites.has(ct.id) ? '<span class="fstar" aria-hidden="true">★</span>' : "";
      el.innerHTML = `<div class="pin${ct.type === "school" ? " school" : ""}">${courtSvg(b)}${dot}${star}</div><div class="lbl">${chipValue(ct, h)}</div><div class="nm">${ct.name}</div>`;
      el.style.zIndex = String(10 + Math.round(notability(ct, h)));   // always above weather icons (z 1)
      if (!mk.shown) { m.addTo(map); mk.shown = true; }
    });
  }

  // ---------- conditions: WMO weather codes -> words + icons ----------
  // Open-Meteo reports a WMO "weather code" each hour. Older forecast files don't have it,
  // so fall back to a guess from rain amount and chance.
  function condition(code, isDay, p, r) {
    if (code == null) code = r >= 0.01 ? 61 : r > 0 ? 51 : p >= 60 ? 3 : 0;
    const day = !!isDay;
    if (code === 0) return { kind: "clear", label: day ? "Sunny" : "Clear" };
    if (code === 1) return { kind: "partly", label: day ? "Mostly sunny" : "Mostly clear" };
    if (code === 2) return { kind: "partly", label: "Partly cloudy" };
    if (code === 3) return { kind: "cloudy", label: "Cloudy" };
    if (code === 45 || code === 48) return { kind: "fog", label: "Fog" };
    if (code >= 51 && code <= 57) return { kind: "drizzle", label: "Drizzle" };
    if (code === 65 || code === 82) return { kind: "rain", label: "Heavy rain" };
    if ((code >= 61 && code <= 67) || (code >= 80 && code <= 81)) return { kind: "rain", label: code >= 80 ? "Showers" : "Rain" };
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { kind: "snow", label: "Snow" };
    if (code >= 95) return { kind: "thunder", label: "Thunderstorms" };
    return { kind: "cloudy", label: "Cloudy" };
  }
  // Small, flat weather icons (sun yellow, cloud gray, rain blue), drawn on a 32x32 grid.
  const CLOUD = '<path d="M9.5 25h14a5.5 5.5 0 0 0 .6-10.97A7.5 7.5 0 0 0 9.8 15.6 4.75 4.75 0 0 0 9.5 25z" fill="var(--cloud)"/>';
  const SUNG = (cx, cy, r) => `<g fill="#ffc531"><circle cx="${cx}" cy="${cy}" r="${r}"/></g><g stroke="#ffc531" stroke-width="2" stroke-linecap="round">${
    [0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
      const c = Math.cos(a * Math.PI / 180), s = Math.sin(a * Math.PI / 180);
      return `<path d="M${(cx + c * (r + 3)).toFixed(1)} ${(cy + s * (r + 3)).toFixed(1)}L${(cx + c * (r + 5.5)).toFixed(1)} ${(cy + s * (r + 5.5)).toFixed(1)}"/>`;
    }).join("")}</g>`;
  const MOONG = (cx, cy, r) => `<path d="M${cx + r * 0.35} ${cy - r}a${r} ${r} 0 1 0 ${r * 0.65} ${r * 1.55} ${r * 0.8} ${r * 0.8} 0 0 1 -${r * 0.65} -${r * 1.55}z" fill="#c9d6ea"/>`;
  const DROPS = (n) => `<g stroke="#4aa3f0" stroke-width="2.2" stroke-linecap="round">${
    [[12, 27], [17, 28], [22, 27]].slice(0, n).map(([x, y]) => `<path d="M${x} ${y}l-1.5 3.5"/>`).join("")}</g>`;
  function wxIcon(kind, day, cls = "wx") {
    const body = {
      clear: day ? SUNG(16, 16, 6.5) : MOONG(15, 16, 8),
      partly: (day ? SUNG(12, 11, 5) : MOONG(11, 10, 6)) + CLOUD,
      cloudy: `<g opacity=".55" transform="translate(9 -4) scale(.75)">${CLOUD}</g>${CLOUD}`,
      fog: CLOUD + '<g stroke="var(--cloud)" stroke-width="2.2" stroke-linecap="round"><path d="M6 28.5h20M9 31h14"/></g>',
      drizzle: CLOUD + DROPS(2),
      rain: CLOUD + DROPS(3),
      snow: CLOUD + '<g fill="#dff1ff" stroke="#9cc9ef" stroke-width=".8"><circle cx="12" cy="28.5" r="1.6"/><circle cx="17" cy="30" r="1.6"/><circle cx="22" cy="28.5" r="1.6"/></g>',
      thunder: CLOUD + '<path d="M17 24l-3.5 5h3l-1.5 3.5 5-5.5h-3l1.5-3z" fill="#ffc531"/>',
    }[kind] || CLOUD;
    return `<svg class="${cls}" viewBox="0 0 32 32" aria-hidden="true">${body}</svg>`;
  }

  // ---------- where the weather panel is: you, a court you tapped, or the whole region ----------
  // REGION has the same per-hour arrays as a court (t, s, g, …), built from the typical
  // (median) court, so it can stand in for "Southern California" before we know where you are.
  let REGION;
  const median = (xs) => {
    const v = xs.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  const mode = (xs) => {
    const n = new Map();
    xs.forEach((x) => { if (x != null) n.set(x, (n.get(x) || 0) + 1); });
    let best = null, bn = 0;
    n.forEach((c, x) => { if (c > bn || (c === bn && x > best)) { best = x; bn = c; } });   // ties: the stormier code
    return best;
  };
  function buildRegion() {
    REGION = summarize(DATA.courts.filter((c) => c.type !== "school" && c.status !== "closed"));
  }
  // The typical (median) court of a set, hour by hour: a stand-in "place" for an area.
  function summarize(cs) {
    const H = DATA.times.length;
    const at = (k, f, round = true) => Array.from({ length: H }, (_, h) => {
      const v = f(cs.map((c) => (c[k] ? c[k][h] : null)));
      return v == null ? null : round ? Math.round(v) : v;
    });
    const day = (k) => (DATA.daily && DATA.daily.date || []).map((_, i) => {
      const v = median(cs.map((c) => (c[k] || [])[i]));
      return v == null ? null : Math.round(v);
    });
    const out = {
      total: cs.length, t: at("t", median), ft: at("ft", median), hu: at("hu", median), cc: at("cc", median),
      uv: at("uv", median, false), w: at("w", median), g: at("g", median), p: at("p", median),
      r: at("r", median, false), wc: at("wc", mode), s: at("s", median, false), hi: day("hi"), lo: day("lo"),
      // Wind direction: the circular mean, so 350° and 10° average to 0°, not 180°.
      d: Array.from({ length: H }, (_, h) => {
        let x = 0, y = 0;
        cs.forEach((c) => { const a = c.d[h] * Math.PI / 180; x += Math.cos(a); y += Math.sin(a); });
        return Math.round((Math.atan2(y, x) * 180 / Math.PI + 360) % 360);
      }),
      good: Array.from({ length: H }, (_, h) => cs.filter((c) => c.b[h] === "play").length),
    };
    out.b = out.s.map((s) => bandOf(s));
    return out;
  }

  // ---------- the panel follows the map ----------
  // Zoomed in to city level, the panel shows the city with the most courts on screen, with live
  // weather for the middle of the map and scores for the courts in view. Zoomed out, it goes back
  // to you (or the whole region).
  const VIEW_ZOOM = 11;
  let viewKey = "";
  function updateView() {
    if (!DATA || !map) return;
    let v = null;
    if (map.getZoom() >= VIEW_ZOOM) {
      const bb = map.getBounds();
      const inView = DATA.courts.filter((c) => c.lat >= bb.getSouth() && c.lat <= bb.getNorth()
        && c.lon >= bb.getWest() && c.lon <= bb.getEast());
      const shown = inView.filter((c) => visible(c) && c.eff !== "closed" && !isHidden(c.id));
      if (shown.length) {
        const tally = new Map();
        inView.forEach((c) => tally.set(c.city, (tally.get(c.city) || 0) + 1));
        const name = [...tally].sort((a, b) => b[1] - a[1])[0][0];
        const ctr = map.getCenter();
        // Centre rounded to ~2 km: small pans reuse the same live forecast.
        v = { name, n: shown.length, lat: Math.round(ctr.lat * 50) / 50, lon: Math.round(ctr.lng * 50) / 50, ids: shown.map((c) => c.id) };
      }
    }
    const key = v ? `${v.name}|${v.lat},${v.lon}|${v.ids.join(",")}|${state.schools}` : "";
    if (key === viewKey) return;
    viewKey = key;
    if (v) v.sum = summarize(v.ids.map((id) => DATA.courts.find((c) => c.id === id)));
    state.view = v;
    if (!state.selected) renderPanel();
  }

  // You: set once you tap "Use my location" (and remembered for next time).
  // `pos` is rounded to ~1 km before it's sent anywhere; `exact` only draws your dot on the map.
  const ME = { pos: null, exact: null, name: "", busy: false, marker: null };
  const REGION_CENTER = { lat: 33.93, lon: -118.0 };
  function nearestCourts(lat, lon, n = 3) {
    return DATA.courts.filter((c) => c.type !== "school" && c.eff !== "closed" && !isHidden(c.id))
      .map((c) => ({ c, m: meters(lat, lon, c.lat, c.lon) })).sort((a, b) => a.m - b.m).slice(0, n);
  }

  // ---------- which courts are on the map: near you, your ★ courts, or all ----------
  // One rule. Your ★ courts always show. With "near me" on, so do courts within `radius` miles of you;
  // with "only my ★ courts" on, nothing else does. A court opened from a link always shows.
  const MI = 1609.34, MI_PER_DEG_LAT = 69.05;
  const filt = {
    near: store.get("cc-near") !== "off",   // on unless turned off: most players stay local
    radius: Math.min(50, Math.max(10, Number(store.get("cc-radius")) || 25)),
    favOnly: store.get("cc-favonly") === "on",
  };
  // What's in force right now: a setting only applies once we have what it needs.
  function filterMode() {
    if (filt.favOnly && community.favorites.size) return "fav";
    if (filt.near && ME.pos) return "near";
    return "all";
  }
  function visible(ct, mode = filterMode()) {
    if (ct.id === state.selected) return true;
    const fav = community.favorites.has(ct.id);
    if (!fav && !state.schools && ct.type === "school") return false;
    if (mode === "all" || fav) return true;
    return mode === "near" && meters(ME.pos.lat, ME.pos.lon, ct.lat, ct.lon) / MI <= filt.radius;
  }
  // A box around a circle of `mi` miles (a degree of longitude shrinks with cos(latitude)).
  function circleBounds(pos, mi) {
    const dLat = mi / MI_PER_DEG_LAT, dLon = dLat / Math.cos(pos.lat * Math.PI / 180);
    return [[pos.lon - dLon, pos.lat - dLat], [pos.lon + dLon, pos.lat + dLat]];
  }
  // A dashed ring at the edge of "near me", so it's clear why the courts stop there.
  function ringFeature() {
    if (filterMode() !== "near") return { type: "FeatureCollection", features: [] };
    const [[w, s], [e, n]] = circleBounds(ME.pos, filt.radius), rx = (e - w) / 2, ry = (n - s) / 2;
    const coords = Array.from({ length: 97 }, (_, i) => {
      const a = (i / 96) * 2 * Math.PI;
      return [ME.pos.lon + rx * Math.cos(a), ME.pos.lat + ry * Math.sin(a)];
    });
    return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } };
  }
  // Your ★ courts: the box around them, and how spread out they are (the box's corner-to-corner miles).
  const FAV_CLUSTER_MI = 30;   // spread this small or less = "your area", worth opening on
  const FAV_MAX_ZOOM = 12.5;   // a single favorite: its neighbourhood, close enough for pins (from 12)
  function favArea() {
    const fs = DATA.courts.filter((c) => community.favorites.has(c.id));
    if (!fs.length) return null;
    const lats = fs.map((c) => c.lat), lons = fs.map((c) => c.lon);
    const sw = [Math.min(...lons), Math.min(...lats)], ne = [Math.max(...lons), Math.max(...lats)];
    return { courts: fs, bounds: [sw, ne], spanMi: meters(sw[1], sw[0], ne[1], ne[0]) / MI };
  }
  function fitTo(bounds, maxZoom = 13, padding = homePadding()) {
    map.fitBounds(bounds, { padding, maxZoom, duration: 700 });
  }
  // The chip on the map: what the rule is showing; tap it to change.
  function renderFilter() {
    const chip = $("filterChip"), mode = filterMode();
    if (!chip) return;
    chip.hidden = mode === "all";
    if (mode === "all") return;
    const n = DATA.courts.filter((c) => visible(c, mode) && !isHidden(c.id)).length;
    const what = mode === "fav" ? "★ Your courts" : `📍 Within ${filt.radius} mi`;
    chip.innerHTML = `${what} <span class="muted">· ${n} court${n === 1 ? "" : "s"}</span>`;
    chip.setAttribute("aria-label", `${mode === "fav" ? "Showing your favorite courts" : `Showing courts within ${filt.radius} miles`}, ${n}. Change which courts show`);
  }
  function applyFilter(fit) {
    renderMarkers();
    updateView();
    if (fit) goHome();
  }
  // The place on screen: its name, where it is, the court scores that speak for it (`src`),
  // and fallback weather numbers (`fb`) from the 2-hourly build until live detail arrives.
  function place() {
    const ct = state.selected && DATA.courts.find((c) => c.id === state.selected);
    if (ct) return { kind: "court", name: ct.name, sub: ct.city, lat: ct.lat, lon: ct.lon, src: ct, fb: ct, court: ct };
    const v = state.view;
    if (v && !(ME.pos && meters(v.lat, v.lon, ME.pos.lat, ME.pos.lon) < 3000)) {
      return { kind: "view", name: v.name, sub: `${v.n} court${v.n === 1 ? "" : "s"} on screen`, lat: v.lat, lon: v.lon, src: v.sum, fb: v.sum };
    }
    if (ME.pos) {
      const near = nearestCourts(ME.pos.lat, ME.pos.lon);
      const best = DATA.times.map((_, h) => near.reduce((a, x) => (!a || x.c.s[h] > a.c.s[h] ? x : a), null));
      return {
        kind: "me", name: ME.name || "Your location", sub: "Your location", lat: ME.pos.lat, lon: ME.pos.lon,
        src: { s: best.map((x, h) => x.c.s[h]), b: best.map((x, h) => x.c.b[h]), best }, fb: near[0].c, near,
      };
    }
    return { kind: "region", name: "Southern California", sub: "The coast to the Inland Empire", ...REGION_CENTER, src: REGION, fb: REGION };
  }

  // The ◎ "locate me" button: MapLibre's built-in, like Google Maps. A blue dot with an accuracy
  // circle; tap to fly to you and follow you as you move; pan away and it stops following (tap to
  // recentre). Every position it reports also updates the weather panel.
  let geo = null, lastNamed = null;
  const LOCATE_ZOOM = 12.5;   // close enough that the courts around you show as pins
  function addGeolocate() {
    if (!navigator.geolocation) return;
    geo = new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true, timeout: 15000, maximumAge: 60 * 1000 },
      trackUserLocation: true, showAccuracyCircle: true, showUserLocation: true,
      fitBoundsOptions: { maxZoom: LOCATE_ZOOM, duration: 900 },
    });
    map.addControl(geo, "top-right");
    geo.on("geolocate", (e) => setMe(e.coords));
    geo.on("error", (e) => {
      ME.busy = false;
      const sw = $("setUseloc");
      if (sw) sw.checked = false;
      toast(e.code === 1 ? "Location is blocked for this site. Allow it in your browser settings to see your area."
        : "Couldn't get your location. Try again in a moment.");
      renderHero();
    });
  }
  function useMyLocation() {
    if (!geo) return;
    const following = geo._watchState && geo._watchState !== "OFF";
    if (ME.exact && following) {   // already showing you: just recentre
      map.flyTo({ center: [ME.exact.lon, ME.exact.lat], zoom: Math.max(map.getZoom(), LOCATE_ZOOM), duration: 900 });
      return;
    }
    if (!ME.exact) { ME.busy = true; renderHero(); }
    geo.trigger();   // the blue dot, and fly to you
  }
  async function setMe(coords) {
    ME.busy = false;
    const { latitude, longitude } = coords;
    ME.exact = { lat: latitude, lon: longitude };   // only for the map; never sent anywhere
    // ~1 km is plenty for weather, and not enough to pinpoint a home.
    const pos = { lat: Math.round(latitude * 100) / 100, lon: Math.round(longitude * 100) / 100 };
    const moved = !ME.pos || ME.pos.lat !== pos.lat || ME.pos.lon !== pos.lon;
    ME.pos = pos;
    store.set("cc-useloc", "on");
    const sw = $("setUseloc");
    if (sw) sw.checked = true;
    if (!moved) return;   // following you: only redo the panel when you've moved ~1 km
    const renamed = !lastNamed || meters(lastNamed.lat, lastNamed.lon, pos.lat, pos.lon) > 1500;
    if (renamed) {
      const guess = nearestCourts(latitude, longitude, 1)[0];
      ME.name = guess ? guess.c.city : "Your location";   // instant guess, replaced by the real place name below
      lastNamed = pos;
    }
    renderMarkers();   // "near me" moves with you
    renderPanel();
    if (!renamed) return;
    try {
      const j = await (await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${pos.lat}&longitude=${pos.lon}&localityLanguage=en`)).json();
      const name = j.locality || j.city;
      if (name) { ME.name = name; renderHero(); }
    } catch (_) { /* keep the guess */ }
  }
  function stopUsingLocation() {
    store.set("cc-useloc", "off");
    // Switch the ◎ button off too (it goes OFF from "following", and via "following" from "background").
    try { for (let i = 0; i < 2 && geo && geo._watchState && geo._watchState !== "OFF"; i++) geo.trigger(); } catch (_) { /* fine */ }
    ME.pos = ME.exact = null;
    ME.name = "";
    lastNamed = null;
    renderMarkers();
    renderPanel();
  }

  // ---------- where the map opens ----------
  // Players stick to their own courts, so open there, not on all of SoCal:
  //   1. your ★ courts, if they sit close together (or "only my ★ courts" is on), unless you're
  //      travelling (farther than your radius from all of them);
  //   2. else you, zoomed in on your neighbourhood (if you've allowed location before);
  //   3. else the whole region.
  // A link to a court, or the player moving the map first, beats all of these.
  // First-time visitors still aren't asked for location until they tap ◎ or "Use my location".
  let cameraTouched = false;
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
  async function locationAllowed() {
    if (store.get("cc-useloc") === "off" || !navigator.permissions || !geo) return false;
    try { return (await navigator.permissions.query({ name: "geolocation" })).state === "granted"; } catch (_) { return false; }
  }
  // Where you are, without moving the map or starting "follow me" (◎ still does both).
  function quietLocate() {
    return new Promise((ok) => navigator.geolocation.getCurrentPosition(
      (p) => { setMe(p.coords); ok(true); }, () => ok(false),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * 60 * 1000 }));
  }
  async function openHome() {
    const [loc] = await Promise.all([locationAllowed(), Promise.race([mineReady, wait(4000)])]);
    const free = () => !state.selected && !cameraTouched;
    const fa = favArea();
    const favHome = fa && (filt.favOnly || fa.spanMi <= FAV_CLUSTER_MI);
    if (!favHome) {
      if (loc && free()) useMyLocation(); else if (loc) quietLocate();
      return;
    }
    if (free()) fitTo(fa.bounds, FAV_MAX_ZOOM, homePadding() + 40);
    if (!loc || !(await quietLocate()) || filt.favOnly || !free()) return;
    const closest = Math.min(...fa.courts.map((c) => meters(ME.pos.lat, ME.pos.lon, c.lat, c.lon))) / MI;
    if (closest > filt.radius) useMyLocation();   // away from your usual courts: show where you are
  }

  // ---------- live detail from Open-Meteo for the place on screen ----------
  // 10-day forecast, feels like, dew point, visibility, pressure, UV and air quality, fetched by the
  // browser for whatever place is showing (rounded to ~1 km) and kept for 30 minutes.
  const WX = new Map();
  const wxKey = (lat, lon) => `${lat.toFixed(2)},${lon.toFixed(2)}`;
  function wxFor(pl) {
    const k = wxKey(pl.lat, pl.lon), hit = WX.get(k);
    const stale = !hit || Date.now() - hit.at > (hit.data ? 30 : 2) * 60 * 1000;
    if (stale && !(hit && hit.loading)) loadWx(k, pl.lat, pl.lon);
    return (hit && hit.data) || null;
  }
  async function loadWx(k, lat, lon) {
    const prev = WX.get(k);
    WX.set(k, { data: prev && prev.data, at: prev ? prev.at : 0, loading: true });
    const common = { latitude: lat.toFixed(2), longitude: lon.toFixed(2), timezone: PT };
    const fq = new URLSearchParams({
      ...common, models: "gfs_seamless", forecast_days: "10",
      temperature_unit: "fahrenheit", wind_speed_unit: "mph", precipitation_unit: "inch",
      hourly: "temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,precipitation_probability,precipitation,"
        + "weather_code,cloud_cover,visibility,wind_speed_10m,wind_gusts_10m,wind_direction_10m,uv_index,pressure_msl,is_day",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,uv_index_max,sunrise,sunset,daylight_duration,wind_gusts_10m_max",
    });
    const aq = new URLSearchParams({ ...common, forecast_days: "3", hourly: "us_aqi,pm2_5,ozone" });
    let data = prev && prev.data;
    try {
      const [f, a] = await Promise.all([
        fetch(`https://api.open-meteo.com/v1/forecast?${fq}`).then((r) => (r.ok ? r.json() : null)),
        fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${aq}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (f && f.hourly) data = { f, aq: a && a.hourly ? a : null, ix: new Map(f.hourly.time.map((t, i) => [t, i])),
        aix: a && a.hourly ? new Map(a.hourly.time.map((t, i) => [t, i])) : new Map() };
    } catch (_) { /* offline: keep showing the build's numbers */ }
    WX.set(k, { data, at: Date.now(), loading: false });
    const pl = place();
    if (wxKey(pl.lat, pl.lon) === k) renderPanel();
  }
  // A reading for forecast hour h: live detail when we have it, else the 2-hourly build's number.
  const API = { t: "temperature_2m", ft: "apparent_temperature", hu: "relative_humidity_2m", dp: "dew_point_2m",
    p: "precipitation_probability", r: "precipitation", wc: "weather_code", cc: "cloud_cover", vis: "visibility",
    w: "wind_speed_10m", g: "wind_gusts_10m", d: "wind_direction_10m", uv: "uv_index", pr: "pressure_msl" };
  function reader(pl) {
    const wx = wxFor(pl);
    const byTime = (k, time) => {
      if (k === "aqi" || k === "pm25" || k === "o3") {
        const i = wx && wx.aq ? wx.aix.get(time) : undefined;
        return i == null ? null : wx.aq.hourly[{ aqi: "us_aqi", pm25: "pm2_5", o3: "ozone" }[k]][i];
      }
      const i = wx ? wx.ix.get(time) : undefined;
      return i == null || !API[k] ? null : wx.f.hourly[API[k]][i];
    };
    return {
      wx,
      time: byTime,
      at(k, h) {
        const live = byTime(k, DATA.times[h]);
        if (live != null) return live;
        const a = pl.fb[k];
        return a && a[h] != null ? a[h] : null;
      },
    };
  }
  const round = (v) => (v == null ? null : Math.round(v));

  // Sunrise / sunset for a local date ("2026-11-17"): live daily data, else the build's.
  function sunTimes(date, rd) {
    const W = rd && rd.wx && rd.wx.f.daily;
    let i = W ? W.time.indexOf(date) : -1;
    if (i >= 0) return { rise: W.sunrise[i], set: W.sunset[i], len: W.daylight_duration ? W.daylight_duration[i] : null };
    const D = DATA.daily;
    i = D && D.date ? D.date.indexOf(date) : -1;
    return i < 0 ? null : { rise: D.sunrise[i], set: D.sunset[i], len: null };
  }
  const clock = (iso) => {   // "2026-11-17T16:45" -> "4:45 PM"
    const [hh, mm] = iso.split("T")[1].split(":").map(Number);
    return `${hh % 12 || 12}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
  };
  const hoursOf = (iso) => Number(iso.slice(11, 13)) + Number(iso.slice(14, 16)) / 60;

  // The hero's sky colour: what you'd see looking up at that hour.
  function skyOf(rd, h) {
    const cond = condition(rd.at("wc", h), DATA.is_day[h], rd.at("p", h), rd.at("r", h));
    const t = DATA.times[h], sun = sunTimes(t.slice(0, 10), rd);
    if (sun && !["rain", "thunder", "drizzle"].includes(cond.kind)) {   // within ~45 min of sunrise or sunset
      const mid = Number(t.slice(11, 13)) + 0.5;
      if (Math.abs(hoursOf(sun.rise) - mid) <= 0.75 || Math.abs(hoursOf(sun.set) - mid) <= 0.75) return "golden";
    }
    const day = DATA.is_day[h];
    if (["rain", "thunder", "drizzle", "snow"].includes(cond.kind)) return day ? "storm" : "storm-night";
    if (["cloudy", "fog"].includes(cond.kind)) return day ? "overcast" : "overcast-night";
    return day ? "clear" : "night";
  }

  // ---------- hero: place, big temperature, condition, highs/lows, and the tennis verdict ----------
  function renderHero() {
    const pl = place(), rd = reader(pl), h = state.hour, now = h === state.base;
    const cond = condition(rd.at("wc", h), DATA.is_day[h], rd.at("p", h), rd.at("r", h));
    const date = DATA.times[h].slice(0, 10);
    let hi = null, lo = null;
    const W = rd.wx && rd.wx.f.daily, wi = W ? W.time.indexOf(date) : -1;
    if (wi >= 0) { hi = round(W.temperature_2m_max[wi]); lo = round(W.temperature_2m_min[wi]); }
    else {
      const di = DATA.daily && DATA.daily.date ? DATA.daily.date.indexOf(date) : -1;
      if (di >= 0 && pl.fb.hi) { hi = pl.fb.hi[di]; lo = pl.fb.lo[di]; }
    }
    const ft = round(rd.at("ft", h));
    const closed = pl.kind === "court" && pl.court.eff === "closed";
    const b = closed ? "skip" : pl.src.b[h], s = pl.src.s[h];
    let verdict;
    if (closed) verdict = `<b>🚫 Not playable</b><span>${esc(pl.court.effNote || "This court is closed")}</span>`;
    else if (pl.kind === "court") {
      const why = pl.court.why[h].length ? pl.court.why[h].join(" · ") : "Nothing in the way";
      verdict = `<b>${BAND[b].face} ${BAND[b].label} · ${s.toFixed(1)}</b><span>${esc(why)}</span>`;
    } else if (pl.kind === "me") {
      const x = pl.src.best[h];
      verdict = `<b>${BAND[b].face} ${BAND[b].label} nearby · ${s.toFixed(1)}</b>
        <span>Best near you: <button class="link inline" data-court="${x.c.id}">${esc(x.c.name)}</button> · ${(x.m / 1609).toFixed(1)} mi</span>`;
    } else {
      const good = pl.src.good[h], here = pl.kind === "view" ? " here" : "";
      verdict = `<b>${BAND[b].face} ${good ? `Good to play at ${good} of ${pl.src.total} court${pl.src.total === 1 ? "" : "s"}${here}` : `${BAND[b].label} ${here ? "here" : "across the area"}`}</b>
        <span>Typical score ${s.toFixed(1)} / 10</span>`;
    }
    const when = now ? `<span class="live-dot"></span>Now · ${clockText()}` : `${fmtTime(DATA.times[h])} · in ${h - state.base} h`;
    const canLocate = !!navigator.geolocation;
    let top;
    if (pl.kind === "court") top = `<button class="back" data-act="all">‹ ${state.view ? esc(state.view.name) : ME.pos ? esc(ME.name) : "All courts"}</button>`;
    else if (pl.kind === "me") top = '<div class="eyebrow">📍 Your location</div>';
    else if (pl.kind === "view") top = `<div class="eyebrow">🗺 On the map · ${esc(pl.sub)}</div>`;
    else top = `<div class="eyebrow">Tennis weather</div>`;
    $("hero").className = `hero sky-${skyOf(rd, h)}`;
    $("hero").innerHTML = `
      <div class="hero-top">
        ${top}
        <h2>${esc(pl.name)}</h2>
        <div class="hero-when">${pl.kind === "court" ? `${esc(pl.sub)} · ` : ""}${when}${now ? "" : ' · <button class="link" data-act="now">Back to now</button>'}</div>
        ${pl.kind === "region" && canLocate ? `<button class="locbtn" data-act="useloc"${ME.busy ? " disabled" : ""}>${ME.busy ? "Finding you…" : "📍 Use my location"}</button>` : ""}
      </div>
      <div class="hero-main">
        <div class="hero-temp">${round(rd.at("t", h))}°</div>
        <div class="hero-cond">${wxIcon(cond.kind, DATA.is_day[h], "wx big")}<span>${cond.label}</span></div>
      </div>
      <div class="hero-sub">${hi != null ? `H:${hi}° L:${lo}°` : ""}${ft != null ? `${hi != null ? " · " : ""}Feels like ${ft}°` : ""}</div>
      <div class="hero-verdict ${b}">${verdict}</div>`;
  }

  // ---------- hourly strip: swipe through the hours like a weather app ----------
  function renderHourly(scroll) {
    const pl = place(), rd = reader(pl), base = state.base, last = DATA.times.length - 1;
    const closed = pl.kind === "court" && pl.court.eff === "closed";
    const items = [];
    for (let i = base; i <= last; i++) {
      const t = DATA.times[i], d = t.slice(0, 10), hh = Number(t.slice(11, 13));
      const p = round(rd.at("p", i)), temp = round(rd.at("t", i));
      const cond = condition(rd.at("wc", i), DATA.is_day[i], p, rd.at("r", i));
      const label = i === base ? "Now" : hh === 0 ? dayWord(d) : `${hh % 12 || 12}${hh < 12 ? "AM" : "PM"}`;
      items.push(`<button class="hr${i === state.hour ? " sel" : ""}${hh === 0 && i !== base ? " newday" : ""}" data-h="${i}"
          role="option" aria-selected="${i === state.hour}" aria-label="${fmtTime(t)}: ${temp} degrees, ${cond.label}, score ${pl.src.s[i].toFixed(1)}">
        <span class="hr-t">${label}</span>
        ${wxIcon(cond.kind, DATA.is_day[i])}
        <span class="hr-p">${p != null && p >= 20 ? `${p}%` : ""}</span>
        <span class="hr-temp">${temp}°</span>
        <span class="hr-s ${closed ? "closed" : pl.src.b[i]}">${closed ? "—" : pl.src.s[i].toFixed(1)}</span>
      </button>`);
      const sun = sunTimes(d, rd);   // sunrise / sunset slot, like phone weather apps
      if (sun && i < last) for (const [iso, word] of [[sun.rise, "Sunrise"], [sun.set, "Sunset"]]) {
        if (Number(iso.slice(11, 13)) === hh) {
          items.push(`<div class="hr sunev" aria-label="${word} ${clock(iso)}"><span class="hr-t">${clock(iso).replace(" ", "")}</span>
            <svg class="wx" viewBox="0 0 32 32" aria-hidden="true">${SUNG(16, 20, 5)}<path d="M4 25h24" stroke="var(--cloud)" stroke-width="2" stroke-linecap="round"/>
            <path d="M16 ${word === "Sunrise" ? "9l-3 3m3-3l3 3" : "12l-3-3m3 3l3-3"}" stroke="#ff9f43" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
            <span class="hr-p"></span><span class="hr-temp small">${word}</span><span class="hr-s none"></span></div>`);
        }
      }
    }
    const el = $("hourly");
    const keep = el.scrollLeft;
    el.innerHTML = items.join("");
    el.scrollLeft = keep;
    if (scroll) {
      const sel = el.querySelector(".hr.sel");
      if (sel) el.scrollTo({ left: sel.offsetLeft - el.clientWidth / 2 + sel.offsetWidth / 2, behavior: "smooth" });
    }
  }

  // ---------- detail tiles: what the weather means on court ----------
  // Each "read" turns a reading into tennis terms:
  //   head  a word for the tile ("Gusty", "Heavy", "Dewy")
  //   play  what it does on court, and what to do about it
  //   sev   how much it matters right now, 0..1 (the "How it plays" summary leads with the biggest)
  //   adj   a word for the summary headline;  sum  a clause for the summary sentence;  tip  a short tip
  // Thresholds follow the playability score (courtcast/config.py) wherever it has one.
  const UV_LEVEL = (u) => (u < 3 ? "Low" : u < 6 ? "Moderate" : u < 8 ? "High" : u < 11 ? "Very high" : "Extreme");
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const andJoin = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
  const feet = (m) => Math.max(1, Math.round(m * 3.281));

  // How far a gust pushes the ball sideways: the drag simulation in courtcast/config.py
  // (gust mph, serve toss m, lob m), interpolated in between and extended past 25 mph.
  const DRIFT = [[0, 0, 0], [10, 0.2, 2.4], [15, 0.4, 3.7], [20, 0.7, 5.2], [25, 1.0, 6.8]];
  function drift(g) {
    let i = 1;
    while (i < DRIFT.length - 1 && g > DRIFT[i][0]) i++;
    const [g0, t0, l0] = DRIFT[i - 1], [g1, t1, l1] = DRIFT[i], f = (g - g0) / (g1 - g0);
    return { toss: Math.max(0, t0 + (t1 - t0) * f), lob: Math.max(0, l0 + (l1 - l0) * f) };
  }
  function readWind(w, g) {
    const B = DATA.bands, d = drift(g);
    const push = `A gust moves your toss ~${feet(d.toss)} ft and a lob ~${feet(d.lob)} ft.`;
    const uneven = g - w >= 8 ? " It comes and goes, so it's hard to adjust for." : "";
    if (g < B.wind_iffy) return { band: "play", head: "Calm", sev: 0, play: "The ball goes where you aim it." };
    if (g < 15) return { band: "iffy", head: "Light breeze", sev: 0.3, adj: "breezy", sum: "a breeze nudges tosses and lobs",
      play: `${push} Toss a little lower.`, tip: "Lower toss" };
    if (g < B.wind_skip) return { band: "iffy", head: "Gusty", sev: 0.65, adj: "gusty", sum: "gusts push tosses and lobs around",
      play: `${push}${uneven} Lower your toss, add spin, and aim well inside the lines.`, tip: "Lower toss, aim inside the lines" };
    return { band: "skip", head: "Too windy", sev: 1, adj: "very windy", sum: "the wind blows lobs and tosses way off",
      play: `${push} Rallies turn into scrambles; most players call it here.`, tip: "Try another hour" };
  }
  // Ball pressure and rubber bounce change with temperature: cold balls are dead, hot ones fly.
  function readBall(t, hu) {
    const damp = hu != null && hu >= 85 ? " Damp air makes it a touch heavier." : "";
    if (t < 50) return { head: "Heavy", sev: 0.55, adj: "cold", sum: "the ball feels heavy and bounces low",
      play: `Cold balls feel dead and bounce low, and strings stiffen. Swing through it and warm up longer.${damp}`, tip: "Longer warm-up" };
    if (t < 62) return { head: "A bit slow", sev: 0.2, adj: "cool", sum: "the ball plays a little slow",
      play: `The ball sits down a little; you'll need more racquet-head speed.${damp}` };
    if (t < 82) return { head: "Plays true", sev: 0, play: `Normal pace and bounce.${damp}` };
    if (t < 92) return { head: "Lively", sev: 0.15, adj: "warm", sum: "the ball flies a little livelier",
      play: "The ball jumps off the strings and bounces higher. A bit more topspin keeps it in." };
    return { head: "Fast", sev: 0.3, adj: "hot", sum: "the ball flies fast and kicks up high",
      play: "The ball flies and kicks up high, and balls lose pressure sooner. Open a fresh can.", tip: "Fresh balls, more topspin" };
  }
  function readHeat(f, sunny) {
    const surface = sunny ? " Hard courts in full sun get much hotter than the air." : "";
    if (f >= 95) return { head: "Heat risk", sev: 0.9, adj: "very hot", sum: "the heat is a real risk",
      play: `Drink every changeover, use the shade and an ice towel, and stop if you feel dizzy.${surface}`, tip: "Drink every changeover" };
    if (f >= 85) return { head: "Hot", sev: 0.45, adj: "hot", sum: "it's hot work out there",
      play: `Drink every changeover and rest in the shade.${surface}`, tip: "Extra water" };
    if (f >= 70) return { head: "Comfortable", sev: 0, play: "Easy on the body. Drink at changeovers." };
    if (f >= 55) return { head: "Cool", sev: 0, play: "Great for long rallies. You'll still sweat, so keep drinking." };
    return { head: "Cold", sev: 0.35, adj: "cold", sum: "it's cold on court",
      play: "Wear layers you can peel off as you heat up. Cold muscles strain more easily, so ease into it.", tip: "Layers" };
  }
  // Dew point is what your skin feels (humidity alone depends on temperature). Near it, dew forms.
  function readGrip(dp, hu, t, dewHours) {
    if (dp != null && t != null && t - dp <= 4 && dewHours) return { head: "Dewy", sev: 0.45, adj: "dewy",
      sum: "dew makes the court and lines slick", tip: "Watch your footing",
      play: "The air is at its dew point, so courts and painted lines get slick, especially in the shade. Check your footing." };
    if (dp != null && dp >= 65) return { head: "Muggy", sev: 0.45, adj: "muggy", sum: "sweat won't dry and grips get slick",
      play: "Sweat won't dry and grips get slick. Bring a towel and a spare overgrip, and slow down between points.", tip: "Towel and spare overgrip" };
    if (dp != null && dp >= 58) return { head: "Sticky", sev: 0.2, adj: "sticky", sum: "grips get damp",
      play: "Your grip gets damp later in a set. Towel off at changeovers." };
    if ((dp != null && dp < 35) || (hu != null && hu < 25)) return { head: "Dry", sev: t >= 75 ? 0.3 : 0.1, adj: "dry",
      sum: "dry air dries you out fast", tip: "Drink before you're thirsty",
      play: "Sweat dries instantly, so you lose water without noticing. Drink before you're thirsty." };
    return { head: "Comfortable", sev: 0, play: "Your grip stays dry and sweat evaporates normally." };
  }
  // How many hours ago it last rained (1-3), looking back past the build's hours with live data.
  function rainedAgo(rd, h) {
    const i0 = rd.wx ? rd.wx.ix.get(DATA.times[h]) : undefined;
    for (let k = 1; k <= 3; k++) {
      let v = h - k >= 0 ? rd.at("r", h - k) : null;
      if (v == null && i0 != null && i0 - k >= 0) v = rd.wx.f.hourly.precipitation[i0 - k];
      if (v != null && v >= 0.01) return k;
    }
    return 0;
  }
  function readCourt(rd, h) {
    const r = rd.at("r", h) || 0;
    if (r >= 0.01) return { band: "skip", head: "Raining", sev: 1, adj: "rainy", sum: "it's raining",
      play: "Courts are wet and slippery. Wait it out." };
    const ago = rainedAgo(rd, h);
    if (ago === 1) return { band: "skip", head: "Wet", sev: 0.9, adj: "wet", sum: "the court is still wet", tip: "Bring a squeegee or towel",
      play: "It rained in the last hour, so courts and lines are slippery. Give them time, or bring a squeegee." };
    if (ago) return { band: "iffy", head: "Drying", sev: 0.5, adj: "damp", sum: "the court is still drying",
      play: `It rained about ${ago} hours ago. Watch for puddles and slick lines in the shade.` };
    if (r > 0) return { band: "iffy", head: "Drizzle", sev: 0.7, adj: "drizzly", sum: "drizzle makes the lines slick",
      play: "A light drizzle: playable, but painted lines get slick fast." };
    let next = null;
    for (let i = h + 1; i <= Math.min(DATA.times.length - 1, h + 6); i++) {
      if ((rd.at("r", i) || 0) >= 0.01 || (rd.at("p", i) || 0) >= 50) { next = i; break; }
    }
    if (next != null) {
      const at = fmtTime(DATA.times[next], true), soon = next - h <= 2;
      return { band: "iffy", head: "Dry for now", sev: soon ? 0.5 : 0.25, adj: soon ? "rain on the way" : "", sum: `rain is likely by ${at}`,
        play: `Rain is likely around ${fmtTime(DATA.times[next])}. Play before then.`, tip: `Play before ${at}` };
    }
    return { band: "play", head: "Dry", sev: 0, play: "No rain on the way. Good footing." };
  }
  // US EPA air-quality bands, and how hard to play in them.
  const AQI_BANDS = [
    [50, "Good", "#2fb344", 0, "Full intensity. Go for it."],
    [100, "Moderate", "#e6c229", 0.1, "Fine for most players. Asthma or allergies? Take it a little easier."],
    [150, "Unhealthy for sensitive groups", "#f08a24", 0.5, "Sensitive players: rally instead of playing a match, take more breaks, keep an inhaler handy."],
    [200, "Unhealthy", "#e5484d", 0.8, "Keep it short and light. Skip the hard sprints."],
    [300, "Very unhealthy", "#a3262a", 0.95, "Better to skip today."],
    [Infinity, "Hazardous", "#6e1b1b", 1, "Stay indoors."],
  ];
  const aqiBand = (v) => AQI_BANDS.find(([max]) => v <= max);
  function readAir(aqi) {
    const [, label, color, sev, play] = aqiBand(aqi);
    return { head: label === "Unhealthy for sensitive groups" ? "Sensitive groups" : label, color, sev, play,
      adj: sev >= 0.5 ? "smoky" : "", sum: "the air is bad for hard breathing", tip: sev >= 0.5 ? "Play lighter" : undefined };
  }
  function readSun(uv, rd, h) {
    const sun = sunTimes(DATA.times[h].slice(0, 10), rd);
    const at = Number(DATA.times[h].slice(11, 13)) + (h === state.base ? new Date().getMinutes() / 60 : 0.5);
    if (!DATA.is_day[h]) return { dark: true, head: "Dark", sev: 0.7, adj: "dark", sum: "it's dark, so lit courts only", tip: "Find a lit court",
      play: sun && at < hoursOf(sun.rise) ? `Before sunrise (${clock(sun.rise)}): lit courts only.` : "After sunset: lit courts only." };
    const uvTxt = uv == null ? "" : uv >= 6 ? "Strong sun: sweat-proof sunscreen, reapplied every hour, and a hat or visor."
      : uv >= 3 ? "Sunscreen, and a visor helps on bright tosses." : "Gentle sun.";
    if (sun && (Math.abs(at - hoursOf(sun.rise)) <= 1.5 || Math.abs(hoursOf(sun.set) - at) <= 1.5)) {
      return { head: "Low sun", sev: 0.25, adj: "low sun", sum: "low sun glares into one end", tip: "Sunglasses or a visor",
        play: `The sun is low, so one end serves and hits overheads into the glare. Sunglasses or a visor help; switching ends evens it out. ${uvTxt}` };
    }
    return { head: uv == null ? "Daylight" : `${UV_LEVEL(uv)} UV`, sev: uv >= 8 ? 0.2 : 0, adj: uv >= 8 ? "sun-baked" : "",
      sum: "the sun is strong", play: uvTxt || "Daylight.", tip: uv >= 6 ? "Sunscreen and a hat" : undefined };
  }
  // The 10-day list: one tennis word per day (daily max gusts, rain and highs).
  function dayTag(D, i) {
    const pp = D.precipitation_probability_max[i] || 0, rain = D.precipitation_sum[i] || 0;
    const g = D.wind_gusts_10m_max ? D.wind_gusts_10m_max[i] : null, hi = D.temperature_2m_max[i];
    if (rain >= 0.1 || pp >= 60) return ["skip", "Rain"];
    if (g != null && g >= DATA.bands.wind_skip) return ["skip", "Windy"];
    if (hi >= 95) return ["iffy", "Hot"];
    if (g != null && g >= 15) return ["iffy", "Breezy"];
    if (hi < 55) return ["iffy", "Cold"];
    return ["play", "Good"];
  }

  // A tile: header, a tennis word, the numbers behind it, then what it means on court.
  const tile = (cls, icon, title, head, meas, play, extra = "") =>
    `<div class="tile ${cls}"><div class="tile-h">${icon}<span>${title}</span></div>
      <div class="tile-word">${head}</div>${meas ? `<div class="tile-meas">${meas}</div>` : ""}
      ${play ? `<div class="tile-note">${play}</div>` : ""}${extra}</div>`;
  const TI = {   // tile header icons (simple line icons; colour comes from CSS)
    cal: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2 6.5h12M5 1.5v3M11 1.5v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    leaf: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13c0-6 4-10 11-10 0 7-4 11-10 11M3 13l5-5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    sun: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="currentColor"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    ball: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.2 4.2c2.6 1.6 2.6 6 0 7.6M12.8 4.2c-2.6 1.6-2.6 6 0 7.6" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    court: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="3.5" width="13" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 3.5v9M4.5 3.5v9M11.5 3.5v9M4.5 8h7" stroke="currentColor" stroke-width="1.1"/></svg>',
    drop: ICON.rain, wind: ICON.wind, temp: ICON.temp,
    rise: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 12a5 5 0 0 1 10 0M1 14h14M8 2v4M6 4l2-2 2 2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  };

  function renderTiles() {
    const pl = place(), rd = reader(pl), h = state.hour, wx = rd.wx, out = [];
    const t = round(rd.at("t", h)), f = round(rd.at("ft", h)), hu = round(rd.at("hu", h)), dp = round(rd.at("dp", h));
    const w = round(rd.at("w", h)) || 0, g = round(rd.at("g", h)) || 0, dir = rd.at("d", h) || 0;
    const uv = rd.at("uv", h), aqi = rd.at("aqi", h), vis = rd.at("vis", h), hr = Number(DATA.times[h].slice(11, 13));
    const cond = condition(rd.at("wc", h), DATA.is_day[h], rd.at("p", h), rd.at("r", h));

    const wind = readWind(w, g), court = readCourt(rd, h);
    const ball = t != null ? readBall(t, hu) : null;
    const heat = f != null ? readHeat(f, DATA.is_day[h] && ["clear", "partly"].includes(cond.kind)) : null;
    const grip = hu != null || dp != null ? readGrip(dp, hu, t, !DATA.is_day[h] || hr < 9) : null;
    const air = aqi != null ? readAir(aqi) : null;
    const sun = readSun(uv, rd, h);
    const fog = vis != null && vis < 1609 ? { sev: 0.5, adj: "foggy", sum: "fog makes high balls hard to track", tip: "Keep the lobs low" } : null;

    // 1. How it plays: the biggest issues right now, in a headline, a sentence and a few tips.
    const issues = [court, wind, heat, ball, grip, air, sun, fog].filter((x) => x && x.sev > 0).sort((a, b) => b.sev - a.sev);
    const adjs = [...new Set(issues.map((x) => x.adj).filter(Boolean))].slice(0, 2);
    const sums = [...new Set(issues.map((x) => x.sum).filter(Boolean))].slice(0, 3);
    const tips = [...new Set(issues.map((x) => x.tip).filter(Boolean))].slice(0, 3);
    const closed = pl.kind === "court" && pl.court.eff === "closed", band = closed ? "skip" : pl.src.b[h];
    const when = h === state.base ? "now" : `at ${fmtTime(DATA.times[h], true)}`;
    out.push(`<div class="tile wide howplays ${band}"><div class="tile-h">${TI.ball}<span>How it plays ${when}</span></div>
      <div class="tile-word">${closed ? "Court not playable" : adjs.length ? cap(adjs.join(" and ")) : "Ideal conditions"}</div>
      <div class="tile-note">${closed ? esc(pl.court.effNote || "This court is marked not playable.")
        : sums.length ? `${cap(andJoin(sums))}.` : "Calm, comfortable and dry: the ball plays true. Just go hit."}</div>
      ${!closed && tips.length ? `<div class="tips">${tips.map((x) => `<span>${x}</span>`).join("")}</div>` : ""}</div>`);

    // 2. Wind, with a compass. Direction is where it blows FROM; the arrow shows where it's going.
    out.push(tile(`wide wind ${wind.band}`, TI.wind, "Wind on court", wind.head, `${w} mph · gusts ${g} · from ${compass(dir)}`, wind.play,
      `<svg class="compass" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="27" fill="none" stroke="var(--line)" stroke-width="2"/>
        ${["N", "E", "S", "W"].map((c, k) => `<text x="${32 + Math.sin(k * Math.PI / 2) * 21}" y="${32 - Math.cos(k * Math.PI / 2) * 21 + 3.5}" text-anchor="middle">${c}</text>`).join("")}
        <g transform="rotate(${(dir + 180) % 360} 32 32)"><path d="M32 13l6 10h-4v22h-4V23h-4z" fill="var(--wind-c)"/></g></svg>`));

    // 3. Court & rain: is the court dry, and when does rain come? Bars = chance of rain each hour.
    const n = Math.min(24, DATA.times.length - h);
    let total = 0;
    const bars = Array.from({ length: n }, (_, k) => {
      const i = h + k, p = rd.at("p", i) || 0, r = rd.at("r", i) || 0;
      total += r;
      return `<i style="height:${Math.max(4, p)}%" class="${r >= 0.01 ? "wet" : ""}" title="${fmtTime(DATA.times[i])}: ${round(p)}%"></i>`;
    }).join("");
    out.push(tile(`wide precip court-${court.band}`, TI.court, "Court & rain", court.head,
      `${round(rd.at("p", h)) || 0}% chance now · ${total >= 0.005 ? total.toFixed(2) : "0"}″ in the next ${n} h`, court.play,
      `<div class="pbars">${bars}</div><div class="mini-ends"><span>${fmtTime(DATA.times[h], true)}</span><span>Chance of rain each hour</span><span>+${n}h</span></div>`));

    // 4-9. Ball, heat, grip, air, sun, daylight.
    if (ball) out.push(tile("ballt", TI.ball, "Ball &amp; bounce", ball.head, `${t}° air`, ball.play));
    if (heat) out.push(tile("heat", TI.temp, "Heat &amp; body", heat.head, `Feels like ${f}°`, heat.play));
    if (grip) out.push(tile("grip", TI.drop, "Grip &amp; sweat", grip.head,
      [hu != null ? `${hu}% humidity` : "", dp != null ? `dew point ${dp}°` : ""].filter(Boolean).join(" · "), grip.play));
    if (air) {
      const pm = rd.at("pm25", h);
      out.push(tile("aqi", TI.leaf, "Air quality", `<span style="color:${air.color}">●</span> ${air.head}`,
        `AQI ${round(aqi)}${pm != null ? ` · PM2.5 ${round(pm)}` : ""}`, air.play,
        `<div class="aqbar"><i style="left:${Math.min(100, (aqi / 300) * 100)}%"></i></div>`));
    } else out.push(tile("aqi", TI.leaf, "Air quality", "—", "", wx ? "Not available here." : "Loading…"));
    // In the dark, the Daylight tile says it all: skip Sun & glare and let Daylight go full width.
    if (!sun.dark) out.push(tile("suntile", TI.sun, "Sun &amp; glare", sun.head, uv != null ? `UV ${Math.round(uv)}` : "", sun.play));

    const st = sunTimes(DATA.times[h].slice(0, 10), rd);
    if (st) {
      const r0 = hoursOf(st.rise), s0 = hoursOf(st.set), now = hr + (h === state.base ? new Date().getMinutes() / 60 : 0.5);
      const frac = Math.max(0, Math.min(1, (now - r0) / (s0 - r0)));
      const x = 10 + frac * 180, y = 70 - Math.sin(frac * Math.PI) * 55, left = s0 - now;
      let head, play;
      if (now < r0) { head = "Before sunrise"; play = `Light from ${clock(st.rise)}. Until then, lit courts only.`; }
      else if (left <= 0) { head = "After dark"; play = "Lit courts only."; }
      else {
        const hh = Math.floor(left), mm = Math.round((left - hh) * 60);
        head = hh ? `${hh} h ${mm} m left` : `${mm} min left`;
        play = left < 1 ? "Time for a quick hit, then lit courts only." : left < 1.75 ? "About a set's worth of light." : "Plenty of light for a match.";
      }
      out.push(tile(`sunt${sun.dark ? " wide" : ""}`, TI.rise, "Daylight", head, `Sunrise ${clock(st.rise)} · sunset ${clock(st.set)}`, play,
        `<svg class="arc" viewBox="0 0 200 80" aria-hidden="true">
          <path d="M10 70 Q100 -40 190 70" fill="none" stroke="var(--line)" stroke-width="2" stroke-dasharray="4 4"/>
          <path d="M0 70h200" stroke="var(--line)" stroke-width="1.5"/>
          ${DATA.is_day[h] ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="#ffc531"/>` : ""}</svg>`));
    }

    // 10. 10-day forecast: a tennis word per day, rain chance, and each day's low-high range on a shared scale.
    if (wx && wx.f.daily) {
      const D = wx.f.daily, lo = Math.min(...D.temperature_2m_min), hi = Math.max(...D.temperature_2m_max), span = Math.max(1, hi - lo);
      const today = pacificHourStamp().slice(0, 10);
      const rows = D.time.map((d, i) => {
        const c = condition(D.weather_code[i], 1, D.precipitation_probability_max[i], (D.precipitation_sum[i] || 0) / 6);
        const a = ((D.temperature_2m_min[i] - lo) / span) * 100, b = ((D.temperature_2m_max[i] - lo) / span) * 100;
        const pp = D.precipitation_probability_max[i], [tb, tw] = dayTag(D, i);
        return `<li${d === today ? ' class="today"' : ""}><span class="dd">${d === today ? "Today" : dayWord(d)}<small class="tag ${tb}">${tw}</small></span>
          ${wxIcon(c.kind, true)}<span class="dp">${pp >= 20 ? `${pp}%` : ""}</span>
          <span class="dlo">${round(D.temperature_2m_min[i])}°</span>
          <span class="drange"><i style="left:${a.toFixed(1)}%;right:${(100 - b).toFixed(1)}%"></i></span>
          <span class="dhi">${round(D.temperature_2m_max[i])}°</span></li>`;
      }).join("");
      out.push(`<div class="tile wide days"><div class="tile-h">${TI.cal}<span>10-day tennis outlook</span></div><ul class="ten">${rows}</ul></div>`);
    } else out.push(`<div class="tile wide days"><div class="tile-h">${TI.cal}<span>10-day tennis outlook</span></div><div class="tile-note">Loading…</div></div>`);

    $("tiles").innerHTML = out.join("");
  }

  function renderPanel(scroll) { renderHero(); renderForYou(); renderHourly(scroll); renderTiles(); }

  // ---------- court card (the court's own details: links, crowd, votes, comments) ----------
  function select(id) {
    state.selected = id;
    render();   // draws the card first so we know how much map it covers
    // Desktop: bring the panel back to the top, where the court's weather now shows.
    // (Phones keep their scroll position, so tapping a pin doesn't jump away from the map.)
    if (innerWidth > 760) document.querySelector(".panel").scrollTo({ top: 0, behavior: "smooth" });
    const mk = markers.find((x) => x.ct.id === id);
    if (!mk) return;
    // Centre the court in the part of the map the card leaves visible:
    // above the card on phones (full-width sheet), right of it on desktop.
    const card = $("card"), wrap = map.getContainer();
    const fullWidth = card.offsetWidth > wrap.offsetWidth * 0.7;
    const padding = fullWidth
      ? { top: 0, left: 0, right: 0, bottom: Math.min(card.offsetHeight + 12, wrap.offsetHeight * 0.6) }
      : { top: 0, bottom: 0, right: 0, left: card.offsetWidth + 24 };
    map.easeTo({ center: [mk.ct.lon, mk.ct.lat], zoom: Math.max(map.getZoom(), 12.5), padding, duration: 600 });
  }

  // Hide: close the card so you see the court fade; the toast offers Undo. Unhide: stay on the court.
  function hideCourt(id, on) {
    const ct = DATA.courts.find((c) => c.id === id);
    if (!ct) return;
    setHidden(id, on);
    if (on && state.selected === id) closeCard(); else render();
    updateView();
    syncFilterControls();
    toast(on ? `<b>${esc(ct.name)}</b> is hidden. <a href="#" data-act="unhide" data-court="${id}">Undo</a>`
      : `<b>${esc(ct.name)}</b> is back on your map.`);
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
    const st = STATUS[ct.eff];
    const banner = st ? `<div class="status ${st.cls}"><b>${st.badge} ${st.label}</b>${ct.effNote ? ` · ${esc(ct.effNote)}` : ""}</div>` : "";
    // The card is rebuilt when the time or view changes; keep a half-written comment.
    const prev = card.dataset.court === ct.id && card.querySelector(".community");
    const typing = prev && prev.querySelector('form[data-act="comment"] input');
    const draft = typing && typing.value ? { text: typing.value, focused: document.activeElement === typing } : null;
    const keepScroll = card.dataset.court === ct.id ? card.scrollTop : 0;
    card.dataset.court = ct.id;
    const fav = community.favorites.has(ct.id), hid = isHidden(ct.id);
    const hiddenNote = hid ? '<div class="status hiddenc"><b>Hidden from your map</b> · faded, and left out of "best near you"</div>' : "";
    card.innerHTML = `
      <button class="x" aria-label="Close">×</button>
      ${sb ? `<button class="fav${fav ? " on" : ""}" data-act="fav" aria-pressed="${fav}" aria-label="${fav ? "Remove from" : "Add to"} your courts" title="${fav ? "In your courts" : "Add to your courts"}">${fav ? "★" : "☆"}</button>` : ""}
      <div class="head">${courtSvg(ct.eff === "closed" ? "closed" : b)}<div><h3>${ct.name}</h3><div class="muted small">${ct.city}${ct.type === "school" ? " · school courts, access varies" : ""}</div></div>
        ${ct.eff === "closed" ? "" : `<span class="card-score ${b}" title="${BAND[b].label} at ${fmtTime(DATA.times[h])}">${ct.s[h].toFixed(1)}</span>`}</div>
      ${banner}${hiddenNote}
      <div class="links">
        <a href="${mapsUrl(ct)}" target="_blank" rel="noopener">📍 Directions</a>
        <a href="${streetUrl(ct)}" target="_blank" rel="noopener">🚶 Street View</a>
        <button type="button" data-act="${hid ? "unhide" : "hide"}" title="${hid ? "Show this court normally again" : "Fade this court on your map"}">${hid ? "Unhide" : "Hide court"}</button>
      </div>
      ${sb ? crowdHtml(ct) : ""}
      ${communityHtml(ct)}`;
    card.hidden = false;
    card.scrollTop = keepScroll;
    card.querySelector(".x").addEventListener("click", closeCard);
    if (draft) {   // the card was rebuilt mid-comment: put the half-typed comment back
      const input = card.querySelector('form[data-act="comment"] input');
      if (input) { input.value = draft.text; if (draft.focused) input.focus(); }
    }
    loadCourt(ct.id);
  }

  // ---------- legend + list ----------
  function renderLegend() {
    const B = DATA.bands;
    const rgba = (c, a) => `rgb(${c.join(" ")} / ${a})`;
    const sw = (bg, text) => `<span><b class="sw" style="background:${bg}"></b>${text}</span>`;
    const ramp = (c) => `linear-gradient(90deg, ${rgba(c, 0.12)}, ${rgba(c, 0.55)})`;
    let html;
    if (state.layer === "play") {
      html = `<div class="keys"><span><i style="background:${PAL.play}"></i>Play</span><span><i style="background:${PAL.iffy}"></i>Iffy</span><span><i style="background:${PAL.skip}"></i>Skip</span></div>
        <div class="keys">${sw(rgba(RAIN_RGB, 0.5), "Rain")}${sw(rgba(WIND_RGB, 0.5), "Wind")}${sw(rgba(BOTH_RGB, 0.5), "Both")}</div>`;
    } else if (state.layer === "wind") {
      html = `<div class="keys"><span><i style="background:${PAL.play}"></i>0–${B.wind_iffy - 1}</span><span><i style="background:${PAL.iffy}"></i>${B.wind_iffy}–${B.wind_skip - 1}</span><span><i style="background:${PAL.skip}"></i>${B.wind_skip}+ mph gusts</span></div>
        <div class="bar" style="background:${ramp(WIND_RGB)}"></div>`;
    } else {
      html = `<div class="bar" style="background:${ramp(RAIN_RGB)}"></div>
        <div class="ends"><span>likely</span><span>sprinkle</span><span>heavy</span></div>`;
    }
    $("legend").innerHTML = html;
  }

  // Your ★ courts (the only list now; the map is how you find courts).
  function listItem(c, h) {
    const closed = c.eff === "closed", b = closed ? "closed" : c.b[h];
    const cond = condition(c.wc ? c.wc[h] : null, DATA.is_day[h], c.p[h], c.r[h]);
    const why = c.why[h].length ? c.why[h].join(" · ") : `Gusts ${c.g[h]} mph · ${c.p[h]}% rain`;
    const live = liveReport(c.id);
    const crowd = live && live.key ? `<span class="crowdtag ${live.cls}">${live.short} · ${ago(live.at)}</span> ` : "";
    return `<li tabindex="0" data-id="${c.id}">${courtSvg(b)}
      <div><div class="name">${c.name}</div><div class="sub">${crowd}${c.city} · ${closed ? "Not playable" : `${c.eff === "poor" ? "⚠ Rough court · " : ""}${why}`}</div></div>
      <span class="li-wx">${wxIcon(cond.kind, DATA.is_day[h])}${c.t[h]}°</span>
      <span class="num ${b}" aria-label="${closed ? "Not playable" : `${BAND[b].label}, score`}">${closed ? "—" : c.s[h].toFixed(1)}</span></li>`;
  }
  function renderList() {
    const h = state.hour;
    const favs = DATA.courts.filter((c) => community.favorites.has(c.id)).sort((a, b) => b.s[h] - a.s[h] || a.name.localeCompare(b.name));
    $("favWrap").hidden = !favs.length;
    $("favList").innerHTML = favs.map((c) => listItem(c, h)).join("");
  }

  function render(scrollHourly) {
    applyStatuses();
    renderWeather();
    renderMarkers();
    renderCard();
    renderLegend();
    renderList();
    renderPanel(scrollHourly);
  }

  function setHour(h, fromStrip) {
    state.hour = Math.max(state.base, Math.min(DATA.times.length - 1, h));
    render(!fromStrip);
    saveHash();
  }

  function showUpdated() {
    const gen = new Date(DATA.generated_utc.replace("Z", ":00Z"));
    const ageH = (Date.now() - gen) / 3.6e6;
    const when = gen.toLocaleString("en-US", { timeZone: PT, weekday: "short", hour: "numeric", minute: "2-digit" });
    $("updated").textContent = ageH > 4 ? `⚠ Forecast is ${Math.floor(ageH)} hours old (updated ${when} PT)` : `Forecast updated ${when} PT`;
  }

  // Every 30 s: keep the clock live and move "now" forward when the hour turns over.
  function tick() {
    const nb = nowIndex();
    if (nb !== state.base) {
      const followingNow = state.hour === state.base;
      state.base = nb;
      if (followingNow || state.hour < nb) state.hour = nb;
      render();
      saveHash();
    } else if (state.hour === state.base) {
      renderHero();   // the "Now · 7:41 AM" clock
    }
    showUpdated();
  }

  // Every 15 min (and when a phone comes back to the tab): pick up a newer forecast.
  async function refreshData() {
    try {
      const d = await (await fetch("data/forecast.json", { cache: "no-cache" })).json();
      if (d.generated_utc === DATA.generated_utc) return;
      const keep = DATA.times[state.hour];
      DATA = hydrate(d);
      markers.forEach((mk) => { const c = d.courts.find((x) => x.id === mk.ct.id); if (c) mk.ct = c; });
      buildWeather();
      buildRegion();
      state.base = nowIndex();
      const i = DATA.times.indexOf(keep);
      state.hour = Math.max(state.base, i >= 0 ? i : state.base);
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

  // ---------- default view + "show all courts" button ----------
  // The whole forecast region (Malibu to Riverside, Newport Beach to the San Fernando Valley), with a margin.
  const HOME_BOUNDS = [[-118.72, 33.54], [-117.28, 34.33]];
  const homePadding = () => (innerWidth < 760 ? 12 : 30);
  // The ⛶ button zooms out to everything the filter shows: your ★ courts, your radius, or the region.
  function goHome() {
    const mode = filterMode();
    if (mode === "fav") fitTo(favArea().bounds, FAV_MAX_ZOOM, homePadding() + 40);
    else if (mode === "near") fitTo(circleBounds(ME.pos, filt.radius));
    else fitTo(HOME_BOUNDS, 22);
  }
  class HomeControl {
    onAdd() {
      this.el = document.createElement("div");
      this.el.className = "maplibregl-ctrl maplibregl-ctrl-group";
      this.el.innerHTML = `<button type="button" class="home-btn" title="Show all my courts" aria-label="Zoom out to show all the courts you've chosen to see">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 8V3h5M17 8V3h-5M3 12v5h5M17 12v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
      this.el.querySelector("button").addEventListener("click", (e) => { e.stopPropagation(); goHome(); });
      return this.el;
    }
    onRemove() { this.el.remove(); }
  }

  // ---------- "For you": a greeting and your next good time to play ----------
  // Looks at your ★ courts (or the 3 nearest you) for the soonest two daylight hours in a row that
  // suit you: in the times you play, and either good to play on the map's own rating, or held back
  // only by wind you said you'll play in.
  const hourOfDay = (h) => Number(DATA.times[h].slice(11, 13));
  // Wind's share of the score, the same ramps as courtcast/config.py (GUSTS and WIND). Keep in step.
  const ramp = (v, start, full, max) => max * clamp01((v - start) / (full - start));
  const windPenalty = (g, w) => ramp(g, 12, 32, 7) + ramp(w, 8, 22, 4);
  function goodForYou(ct, h) {
    if (!DATA.is_day[h]) return false;
    const hr = hourOfDay(h);
    if (prefs.times.length && !prefs.times.some((k) => hr >= PLAY_TIMES[k].from && hr < PLAY_TIMES[k].to)) return false;
    if (ct.b[h] === "play") return "play";
    if (prefs.wind === "calm") return false;
    const lim = WIND_PREF[prefs.wind], why = ct.why[h] || [], g = ct.g[h], w = ct.w[h], s = ct.s[h];
    if (!why.length || !why.every((r) => /^(Gusts|Wind) /.test(r)) || g > lim.gust || w > lim.wind) return false;
    // The reasons only list the two biggest penalties. Check nothing else took a real bite: at the
    // wind cap (6.9) the rest of the score is fine; below it, what wind doesn't explain must be small.
    return s >= DATA.bands.play - 0.15 || 10 - windPenalty(g, w) - s < 0.75 ? "wind" : false;
  }
  function nextGoodTime() {
    const favs = DATA.courts.filter((c) => community.favorites.has(c.id));
    const pool = (favs.length ? favs : ME.pos ? nearestCourts(ME.pos.lat, ME.pos.lon).map((x) => x.c) : [])
      .filter((c) => c.eff !== "closed" && !isHidden(c.id));
    if (!pool.length) return null;
    for (let h = state.base; h < DATA.times.length - 1; h++) {
      let best = null;
      pool.forEach((c) => {
        const a = goodForYou(c, h), b = a && goodForYou(c, h + 1);
        if (b && (!best || c.s[h] + c.s[h + 1] > best.c.s[h] + best.c.s[h + 1])) {
          best = { c, h, breezy: a === "wind" || b === "wind" };
        }
      });
      if (best) return best;
    }
    return { none: true, favs: !!favs.length };
  }
  function windowText(h) {
    const a = hourOfDay(h), b = (a + 2) % 24, ap = (x) => (x < 12 ? "AM" : "PM"), t = (x) => x % 12 || 12;
    if (h === state.base) return `Now until ${t(b)} ${ap(b)}`;
    const span = ap(a) === ap(b) ? `${t(a)}–${t(b)} ${ap(b)}` : `${t(a)} ${ap(a)}–${t(b)} ${ap(b)}`;
    return `${dayWord(DATA.times[h].slice(0, 10))} ${span}`;
  }
  function greeting() {
    const hr = Number(pacificHourStamp().slice(11, 13));
    return hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";
  }
  function myFirstName() {
    if (community.user) { const n = firstName(); return n === "Player" ? "" : n; }
    return prefs.name.split(" ")[0];
  }
  function renderForYou() {
    const el = $("forYou");
    if (!el || !DATA) return;
    const name = myFirstName(), ng = nextGoodTime();
    if (!name && !ng && !store.get("cc-onboarded")) { el.hidden = true; return; }
    let main;
    if (!ng) {
      main = `<div class="fy-main">☆ Star a court${navigator.geolocation ? ' or <button type="button" class="link" data-act="useloc">use your location</button>' : ""} to see your next good time to play.</div>`;
    } else if (ng.none) {
      main = `<div class="fy-main">No good two-hour stretch at ${ng.favs ? "your ★ courts" : "the courts near you"} in the next ${DATA.times.length - state.base} hours${prefs.times.length ? ", at the times you play" : ""}.</div>`;
    } else {
      const c = ng.c, s = c.s[ng.h], gust = Math.round(Math.max(c.g[ng.h], c.g[ng.h + 1]));
      main = `<div class="fy-label">Your next good time</div>
        <div class="fy-main"><b>${windowText(ng.h)}</b> at <button type="button" class="link" data-court="${c.id}">${esc(c.name)}</button>
          <span class="fy-score ${c.b[ng.h]}">${s.toFixed(1)}</span></div>
        ${ng.breezy ? `<div class="fy-note">Breezy, gusts to ${gust} mph: within what you said you'll play in.</div>` : ""}`;
    }
    const when = prefs.times.length ? prefs.times.map((k) => PLAY_TIMES[k].label).join(", ") : "Any daylight hour";
    el.hidden = false;
    el.innerHTML = `${name ? `<div class="fy-hi">${greeting()}, ${esc(name)}</div>` : ""}${main}
      <div class="fy-sub">${esc(when)} · ${esc(WIND_PREF[prefs.wind].label.toLowerCase())} · <button type="button" class="link" data-act="personalize">Change</button></div>`;
  }

  // ---------- welcome: a short, skippable setup on the first visit ----------
  // 1 text size · 2 your courts · 3 how you play · 4 your name, and an invitation to sign up.
  // Nothing is required: every screen can be skipped, and guests get the whole app.
  const WEL_STEPS = 4;
  const wel = { step: 0, center: null, label: "", typed: "", busy: false, msg: "" };
  // Someone who used CourtCast before this setup existed: don't make them sit through it.
  function returningVisitor() {
    try { return Object.keys(localStorage).some((k) => /^(cc-(useloc|near|radius|hidden|schools|favonly|autocheck)$|sb-)/.test(k)); } catch (_) { return false; }
  }
  function maybeWelcome() {
    if (!FORCE_WELCOME) {
      if (store.get("cc-onboarded") || LANDED.code || LANDED.reset || LANDED.error) return;
      if (returningVisitor()) { store.set("cc-onboarded", "returning"); return; }
      if (state.selected) return;   // came from a link to a court: show the court, set up next visit
    }
    openWelcome(0);
  }
  function openWelcome(step = 0) {
    if ($("settings").open) $("settings").close();
    wel.step = step;
    wel.msg = "";
    if (ME.pos) { wel.center = ME.pos; wel.label = ME.name; }
    renderWelcome();
    if (!$("welcome").open) $("welcome").showModal();
    const nx = $("welcomeBody").querySelector('[data-w="next"]');
    if (nx) nx.focus();   // Enter moves on (focus would otherwise land on "Skip setup")
    track("welcome_step", { step: step + 1 });
  }
  function finishWelcome(how) {
    const first = $("welcomeBody").querySelector('[name="first"]');
    if (first) setPrefs({ name: first.value.trim().slice(0, 40) });
    store.set("cc-onboarded", how === "skip" ? "skipped" : "done");
    setPrefs({});
    track(how === "skip" ? "welcome_skip" : "welcome_done",
      { step: wel.step + 1, favorites: community.favorites.size, located: !!ME.pos, text_size: prefs.text });
    if ($("welcome").open) $("welcome").close();
    render();
    // Open the map on what they just picked.
    const fa = favArea();
    if (fa) fitTo(fa.bounds, FAV_MAX_ZOOM, homePadding() + 40);
    else if (ME.pos) goHome();
  }
  function welcomeCourtsHtml() {
    if (!wel.center) return "";
    const near = nearestCourts(wel.center.lat, wel.center.lon, 6);
    return `<h3>Tap ☆ to save your courts${wel.label ? ` near ${esc(wel.label)}` : ""}</h3>
      <ul class="wcourts">${near.map(({ c, m }) => {
        const on = community.favorites.has(c.id);
        return `<li><button type="button" data-wfav="${c.id}" aria-pressed="${on}"><span class="star" aria-hidden="true">${on ? "★" : "☆"}</span>
          <span class="wc-txt"><b>${esc(c.name)}</b><span class="muted small">${esc(c.city)} · ${(m / MI).toFixed(1)} mi</span></span></button></li>`;
      }).join("")}</ul>
      <p class="muted small fine">${community.user ? "Saved to your account." : "Saved on this device. No account needed."}</p>`;
  }
  function renderWelcome() {
    const s = wel.step;
    const dots = `<div class="wdots" role="img" aria-label="Step ${s + 1} of ${WEL_STEPS}">${Array.from({ length: WEL_STEPS },
      (_, i) => `<span class="${i === s ? "on" : i < s ? "done" : ""}"></span>`).join("")}</div>`;
    let body, next = "Next";
    if (s === 0) {
      const ex = DATA.courts.filter((c) => c.type !== "school" && c.eff !== "closed")
        .sort((a, b) => b.s[state.base] - a.s[state.base])[0];
      const exBand = ex.b[state.base];
      body = `<h2>Welcome to CourtCast 🎾</h2>
        <p class="sub">Tennis weather for 850+ public courts in Southern California. Let's set it up for you. It takes under a minute.</p>
        <h3>Pick a comfortable text size</h3>
        <div class="textpick" role="group" aria-label="Text size">${Object.entries(TEXT_SIZES).map(([k, v]) =>
          `<button type="button" data-text="${k}" aria-pressed="${prefs.text === k}"><span class="aa aa-${k}" aria-hidden="true">Aa</span>${v}</button>`).join("")}</div>
        <div class="wpreview" aria-hidden="true">${courtSvg(exBand)}
          <span class="wc-txt"><b>${esc(ex.name)}</b><span class="muted small">${esc(ex.city)} · ${esc(BAND[exBand].label)} right now</span></span>
          <span class="fy-score ${exBand}">${ex.s[state.base].toFixed(1)}</span></div>
        <p class="muted small fine">Change it any time in ⚙ Settings.</p>`;
    } else if (s === 1) {
      // Location may have arrived after the setup opened (allowed on an earlier visit): use it.
      if (!wel.center && ME.pos) { wel.center = ME.pos; wel.label = ME.name; }
      const cities = [...new Set(DATA.courts.map((c) => c.city))].sort();
      body = `<h2>Where do you play?</h2>
        <p class="sub">We'll show the courts near you first.</p>
        ${navigator.geolocation ? `<button type="button" class="primary" data-w="locate"${wel.busy ? " disabled" : ""}>${
          wel.busy ? "Finding you…" : ME.pos ? `📍 Using your location${ME.name ? ` · ${esc(ME.name)}` : ""}` : "📍 Use my location"}</button>
        <p class="muted small fine">To find courts and weather near you. It's rounded to about 1 km and never stored by CourtCast. Turn it off any time in Settings.</p>
        <div class="or"><span>or</span></div>` : ""}
        <label class="wcity">Type your city<input name="city" list="wCities" autocomplete="off" placeholder="e.g. Pasadena" value="${esc(wel.typed)}"></label>
        <datalist id="wCities">${cities.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
        <div class="msg small" aria-live="polite">${esc(wel.msg)}</div>
        <div id="wCourts">${welcomeCourtsHtml()}</div>`;
    } else if (s === 2) {
      body = `<h2>How do you like to play?</h2>
        <p class="sub">We'll use this to find your next good time to play.</p>
        <h3>Wind</h3>
        <div class="wopts" role="radiogroup" aria-label="How much wind you'll play in">${Object.entries(WIND_PREF).map(([k, v]) =>
          `<button type="button" role="radio" data-wwind="${k}" aria-checked="${prefs.wind === k}"><b>${v.label}</b><span class="muted small">${v.sub}</span></button>`).join("")}</div>
        <h3>When do you usually play? <span class="muted small">Pick any</span></h3>
        <div class="wopts three">${Object.entries(PLAY_TIMES).map(([k, v]) =>
          `<button type="button" data-wtime="${k}" aria-pressed="${prefs.times.includes(k)}"><b>${v.label}</b><span class="muted small">${v.sub}</span></button>`).join("")}</div>`;
    } else {
      const canSign = !!sb && (community.googleReady || community.emailReady);
      if (community.user) {
        body = `<h2>You're all set${myFirstName() ? `, ${esc(myFirstName())}` : ""}</h2>
          <p class="sub">You're signed in, so your courts and settings are saved to your account.</p>`;
        next = "Done";
      } else {
        body = `<h2>What should we call you?</h2>
          <label class="wname">First name <span class="muted small">(optional)</span>
            <input name="first" maxlength="40" autocomplete="given-name" value="${esc(prefs.name)}"></label>
          ${canSign ? `<div class="savebox"><b>Save your setup with a free account</b>
            <ul><li>Your ★ courts and settings on every phone and computer</li><li>Comment on courts and rate their condition</li></ul>
            <button type="button" class="primary" data-w="signup">Create a free account</button>
            <button type="button" class="ghost wide" data-w="signin">I already have an account</button></div>` : ""}`;
        next = canSign ? "Continue as guest" : "Done";
      }
    }
    const last = s === WEL_STEPS - 1;
    $("welcomeBody").innerHTML = `<div class="whead">${dots}${last ? "" : '<button type="button" class="link wskip" data-w="skip">Skip setup</button>'}</div>
      ${body}
      <div class="wfoot">
        ${s > 0 ? '<button type="button" class="ghost" data-w="back">Back</button>' : "<span></span>"}
        <button type="button" class="${last && next !== "Done" ? "ghost" : "primary"}" data-w="next" autofocus>${next}${last ? "" : " ›"}</button>
      </div>`;
  }
  async function onWelcomeClick(e) {
    const t = e.target.closest("[data-w], [data-text], [data-wfav], [data-wwind], [data-wtime]");
    if (!t) return;
    const body = $("welcomeBody");
    if (t.dataset.text) {   // aria-pressed on every text-size button updates in applyTextSize()
      setPrefs({ text: t.dataset.text });
      track("text_size", { size: t.dataset.text, from: "welcome" });
    } else if (t.dataset.wfav) {
      await toggleFavorite(t.dataset.wfav, { quiet: true });
      $("wCourts").innerHTML = welcomeCourtsHtml();
    } else if (t.dataset.wwind) {
      setPrefs({ wind: t.dataset.wwind });
      body.querySelectorAll("[data-wwind]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.wwind === prefs.wind)));
    } else if (t.dataset.wtime) {
      const k = t.dataset.wtime, on = prefs.times.includes(k);
      setPrefs({ times: on ? prefs.times.filter((x) => x !== k) : [...prefs.times, k].sort((a, b) => Object.keys(PLAY_TIMES).indexOf(a) - Object.keys(PLAY_TIMES).indexOf(b)) });
      t.setAttribute("aria-pressed", String(!on));
    } else if (t.dataset.w === "locate") {
      if (ME.pos) { wel.center = ME.pos; wel.label = ME.name; wel.typed = ""; renderWelcome(); return; }
      wel.busy = true; wel.msg = ""; renderWelcome();
      const ok = await quietLocate();
      wel.busy = false;
      if (ok && ME.pos) { wel.center = ME.pos; wel.label = ME.name; wel.typed = ""; track("welcome_location", { ok: true }); }
      else { wel.msg = "Couldn't get your location. Type your city instead."; track("welcome_location", { ok: false }); }
      if (wel.step === 1 && $("welcome").open) renderWelcome();
    } else if (t.dataset.w === "back") {
      wel.step = Math.max(0, wel.step - 1); renderWelcome();
    } else if (t.dataset.w === "next") {
      if (wel.step === WEL_STEPS - 1) { finishWelcome("done"); return; }
      wel.step += 1; renderWelcome();
      track("welcome_step", { step: wel.step + 1 });
    } else if (t.dataset.w === "skip") {
      finishWelcome("skip");
    } else if (t.dataset.w === "signup" || t.dataset.w === "signin") {
      track("signup_prompt", { from: "welcome", choice: t.dataset.w });
      finishWelcome("done");
      openAccount(t.dataset.w);
    }
  }
  // Typing a city: once it matches one of the court cities, list the courts there (no lookup service needed).
  function onWelcomeInput(e) {
    if (e.target.name !== "city") return;
    wel.typed = e.target.value;
    const v = wel.typed.trim().toLowerCase();
    const cs = v ? DATA.courts.filter((c) => c.city.toLowerCase() === v) : [];
    if (!cs.length) return;
    const avg = (k) => cs.reduce((a, c) => a + c[k], 0) / cs.length;
    wel.center = { lat: avg("lat"), lon: avg("lon") };
    wel.label = cs[0].city;
    $("wCourts").innerHTML = welcomeCourtsHtml();
  }

  // ---------- settings ----------
  function openSettings() {
    applyTextSize();
    $("schools").checked = state.schools;
    $("setUseloc").checked = !!ME.pos;
    $("setUseloc").disabled = !navigator.geolocation;
    $("setAutocheck").checked = autoCheckOn();
    syncFilterControls();
    $("settings").showModal();
  }
  function syncFilterControls() {
    $("setNear").checked = filt.near;
    $("setNear").disabled = !navigator.geolocation;
    $("setRadius").value = filt.radius;
    $("radiusOut").textContent = `${filt.radius} mi`;
    $("radiusRow").hidden = !filt.near;
    $("setFavOnly").checked = filt.favOnly;
    const n = hiddenCourts.size;
    $("hiddenCount").textContent = n ? `${n} court${n === 1 ? "" : "s"} faded on your map (this browser)` : "None. Hide a court from its card.";
    $("unhideAll").hidden = !n;
  }

  // ---------- wiring ----------
  function wire() {
    document.querySelectorAll(".seg button").forEach((btn) => btn.addEventListener("click", () => {
      setLayer(btn.dataset.layer); render(); saveHash();
    }));
    $("schools").addEventListener("change", (e) => {
      state.schools = e.target.checked;
      viewKey = "";
      store.set("cc-schools", state.schools ? "on" : "off");
      render(); saveHash(); updateView();
    });
    $("settingsBtn").addEventListener("click", openSettings);
    // Text size: the buttons in Settings (the welcome screen has its own copy of them).
    $("settings").querySelectorAll("button[data-text]").forEach((b) => b.addEventListener("click", () => {
      setPrefs({ text: b.dataset.text });
      track("text_size", { size: b.dataset.text, from: "settings" });
    }));
    $("rerunWelcome").addEventListener("click", () => openWelcome(0));
    $("welcome").addEventListener("click", onWelcomeClick);
    $("welcome").addEventListener("input", onWelcomeInput);
    $("welcome").addEventListener("cancel", (e) => { e.preventDefault(); finishWelcome("skip"); });   // Esc = skip
    $("forYou").addEventListener("click", (e) => {
      const t = e.target.closest("[data-court], [data-act]");
      if (!t) return;
      if (t.dataset.court) { select(t.dataset.court); saveHash(); }
      else if (t.dataset.act === "personalize") openWelcome(1);
      else if (t.dataset.act === "useloc") useMyLocation();
    });
    $("filterChip").addEventListener("click", openSettings);
    $("unhideAll").addEventListener("click", () => {
      [...hiddenCourts].forEach((id) => setHidden(id, false));
      syncFilterControls(); render(); updateView();
    });
    // Which courts show. Changing a setting zooms to the courts it now shows.
    $("setNear").addEventListener("change", (e) => {
      filt.near = e.target.checked;
      store.set("cc-near", filt.near ? "on" : "off");
      syncFilterControls();
      if (filt.near && !ME.pos) { useMyLocation(); return; }   // it starts once we know where you are
      applyFilter(filt.near && filterMode() === "near");
    });
    $("setRadius").addEventListener("input", (e) => {   // while dragging: redraw the ring and courts
      filt.radius = Number(e.target.value);
      $("radiusOut").textContent = `${filt.radius} mi`;
      applyFilter(false);
    });
    $("setRadius").addEventListener("change", () => {   // let go: remember it and fit the ring
      store.set("cc-radius", String(filt.radius));
      if (filterMode() === "near") goHome();
    });
    $("setFavOnly").addEventListener("change", (e) => {
      filt.favOnly = e.target.checked;
      store.set("cc-favonly", filt.favOnly ? "on" : "off");
      if (filt.favOnly && !community.favorites.size) {
        toast("No ★ courts yet. Tap ☆ on a court to add it.");
      }
      applyFilter(filterMode() !== "all");
    });
    $("settings").addEventListener("click", (e) => {
      if (e.target === $("settings") || e.target.closest('[data-act="close"]')) $("settings").close();
    });
    $("setUseloc").addEventListener("change", (e) => { if (e.target.checked) useMyLocation(); else stopUsingLocation(); });
    $("setAutocheck").addEventListener("change", (e) => {
      store.set("cc-autocheck", e.target.checked ? "on" : "off");
      if (e.target.checked) autoLocate(true);
    });
    // Hourly strip: tap an hour; arrow keys step through hours.
    $("hourly").addEventListener("click", (e) => {
      const b = e.target.closest(".hr[data-h]");
      if (b) setHour(Number(b.dataset.h), true);
    });
    $("hourly").addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      setHour(state.hour + (e.key === "ArrowRight" ? 1 : -1));
      const sel = $("hourly").querySelector(".hr.sel");
      if (sel) sel.focus();
    });
    // Hero buttons: back to all courts / back to now.
    $("hero").addEventListener("click", (e) => {
      const t = e.target.closest("[data-act], [data-court]");
      if (!t) return;
      if (t.dataset.court) { select(t.dataset.court); saveHash(); }
      else if (t.dataset.act === "all") closeCard();
      else if (t.dataset.act === "now") setHour(state.base);
      else if (t.dataset.act === "useloc") useMyLocation();
    });
    setInterval(tick, 30 * 1000);
    setInterval(refreshData, 15 * 60 * 1000);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      tick(); refreshData();
      if (sb) { loadActivity(); autoLocate(); }   // back on the phone: fresh reports, maybe you're at a court now
    });
    $("card").addEventListener("click", onCommunityClick);    // vote / delete / favorite / report, inside the court card
    $("card").addEventListener("submit", onCommentSubmit);    // post a comment
    $("toast").addEventListener("click", onCommunityClick);   // the "you're at a court" prompt
    $("acct").addEventListener("click", onAccountClick);      // sign in / create account / profile
    $("acct").addEventListener("submit", onAccountSubmit);
    $("acctBtn").addEventListener("click", () => openAccount());
    if (sb && navigator.geolocation) {
      $("locateBtn").hidden = false;
      $("locateBtn").addEventListener("click", () => locate(true));
    }
    const pick = (e) => { const li = e.target.closest("li"); if (li) { select(li.dataset.id); saveHash(); } };
    $("favList").addEventListener("click", pick);
    $("favList").addEventListener("keydown", (e) => { if (e.key === "Enter") pick(e); });
    map.on("click", () => { if (state.selected) closeCard(); });   // tap the map (not a court) to close the card
    map.on("moveend", () => { renderPins(); updateView(); });   // pins and the weather panel follow the map
    map.on("movestart", (e) => { if (e.originalEvent) cameraTouched = true; });   // the player moved it: leave it be
    // Names appear once you're zoomed in (numbers are always on the courts).
    const names = () => map.getContainer().classList.toggle("show-names", map.getZoom() >= 12.5);
    map.on("zoom", names);
    names();
  }

  function start() {
    PAL = {
      play: css("--play"), iffy: css("--iffy"), skip: css("--skip"), closed: css("--muted"),
      iffyRGB: hex(css("--iffy")), skipRGB: hex(css("--skip")),
    };
    buildRegion();
    map = new maplibregl.Map({
      container: "map",
      style: STYLE_URL,
      bounds: HOME_BOUNDS,
      fitBoundsOptions: { padding: homePadding() },
      attributionControl: { compact: true, customAttribution: 'Forecast: <a href="https://open-meteo.com/">Open-Meteo</a>' },
      dragRotate: false,
      pitchWithRotate: false,
      // Phones: one finger scrolls the page past the map; two fingers move it (like Google Maps embeds).
      cooperativeGestures: matchMedia("(max-width: 760px)").matches,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new HomeControl(), "top-right");
    addGeolocate();
    map.touchZoomRotate.disableRotation();
    map.on("error", (e) => console.warn("map:", e.error && e.error.message));
    map.on("idle", () => { document.body.dataset.mapReady = "1"; });  // lets tests know rendering finished
    // Start the map credits (the ⓘ button) collapsed. MapLibre opens them on wide
    // screens; they stay one tap away, which keeps the required attribution.
    const collapseCredits = () => {
      const el = map.getContainer().querySelector(".maplibregl-ctrl-attrib");
      if (el) { el.classList.remove("maplibregl-compact-show"); el.removeAttribute("open"); }
    };
    map.once("load", collapseCredits);
    map.once("idle", collapseCredits);
    // "style.load" fires once the style is ready; "load" would also wait for every
    // tile, which on a slow phone connection delays the court list for no reason.
    map.once("style.load", () => {
      softenBasemap();
      buildWeather();
      buildMarkers();
      state.base = state.hour = nowIndex();
      state.schools = store.get("cc-schools") === "on";   // remembered setting; a shared link can still turn it on
      $("schools").checked = state.schools;
      wire();
      readHash();
      render(true);
      if (state.selected) select(state.selected);
      initCommunity();   // reviews load after the map, so they never slow down the forecast
      openHome();        // your ★ courts or your area, not all of SoCal
      applyTextSize();   // (already applied in <head>; this marks the right Settings button)
      maybeWelcome();    // first visit: the short setup
    });
  }

  fetch("data/forecast.json", { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((d) => {
      DATA = hydrate(d);
      showUpdated();
      start();
    })
    .catch((err) => { $("updated").textContent = `Couldn't load the forecast (${err.message}).`; });
})();
