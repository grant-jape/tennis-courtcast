import unittest

from courtcast.build import daily, details


class TestDetails(unittest.TestCase):
    def test_slices_rounds_and_keeps_daily(self):
        res = {
            "hourly": {"time": ["a", "b", "c"], "weather_code": [0, 3, 61], "apparent_temperature": [50.4, 51.6, None],
                       "relative_humidity_2m": [20.2, 30, 40], "uv_index": [0, 2.345, 5], "cloud_cover": [0, 50, 100]},
            "daily": {"time": ["2026-11-17"], "sunrise": ["2026-11-17T06:25"], "sunset": ["2026-11-17T16:45"],
                      "temperature_2m_max": [66.4], "temperature_2m_min": [50.7]},
        }
        d = details(res, 1, 2)
        self.assertEqual(d["wc"], [3, 61])
        self.assertEqual(d["ft"], [52, None])        # gaps stay gaps instead of becoming 0
        self.assertEqual(d["uv"], [2.3, 5])
        self.assertEqual((d["hi"], d["lo"]), ([66], [51]))
        self.assertEqual(daily(res)["sunset"], ["2026-11-17T16:45"])

    def test_missing_variables_are_empty_not_errors(self):
        d = details({"hourly": {"time": ["a", "b"]}}, 0, 2)
        self.assertEqual(d["wc"], [None, None])
        self.assertEqual(d["hi"], [])
        self.assertEqual(daily({"hourly": {}}), {"date": [], "sunrise": [], "sunset": []})


if __name__ == "__main__":
    unittest.main()
