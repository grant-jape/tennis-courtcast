# Tennis CourtCast 🎾

**Court-by-court tennis weather for the Inland Empire.** A map of every public court from Claremont to Fontana, colored by a 0–10 playability score, with wind and rain layers and a time slider for the next 36 hours.

**Live map:** https://grant-jape.github.io/tennis-courtcast/

Rain at Day Creek doesn't mean rain at Claremont. Fontana can be gusting 25 mph while Chino is calm. A single city forecast hides that. CourtCast pulls a forecast for every court and for a ~3 km grid across the region, so you can see where it's playable and when.

## What's on the map

- **Playability layer:** each court pin shows its score. Grid squares tint red or amber where conditions are bad.
- **Wind layer:** gust strength by area, with arrows showing which way the wind blows.
- **Rain layer:** forecast rain amount by area.
- **Time slider:** scrub through the next 36 hours. The URL updates, so you can share a link like `…/#t=2026-11-16T14` ("what about Monday 2pm?").
- **Court popups:** current conditions, a 12-hour strip, and the best two-hour daylight window.
- **School courts** are behind a toggle because public access varies.

## How the score works

Start at 10 and subtract a penalty for each thing that makes tennis worse. Each penalty grows linearly between a "starts to matter" value and a "maxed out" value:

| Factor | No penalty below | Full penalty at | Max points off | Why |
|---|---|---|---|---|
| Rain this hour | | ≥ 0.01 in | score = 0 | Measurable rain means wet lines and slipping |
| Rain last hour | | ≥ 0.01 in | 5 | Hard courts need about an hour of sun or wind to dry |
| Rain 2–3 hours ago | | ≥ 0.01 in | 2.5 | Mostly dry, but puddles linger |
| Rain chance | 10% | 100% | 3 | Risk of getting rained out mid-set |
| Gusts | 12 mph | 35 mph | 6 | Gusts wreck tosses and lobs more than steady wind |
| Sustained wind | 8 mph | 25 mph | 3 | |
| Heat | 88 °F | 108 °F | 4 | |
| Cold | 48 °F | 33 °F | 3 | |

**7+ = Play, 4–7 = Iffy, below 4 = Skip.** Every threshold is a judgment call for recreational tennis, and they all live in [`courtcast/config.py`](courtcast/config.py) so they're easy to tune.

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
