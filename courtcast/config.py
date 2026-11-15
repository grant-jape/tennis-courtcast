"""Settings for the region, the forecast request, and the playability score.

Every threshold here is a judgment call for recreational tennis, not a law of
nature. They live in one place so they are easy to tune once we have data on
when people actually played (see README, "Tuning the score").
"""

# --- Region -----------------------------------------------------------------
# Bounding box around Chino Hills -> Rialto, Pomona -> the foothills.
LAT_MIN, LAT_MAX = 33.98, 34.20
LON_MIN, LON_MAX = -117.78, -117.40

# Grid spacing for the map overlay. HRRR (the model behind the first ~2 days
# of the forecast) runs on a ~3 km grid; 0.03 deg lat ~ 3.3 km and 0.035 deg
# lon ~ 3.2 km at this latitude, so each cell is about one model grid box.
# A finer grid would only interpolate between the same model points.
GRID_STEP_LAT = 0.03
GRID_STEP_LON = 0.035

# --- Forecast request -------------------------------------------------------
TIMEZONE = "America/Los_Angeles"
MODEL = "gfs_seamless"  # HRRR 3 km for the near term, blended into GFS later
HOURLY_VARS = [
    "temperature_2m",
    "precipitation_probability",
    "precipitation",
    "wind_speed_10m",
    "wind_gusts_10m",
    "wind_direction_10m",
    "is_day",
]
HOURS_AHEAD = 36            # how far ahead the map lets you scrub
LOCATIONS_PER_REQUEST = 50  # keeps request URLs a sane length

# --- Playability score (0-10) -----------------------------------------------
# Each factor subtracts a penalty that ramps linearly from 0 at `start` to
# `max_penalty` at `full`. Precipitation is in inches, wind in mph, temp in F.
RAIN_STOP = 0.01              # >= this much rain in the hour: unplayable (score 0)
DRIZZLE = 0.002               # trace amounts: a big penalty but not a hard stop
DRIZZLE_PENALTY = 5.0
WET_LAST_HOUR_PENALTY = 5.0   # it rained in the previous hour: courts still wet
WET_2_3H_PENALTY = 2.5        # rained 2-3 hours ago: probably drying, puddles

RAIN_CHANCE = dict(start=10, full=100, max_penalty=3.0)   # percent
GUSTS = dict(start=12, full=35, max_penalty=6.0)          # mph
WIND = dict(start=8, full=25, max_penalty=3.0)            # mph, sustained
HEAT = dict(start=88, full=108, max_penalty=4.0)          # F, rising
COLD = dict(start=48, full=33, max_penalty=3.0)           # F, falling

GOOD_AT = 7.0   # score >= 7: "Play"
IFFY_AT = 4.0   # 4 <= score < 7: "Iffy"; below 4: "Skip"
