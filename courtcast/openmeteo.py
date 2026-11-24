"""Fetch hourly forecasts for many points from Open-Meteo.

Free API by default. With OPEN_METEO_API_KEY set (a GitHub Actions secret), the build uses
Open-Meteo's paid commercial endpoint instead: same request, different host, plus &apikey=.

Open-Meteo accepts comma-separated lists of coordinates and returns one result
per point, so ~150 points take 3-4 requests.
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

from . import config as C

URL = "https://api.open-meteo.com/v1/forecast"                    # free, non-commercial
PAID_URL = "https://customer-api.open-meteo.com/v1/forecast"      # with an API key (commercial licence)


def endpoint(params):
    """(base URL, params) to use: the paid endpoint with the key when OPEN_METEO_API_KEY is set."""
    key = os.environ.get("OPEN_METEO_API_KEY", "").strip()
    if not key:
        return URL, params
    return PAID_URL, {**params, "apikey": key}


def _get(params, retries=6):
    """GET with retries. GitHub's runners share IP addresses with other projects,
    so Open-Meteo's per-IP rate limit (HTTP 429) can trip from someone else's
    traffic; those waits need to be long (and follow Retry-After when given)."""
    base, params = endpoint(params)
    url = base + "?" + urllib.parse.urlencode(params)   # never print this: it can hold the key
    req = urllib.request.Request(url, headers={"User-Agent": "tennis-courtcast/0.1"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if attempt == retries - 1:
                raise
            if e.code == 429:
                hint = e.headers.get("Retry-After")
                backoff = 30 * 2 ** attempt   # 30, 60, 120, 240 s
                # Follow the server's hint, but never retry instantly: a "Retry-After: 0" from a busy,
                # shared IP otherwise burns every retry in a second.
                wait = max(int(hint), 15 * (attempt + 1)) if hint and hint.isdigit() else backoff
                print(f"rate limited (429); waiting {wait}s before retry {attempt + 2}/{retries}", flush=True)
                time.sleep(min(wait, 300))
            else:
                time.sleep(5 * (attempt + 1))
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(5 * (attempt + 1))


def fetch(points, hourly, daily=None, per_minute=None):
    """points: list of (lat, lon). Returns a list of Open-Meteo results, same order.

    Open-Meteo counts each location as a call, so requests are paced to stay under
    `per_minute` calls (its free limit is 600 a minute)."""
    out = []
    n = C.LOCATIONS_PER_REQUEST
    per_minute = per_minute or C.CALLS_PER_MINUTE
    window = []   # (time, calls) sent in the last 60 s
    for i in range(0, len(points), n):
        chunk = points[i:i + n]
        now = time.monotonic()
        window = [(t, k) for t, k in window if now - t < 60]
        if sum(k for _, k in window) + len(chunk) > per_minute:
            wait = 60 - (now - window[0][0]) + 1
            print(f"pacing: waiting {wait:.0f}s to stay under {per_minute} calls/minute", flush=True)
            time.sleep(wait)
            window = []
        window.append((time.monotonic(), len(chunk)))
        params = {
            "latitude": ",".join(f"{la:.4f}" for la, _ in chunk),
            "longitude": ",".join(f"{lo:.4f}" for _, lo in chunk),
            "hourly": ",".join(hourly),
            "models": C.MODEL,
            "past_days": 1,       # the hours before "now", for the wet-court check
            "forecast_days": 3,
            "timezone": C.TIMEZONE,
            "temperature_unit": "fahrenheit",
            "wind_speed_unit": "mph",
            "precipitation_unit": "inch",
        }
        if daily:
            params["daily"] = ",".join(daily)
        data = _get(params)
        out.extend(data if isinstance(data, list) else [data])
    if len(out) != len(points):
        raise RuntimeError(f"asked for {len(points)} points, got {len(out)}")
    return out
