"""Build the Southern California court list from OpenStreetMap.

    python scripts/build_socal_courts.py [--cache DIR]

Writes site/courts-socal.json: one entry per court *site* (a park, school or
college with tennis courts), the same idea as the hand-checked Inland Empire
list in courts.csv, but automated:

1. For each half-degree tile (~50 km) from Santa Barbara to San Diego and
   inland to Palm Springs / El Centro, ask Overpass (OpenStreetMap's query
   service) for three things in ONE small request: tennis courts, named
   parks / schools / colleges (their centre points), and town names.
   One light request per tile keeps the shared, often-busy servers happy.
2. Group courts within 150 m of each other into one site.
3. Name each site after the nearest named park / school / college within
   ~600 m, and give it the nearest town or neighbourhood as its city.
4. Drop courts tagged private, sites with no named place nearby (mostly HOA
   and apartment courts), anything named like a private club, and Mexico.

Matching by distance is simpler than checking which park polygon a court sits
inside (that per-site lookup took hours on the busy servers), at the cost of
an occasional wrong name when a school and a park are side by side.

Run locally; the GitHub workflow doesn't run it. Re-run to refresh the list.
"""

import argparse
import json
import math
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "courts-socal.json"
MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
UA = {"User-Agent": "tennis-courtcast/0.1 (court list builder)"}
LAT, LON, STEP = (32.5, 35.0), (-120.5, -115.3), 0.5   # Southern California, populated areas
PRIVATE = re.compile(r"\b(country club|club|hoa|homeowners|apartments?|condominiums?|resort|hotel|estates)\b", re.I)
KINDS = {"park": "park", "recreation_ground": "park", "sports_centre": "park",
         "school": "school", "college": "college", "university": "college"}
MATCH_M = 600          # a court site takes the name of a named place whose centre is within this distance


def overpass(query, cache=None, key=None):
    if cache and key and (cache / key).exists():
        return json.loads((cache / key).read_text(encoding="utf-8"))
    last = None
    for attempt in range(8):
        url = MIRRORS[attempt % len(MIRRORS)]
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": query}).encode(), headers=UA)
            data = json.loads(urllib.request.urlopen(req, timeout=150).read())
            if cache and key:
                (cache / key).write_text(json.dumps(data), encoding="utf-8")
            time.sleep(1.0)                       # be polite to the shared servers
            return data
        except Exception as e:                    # busy mirror / timeout: try the next one
            last = e
            print(f"  overpass retry {attempt + 1}/8 ({url.split('/')[2]}): {repr(e)[:70]}", flush=True)
            time.sleep(6 * (attempt + 1))
    raise RuntimeError(f"Overpass failed: {last!r}")


def metres(a_lat, a_lon, b_lat, b_lon):
    return math.hypot((a_lat - b_lat) * 110540, (a_lon - b_lon) * 111320 * math.cos(math.radians(a_lat)))


def fetch(cache):
    courts, places, towns = [], [], []
    lat = LAT[0]
    while lat < LAT[1] - 1e-9:
        lon = LON[0]
        while lon < LON[1] - 1e-9:
            bb = f"{lat:.2f},{lon:.2f},{lat + STEP:.2f},{lon + STEP:.2f}"
            q = (f'[out:json][timeout:120];'
                 f'(way["sport"="tennis"]({bb});node["sport"="tennis"]({bb}););out center tags;'
                 f'(way["leisure"~"^(park|recreation_ground|sports_centre)$"]["name"]({bb});'
                 f'relation["leisure"~"^(park|recreation_ground|sports_centre)$"]["name"]({bb});'
                 f'way["amenity"~"^(school|college|university)$"]["name"]({bb});'
                 f'relation["amenity"~"^(school|college|university)$"]["name"]({bb}););out center tags;'
                 f'node["place"~"^(city|town|village|suburb|neighbourhood)$"]["name"]({bb});out tags;')
            els = overpass(q, cache, f"tile_{lat:.2f}_{lon:.2f}.json")["elements"]
            n0 = len(courts)
            for e in els:
                t = e.get("tags", {})
                c = e.get("center", e)
                if "lat" not in c:
                    continue
                if "place" in t:
                    if t.get("name"):
                        towns.append((c["lat"], c["lon"], t["name"], t["place"]))
                    continue
                public = t.get("access") not in ("private", "no", "customers", "members")
                if t.get("sport") == "tennis" and public:
                    courts.append((c["lat"], c["lon"]))   # a court (or a whole tennis centre)
                # A named park / school / college (a named tennis centre counts too) can name nearby courts.
                kind = KINDS.get(t.get("leisure") or t.get("amenity") or "")
                if kind and t.get("name") and public:
                    places.append((c["lat"], c["lon"], t["name"], kind, t.get("addr:city", "")))
            print(f"tile {lat:.1f},{lon:.1f}: +{len(courts) - n0} courts (total {len(courts)}, places {len(places)})", flush=True)
            lon += STEP
        lat += STEP
    return courts, places, towns


def cluster(points, radius_m=150):
    """Greedy grouping with a coarse spatial hash so it stays fast for thousands of courts."""
    cell, buckets, sites = 0.002, {}, []
    for la, lo in points:
        bx, by = int(la / cell), int(lo / cell)
        hit = next((s for dx in (-1, 0, 1) for dy in (-1, 0, 1) for s in buckets.get((bx + dx, by + dy), [])
                    if metres(la, lo, *s["pts"][0]) < radius_m), None)
        if hit:
            hit["pts"].append((la, lo))
        else:
            s = {"pts": [(la, lo)]}
            sites.append(s)
            buckets.setdefault((bx, by), []).append(s)
    for s in sites:
        s["lat"] = round(sum(p[0] for p in s["pts"]) / len(s["pts"]), 5)
        s["lon"] = round(sum(p[1] for p in s["pts"]) / len(s["pts"]), 5)
    return sites


def index(items, cell=0.01):
    idx = {}
    for it in items:
        idx.setdefault((int(it[0] / cell), int(it[1] / cell)), []).append(it)
    return idx, cell


def nearby(idx_cell, lat, lon, reach):
    idx, cell = idx_cell
    bx, by = int(lat / cell), int(lon / cell)
    for dx in range(-reach, reach + 1):
        for dy in range(-reach, reach + 1):
            yield from idx.get((bx + dx, by + dy), [])


def in_mexico(lat, lon):
    # The border runs from ~32.53 N at the coast to ~32.72 N at the Colorado River.
    return lat < 32.53 + (lon + 117.12) * 0.11 if lon > -117.12 else lat < 32.53


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", help="folder to keep raw Overpass responses (reruns skip finished tiles)")
    args = ap.parse_args()
    cache = Path(args.cache) if args.cache else None
    if cache:
        cache.mkdir(parents=True, exist_ok=True)

    courts, places, towns = fetch(cache)
    sites = cluster(courts)
    print(f"{len(courts)} courts -> {len(sites)} sites; {len(places)} named places; {len(towns)} towns", flush=True)
    pidx, tidx = index(places), index(towns, 0.05)

    out, seen = [], set()
    for s in sites:
        if in_mexico(s["lat"], s["lon"]):
            continue
        cands = [(metres(s["lat"], s["lon"], p[0], p[1]), p) for p in nearby(pidx, s["lat"], s["lon"], 1)]
        cands = [c for c in cands if c[0] <= MATCH_M]
        if not cands:
            continue                               # no named park/school nearby: mostly HOA courts
        _, (plat, plon, name, kind, addr_city) = min(cands)
        if PRIVATE.search(name):
            continue
        tcands = [(metres(s["lat"], s["lon"], t[0], t[1]), t) for t in nearby(tidx, s["lat"], s["lon"], 1)]
        # Prefer a real town over a neighbourhood unless the neighbourhood is much closer.
        city = addr_city
        if not city and tcands:
            towns_only = [c for c in tcands if c[1][3] in ("city", "town", "village")]
            best = min(towns_only or tcands)
            city = best[1][2]
        key = (name, city)
        if key in seen:                            # one entry per park/school, even if its courts are split
            continue
        seen.add(key)
        slug = re.sub(r"[^a-z0-9]+", "-", f"{name}-{city}".lower()).strip("-")
        out.append({"id": slug, "name": name, "city": city, "type": kind, "lat": s["lat"], "lon": s["lon"], "n": len(s["pts"])})
    out.sort(key=lambda r: (r["city"], r["name"]))
    OUT.write_text(json.dumps({"source": "OpenStreetMap contributors (ODbL)", "courts": out},
                              separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    kinds = {}
    for r in out:
        kinds[r["type"]] = kinds.get(r["type"], 0) + 1
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB): {len(out)} sites {kinds}", flush=True)


if __name__ == "__main__":
    main()
