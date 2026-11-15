"""Turn one hour of weather at one spot into a 0-10 playability score.

Start at 10 and subtract a penalty for each thing that makes tennis worse.
Kept as plain rules (not a fitted model) on purpose: it is useful on day one
and every number is explainable. Later, logged outcomes can tune the numbers.
"""

from dataclasses import dataclass

from . import config as C


@dataclass
class Hour:
    temp: float          # F
    rain_chance: float   # percent
    rain: float          # inches this hour
    rain_prev1: float    # inches in the previous hour
    rain_prev2_3: float  # inches in the 2 hours before that
    wind: float          # mph sustained
    gust: float          # mph


def ramp(value, start, full, max_penalty):
    """0 at `start`, `max_penalty` at `full`, linear in between, clamped.

    Works in either direction: for cold, `full` is below `start`.
    """
    frac = (value - start) / (full - start)
    return max_penalty * min(1.0, max(0.0, frac))


def score_hour(h: Hour):
    """Return (score, band, reasons). Reasons are the biggest penalties."""
    if h.rain >= C.RAIN_STOP:
        return 0.0, "skip", [f"Raining ({h.rain:.2f} in/hr)"]

    penalties = []  # (points, reason)
    if h.rain >= C.DRIZZLE:
        penalties.append((C.DRIZZLE_PENALTY, "Drizzle"))
    if h.rain_prev1 >= C.RAIN_STOP:
        penalties.append((C.WET_LAST_HOUR_PENALTY, "Courts wet (rain last hour)"))
    elif h.rain_prev2_3 >= C.RAIN_STOP:
        penalties.append((C.WET_2_3H_PENALTY, "Courts drying (rain 2-3h ago)"))

    penalties.append((ramp(h.rain_chance, **C.RAIN_CHANCE), f"{h.rain_chance:.0f}% rain chance"))
    penalties.append((ramp(h.gust, **C.GUSTS), f"Gusts {h.gust:.0f} mph"))
    penalties.append((ramp(h.wind, **C.WIND), f"Wind {h.wind:.0f} mph"))
    penalties.append((ramp(h.temp, **C.HEAT), f"Hot ({h.temp:.0f}°F)"))
    penalties.append((ramp(h.temp, **C.COLD), f"Cold ({h.temp:.0f}°F)"))

    score = round(max(0.0, 10.0 - sum(p for p, _ in penalties)), 1)
    reasons = [r for p, r in sorted(penalties, reverse=True) if p >= 0.75][:2]
    return score, band(score), reasons


def band(score):
    if score >= C.GOOD_AT:
        return "play"
    if score >= C.IFFY_AT:
        return "iffy"
    return "skip"
