import unittest

from courtcast.score import Hour, ramp, score_hour


def hour(**kw):
    base = dict(temp=72, rain_chance=0, rain=0, rain_prev1=0, rain_prev2_3=0, wind=4, gust=8)
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

    def test_ramp_both_directions(self):
        self.assertEqual(ramp(50, 40, 60, 4), 2.0)
        self.assertEqual(ramp(40, 48, 33, 3), 1.6)  # cold ramps downward
        self.assertEqual(ramp(100, 40, 60, 4), 4.0)


if __name__ == "__main__":
    unittest.main()
