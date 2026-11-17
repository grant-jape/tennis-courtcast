"""Build the map data and the daily snapshot.

    python -m courtcast.build --out site/data/forecast.json --snapshot-dir data/snapshots

1. Read the court list and lay a grid over the region.
2. Fetch the hourly forecast for every court and grid point (one batch).
3. Score every hour at every point.
4. Write one compact JSON file the map page reads.
5. Once per local day, save the courts' next-24h forecast as a CSV. That log is
   what later lets us check the forecast against what actually happened.
"""

import argparse
import csv
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import config as C
from .openmeteo import fetch
from .score import Hour, score_hour, wind_band

ROOT = Path(__file__).resolve().parent.parent


def load_courts(path=ROOT / "courts.csv"):
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        r["lat"], r["lon"] = float(r["lat"]), float(r["lon"])
    return rows


def _km(a_lat, a_lon, b_lat, b_lon):
    return math.hypot((a_lat - b_lat) * 110.54, (a_lon - b_lon) * 111.32 * math.cos(math.radians(a_lat)))


def cells_of(courts):
    """Group courts into ~3 km squares (the forecast model's own resolution).

    Returns (points, cell index for each court). Each square's point is the average
    position of its courts, so a lone court is forecast right where it is."""
    keys, members, idx = {}, [], []
    for c in courts:
        k = (round(c["lat"] / C.CELL_LAT), round(c["lon"] / C.CELL_LON))
        if k not in keys:
            keys[k] = len(members)
            members.append([])
        members[keys[k]].append(c)
        idx.append(keys[k])
    pts = [(round(sum(c["lat"] for c in m) / len(m), 4), round(sum(c["lon"] for c in m) / len(m), 4)) for m in members]
    return pts, idx


def grid_points(courts=None):
    """The rain/wind shading grid: even steps across the region, kept only within
    GRID_REACH_KM of a court (all of it when `courts` is None).
    Returns (meta, points, (row, col) of each point)."""
    nlat = int(round((C.LAT_MAX - C.LAT_MIN) / C.GRID_STEP_LAT)) + 1
    nlon = int(round((C.LON_MAX - C.LON_MIN) / C.GRID_STEP_LON)) + 1
    pts, ij = [], []
    for i in range(nlat):
        la = round(C.LAT_MIN + i * C.GRID_STEP_LAT, 4)
        for j in range(nlon):
            lo = round(C.LON_MIN + j * C.GRID_STEP_LON, 4)
            if courts is None or any(_km(la, lo, c["lat"], c["lon"]) <= C.GRID_REACH_KM for c in courts):
                pts.append((la, lo))
                ij.append((i, j))
    meta = {"lat0": C.LAT_MIN, "lon0": C.LON_MIN, "step_lat": C.GRID_STEP_LAT, "step_lon": C.GRID_STEP_LON,
            "nlat": nlat, "nlon": nlon}
    return meta, pts, ij


def now_index(result):
    """Index of the current local hour in Open-Meteo's local-time `time` list."""
    offset = timedelta(seconds=result["utc_offset_seconds"])
    local_now = (datetime.now(timezone.utc) + offset).replace(tzinfo=None)
    stamp = local_now.strftime("%Y-%m-%dT%H:00")
    return result["hourly"]["time"].index(stamp), local_now


def series(result, start, hours):
    """Score each of `hours` hours from `start`; returns compact per-hour lists."""
    h = result["hourly"]
    v = lambda k, i: h[k][i] if h[k][i] is not None else 0.0  # noqa: E731
    out = {k: [] for k in ("s", "b", "wb", "why", "t", "p", "r", "w", "g", "d")}
    for i in range(start, start + hours):
        hour = Hour(
            temp=v("temperature_2m", i),
            rain_chance=v("precipitation_probability", i),
            rain=v("precipitation", i),
            rain_prev1=v("precipitation", i - 1),
            rain_prev2_3=v("precipitation", i - 2) + v("precipitation", i - 3),
            wind=v("wind_speed_10m", i),
            gust=v("wind_gusts_10m", i),
        )
        s, b, why = score_hour(hour)
        out["s"].append(s)
        out["b"].append(b)
        out["wb"].append(wind_band(hour.gust, hour.wind))   # wind-only rating for the Wind view
        out["why"].append(why)
        out["t"].append(round(hour.temp))
        out["p"].append(round(hour.rain_chance))
        out["r"].append(round(hour.rain, 3))
        out["w"].append(round(hour.wind))
        out["g"].append(round(hour.gust))
        out["d"].append(round(v("wind_direction_10m", i)))
    return out


def details(result, start, hours):
    """Weather-panel extras for one court: condition code, feels like, humidity, UV, cloud cover
    per hour, plus daily highs/lows. Missing variables just come out as empty lists."""
    h, d = result["hourly"], result.get("daily") or {}
    get = lambda k: h.get(k) or [None] * len(h["time"])  # noqa: E731
    pick = lambda k, f: [None if x is None else f(x) for x in get(k)[start:start + hours]]  # noqa: E731
    return {
        "wc": pick("weather_code", int),
        "ft": pick("apparent_temperature", round),
        "hu": pick("relative_humidity_2m", round),
        "uv": pick("uv_index", lambda x: round(x, 1)),
        "cc": pick("cloud_cover", round),
        "hi": [None if x is None else round(x) for x in d.get("temperature_2m_max", [])],
        "lo": [None if x is None else round(x) for x in d.get("temperature_2m_min", [])],
    }


def daily(result):
    """Days (local dates) with sunrise and sunset, region-wide (they differ by seconds across the map)."""
    d = result.get("daily") or {}
    return {"date": d.get("time", []), "sunrise": d.get("sunrise", []), "sunset": d.get("sunset", [])}


def in_box(c, box):
    a, b, lo0, lo1 = box
    return a <= c["lat"] <= b and lo0 <= c["lon"] <= lo1


def write_snapshot(courts, results, start, issued, snap_dir):
    """Save today's first forecast for each court (next 24h). Returns path or None."""
    snap_dir.mkdir(parents=True, exist_ok=True)
    path = snap_dir / f"{issued:%Y-%m-%d}.csv"
    if path.exists():
        return None
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["issued_local", "court_id", "valid_local", "lead_h", "temp_f",
                    "rain_chance_pct", "rain_in", "wind_mph", "gust_mph", "wind_dir_deg", "score"])
        for court, res in zip(courts, results):
            ser = series(res, start, 24)
            times = res["hourly"]["time"][start:start + 24]
            for lead, t in enumerate(times):
                w.writerow([f"{issued:%Y-%m-%dT%H:00}", court["id"], t, lead, ser["t"][lead],
                            ser["p"][lead], ser["r"][lead], ser["w"][lead], ser["g"][lead],
                            ser["d"][lead], ser["s"][lead]])
    return path


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "site" / "data" / "forecast.json"))
    ap.add_argument("--snapshot-dir", default=str(ROOT / "data" / "snapshots"))
    args = ap.parse_args(argv)

    courts = load_courts()
    cell_pts, cell_of = cells_of(courts)
    meta, grid, grid_ij = grid_points(courts)
    mid = (round((C.LAT_MIN + C.LAT_MAX) / 2, 4), round((C.LON_MIN + C.LON_MAX) / 2, 4))
    print(f"{len(courts)} courts in {len(cell_pts)} weather squares + {len(grid)} grid points "
          f"= {len(cell_pts) + len(grid) + 1} Open-Meteo calls", flush=True)
    cell_res = fetch(cell_pts, C.CELL_VARS)
    grid_res = fetch(grid, C.GRID_VARS)
    day_res = fetch([mid], ["is_day"], C.DAILY_VARS)[0]

    start, local_now = now_index(cell_res[0])
    hours = C.HOURS_AHEAD
    h0 = cell_res[0]["hourly"]

    data = {
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "times": h0["time"][start:start + hours],
        "is_day": h0["is_day"][start:start + hours],
        "daily": daily(day_res),
        "bands": {"play": C.GOOD_AT, "iffy": C.IFFY_AT,
                  "wind_iffy": C.WIND_IFFY_GUST, "wind_skip": C.WIND_SKIP_GUST},
        # Forecast + score per ~3 km square; each court points at its square with "cell".
        "cells": [],
        "courts": [],
        "grid": {**meta, "cells": []},
    }
    for (la, lo), res in zip(cell_pts, cell_res):
        data["cells"].append({"lat": la, "lon": lo, **series(res, start, hours), "wc": details(res, start, hours)["wc"]})
    for c, k in zip(courts, cell_of):
        # status: "" (fine) / "poor" (playable but rough) / "closed" (not playable); note explains why.
        data["courts"].append({**{key: c.get(key) or "" for key in ("id", "name", "city", "type", "status", "note")},
                               "lat": c["lat"], "lon": c["lon"],
                               # how many courts the site has (feeds the "likely busy" guess)
                               "courts": int(c["courts"]) if (c.get("courts") or "").strip().isdigit() else None,
                               "cell": k})
    for (i, j), res in zip(grid_ij, grid_res):
        ser = series(res, start, hours)
        data["grid"]["cells"].append({"i": i, "j": j, **{k: ser[k] for k in ("p", "r", "g")}})   # what the shading uses

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size // 1024} KB): {len(courts)} courts, {len(cell_pts)} squares, "
          f"{len(grid)} grid cells, {hours} h")

    snap_courts = [(c, cell_res[k]) for c, k in zip(courts, cell_of) if in_box(c, C.SNAPSHOT_BOX)]
    snap = write_snapshot([c for c, _ in snap_courts], [r for _, r in snap_courts], start, local_now, Path(args.snapshot_dir))
    print(f"snapshot: {snap}" if snap else "snapshot: already have today's")


if __name__ == "__main__":
    main()
