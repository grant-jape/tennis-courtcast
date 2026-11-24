/**
 * CourtCast weather proxy (Cloudflare Worker).
 *
 * The map's live detail (10-day forecast, feels like, UV, air quality) is fetched by each visitor's
 * browser. On Open-Meteo's paid plan those requests need the API key, and anything in app.js is
 * public. So the browser asks this Worker instead; the Worker adds the key (a Cloudflare secret),
 * forwards the request to Open-Meteo's commercial endpoints, and caches each answer for 30 minutes,
 * so many visitors near the same courts cost one call.
 *
 * Guard rails: only the two paths CourtCast uses, only GET, only from CourtCast's own pages
 * (browser Origin), and only for points inside the CourtCast area, so the key isn't useful to anyone
 * else. Without the secret it answers 503 and the map keeps showing the build's numbers.
 *
 * Setup (Cloudflare dashboard), once the Open-Meteo subscription exists:
 *   1. Workers & Pages -> Create -> Worker -> name it "courtcast-weather" -> Deploy,
 *      then "Edit code", paste this file, Deploy.
 *   2. Settings -> Variables and Secrets -> add a Secret named OPEN_METEO_API_KEY (your key).
 *   3. Settings -> Domains & Routes -> Add -> Custom domain -> wx.tenniscourtcast.com
 *      (a custom domain on your own zone also lets the 30-minute cache work).
 *   4. Open https://wx.tenniscourtcast.com : it should say "key set: yes".
 * Then app.js's WX_PROXY is switched on (see site/app.js).
 */
const UPSTREAM = {
  "/v1/forecast": "https://customer-api.open-meteo.com/v1/forecast",
  "/v1/air-quality": "https://customer-air-quality-api.open-meteo.com/v1/air-quality",
};
const ORIGINS = [
  "https://tenniscourtcast.com",
  "https://www.tenniscourtcast.com",
  "https://staging.tenniscourtcast.com",
  "http://localhost:8765",
  "http://127.0.0.1:8765",
];
// The CourtCast region with a wide margin (Malibu to Riverside, Ventura to San Diego's edge).
const AREA = { south: 32.4, north: 35.0, west: -120.0, east: -116.0 };
const KEEP_FOR = 30 * 60;   // seconds; the browser keeps its copy for 30 minutes too

const corsHeaders = (origin) => (ORIGINS.includes(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {});
function text(body, status, origin = "") {
  return new Response(body + "\n", { status, headers: { "content-type": "text/plain", ...corsHeaders(origin) } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    if (url.pathname === "/") {
      return text(`CourtCast weather proxy. key set: ${env.OPEN_METEO_API_KEY ? "yes" : "no"}`, 200);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...corsHeaders(origin), "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" } });
    }
    const upstream = UPSTREAM[url.pathname];
    if (request.method !== "GET" || !upstream) return text("Not found", 404, origin);
    if (!ORIGINS.includes(origin)) return text("Only for Tennis CourtCast", 403);
    if (!env.OPEN_METEO_API_KEY) return text("Not configured yet", 503, origin);

    const q = new URLSearchParams(url.search);
    q.delete("apikey");
    const lat = Number(q.get("latitude")), lon = Number(q.get("longitude"));
    if (!(lat >= AREA.south && lat <= AREA.north && lon >= AREA.west && lon <= AREA.east)) {
      return text("Outside the CourtCast area", 400, origin);
    }
    q.set("latitude", lat.toFixed(2));    // ~1 km: the app already rounds; this keeps the cache shared
    q.set("longitude", lon.toFixed(2));
    q.sort();
    const cacheKey = new Request(`${url.origin}${url.pathname}?${q}`);   // never includes the key
    const cache = caches.default;
    let res = await cache.match(cacheKey);
    if (!res) {
      const up = new URLSearchParams(q);
      up.set("apikey", env.OPEN_METEO_API_KEY);
      const r = await fetch(`${upstream}?${up}`, { headers: { "User-Agent": "tennis-courtcast-weather-proxy" } });
      res = new Response(r.body, {
        status: r.status,
        headers: { "content-type": r.headers.get("content-type") || "application/json", "Cache-Control": `public, max-age=${KEEP_FOR}` },
      });
      if (r.ok) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }
    const out = new Response(res.body, res);
    Object.entries(corsHeaders(origin)).forEach(([k, v]) => out.headers.set(k, v));
    return out;
  },
};
