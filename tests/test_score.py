import unittest

from courtcast.score import Hour, ramp, score_hour, wind_band


def hour(**kw):
    base = dict(temp=72, rain_chance=0, rain=0, rain_prev1=0, rain_prev2_3=0, wind=4, gust=6)
    base.update(kw)
    return Hour(**base)


class TestScore(unittest.TestCase):
    def test_perfect_day_is_ten(self):
        s, band, why = score_hour(hour())
        self.assertEqual((s, band, why), (10.0, "play", []))

    def test_rain_is_a_hard_stop(self):
        self.assertEqual(score_hour(hour(rain=0.05))[0], 0.0)

    def test_wet_courts_after_rain(self):
        s, band, why = score_hour(hour(rain_prev1=0.1))
        self.assertEqual(s, 5.0)
        self.assertIn("wet", why[0])

    def test_gusts_hurt_and_are_explained(self):
        s, band, why = score_hour(hour(gust=30, wind=15))
        self.assertLess(s, 7)
        self.assertTrue(why[0].startswith("Gusts"))

    def test_score_never_negative(self):
        s, band, _ = score_hour(hour(gust=60, wind=40, temp=115, rain_chance=100))
        self.assertEqual((s, band), (0.0, "skip"))

    def test_wind_bands(self):
        self.assertEqual(wind_band(gust=7, wind=4), "play")     # 0-7 mph gusts play
        self.assertEqual(wind_band(gust=8, wind=4), "iffy")     # gust threshold
        self.assertEqual(wind_band(gust=24, wind=12), "iffy")
        self.assertEqual(wind_band(gust=25, wind=8), "skip")
        self.assertEqual(wind_band(gust=20, wind=18), "skip")   # steady-wind threshold

    def test_skip_level_wind_caps_a_nice_day(self):
        # 25 mph gusts on an otherwise perfect day must not show green or amber.
        s, band, why = score_hour(hour(gust=25, wind=8))
        self.assertEqual(band, "skip")
        self.assertTrue(why[0].startswith("Gusts"))

    def test_iffy_wind_caps_at_iffy(self):
        s, band, _ = score_hour(hour(gust=12, wind=6))
        self.assertEqual(band, "iffy")
        self.assertLessEqual(s, 6.9)

    def test_light_breeze_still_plays(self):
        self.assertEqual(score_hour(hour(gust=7, wind=4))[1], "play")

    def test_ramp_both_directions(self):
        self.assertEqual(ramp(50, 40, 60, 4), 2.0)
        self.assertEqual(ramp(40, 48, 33, 3), 1.6)  # cold ramps downward
        self.assertEqual(ramp(100, 40, 60, 4), 4.0)


if __name__ == "__main__":
    unittest.main()
