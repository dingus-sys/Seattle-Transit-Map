"""Regression checks for shore-aligned passenger ferry terminals."""
import json
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))
from align_ferry_terminals import FERRY_SHORE_ENDPOINTS, meters  # noqa: E402


class FerryTerminalSnapTests(unittest.TestCase):
    def test_terminal_access_points_are_unique_and_in_puget_sound_region(self):
        self.assertEqual(len(FERRY_SHORE_ENDPOINTS), len(set(FERRY_SHORE_ENDPOINTS.values())))
        for stop_id, (lon, lat) in FERRY_SHORE_ENDPOINTS.items():
            self.assertTrue(stop_id.startswith("kt-"))
            self.assertGreater(lon, -123)
            self.assertLess(lon, -122)
            self.assertGreater(lat, 47)
            self.assertLess(lat, 48)

    def test_generated_terminal_markers_use_shore_access_points(self):
        data = json.loads((ROOT / "site/data/stops.json").read_text())
        station_for_stop = {
            stop_id: station
            for station in data["stations"]
            for stop_id in station.get("stops", [])
            if stop_id in FERRY_SHORE_ENDPOINTS
        }
        self.assertEqual(set(station_for_stop), set(FERRY_SHORE_ENDPOINTS))
        for stop_id, target in FERRY_SHORE_ENDPOINTS.items():
            station = station_for_stop[stop_id]
            self.assertLess(meters((station["lon"], station["lat"]), target), 1,
                            f"{stop_id} must sit on its shore-side access point")


if __name__ == "__main__":
    unittest.main()
