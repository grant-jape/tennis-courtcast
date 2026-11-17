"""Fetch hourly forecasts for many points from Open-Meteo (free, no key).

Open-Meteo accepts comma-separated lists of coordinates and returns one result
per point, so ~150 points take 3-4 requests.
"""

import json
import time
import urllib.error
import urllib.parse
import urllib.request

from . import config as C

URL = "https://api.open-meteo.com/v1/forecast"


def _get(params, retries=5):
    """GET with retries. GitHub's runners share IP addresses with other projects,
    so Open-Meteo's per-IP rate limit (HTTP 429) can trip from someone else's
    traffic; those waits need to be long (and follow Retry-After when given)."""
    url = URL + "?" + urllib.parse.urlencode(params)
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
                wait = int(hint) if hint and hint.isdigit() else 30 * 2 ** attempt   # 30, 60, 120, 240 s
                print(f"rate limited (429); waiting {wait}s before retry {attempt + 2}/{retries}", flush=True)
                time.sleep(min(wait, 300))
            else:
                time.sleep(5 * (attempt + 1))
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(5 * (attempt + 1))


def fetch(points):
    """points: list of (lat, lon). Returns a list of Open-Meteo results, same order."""
    out = []
    n = C.LOCATIONS_PER_REQUEST
    for i in range(0, len(points), n):
        chunk = points[i:i + n]
        data = _get({
            "latitude": ",".join(f"{la:.4f}" for la, _ in chunk),
            "longitude": ",".join(f"{lo:.4f}" for _, lo in chunk),
            "hourly": ",".join(C.HOURLY_VARS),
            "daily": ",".join(C.DAILY_VARS),
            "models": C.MODEL,
            "past_days": 1,       # the hours before "now", for the wet-court check
            "forecast_days": 3,
            "timezone": C.TIMEZONE,
            "temperature_unit": "fahrenheit",
            "wind_speed_unit": "mph",
            "precipitation_unit": "inch",
        })
        out.extend(data if isinstance(data, list) else [data])
    if len(out) != len(points):
        raise RuntimeError(f"asked for {len(points)} points, got {len(out)}")
    return out
