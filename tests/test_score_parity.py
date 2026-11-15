"""The browser scores courts outside the Inland Empire with its own copy of
score_hour (site/app.js). This test runs both on the same 5,000+ random hours
and fails if they ever disagree, so the two copies can't drift apart."""

import json
import random
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from courtcast.build import score_config
from courtcast.score import Hour, score_hour, wind_band

ROOT = Path(__file__).resolve().parent.parent


def make_cases(n=5000, seed=7):
    rnd = random.Random(seed)
    base = dict(temp=72, rain_chance=0, rain=0, rain_prev1=0, rain_prev2_3=0, wind=4, gust=6)
    edges = [base, {**base, "rain": 0.05}, {**base, "rain_prev1": 0.1}, {**base, "rain_prev2_3": 0.02, "gust": 8},
             {**base, "wind": 8, "gust": 25}, {**base, "temp": 110, "rain_chance": 90, "rain": 0.003, "wind": 20, "gust": 40},
             {**base, "temp": 30, "rain_chance": 10, "wind": 2, "gust": 3}]
    cases = list(edges)
    for _ in range(n):
        cases.append(dict(temp=rnd.choice([rnd.uniform(25, 115), round(rnd.uniform(25, 115))]),
                          rain_chance=rnd.choice([0, 0, rnd.uniform(0, 100)]),
                          rain=rnd.choice([0, 0, 0, rnd.uniform(0, 0.03), rnd.uniform(0, 0.3)]),
                          rain_prev1=rnd.choice([0, 0, rnd.uniform(0, 0.05)]),
                          rain_prev2_3=rnd.choice([0, 0, rnd.uniform(0, 0.05)]),
                          wind=rnd.uniform(0, 30), gust=rnd.uniform(0, 45)))
    out = []
    for c in cases:
        s, b, why = score_hour(Hour(**c))
        out.append({"in": c, "s": s, "b": b, "why": why, "wb": wind_band(c["gust"], c["wind"])})
    return out


@unittest.skipUnless(shutil.which("node"), "node not installed")
class TestBrowserScoringMatchesPython(unittest.TestCase):
    def test_same_scores(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "cases.json"
            path.write_text(json.dumps({"score": score_config(), "cases": make_cases()}), encoding="utf-8")
            res = subprocess.run(["node", str(ROOT / "tests" / "score_parity.mjs"), str(ROOT / "site" / "app.js"), str(path)],
                                 capture_output=True, text=True, check=True)
        report = json.loads(res.stdout)
        self.assertEqual(report["mismatches"], 0, f"browser and Python scoring differ: {report['examples']}")


if __name__ == "__main__":
    unittest.main()
