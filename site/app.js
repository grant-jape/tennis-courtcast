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
    if (!sb) return;
    try {   // Each sign-in option appears once it's switched on in Supabase (no code change needed).
      const ext = (await (await fetch(`${SB_URL}/auth/v1/settings`, { headers: { apikey: SB_KEY } })).json()).external || {};
      community.googleReady = !!ext.google;
      community.emailReady = !!ext.email;
    } catch (_) { /* offline: the community parts stay read-only */ }
    const { data } = await sb.auth.getSession();
    community.user = (data.session && data.session.user) || null;
    await loadMine();
    sb.auth.onAuthStateChange((event, session) => {
      const before = community.user && community.user.id;
      community.user = (session && session.user) || null;
      if (event === "PASSWORD_RECOVERY") setTimeout(() => openAccount("reset"), 0);
      if ((community.user && community.user.id) !== before) {
        community.comments.clear(); community.myVote.clear(); community.stats = null;
        // Supabase asks us not to call it from inside this callback, so load on the next tick.
        setTimeout(async () => { await loadMine(); renderAcctBtn(); renderMarkers(); renderList(); renderCard(); }, 0);
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
    if (!u) { community.profile = null; community.favorites = new Set(); return; }
    const [p, f] = await Promise.all([
      sb.from("profiles").select("display_name,created_at").eq("id", u.id).maybeSingle(),
      sb.from("favorite_courts").select("court_id").eq("user_id", u.id),
    ]);
    community.profile = p.data || null;
    community.favorites = new Set((f.data || []).map((r) => r.court_id));
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
    const google = community.googleReady
      ? `<button type="button" class="gbtn" data-act="google">${GOOGLE_G}<span>Continue with Google</span></button>` : "";
    const or = google && community.emailReady ? '<div class="or"><span>or</span></div>' : "";
    const field = (label, name, type, auto, extra = "") =>
      `<label>${label}<input name="${name}" type="${type}" autocomplete="${auto}" required ${extra}></label>`;
    let html;
    if (m === "signin" || m === "signup") {
      const up = m === "signup";
      html = `<h2>${up ? "Create your account" : "Sign in"}</h2>
        <p class="muted small sub">${up ? "Save favorite courts, vote, comment, and report open courts." : "Welcome back to CourtCast."}</p>
        ${note}${google}${or}
        ${community.emailReady ? `<form data-form="${m}" novalidate>
          ${up ? field("Name", "name", "text", "name", 'maxlength="40"') : ""}
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
        <div class="muted small fine">How we use your info: <a href="privacy.html">Privacy</a></div>`;
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
        <h3>Settings</h3>
        <label class="check"><input type="checkbox" data-act="autocheck" ${autoCheckOn() ? "checked" : ""}>
          <span>When I open CourtCast at a court, ask how many courts are open <span class="muted small">(only if you've allowed location)</span></span></label>
        <div class="msg small" aria-live="polite"></div>
        <div class="pfoot">
          <button type="button" class="ghost" data-act="signout">Sign out</button>
          <button type="button" class="danger" data-act="delete">${acct.confirmDelete ? "Tap again to delete everything" : "Delete account"}</button>
        </div>
        <div class="muted small fine"><a href="privacy.html">Privacy</a></div>`;
    }
    $("acctBody").innerHTML = html;
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
  async function toggleFavorite(id) {
    if (!community.user) { openAccount("signin", "Sign in to save your favorite courts."); return; }
    const on = community.favorites.has(id);
    const flip = () => { if (on) community.favorites.add(id); else community.favorites.delete(id); };
    if (on) community.favorites.delete(id); else community.favorites.add(id);   // show it right away
    renderMarkers(); renderList(); renderCard();
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
    if (!t || !sb || t.tagName === "FORM") return;
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
    } else if (act === "fav") {
      await toggleFavorite(courtId);
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
    const lats = [...new Set(DATA.grid.cells.map((c) => c.lat))].sort((a, b) => a - b);
    const lons = [...new Set(DATA.grid.cells.map((c) => c.lon))].sort((a, b) => a - b);
    const byKey = new Map(DATA.grid.cells.map((c) => [`${c.lat},${c.lon}`, c]));
    const px = 24;                                    // canvas pixels per grid step
    const W = (lons.length - 1) * px + 1, H = (lats.length - 1) * px + 1;
    weather = {
      lats, lons, W, H,
      rows: lats.map((la) => lons.map((lo) => byKey.get(`${la},${lo}`))),
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
    if (ct.eff === "closed") return "Closed";
    const warn = ct.eff === "poor" ? "⚠ " : "";
    if (state.layer === "wind") return `${warn}${ct.g[h]} mph`;
    if (state.layer === "rain") return warn + (ct.r[h] > 0 ? `${ct.r[h].toFixed(2)} in` : `${ct.p[h]}%`);
    return warn + (ct.s[h] >= 10 ? "10" : ct.s[h].toFixed(1));
  }

  // How notable a court is for the current view; higher sits on top when markers overlap.
  function notability(ct, h) {
    if (ct.id === state.selected) return 1e6;
    if (ct.eff === "closed") return 0;                 // closed courts sink under the others
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
      // A closed court is gray with a ✕ whatever the weather.
      const b = ct.eff === "closed" ? "closed" : state.layer === "wind" && ct.wb ? ct.wb[h] : ct.b[h];
      el.classList.toggle("selected", state.selected === ct.id);
      el.setAttribute("aria-label", ct.eff === "closed" ? `${ct.name}: not playable` :
        `${ct.name}: ${BAND[b].label}, ${ct.s[h]} out of 10${ct.eff === "poor" ? ", rough court" : ""}`);
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
      // Sun or moon above each hour; the block keeps its playability colour either way.
      const day = DATA.is_day[i];
      strip.push(`<div><span class="dn ${day ? "sun" : "moon"}" title="${day ? "Daylight" : "After dark"}">${day ? SUN : MOON}</span><i class="${ct.b[i]}" title="${fmtTime(DATA.times[i])}: ${ct.s[i]}"></i>${fmtTime(DATA.times[i], true)}</div>`);
    }
    const st = STATUS[ct.eff];
    const banner = st ? `<div class="status ${st.cls}"><b>${st.badge} ${st.label}</b>${ct.effNote ? ` · ${esc(ct.effNote)}` : ""}</div>` : "";
    // The card is rebuilt when the time or view changes; keep a half-written review.
    const prev = card.dataset.court === ct.id && card.querySelector(".community");
    const typing = prev && prev.querySelector('form[data-act="comment"] input');
    const draft = typing && typing.value ? { text: typing.value, focused: document.activeElement === typing } : null;
    card.dataset.court = ct.id;
    const fav = community.favorites.has(ct.id);
    card.innerHTML = `
      <button class="x" aria-label="Close">×</button>
      ${sb ? `<button class="fav${fav ? " on" : ""}" data-act="fav" aria-pressed="${fav}" aria-label="${fav ? "Remove from" : "Add to"} your courts" title="${fav ? "In your courts" : "Add to your courts"}">${fav ? "★" : "☆"}</button>` : ""}
      <div class="head">${courtSvg(ct.eff === "closed" ? "closed" : b)}<div><h3>${ct.name}</h3><div class="muted small">${ct.city}${ct.type === "school" ? " · school courts, access varies" : ""}</div></div></div>
      ${banner}
      <div class="links">
        <a href="${mapsUrl(ct)}" target="_blank" rel="noopener">📍 Google Maps</a>
        <a href="${streetUrl(ct)}" target="_blank" rel="noopener">🚶 Street View</a>
      </div>
      ${ct.eff === "closed"
        // A closed court can't be "good to play" whatever the weather, so no score or best window.
        ? `<div class="verdict skip"><span class="face" aria-hidden="true">🚫</span>
            <div><strong>Not playable</strong><span class="muted small">Weather below is for reference only</span></div>
            <span class="score">—</span></div>`
        : `<div class="verdict ${b}"><span class="face" aria-hidden="true">${BAND[b].face}</span>
            <div><strong>${BAND[b].label}</strong><span class="muted small">${fmtTime(DATA.times[h])} · ${why}</span></div>
            <span class="score">${ct.s[h].toFixed(1)}<small>/10</small></span></div>`}
      <div class="facts">
        <span>${ICON.temp} ${ct.t[h]}°F</span>
        <span>${ICON.wind} ${ct.w[h]} mph, gusts ${ct.g[h]} · from ${compass(ct.d[h])}</span>
        <span>${ICON.rain} ${ct.p[h]}% chance${ct.r[h] > 0 ? ` · ${ct.r[h]}″` : ""}</span>
      </div>
      ${ct.eff === "closed" ? "" : `<div class="muted small">Next 12 hours</div>
      <div class="strip">${strip.join("")}</div>
      <div class="best">${bestWindow(ct, h)}</div>`}
      ${sb ? crowdHtml(ct) : ""}
      ${communityHtml(ct)}`;
    card.hidden = false;
    card.querySelector(".x").addEventListener("click", closeCard);
    if (draft) {   // the card was rebuilt mid-comment: put the half-typed comment back
      const input = card.querySelector('form[data-act="comment"] input');
      if (input) { input.value = draft.text; if (draft.focused) input.focus(); }
    }
    loadCourt(ct.id);
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
    const B = DATA.bands;
    const rgba = (c, a) => `rgb(${c.join(" ")} / ${a})`;
    const sw = (bg, text) => `<span><b class="sw" style="background:${bg}"></b>${text}</span>`;
    const rain = rgba(RAIN_RGB, 0.5), wind = rgba(WIND_RGB, 0.5);
    const both = rgba(BOTH_RGB, 0.5);
    const ramp = (c) => `linear-gradient(90deg, ${rgba(c, 0.12)}, ${rgba(c, 0.55)})`;
    let html;
    if (state.layer === "play") {
      html = `<div class="title">Playability score</div>
        <div class="keys"><span><i style="background:${PAL.play}"></i>Play</span><span><i style="background:${PAL.iffy}"></i>Iffy</span><span><i style="background:${PAL.skip}"></i>Skip it</span></div>
        <div class="keys">${sw(rain, "Rain")}${sw(wind, "Wind")}${sw(both, "Both")}</div>`;
    } else if (state.layer === "wind") {
      html = `<div class="title">Wind gusts</div>
        <div class="keys"><span><i style="background:${PAL.play}"></i>0–${B.wind_iffy - 1}</span><span><i style="background:${PAL.iffy}"></i>${B.wind_iffy}–${B.wind_skip - 1}</span><span><i style="background:${PAL.skip}"></i>${B.wind_skip}+ mph</span></div>
        <div class="bar" style="background:${ramp(WIND_RGB)}"></div>
        <div class="ends"><span>${B.wind_iffy} mph</span><span>${B.wind_skip}+ mph</span></div>`;
    } else {
      html = `<div class="title">Rain</div>
        <div class="bar" style="background:${ramp(RAIN_RGB)}"></div>
        <div class="ends"><span>likely</span><span>sprinkle</span><span>heavy</span></div>`;
    }
    $("legend").innerHTML = html;
  }

  function listItem(c, h) {
    const closed = c.eff === "closed", b = closed ? "closed" : c.b[h];
    const why = c.why[h].length ? c.why[h].join(" · ") : `Gusts ${c.g[h]} mph · ${c.p[h]}% rain · ${c.t[h]}°F`;
    const live = liveReport(c.id);
    const crowd = live && live.key ? `<span class="crowdtag ${live.cls}">${live.short} · ${ago(live.at)}</span> ` : "";
    return `<li tabindex="0" data-id="${c.id}">${courtSvg(b)}
      <div><div class="name">${c.name}</div><div class="sub">${crowd}${c.city} · ${closed ? "Not playable" : `${c.eff === "poor" ? "⚠ Rough court · " : ""}${why}`}</div></div>
      <span class="num" aria-label="${closed ? "Not playable" : `${BAND[b].label}, score`}">${closed ? "—" : c.s[h].toFixed(1)}</span></li>`;
  }

  function renderList() {
    const h = state.hour;
    const byScore = (a, b) => (a.eff === "poor") - (b.eff === "poor") ||   // rough courts sink
      b.s[h] - a.s[h] || a.g[h] - b.g[h] || a.name.localeCompare(b.name);
    // Your favorites first (whatever their state), then the best courts overall.
    const favs = DATA.courts.filter((c) => community.favorites.has(c.id)).sort(byScore);
    $("favWrap").hidden = !favs.length;
    $("favList").innerHTML = favs.map((c) => listItem(c, h)).join("");
    const items = DATA.courts
      .filter((c) => (state.schools || c.type !== "school") && c.eff !== "closed")   // not-playable courts aren't "best"
      .sort(byScore);
    $("listTitle").textContent = `Best courts · ${fmtTime(DATA.times[h])}`;
    $("list").innerHTML = items.map((c) => listItem(c, h)).join("");
  }

  function render() {
    applyStatuses();
    renderWeather();
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
      buildWeather();
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
    for (const id of ["list", "favList"]) {
      $(id).addEventListener("click", pick);
      $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") pick(e); });
    }
    map.on("click", () => { if (state.selected) closeCard(); });
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
      buildTimeline();
      wire();
      readHash();
      render();
      if (state.selected) select(state.selected);
      initCommunity();   // reviews load after the map, so they never slow down the forecast
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
