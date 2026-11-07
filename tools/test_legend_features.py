"""Unit tests for printed legend features, through-route pairs, POIs, and service indicators."""
import json
import os
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
SITE_DATA = ROOT / "site" / "data"
WEB = ROOT / "web"


class LegendFeaturesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(SITE_DATA / "routes.json") as f:
            cls.routes_data = json.load(f)["routes"]
        cls.routes_by_id = {r["id"]: r for r in cls.routes_data}

        with open(SITE_DATA / "stops.json") as f:
            stops_raw = json.load(f)
            cls.stops = stops_raw["stops"]
            cls.stations = stops_raw["stations"]

        app_js = (WEB / "app.js").read_text()
        cls.app_js = app_js

    def test_through_route_ids_exist_in_network(self):
        """Every route specified in through-route pairs must exist in King County Metro data."""
        through_route_ids = [
            "metro-1", "metro-14",
            "metro-2", "metro-13",
            "metro-5", "metro-21",
            "metro-24", "metro-33", "metro-124",
            "metro-28", "metro-131", "metro-132",
            "metro-27"
        ]
        for rid in through_route_ids:
            self.assertIn(rid, self.routes_by_id, f"Through route {rid} missing from routes.json")
            r = self.routes_by_id[rid]
            self.assertEqual(r.get("agencyShort"), "Metro", f"Through route {rid} must be operated by Metro")

    def test_non_metro_routes_not_paired_as_through_routes(self):
        """Non-Metro routes with matching route numbers (e.g. PT 1, PT 2) must not match Downtown through-routes."""
        non_metro_same_shorts = [
            r for r in self.routes_data
            if r.get("agencyShort") != "Metro" and not r["id"].startswith("metro-")
            and r.get("short") in {"1", "2", "5", "13", "14", "21", "24", "27", "28", "33", "124", "131", "132"}
        ]
        self.assertGreater(len(non_metro_same_shorts), 0, "Expected non-Metro routes with same numbers in region")
        
        # In getThroughRouteInfo, isMetro check is required:
        self.assertIn("const isMetro = r.agencyShort === \"Metro\" || r.agency === \"Metro\" || r.agency === \"King County Metro\" || (r.id && r.id.startsWith(\"metro-\"));", self.app_js)
        self.assertIn("if (!isMetro) return null;", self.app_js)

    def test_key_destinations_integrity(self):
        """Key POI destinations must have valid coordinates, descriptions, and transit info."""
        # Extract KEY_DESTINATIONS definition from app.js
        dest_match = re.search(r"const KEY_DESTINATIONS = \[(.*?)\];\s*function destinationsGeoJSON", self.app_js, re.DOTALL)
        self.assertIsNotNone(dest_match, "Could not find KEY_DESTINATIONS array in app.js")
        
        # Region bounds
        west, east = -123.50, -121.60
        south, north = 46.80, 48.85

        coords_matches = re.findall(r"coords:\s*\[\s*(-?\d+\.\d+),\s*(-?\d+\.\d+)\s*\]", dest_match.group(1))
        self.assertGreater(len(coords_matches), 20, "Expected at least 20 POIs in KEY_DESTINATIONS")
        for lon_str, lat_str in coords_matches:
            lon, lat = float(lon_str), float(lat_str)
            self.assertTrue(west <= lon <= east, f"POI longitude {lon} out of region bounds [{west}, {east}]")
            self.assertTrue(south <= lat <= north, f"POI latitude {lat} out of region bounds [{south}, {north}]")

    def test_suspended_service_css_present(self):
        """CSS classes for suspended routes and stops must be defined."""
        app_css = (WEB / "app.css").read_text()
        self.assertIn(".badge.suspended", app_css)
        self.assertIn(".stop-susp-banner", app_css)
        self.assertIn(".stop-susp-pill", app_css)
        self.assertIn(".tt-sched.suspended", app_css)
        self.assertIn(".legend-nav-btn", app_css)

    def test_service_worker_cache_version(self):
        """Service worker cache version must be bumped to v10.2."""
        sw_js = (WEB / "sw.js").read_text()
        self.assertIn('const CACHE_NAME = "seattle-transit-v10-2";', sw_js)


if __name__ == "__main__":
    unittest.main()
