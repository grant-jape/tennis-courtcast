# Tennis CourtCast 🎾

**Court-by-court tennis weather for Southern California.** A map of public tennis courts from Santa Barbara to San Diego, each colored by a 0–10 playability score, with rain and wind shading and a time slider for the next 36 hours. It started in the Inland Empire (Claremont to Fontana), which still gets the most detail.

**Live map:** https://grant-jape.github.io/tennis-courtcast/

Rain at Day Creek doesn't mean rain at Claremont. Fontana can be gusting 25 mph while Chino is calm. A single city forecast hides that. CourtCast gets a forecast for every court, so you can see where it's playable and when.

## What's on the map

- **Courts:** each court is a small tennis-court icon colored green / amber / red (play / iffy / skip), with its score underneath. Zoomed far out, courts become dots.
- **Weather shading:** blue = rain, orange = wind, purple = both. Darker means heavier rain or stronger gusts.
- **Play / Wind / Rain views:** Wind colors courts by wind alone and shows gusts in mph; Rain shows rain amounts.
- **Time slider:** follows the real clock (Pacific time) and scrubs through the next 36 hours, shaded day and night.
- **Court card:** tap a court for its verdict, temperature, wind and rain, a 12-hour strip with sun and moon icons, and the best two-hour daylight window.
- **Shareable links:** the URL keeps the time, view, map position and selected court, e.g. `…/#court=day-creek-park&t=2026-11-16T14`.
- **School courts** are behind a toggle because public access varies.

## How the score works

Start at 10 and subtract a penalty for each thing that makes tennis worse. Each penalty grows linearly between a "starts to matter" value and a "maxed out" value:

| Factor | No penalty below | Full penalty at | Max points off | Why |
|---|---|---|---|---|
| Rain this hour | | ≥ 0.01 in | score = 0 | Measurable rain means wet lines and slipping |
| Rain last hour | | ≥ 0.01 in | 5 | Hard courts need about an hour of sun or wind to dry |
| Rain 2–3 hours ago | | ≥ 0.01 in | 2.5 | Mostly dry, but puddles linger |
| Rain chance | 10% | 100% | 3 | Risk of getting rained out mid-set |
| Gusts | 12 mph | 32 mph | 7 | Gusts wreck tosses and lobs more than steady wind |
| Sustained wind | 8 mph | 22 mph | 4 | |
| Heat | 88 °F | 108 °F | 4 | |
| Cold | 48 °F | 33 °F | 3 | |

**7+ = Play, 4–7 = Iffy, below 4 = Skip.** Every threshold is a judgment call for recreational tennis, and they all live in [`courtcast/config.py`](courtcast/config.py) so they're easy to tune.

### Wind thresholds

Wind also rates each court on its own. The Wind view colors courts by this rating, and it caps the overall score, so a nice warm day with 25 mph gusts still shows red.

| Wind rating | Gusts | or steady wind |
|---|---|---|
| Play | 0–7 mph | under 8 mph |
| Iffy | 8–24 mph | 8–17 mph |
| Skip | 25+ mph | 18+ mph |

**Where these come from.** A drag simulation of a tennis ball (57.5 g, 6.7 cm across, drag coefficient about 0.55) in a crosswind shows how far each shot gets pushed sideways:

| Crosswind | Serve toss | Rally ball (60 mph shot) | Lob |
|---|---|---|---|
| 10 mph | 0.2 m | 0.7 m | 2.4 m |
| 15 mph | 0.4 m | 1.1 m | 3.7 m |
| 20 mph | 0.7 m | 1.5 m | 5.2 m |
| 25 mph | 1.0 m | 1.9 m (wider than a doubles alley) | 6.8 m |

The group sets the Play cutoff at 7 mph: even a 10 mph gust moves a serve toss about 0.2 m, about three ball-widths. Above 25 mph, a serve toss moves a full meter and rally balls get pushed more than an alley's width. Coaches' advice lines up with this: about 15 mph is tough but playable, and 25+ is where most recreational players stop. The National Weather Service calls 15–25 mph "breezy" and 25+ "windy". Gusts count more than steady wind, because you can aim for a steady push but not for a gust.

## How it runs

```
GitHub Actions (every 2 hours)
  └─ courtcast/build.py
       ├─ courts.csv + a lat/lon grid  →  Open-Meteo (HRRR 3 km model for the first ~2 days)
       ├─ score.py: 0–10 for every point and hour
       ├─ site/data/forecast.json      →  published to GitHub Pages with the map (site/)
       └─ data/snapshots/YYYY-MM-DD.csv →  committed once a day
```

The daily snapshot stores each court's next-24-hour forecast as issued. That log is the raw material for checking the forecast against what actually happened (see the roadmap).

### Southern California: forecasts load in your browser

Precomputing every SoCal court every 2 hours would blow past Open-Meteo's free limit (10,000 calls a day, counted per IP address): about 1,500 sites plus a weather grid, 12 times a day. So outside the Inland Empire the map works differently:

- **Court list:** [`scripts/build_socal_courts.py`](scripts/build_socal_courts.py) builds `site/courts-socal.json` from OpenStreetMap: tennis courts grouped into sites, each named after the nearest park, school or college. Run it locally to refresh.
- **Live forecasts:** when you zoom in on an area, *your browser* asks Open-Meteo for the courts on screen (up to ~120, nearest the center first) plus a small 7×7 grid for the shading, then scores them itself. Each visitor uses their own free allowance, so covering more area costs nothing extra.
- **Same scoring everywhere:** the browser uses a copy of `score.py`. The thresholds come from the forecast data file, and [`tests/test_score_parity.py`](tests/test_score_parity.py) runs both versions on 5,000+ random hours and fails if they disagree.
- **Trade-offs:** a new area takes a second or two to load, and only the Inland Empire is logged in the daily snapshots.

## Run it locally

No dependencies beyond the Python standard library.

```bash
python -m unittest discover -s tests -t .
python -m courtcast.build
python -m http.server 8765 --directory site   # then open http://localhost:8765
```

## Add or fix a court

Edit [`courts.csv`](courts.csv) (`id,name,city,type,lat,lon`; `type` is `park`, `college` or `school`) and push. The map rebuilds automatically. To get coordinates, right-click the courts in Google Maps and copy the numbers.

## Roadmap

- **v2:** live radar overlay for pop-up storms in the next hour or two, where forecasts are weakest.
- **v3:** forecast verification. Compare the daily snapshots with observed rain and wind (radar-estimated rainfall plus nearby airport stations) and score the forecast with mean absolute error and Brier score.
- **v4:** learn the score. Log when the group actually played and fit the penalties from data instead of judgment.

## Data and credits

- Court locations: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL), curated to public parks, colleges and schools.
- Forecasts: [Open-Meteo](https://open-meteo.com/) (CC BY 4.0), using NOAA's HRRR and GFS models.
- Map: [Leaflet](https://leafletjs.com/) with OpenStreetMap tiles.
