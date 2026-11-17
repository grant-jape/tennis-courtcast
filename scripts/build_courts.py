"""Build the court list from a downloaded OpenStreetMap extract.

    python scripts/build_courts.py socal-latest.osm.pbf            # writes courts.csv
    python scripts/build_courts.py socal-latest.osm.pbf --dry-run  # just report

Get the extract from https://download.geofabrik.de/north-america/us/california/socal.html
(~700 MB, once). It's read locally with the `osmium` library, so nothing depends on the
busy public Overpass servers. Run it locally; the GitHub workflow doesn't.

1. Find tennis courts (`sport=tennis`), skipping ones tagged private.
2. Group courts within 150 m of each other into one site.
3. Name each site after the public park, school or college whose outline contains it
   (or, failing that, one whose outline is within 120 m). Sites with neither are dropped:
   they're mostly HOA, apartment and backyard courts. Names that sound private
   (club, resort, HOA, ...) are dropped too.
4. Give each site its city from the official city boundaries; inside the City of
   Los Angeles, use the neighbourhood instead (Venice, Silver Lake, ...), which is what
   people call it. Unincorporated areas take the nearest named community.
5. Keep every row already in courts.csv exactly as it is (ids, statuses and notes are
   hand-checked, and votes/comments hang off the ids); only add sites that aren't
   already there.

Matching by outline needs the outlines' points, so the file is read in three passes:
tags first, then the ways that make up multipolygon outlines, then just the points needed.
"""

import argparse
import csv
import math
import re
import sys
from collections import Counter
from pathlib import Path

import osmium

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from courtcast import config as C  # noqa: E402

PRIVATE_ACCESS = {"private", "no", "customers", "members"}
PRIVATE_NAME = re.compile(r"\b(country club|club|hoa|homeowners|apartments?|condominiums?|condos?|resort|hotel|"
                          r"estates|villas?|townhomes?|senior living|community association)\b", re.I)
KIND = {"park": "park", "recreation_ground": "park", "sports_centre": "park", "playground": None,
        "school": "school", "college": "college", "university": "college"}
CLUSTER_M = 150
NEAR_M = 120


def has_tennis(tags):
    return "tennis" in (tags.get("sport") or "").replace(",", ";").split(";")


def place_kind(tags):
    return KIND.get(tags.get("leisure") or "") or KIND.get(tags.get("amenity") or "")


def metres(a_lat, a_lon, b_lat, b_lon):
    return math.hypot((a_lat - b_lat) * 110_540, (a_lon - b_lon) * 111_320 * math.cos(math.radians(a_lat)))


class Tags(osmium.SimpleHandler):
    """Pass 1: courts, named places, city boundaries and community names (tags + node ids only)."""

    def __init__(self, box):
        super().__init__()
        self.box = box
        self.court_nodes, self.court_ways = [], []          # (lat, lon) / [node ids]
        self.place_ways, self.place_rels = [], []            # dicts with name/kind/... and refs
        self.city_rels, self.towns = [], []
        self.need_ways = set()

    def inbox(self, la, lo):
        a, b, c, d = self.box
        return a <= la <= b and c <= lo <= d

    def node(self, n):
        t = n.tags
        if not n.location.valid():
            return
        la, lo = n.location.lat, n.location.lon
        if not self.inbox(la, lo):
            return
        if has_tennis(t) and t.get("access") not in PRIVATE_ACCESS:
            self.court_nodes.append((la, lo))
        if t.get("place") in ("city", "town", "village", "suburb", "neighbourhood", "hamlet") and t.get("name"):
            self.towns.append((la, lo, t["name"], t["place"]))

    def way(self, w):
        t = w.tags
        if has_tennis(t) and t.get("access") not in PRIVATE_ACCESS:
            self.court_ways.append([nd.ref for nd in w.nodes])
        kind = place_kind(t)
        if kind and t.get("name") and t.get("access") not in PRIVATE_ACCESS and w.is_closed():
            self.place_ways.append({"name": t["name"], "kind": kind, "city": t.get("addr:city", ""),
                                    "rings": [[nd.ref for nd in w.nodes]]})

    def relation(self, r):
        t = r.tags
        kind = place_kind(t)
        outers = [m.ref for m in r.members if m.type == "w" and m.role in ("outer", "")]
        if kind and t.get("name") and t.get("access") not in PRIVATE_ACCESS and t.get("type") == "multipolygon":
            self.place_rels.append({"name": t["name"], "kind": kind, "city": t.get("addr:city", ""), "ways": outers})
            self.need_ways.update(outers)
        if t.get("boundary") == "administrative" and t.get("admin_level") == "8" and t.get("name"):
            self.city_rels.append({"name": t["name"], "ways": outers})
            self.need_ways.update(outers)


class WayNodes(osmium.SimpleHandler):
    """Pass 2: node ids of the ways that make up multipolygon outlines."""

    def __init__(self, need):
        super().__init__()
        self.need, self.nodes = need, {}

    def way(self, w):
        if w.id in self.need:
            self.nodes[w.id] = [nd.ref for nd in w.nodes]


class Points(osmium.SimpleHandler):
    """Pass 3: coordinates of just the nodes we need."""

    def __init__(self, need):
        super().__init__()
        self.need, self.loc = need, {}

    def node(self, n):
        if n.id in self.need and n.location.valid():
            self.loc[n.id] = (n.location.lat, n.location.lon)


def join_rings(way_ids, way_nodes):
    """Stitch a multipolygon's member ways into closed rings (good enough for point-in-polygon)."""
    segs = [list(way_nodes[w]) for w in way_ids if w in way_nodes and len(way_nodes[w]) > 1]
    rings = []
    while segs:
        ring = segs.pop()
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == ring[-1]:
                    ring += s[1:]
                elif s[-1] == ring[-1]:
                    ring += s[-2::-1]
                elif s[-1] == ring[0]:
                    ring = s[:-1] + ring
                elif s[0] == ring[0]:
                    ring = s[:0:-1] + ring
                else:
                    continue
                segs.pop(i)
                changed = True
                break
        rings.append(ring)
    return rings


class Shape:
    """A named area: rings of (lat, lon), its bounding box, area and centre."""

    def __init__(self, name, kind, city, rings):
        self.name, self.kind, self.city = name, kind, city
        self.rings = [r for r in rings if len(r) >= 4]
        pts = [p for r in self.rings for p in r]
        self.ok = bool(pts)
        if not self.ok:
            return
        self.box = (min(p[0] for p in pts), max(p[0] for p in pts), min(p[1] for p in pts), max(p[1] for p in pts))
        self.area = (self.box[1] - self.box[0]) * (self.box[3] - self.box[2])
        self.lat, self.lon = sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)

    def contains(self, la, lo):
        a, b, c, d = self.box
        if not (a <= la <= b and c <= lo <= d):
            return False
        inside = False
        for ring in self.rings:            # even-odd rule across rings (outer rings only here)
            for (y1, x1), (y2, x2) in zip(ring, ring[1:]):
                if (y1 > la) != (y2 > la) and lo < x1 + (la - y1) * (x2 - x1) / (y2 - y1):
                    inside = not inside
        return inside

    def distance(self, la, lo):
        """Rough distance (m) from a point to the outline's nearest vertex; 0 if inside."""
        if self.contains(la, lo):
            return 0.0
        return min(metres(la, lo, p[0], p[1]) for r in self.rings for p in r)


class Grid:
    """Spatial hash of shapes by bounding box, for quick 'what's around this point' lookups."""

    def __init__(self, shapes, cell=0.01):
        self.cell, self.cells = cell, {}
        for s in shapes:
            a, b, c, d = s.box
            for i in range(int(a / cell), int(b / cell) + 1):
                for j in range(int(c / cell), int(d / cell) + 1):
                    self.cells.setdefault((i, j), []).append(s)

    def around(self, la, lo, reach=1):
        seen = set()
        i0, j0 = int(la / self.cell), int(lo / self.cell)
        for i in range(i0 - reach, i0 + reach + 1):
            for j in range(j0 - reach, j0 + reach + 1):
                for s in self.cells.get((i, j), []):
                    if id(s) not in seen:
                        seen.add(id(s))
                        yield s


def cluster(points):
    cell, buckets, sites = 0.002, {}, []
    for la, lo in points:
        bx, by = int(la / cell), int(lo / cell)
        hit = next((s for dx in (-1, 0, 1) for dy in (-1, 0, 1) for s in buckets.get((bx + dx, by + dy), [])
                    if metres(la, lo, *s["pts"][0]) < CLUSTER_M), None)
        if hit:
            hit["pts"].append((la, lo))
        else:
            s = {"pts": [(la, lo)]}
            sites.append(s)
            buckets.setdefault((bx, by), []).append(s)
    for s in sites:
        s["lat"] = sum(p[0] for p in s["pts"]) / len(s["pts"])
        s["lon"] = sum(p[1] for p in s["pts"]) / len(s["pts"])
    return sites


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pbf")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    box = (C.LAT_MIN, C.LAT_MAX, C.LON_MIN, C.LON_MAX)

    print("pass 1/3: tags", flush=True)
    t = Tags(box)
    t.apply_file(args.pbf)
    print(f"  {len(t.court_nodes) + len(t.court_ways)} courts, {len(t.place_ways) + len(t.place_rels)} named places, "
          f"{len(t.city_rels)} cities, {len(t.towns)} community names", flush=True)
    print("pass 2/3: outline ways", flush=True)
    wn = WayNodes(t.need_ways)
    wn.apply_file(args.pbf)
    need = {n for w in t.court_ways for n in w} | {n for p in t.place_ways for r in p["rings"] for n in r}
    need |= {n for nodes in wn.nodes.values() for n in nodes}
    print(f"pass 3/3: {len(need):,} points", flush=True)
    pts = Points(need)
    pts.apply_file(args.pbf)
    loc = pts.loc

    def ring_coords(ids):
        return [loc[i] for i in ids if i in loc]

    courts = list(t.court_nodes)
    for ids in t.court_ways:
        c = ring_coords(ids)
        if c:
            la, lo = sum(p[0] for p in c) / len(c), sum(p[1] for p in c) / len(c)
            if box[0] <= la <= box[1] and box[2] <= lo <= box[3]:
                courts.append((la, lo))
    places = [Shape(p["name"], p["kind"], p["city"], [ring_coords(r) for r in p["rings"]]) for p in t.place_ways]
    places += [Shape(p["name"], p["kind"], p["city"], [ring_coords(r) for r in join_rings(p["ways"], wn.nodes)])
               for p in t.place_rels]
    places = [p for p in places if p.ok and not PRIVATE_NAME.search(p.name)]
    cities = [Shape(c["name"], "city", "", [ring_coords(r) for r in join_rings(c["ways"], wn.nodes)]) for c in t.city_rels]
    cities = [c for c in cities if c.ok]
    pgrid, cgrid = Grid(places), Grid(cities, cell=0.05)
    towns = [x for x in t.towns if x[3] in ("suburb", "neighbourhood", "village", "hamlet", "town", "city")]

    # Community labels that aren't what anyone calls the place they play tennis.
    ODD = re.compile(r"(industrial|district|estates?|ranch|business|center|centre|plaza|apartments?|club|tract)", re.I)

    def city_of(la, lo, hint):
        inside = [c for c in cgrid.around(la, lo, 0) if c.contains(la, lo)]
        city = min(inside, key=lambda c: c.area).name if inside else ""
        if city and city != "Los Angeles":
            return city
        near = sorted((metres(la, lo, x[0], x[1]), x) for x in towns
                      if abs(x[0] - la) < 0.06 and abs(x[1] - lo) < 0.07 and not ODD.search(x[2]))
        if city == "Los Angeles":
            # LA's own districts (Venice, Hollywood, ...), then a close-by neighbourhood label.
            return (next((x[2] for d, x in near if d < 3000 and x[3] == "suburb"), None)
                    or next((x[2] for d, x in near if d < 1200 and x[3] == "neighbourhood"), None)
                    or "Los Angeles")
        # Unincorporated: the nearest real town first, then a community label.
        return (next((x[2] for d, x in near if d < 6000 and x[3] in ("city", "town", "village")), None)
                or next((x[2] for d, x in near if d < 3000 and x[3] in ("suburb", "hamlet", "neighbourhood")), None)
                or hint or "")

    sites = cluster(courts)
    out, reasons = [], Counter()
    for s in sites:
        la, lo = s["lat"], s["lon"]
        cands = []
        for p in pgrid.around(la, lo):
            d = min(p.distance(q[0], q[1]) for q in s["pts"])
            if d <= NEAR_M:
                cands.append((d, p.area, p))
        if not cands:
            reasons["no public park/school/college"] += 1
            continue
        _, _, place = min(cands, key=lambda x: (x[0], x[1]))   # inside beats nearby; smallest area wins
        out.append({"name": place.name, "kind": place.kind, "lat": la, "lon": lo, "courts": len(s["pts"]),
                    "city": city_of(la, lo, place.city)})

    # One row per named place + city, even if its courts are in two groups.
    merged = {}
    for r in out:
        k = (r["name"], r["city"])
        if k in merged:
            m = merged[k]
            total = m["courts"] + r["courts"]
            m["lat"] = (m["lat"] * m["courts"] + r["lat"] * r["courts"]) / total
            m["lon"] = (m["lon"] * m["courts"] + r["lon"] * r["courts"]) / total
            m["courts"] = total
        else:
            merged[k] = dict(r)
    found = list(merged.values())

    # Keep courts.csv rows as they are; add what's new.
    path = ROOT / "courts.csv"
    with open(path, newline="", encoding="utf-8") as f:
        existing = list(csv.DictReader(f))
    ids = {r["id"] for r in existing}
    added, kept_matched = [], 0
    for r in existing:
        near = [f for f in found if metres(float(r["lat"]), float(r["lon"]), f["lat"], f["lon"]) < 250]
        if near:
            kept_matched += 1
            r["courts"] = r.get("courts") or str(max(n["courts"] for n in near))
            for n in near:
                n["dup"] = True
    for f in sorted(found, key=lambda x: (x["city"], x["name"])):
        if f.get("dup"):
            continue
        base = slug(f"{f['name']}-{f['city']}") or "court"
        i, sid = 2, base
        while sid in ids:
            sid, i = f"{base}-{i}", i + 1
        ids.add(sid)
        added.append({"id": sid, "name": f["name"], "city": f["city"], "type": f["kind"],
                      "lat": f"{f['lat']:.5f}", "lon": f"{f['lon']:.5f}", "status": "", "note": "",
                      "courts": str(f["courts"])})

    kinds = Counter(r["type"] for r in added)
    print(f"\n{len(courts)} public courts -> {len(sites)} groups; dropped: {dict(reasons)}")
    print(f"existing rows kept: {len(existing)} ({kept_matched} matched to OSM sites)")
    print(f"new sites: {len(added)} {dict(kinds)}")
    print(f"total: {len(existing) + len(added)}")
    if args.dry_run:
        for r in added[:15]:
            print("  +", r["name"], "|", r["city"], "|", r["type"], "|", r["courts"], "courts")
        return
    fields = ["id", "name", "city", "type", "lat", "lon", "status", "note", "courts"]
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, lineterminator="\n")
        w.writeheader()
        for r in existing + added:
            w.writerow({k: r.get(k, "") for k in fields})
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
