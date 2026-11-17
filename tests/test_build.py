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


class TestCellsAndGrid(unittest.TestCase):
    def test_courts_in_one_square_share_a_point(self):
        from courtcast.build import cells_of
        courts = [{"lat": 34.0001, "lon": -117.7001}, {"lat": 34.0049, "lon": -117.6951},   # same ~3 km square
                  {"lat": 34.1500, "lon": -117.4000}]                                       # far away
        pts, idx = cells_of(courts)
        self.assertEqual(len(pts), 2)
        self.assertEqual(idx[0], idx[1])
        self.assertNotEqual(idx[0], idx[2])
        self.assertAlmostEqual(pts[idx[0]][0], 34.0025, places=3)   # average of its courts

    def test_grid_only_near_courts(self):
        from courtcast.build import grid_points
        meta, all_pts, _ = grid_points(None)
        _, near, ij = grid_points([{"lat": 34.0, "lon": -117.7}])
        self.assertEqual(len(all_pts), meta["nlat"] * meta["nlon"])
        self.assertTrue(0 < len(near) < 12)                       # a handful around the one court
        self.assertTrue(all(0 <= i < meta["nlat"] and 0 <= j < meta["nlon"] for i, j in ij))
