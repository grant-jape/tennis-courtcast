"""Build the Southern California court list from OpenStreetMap.

    python scripts/build_socal_courts.py [--cache DIR]

Writes site/courts-socal.json: one entry per court *site* (a park, school or
college with tennis courts), the same idea as the hand-checked Inland Empire
list in courts.csv, but automated:

1. Download every tennis court (sport=tennis) in the region, in 1x1 degree
   tiles so each Overpass query stays small.
2. Group courts within 150 m of each other into one site.
3. Ask Overpass which named areas each site sits inside ("is_in"), in batches.
   That gives the site's name (the park / school / college), its city, and
   its county, which decides whether it's in Southern California.
4. Keep public-looking sites: parks, recreation grounds, schools, colleges and
   tennis/sports centres. Drop courts marked private, unnamed sites (mostly HOA
   and apartment courts), and anything named like a private club.

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
MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
           "https://overpass.private.coffee/api/interpreter"]
UA = {"User-Agent": "tennis-courtcast/0.1 (court list builder)"}
# Southern California = these 8 counties; the tiles cover their bounding box.
SOCAL_COUNTIES = {"Los Angeles County", "Orange County", "San Diego County", "Riverside County",
                  "San Bernardino County", "Ventura County", "Santa Barbara County", "Imperial County"}
CA_LAT, CA_LON = (32.5, 35.2), (-121.5, -114.1)
PRIVATE = re.compile(r"\b(country club|club|hoa|homeowners|apartments?|condominiums?|resort|hotel|estates)\b", re.I)
PUBLIC_KINDS = {"park": "park", "recreation_ground": "park", "sports_centre": "park", "pitch": "park",
                "school": "school", "college": "college", "university": "college"}


def overpass(query, cache=None, key=None):
    if cache and key and (cache / key).exists():
        return json.loads((cache / key).read_text(encoding="utf-8"))
    last = None
    for attempt in range(6):
        url = MIRRORS[attempt % len(MIRRORS)]
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": query}).encode(), headers=UA)
            data = json.loads(urllib.request.urlopen(req, timeout=180).read())
            if cache and key:
                (cache / key).write_text(json.dumps(data), encoding="utf-8")
            time.sleep(1.5)                       # be polite to the shared servers
            return data
        except Exception as e:                    # busy mirror / timeout: try the next one
            last = e
            print(f"  overpass retry {attempt + 1}/6 ({url.split('/')[2]}): {repr(e)[:70]}", flush=True)
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"Overpass failed: {last!r}")


def fetch_courts(cache):
    courts = []
    lat = CA_LAT[0]
    while lat < CA_LAT[1]:
        lon = CA_LON[0]
        while lon < CA_LON[1]:
            bbox = f"{lat},{lon},{lat + 1},{lon + 1}"
            q = (f'[out:json][timeout:120];(way["sport"="tennis"]({bbox});node["sport"="tennis"]({bbox});'
                 f'relation["sport"="tennis"]({bbox}););out center tags;')
            els = overpass(q, cache, f"tile_{lat:.0f}_{lon:.0f}.json")["elements"]
            for e in els:
                t = e.get("tags", {})
                if t.get("access") in ("private", "no", "customers", "members"):
                    continue
                c = e.get("center", e)
                if "lat" in c:
                    courts.append((c["lat"], c["lon"]))
            print(f"tile {lat:.0f},{lon:.0f}: {len(els)} courts (total kept {len(courts)})", flush=True)
            lon += 1
        lat += 1
    return courts


def cluster(points, radius_m=150):
    """Greedy grouping using a coarse spatial hash so it stays fast for 30k+ courts."""
    cell = 0.002                                   # ~200 m
    buckets, sites = {}, []
    for la, lo in points:
        bx, by = int(la / cell), int(lo / cell)
        hit = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for s in buckets.get((bx + dx, by + dy), []):
                    dlat = (la - s["pts"][0][0]) * 110540
                    dlon = (lo - s["pts"][0][1]) * 111320 * math.cos(math.radians(la))
                    if math.hypot(dlat, dlon) < radius_m:
                        hit = s
                        break
                if hit: break
            if hit: break
        if hit:
            hit["pts"].append((la, lo))
        else:
            s = {"pts": [(la, lo)]}
            sites.append(s)
            buckets.setdefault((bx, by), []).append(s)
    for s in sites:
        s["lat"] = round(sum(p[0] for p in s["pts"]) / len(s["pts"]), 5)
        s["lon"] = round(sum(p[1] for p in s["pts"]) / len(s["pts"]), 5)
        s["n"] = len(s["pts"])
    return sites


def name_sites(sites, cache, batch=120):
    for b in range(0, len(sites), batch):
        chunk = sites[b:b + batch]
        q = ["[out:json][timeout:170];"]
        for i, s in enumerate(chunk):
            q.append(f'make sep i={i};out;is_in({s["lat"]},{s["lon"]})->.a;area.a[name];out tags;')
        els = overpass("".join(q), cache, f"isin_{b}.json")["elements"]
        cur = None
        for e in els:
            if e["type"] == "sep":
                cur = chunk[int(e["tags"]["i"])]
                cur["areas"] = []
            elif cur is not None:
                cur["areas"].append(e["tags"])
        print(f"named {min(b + batch, len(sites))}/{len(sites)} sites", flush=True)


def describe(site):
    areas = site.get("areas", [])
    if not any(a.get("admin_level") == "6" and a.get("name") in SOCAL_COUNTIES for a in areas):
        return None                                # outside the 8 Southern California counties
    city = next((a["name"] for a in areas if a.get("boundary") == "administrative" and a.get("admin_level") == "8"), "")
    if not city:
        city = next((a["name"] for a in areas if a.get("place") in ("city", "town", "village", "suburb", "hamlet")), "")
    for a in areas:
        kind = a.get("leisure") or a.get("amenity") or ""
        if kind in PUBLIC_KINDS and a.get("access") not in ("private", "no"):
            name = a["name"]
            if PRIVATE.search(name) or a.get("golf"):
                return None
            return {"name": name, "city": city, "type": PUBLIC_KINDS[kind]}
    return None                                    # unnamed: mostly HOA / apartment courts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", help="folder to keep raw Overpass responses (reruns skip finished queries)")
    args = ap.parse_args()
    cache = Path(args.cache) if args.cache else None
    if cache:
        cache.mkdir(parents=True, exist_ok=True)

    courts = fetch_courts(cache)
    sites = cluster(courts)
    print(f"{len(courts)} courts -> {len(sites)} sites", flush=True)
    name_sites(sites, cache)

    out, seen = [], set()
    for s in sites:
        d = describe(s)
        if not d:
            continue
        key = (d["name"], d["city"])
        if key in seen:                            # one entry per park/school, even if courts are split
            continue
        seen.add(key)
        slug = re.sub(r"[^a-z0-9]+", "-", f"{d['name']}-{d['city']}".lower()).strip("-")
        out.append({"id": slug, **d, "lat": s["lat"], "lon": s["lon"], "n": s["n"]})
    out.sort(key=lambda r: (r["city"], r["name"]))
    OUT.write_text(json.dumps({"source": "OpenStreetMap contributors (ODbL)", "courts": out},
                              separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    kinds = {}
    for r in out:
        kinds[r["type"]] = kinds.get(r["type"], 0) + 1
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB): {len(out)} sites {kinds}", flush=True)


if __name__ == "__main__":
    main()
