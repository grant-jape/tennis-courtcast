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
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import config as C
from .openmeteo import fetch
from .score import Hour, score_hour, wind_band

ROOT = Path(__file__).resolve().parent.parent


def score_config():
    """Every scoring threshold, for the browser's copy of score_hour (site/app.js)."""
    return {
        "rain_stop": C.RAIN_STOP, "drizzle": C.DRIZZLE, "drizzle_penalty": C.DRIZZLE_PENALTY,
        "wet_last_hour_penalty": C.WET_LAST_HOUR_PENALTY, "wet_2_3h_penalty": C.WET_2_3H_PENALTY,
        "rain_chance": C.RAIN_CHANCE, "gusts": C.GUSTS, "wind": C.WIND, "heat": C.HEAT, "cold": C.COLD,
        "wind_iffy_gust": C.WIND_IFFY_GUST, "wind_skip_gust": C.WIND_SKIP_GUST,
        "wind_iffy_sustained": C.WIND_IFFY_SUSTAINED, "wind_skip_sustained": C.WIND_SKIP_SUSTAINED,
        "wind_iffy_cap": C.WIND_IFFY_CAP, "wind_skip_cap": C.WIND_SKIP_CAP,
        "good_at": C.GOOD_AT, "iffy_at": C.IFFY_AT,
    }


def load_courts(path=ROOT / "courts.csv"):
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        r["lat"], r["lon"] = float(r["lat"]), float(r["lon"])
    return rows


def grid_points():
    pts = []
    lat = C.LAT_MIN
    while lat <= C.LAT_MAX + 1e-9:
        lon = C.LON_MIN
        while lon <= C.LON_MAX + 1e-9:
            pts.append((round(lat, 4), round(lon, 4)))
            lon += C.GRID_STEP_LON
        lat += C.GRID_STEP_LAT
    return pts


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
    grid = grid_points()
    results = fetch([(c["lat"], c["lon"]) for c in courts] + grid)
    court_res, grid_res = results[:len(courts)], results[len(courts):]

    start, local_now = now_index(results[0])
    hours = C.HOURS_AHEAD
    h0 = results[0]["hourly"]

    data = {
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "times": h0["time"][start:start + hours],
        "is_day": h0["is_day"][start:start + hours],
        "bands": {"play": C.GOOD_AT, "iffy": C.IFFY_AT,
                  "wind_iffy": C.WIND_IFFY_GUST, "wind_skip": C.WIND_SKIP_GUST},
        # The browser scores courts outside the Inland Empire itself (it fetches
        # their forecasts live), so it needs the exact same rules as score.py.
        "score": score_config(),
        "region": {"lat_min": C.LAT_MIN, "lat_max": C.LAT_MAX, "lon_min": C.LON_MIN, "lon_max": C.LON_MAX},
        "model": C.MODEL,
        "grid": {"step_lat": C.GRID_STEP_LAT, "step_lon": C.GRID_STEP_LON, "cells": []},
        "courts": [],
    }
    for c, res in zip(courts, court_res):
        data["courts"].append({**{k: c[k] for k in ("id", "name", "city", "type", "lat", "lon")},
                               **series(res, start, hours)})
    for (la, lo), res in zip(grid, grid_res):
        ser = series(res, start, hours)
        data["grid"]["cells"].append({"lat": la, "lon": lo, **{k: ser[k] for k in ("s", "p", "r", "w", "g", "d", "t")}})

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size // 1024} KB): {len(courts)} courts, {len(grid)} grid cells, {hours} h")

    snap = write_snapshot(courts, court_res, start, local_now, Path(args.snapshot_dir))
    print(f"snapshot: {snap}" if snap else "snapshot: already have today's")


if __name__ == "__main__":
    main()
