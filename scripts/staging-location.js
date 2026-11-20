/* STAGING ONLY. scripts/cf-build.sh copies this into the staging build; the live site (GitHub Pages)
 * never gets it. It makes the browser report a pretend location, so the "near me" features can be
 * tested from anywhere. Loaded before the map and app.js, so both see the pretend location.
 *
 *   staging.tenniscourtcast.com                    -> pretend you're in Rancho Cucamonga
 *   staging.tenniscourtcast.com/?at=34.02,-118.49  -> pretend you're anywhere (lat,lon)
 *   staging.tenniscourtcast.com/?at=real           -> your real location
 */
(() => {
  "use strict";
  const DEFAULT = { lat: 34.1064, lon: -117.5931, name: "Rancho Cucamonga" };
  const at = new URLSearchParams(location.search).get("at");
  if (at === "real" || !navigator.geolocation) return;
  let spot = DEFAULT;
  const m = at && at.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) spot = { lat: Number(m[1]), lon: Number(m[2]), name: `${m[1]}, ${m[2]}` };

  const position = () => ({
    timestamp: Date.now(),
    coords: { latitude: spot.lat, longitude: spot.lon, accuracy: 10, altitude: null,
      altitudeAccuracy: null, heading: null, speed: null },
  });
  let nextId = 1;
  const geo = {
    getCurrentPosition(ok) { setTimeout(() => ok(position()), 150); },
    watchPosition(ok) { const id = nextId++; setTimeout(() => ok(position()), 150); return id; },
    clearWatch() {},
  };
  Object.defineProperty(navigator, "geolocation", { value: geo, configurable: true });
  // Report location as already allowed, so the site uses it on open without a browser prompt.
  if (navigator.permissions && navigator.permissions.query) {
    const real = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (d) => (d && d.name === "geolocation"
      ? Promise.resolve({ state: "granted", name: "geolocation", onchange: null,
          addEventListener() {}, removeEventListener() {} })
      : real(d));
  }
  // A small badge so it's obvious the location is pretend.
  addEventListener("DOMContentLoaded", () => {
    const b = document.createElement("div");
    b.textContent = `Staging · pretending you're in ${spot.name}`;
    b.style.cssText = "position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:9999;"
      + "background:#1f2328;color:#fff;font:700 12px/1.2 system-ui,sans-serif;padding:6px 12px;"
      + "border-radius:999px;opacity:.85;pointer-events:none;white-space:nowrap";
    document.body.appendChild(b);
  });
})();
