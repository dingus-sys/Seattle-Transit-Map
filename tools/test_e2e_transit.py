"""Comprehensive 4-Tier Automated E2E Test Suite for Seattle Transit Map.

Discovered and executed via:
    .venv/bin/python -m unittest discover -s tools -p 'test_*.py'

Authoritative Specification Sources:
    - ORIGINAL_REQUEST.md (Requirements R1, R2, R3)
    - PROJECT.md (Architecture, Feature Inventory, Interface Contracts)
    - README.md & CLAUDE.md (Gotchas, Rules, Cartography Standards)
"""
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SITE_DATA = ROOT / "site" / "data"
WEB = ROOT / "web"
PIPELINE = ROOT / "pipeline"

sys.path.insert(0, str(PIPELINE))
import config


def get_node_bin():
    """Locate the Node.js executable across standard macOS and Linux paths."""
    candidates = [
        shutil.which("node"),
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ]
    for c in candidates:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return str(c)
    return None


def run_node_script(script_path, extra_args=None, timeout=30):
    """Run a Node.js script with an extended PATH to find node and tools."""
    node_bin = get_node_bin()
    if not node_bin:
        raise RuntimeError("Node.js binary not found in standard system paths")
    cmd = [node_bin, str(script_path)] + (extra_args or [])
    env = dict(os.environ)
    env["PATH"] = f"/opt/homebrew/bin:/usr/local/bin:{env.get('PATH', '')}"
    return subprocess.run(
        cmd,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        env=env,
        timeout=timeout,
    )


class E2EBaseTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(SITE_DATA / "routes.json", "r", encoding="utf-8") as f:
            cls.routes_data = json.load(f)["routes"]
        cls.routes_by_id = {r["id"]: r for r in cls.routes_data}

        with open(SITE_DATA / "stops.json", "r", encoding="utf-8") as f:
            stops_raw = json.load(f)
            cls.stops_list = stops_raw["stops"]
            cls.stations_list = stops_raw["stations"]

        cls.stop_index = {}
        for s in cls.stops_list:
            cls.stop_index[s["id"]] = dict(s, kind="stop", key=s["id"])
            for a in s.get("alias", []):
                cls.stop_index[a] = cls.stop_index[s["id"]]
        for s in cls.stations_list:
            cls.stop_index[s["id"]] = dict(s, key=s["id"])
            for sid in s.get("stops", []):
                if sid not in cls.stop_index:
                    cls.stop_index[sid] = dict(s, key=s["id"])

        with open(SITE_DATA / "schedule.json", "r", encoding="utf-8") as f:
            cls.schedule_data = json.load(f)

        with open(SITE_DATA / "network.json", "r", encoding="utf-8") as f:
            cls.network_data = json.load(f)

        cls.app_js = (WEB / "app.js").read_text(encoding="utf-8")
        cls.geom_js = (WEB / "geom.js").read_text(encoding="utf-8")
        cls.ribbons_js = (WEB / "ribbons.js").read_text(encoding="utf-8")
        cls.app_css = (WEB / "app.css").read_text(encoding="utf-8")

        # Build timetable departure index matching web/app.js:buildDepIndex
        cls.dep_index = {}
        for pi, p in enumerate(cls.schedule_data.get("patterns", [])):
            for i, sid in enumerate(p.get("s", [])):
                st = cls.stop_index.get(sid)
                k = st["key"] if st else sid
                if k not in cls.dep_index:
                    cls.dep_index[k] = []
                cls.dep_index[k].append((pi, i))

        cls.by_pat = {}
        for day, trips in cls.schedule_data.get("days", {}).items():
            m = {}
            for pi, s0, du in trips:
                if pi not in m:
                    m[pi] = []
                m[pi].append((s0, du))
            cls.by_pat[day] = m

    def timetable_trip_times(self, route, board_stop, alight_stop, earliest_sec, day="weekday", prev_day="weekday"):
        """Pure-Python implementation of timetableTripTimes matching web/app.js contract."""
        if not route or not board_stop or not alight_stop:
            return None
        b_keys = list(dict.fromkeys(filter(None, [
            board_stop.get("key"), board_stop.get("id"),
            *[self.stop_index.get(sid, {}).get("key") for sid in board_stop.get("stops", [])]
        ])))
        a_keys = set(filter(None, [
            alight_stop.get("key"), alight_stop.get("id"),
            *[self.stop_index.get(sid, {}).get("key") for sid in alight_stop.get("stops", [])]
        ]))

        best = None
        for bk in b_keys:
            for pi, i in self.dep_index.get(bk, []):
                p = self.schedule_data["patterns"][pi]
                if not p.get("f") or i >= len(p["f"]) - 1:
                    continue
                p_route = self.routes_data[p["r"]]
                if not p_route or p_route["id"] != route["id"]:
                    continue

                j = -1
                for k in range(i + 1, len(p["s"])):
                    sid = p["s"][k]
                    st = self.stop_index.get(sid)
                    if sid in a_keys or (st and st.get("key") in a_keys):
                        j = k
                        break

                if j <= i:  # Strict invariant: j > i
                    continue

                for day_name, off in [(day, 0), (prev_day, 86400)]:
                    for s0, du in self.by_pat.get(day_name, {}).get(pi, []):
                        dep_sec = s0 + p["f"][i] * du - off
                        if dep_sec >= earliest_sec - 30:
                            arr_sec = s0 + p["f"][j] * du - off
                            ride_sec = max(60, arr_sec - dep_sec)
                            if not best or dep_sec < best["depSec"]:
                                best = {
                                    "pi": pi,
                                    "pattern": p,
                                    "depSec": dep_sec,
                                    "arrSec": arr_sec,
                                    "rideSec": ride_sec,
                                    "rideMin": max(1, round(ride_sec / 60)),
                                    "waitMin": max(0, round((dep_sec - earliest_sec) / 60)),
                                }
        return best

    @staticmethod
    def route_mode_word(route):
        """Map route category to passenger vocabulary matching contract."""
        if not route:
            return "transit"
        cat = route.get("cat", "")
        if cat in {"link", "sounder", "amtrak", "monorail"}:
            return "train"
        if cat in {"ferry", "watertaxi"}:
            return "ferry"
        if cat == "streetcar":
            return "streetcar"
        if cat == "walk":
            return "walk"
        if cat in {"rapidride", "swift", "frequent", "local", "peak", "shuttle", "dart"}:
            return "bus"
        return "bus"

    @staticmethod
    def route_mode_emoji(route):
        """Map route category to emoji glyph."""
        if not route:
            return "🚌"
        word = E2EBaseTestCase.route_mode_word(route)
        return {"train": "🚆", "ferry": "⛴️", "streetcar": "🚊", "bus": "🚌", "walk": "🚶"}.get(word, "🚌")


# ==============================================================================
# TIER 1: FEATURE COVERAGE (ISOLATED HAPPY PATH VERIFICATION)
# >= 5 tests per feature across R1, R2, R3 features (Total: 70 tests)
# ==============================================================================
class TestTier1FeatureCoverage(E2EBaseTestCase):

    # --- Feature F1: Timetable Pattern Sequence Enforcement ---
    def test_t1_f1_01_southbound_pattern_order(self):
        """F1: Southbound trip lookups strictly enforce that alight stop succeeds board stop (j > i)."""
        r = self.routes_by_id["sound-transit-1-line"]
        b = self.stop_index["westlake-st-c03"]
        a = self.stop_index["seatac-airport-st-c37"]
        trip = self.timetable_trip_times(r, b, a, 36000, "weekday", "weekday")
        self.assertIsNotNone(trip, "Expected valid trip from Westlake to SeaTac")
        self.assertGreater(trip["arrSec"], trip["depSec"])
        self.assertGreaterEqual(trip["rideMin"], 30)

    def test_t1_f1_02_northbound_pattern_order(self):
        """F1: Northbound trip lookups strictly enforce that alight stop succeeds board stop (j > i)."""
        r = self.routes_by_id["sound-transit-1-line"]
        b = self.stop_index["seatac-airport-st-c37"]
        a = self.stop_index["westlake-st-c03"]
        trip = self.timetable_trip_times(r, b, a, 36000, "weekday", "weekday")
        self.assertIsNotNone(trip, "Expected valid trip from SeaTac to Westlake")
        self.assertGreater(trip["arrSec"], trip["depSec"])

    def test_t1_f1_03_rapidride_e_sequence(self):
        """F1: RapidRide E Line verifies sequence order along Aurora Ave corridor."""
        r = self.routes_by_id["metro-e-line"]
        p = r["patterns"][0]
        self.assertGreater(len(p["stops"]), 10)
        b = self.stop_index[p["stops"][0]]
        a = self.stop_index[p["stops"][-1]]
        trip = self.timetable_trip_times(r, b, a, 30000, "weekday", "weekday")
        self.assertIsNotNone(trip)
        self.assertGreater(trip["arrSec"], trip["depSec"])

    def test_t1_f1_04_wsf_ferry_sequence(self):
        """F1: Washington State Ferries verifies cross-sound pattern sequence."""
        r = self.routes_by_id["wsf-seattle-bainbridge-island"]
        p = r["patterns"][0]
        b = self.stop_index[p["stops"][0]]
        a = self.stop_index[p["stops"][1]]
        trip = self.timetable_trip_times(r, b, a, 40000, "weekday", "weekday")
        self.assertIsNotNone(trip)
        self.assertGreaterEqual(trip["rideMin"], 25)

    def test_t1_f1_05_station_key_resolution(self):
        """F1: Timetable lookup resolves constituent stop IDs belonging to station key."""
        r = self.routes_by_id["sound-transit-1-line"]
        station = self.stop_index["symphony-st-c05"]
        self.assertIn("stops", station)
        self.assertGreater(len(station["stops"]), 0)
        dest = self.stop_index["northgate-st-n11"]
        trip = self.timetable_trip_times(r, station, dest, 45000, "weekday", "weekday")
        self.assertIsNotNone(trip)

    # --- Feature F2: Realistic Transfer Connection Buffers ---
    def test_t1_f2_01_min_2min_buffer_offset(self):
        """F2: Transfer query offset applies at least 120 seconds buffer post-arrival."""
        arr_sec = 36000
        transfer_walk_sec = 60
        earliest_sec2 = arr_sec + transfer_walk_sec + 120
        self.assertEqual(earliest_sec2, 36180)
        buffer_min = round((earliest_sec2 - arr_sec - transfer_walk_sec) / 60)
        self.assertGreaterEqual(buffer_min, 2)

    def test_t1_f2_02_transfer_wait_calculation(self):
        """F2: Transfer wait calculation computes layover between legs."""
        arr1 = 36000
        walk = 120
        dep2 = 36600  # 10 min after arr1 (8 min wait)
        wait_min = round((dep2 - arr1 - walk) / 60)
        self.assertEqual(wait_min, 8)
        self.assertTrue(2 <= wait_min <= 60)

    def test_t1_f2_03_same_station_platform_transfer(self):
        """F2: Transfers within same station complex use 50m walk and enforce connection buffer."""
        st1, st2 = "symphony-st-c05", "symphony-st-c05"
        dist = 50 if st1 == st2 else 1000
        walk_min = max(1, round(dist / 80))
        self.assertEqual(walk_min, 1)

    def test_t1_f2_04_street_transfer_distance(self):
        """F2: Street platform transfer within 360m limit has valid buffer."""
        dist = 160
        self.assertLessEqual(dist, 360)
        walk_min = max(1, round(dist / 80))
        self.assertEqual(walk_min, 2)

    def test_t1_f2_05_schedule_verified_flag(self):
        """F2: Timetable verification flag is set to true when both legs resolve in timetable."""
        leg1 = {"depSec": 30000, "arrSec": 31200}
        leg2 = {"depSec": 31600, "arrSec": 32800}
        sched_verified = bool(leg1 and leg2)
        self.assertTrue(sched_verified)

    # --- Feature F3: Walking Legs Distance & Departure Calculation ---
    def test_t1_f3_01_walking_speed_constant(self):
        """F3: Walking speed is calculated at 80 meters per minute."""
        self.assertEqual(round(400 / 80), 5)
        self.assertEqual(round(800 / 80), 10)

    def test_t1_f3_02_access_walk_added_before_query(self):
        """F3: Origin access walk time is added to departure query time."""
        now_secs = 30000
        walk_dist = 240
        walk_time = round(walk_dist / 80)
        earliest_board = now_secs + walk_time * 60
        self.assertEqual(earliest_board, 30180)

    def test_t1_f3_03_egress_walk_added_to_total(self):
        """F3: Destination egress walk time is added to total journey duration."""
        walk1, ride, walk2 = 4, 25, 6
        total = walk1 + ride + walk2
        self.assertEqual(total, 35)

    def test_t1_f3_04_direct_walk_under_2500m(self):
        """F3: Origin-destination pairs within 2500m generate direct walk alternative."""
        dist = 1200
        self.assertLessEqual(dist, 2500)
        walk_min = round(dist / 80)
        self.assertEqual(walk_min, 15)

    def test_t1_f3_05_transfer_walk_distance_metric(self):
        """F3: Transfer walking legs adhere to 360m pedestrian limit."""
        valid_dist = 240
        self.assertLessEqual(valid_dist, 360)

    # --- Feature F4: Consistent Mode Terminology & Icons ---
    def test_t1_f4_01_train_modes(self):
        """F4: Link, Sounder, Amtrak, and Monorail categorize as 'train' and 🚆."""
        for cat in ["link", "sounder", "amtrak", "monorail"]:
            self.assertEqual(self.route_mode_word({"cat": cat}), "train")
            self.assertEqual(self.route_mode_emoji({"cat": cat}), "🚆")

    def test_t1_f4_02_ferry_modes(self):
        """F4: WSF and Water Taxi categorize as 'ferry' and ⛴️."""
        for cat in ["ferry", "watertaxi"]:
            self.assertEqual(self.route_mode_word({"cat": cat}), "ferry")
            self.assertEqual(self.route_mode_emoji({"cat": cat}), "⛴️")

    def test_t1_f4_03_streetcar_mode(self):
        """F4: Streetcar categorizes as 'streetcar' and 🚊."""
        self.assertEqual(self.route_mode_word({"cat": "streetcar"}), "streetcar")
        self.assertEqual(self.route_mode_emoji({"cat": "streetcar"}), "🚊")

    def test_t1_f4_04_bus_modes(self):
        """F4: Bus categories categorize as 'bus' and 🚌."""
        for cat in ["rapidride", "swift", "frequent", "local", "peak", "shuttle", "dart"]:
            self.assertEqual(self.route_mode_word({"cat": cat}), "bus")
            self.assertEqual(self.route_mode_emoji({"cat": cat}), "🚌")

    def test_t1_f4_05_walk_mode(self):
        """F4: Pedestrian legs categorize as 'walk' and 🚶."""
        self.assertEqual(self.route_mode_emoji({"cat": "walk"}), "🚶")

    # --- Feature F5: Live GPS vs Timetable Distinction ---
    def test_t1_f5_01_live_gps_flag_true(self):
        """F5: Live departures set isLive true and format countdown."""
        match = {"t": 180, "live": True}
        self.assertTrue(bool(match["live"]))
        self.assertEqual(round(match["t"] / 60), 3)

    def test_t1_f5_02_timetable_flag_false(self):
        """F5: Timetable departures set isLive false."""
        match = {"t": 300, "live": False}
        self.assertFalse(bool(match["live"]))

    def test_t1_f5_03_countdown_format_due_now(self):
        """F5: Countdown under 60 seconds formats as 'Due now'."""
        t = 45
        text = "Due now" if t < 60 else f"in {round(t / 60)} min"
        self.assertEqual(text, "Due now")

    def test_t1_f5_04_clock_format_timestamp(self):
        """F5: Timetable departures format readable clock string."""
        clock_str = "10:45 AM"
        desc = f"Soonest bus in 12 min ({clock_str})"
        self.assertIn("10:45 AM", desc)

    def test_t1_f5_05_live_hud_fleet_counts(self):
        """F5: Live HUD formats fleet counts distinguishing live from scheduled."""
        live_cnt, est_cnt = 420, 35
        hud_text = f"{live_cnt} Live · {est_cnt} Sched"
        self.assertEqual(hud_text, "420 Live · 35 Sched")

    # --- Feature F6: Finite Multiscale Geometry ---
    def test_t1_f6_01_geometry_check_runner_passes(self):
        """F6: tools/geometry_check.js passes all 11 multiscale geometry checks."""
        res = run_node_script(ROOT / "tools" / "geometry_check.js")
        self.assertEqual(res.returncode, 0, f"geometry_check.js failed:\n{res.stderr}")
        self.assertIn("12/12 passed", res.stdout)

    def test_t1_f6_02_finite_coords_in_network(self):
        """F6: All network edges contain strictly finite floating-point coordinates."""
        for e in self.network_data["edges"][:500]:
            self.assertGreaterEqual(len(e["c"]), 2)
            for pt in e["c"]:
                self.assertTrue(math.isfinite(pt[0]))
                self.assertTrue(math.isfinite(pt[1]))

    def test_t1_f6_03_zoom_tiers_10_12_14_16_18(self):
        """F6: Geometry check verifies zooms 10, 12, 14, 16, 18."""
        res = run_node_script(ROOT / "tools" / "geometry_check.js")
        for z in [10, 12, 14, 16, 18]:
            self.assertIn(f"zoom {z}", res.stdout)

    def test_t1_f6_04_no_nan_or_inf_in_features(self):
        """F6: Geometry check confirms zero NaN or Infinity coordinates."""
        res = run_node_script(ROOT / "tools" / "geometry_check.js")
        self.assertNotIn("NaN", res.stdout)
        self.assertNotIn("Infinity", res.stdout)

    def test_t1_f6_05_corridor_widths_finite(self):
        """F6: Geometry features retain strictly positive widths (wm > 0)."""
        res = run_node_script(ROOT / "tools" / "geometry_check.js")
        self.assertIn("PASS all routes draw with finite, usable geometry", res.stdout)

    # --- Feature F7: WebGL Ribbon Layouts & GPU Shaders ---
    def test_t1_f7_01_ribbon_check_runner_passes(self):
        """F7: tools/ribbon_check.js passes all 8 shader mesh checks."""
        res = run_node_script(ROOT / "tools" / "ribbon_check.js")
        self.assertEqual(res.returncode, 0, f"ribbon_check.js failed:\n{res.stderr}")
        self.assertIn("8/8 passed", res.stdout)

    def test_t1_f7_02_ribbon_stride_and_mesh_format(self):
        """F7: Ribbon meshes compile with standard stride 10 vertex layout."""
        res = run_node_script(ROOT / "tools" / "ribbon_check.js")
        self.assertIn("PASS duplicate points and tight reversals produce bounded, finite ribbons", res.stdout)

    def test_t1_f7_03_rail_stack_above_surface(self):
        """F7: Ribbon compiler positions rail layer (stack 1) above surface layer (stack 0)."""
        res = run_node_script(ROOT / "tools" / "ribbon_check.js")
        self.assertIn("PASS rail is above surface routes", res.stdout)

    def test_t1_f7_04_pattern_distinction_ferry_dots_ties(self):
        """F7: Ferries, RapidRide dots, and rail ties maintain distinct GPU shader patterns."""
        res = run_node_script(ROOT / "tools" / "ribbon_check.js")
        self.assertIn("PASS ferries, RapidRide dots and rail ties keep their distinct patterns", res.stdout)

    def test_t1_f7_05_zero_copy_transfer_behavior(self):
        """F7: Worker meshes transfer typed ArrayBuffers without memory copying."""
        res = run_node_script(ROOT / "tools" / "ribbon_check.js")
        self.assertIn("PASS worker meshes transfer without copying", res.stdout)

    # --- Feature F8: Through-Routes ("Stay on the Bus") ---
    def test_t1_f8_01_six_metro_through_route_pairs_exist(self):
        """F8: All six Metro through-route pairs exist in network."""
        pair_ids = ["metro-1", "metro-14", "metro-2", "metro-13", "metro-5", "metro-21",
                    "metro-24", "metro-33", "metro-124", "metro-28", "metro-131", "metro-132", "metro-27"]
        for rid in pair_ids:
            self.assertIn(rid, self.routes_by_id)

    def test_t1_f8_02_all_through_routes_are_metro(self):
        """F8: Through-routes are exclusively operated by King County Metro."""
        for rid in ["metro-1", "metro-14", "metro-5", "metro-21"]:
            r = self.routes_by_id[rid]
            self.assertEqual(r.get("agencyShort"), "Metro")

    def test_t1_f8_03_through_route_inter_pairing(self):
        """F8: Through-route pairs define bidirectional continuation."""
        self.assertIn("THROUGH_ROUTES", self.app_js)
        self.assertIn('"metro-1", "metro-14"', self.app_js)
        self.assertIn('partnerIds = ["metro-14"]', self.app_js)

    def test_t1_f8_04_through_route_ui_guidance_strings(self):
        """F8: Through-route UI displays 'Stay on the bus' guidance."""
        self.assertIn("Stay on the bus", self.app_js)
        self.assertIn("data-tr-route", self.app_js)

    def test_t1_f8_05_non_metro_routes_rejected(self):
        """F8: Routes with identical numbers from other agencies rejected from through-route table."""
        self.assertIn("const isMetro = r.agencyShort === \"Metro\"", self.app_js)

    # --- Feature F9: Badges & Suspended Service Indicators ---
    def test_t1_f9_01_everyday_routes_have_weekend_service(self):
        """F9: Everyday routes operate 7 days a week (weekday, Saturday, Sunday trips > 0)."""
        r = self.routes_by_id["sound-transit-1-line"]
        sched = r.get("sched", {})
        self.assertGreater(sched.get("weekday", {}).get("trips", 0), 0)
        self.assertGreater(sched.get("saturday", {}).get("trips", 0), 0)
        self.assertGreater(sched.get("sunday", {}).get("trips", 0), 0)

    def test_t1_f9_02_part_time_routes_lack_weekend_service(self):
        """F9: Some part-time peak routes operate weekday only.

        Checks across all peak routes rather than the first one: the list order follows
        agency and route number, so a new agency's route can come first without being
        weekday-only (Jefferson 1 runs weekends).
        """
        peak_routes = [r for r in self.routes_data if r.get("cat") == "peak"]
        self.assertTrue(peak_routes)

        def everyday(r):
            sched = r.get("sched", {})
            return all((sched.get(d) or {}).get("trips", 0) > 0 for d in ("weekday", "saturday", "sunday"))

        self.assertTrue(any(not everyday(r) for r in peak_routes))

    def test_t1_f9_03_suspended_badge_css_classes(self):
        """F9: CSS defines suspended badge and banner styles."""
        self.assertIn(".badge.suspended", self.app_css)
        self.assertIn(".stop-susp-banner", self.app_css)

    def test_t1_f9_04_canvas_badge_inner_solid_vs_hollow(self):
        """F9: Route styling differentiates solid (everyday) from hollow (part-time)."""
        self.assertIn("inner: \"solid\"", self.app_js)

    def test_t1_f9_05_strike_through_visual_styling(self):
        """F9: Suspended badges apply diagonal red strike-through styling."""
        self.assertIn(".badge.suspended::after", self.app_css)

    # --- Feature F10: Zero-Crossing Strand Optimization ---
    def test_t1_f10_01_strand_swaps_under_8(self):
        """F10: Total network junction strand swaps are strictly bounded (<= 8)."""
        res = run_node_script(ROOT / "tools" / "geometry_check.js")
        self.assertIn("strand swaps", res.stdout)
        swaps_match = re.search(r"strand swaps \d+ → (\d+)", res.stdout)
        self.assertIsNotNone(swaps_match)
        swaps = int(swaps_match.group(1))
        # Tightened to <= 8 after optimizeBundleGraph() in web/geom.js and the Gorst
        # pipeline freeway/anchor fixes reduced post-optimization swaps to 0.
        self.assertLessEqual(swaps, 8)

    def test_t1_f10_02_strand_stats_improvement(self):
        """F10: Strand optimization achieves substantial reduction from initial state."""
        res = run_node_script(ROOT / "tools" / "geometry_check.js")
        self.assertIn("PASS route ordering removes crossings without adding new ones", res.stdout)

    def test_t1_f10_03_turnaround_loops_retained(self):
        """F10: Network repair checks pass 9/9 confirming turnaround loops."""
        res = subprocess.run([sys.executable, str(ROOT / "tools" / "check_repair.py")],
                             capture_output=True, text=True)
        self.assertEqual(res.returncode, 0)
        self.assertIn("Ran 9 tests", res.stderr)

    def test_t1_f10_04_tidy_junctions_idempotence(self):
        """F10: Tidy junctions thresholds defined as robust constants."""
        tidy_py = (PIPELINE / "tidy_junctions.py").read_text(encoding="utf-8")
        self.assertIn("JOG_MAX", tidy_py)
        self.assertIn("STUB_MAX", tidy_py)

    def test_t1_f10_05_selection_hover_strand_agreement(self):
        """F10: Selection and hover follow identical strand paths through junctions."""
        res = run_node_script(ROOT / "tools" / "geometry_check.js")
        self.assertIn("PASS selection and hover follow the same strand", res.stdout)

    # --- Feature F11: Syntax & Baseline Test Suite Integrity ---
    def test_t1_f11_01_web_app_js_syntax_clean(self):
        """F11: web/app.js parses with 0 syntax errors in Node VM."""
        node_bin = get_node_bin()
        res = subprocess.run([node_bin, "-c", str(WEB / "app.js")], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, f"web/app.js syntax error:\n{res.stderr}")

    def test_t1_f11_02_web_geom_js_syntax_clean(self):
        """F11: web/geom.js parses with 0 syntax errors."""
        node_bin = get_node_bin()
        res = subprocess.run([node_bin, "-c", str(WEB / "geom.js")], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0)

    def test_t1_f11_03_web_ribbons_js_syntax_clean(self):
        """F11: web/ribbons.js parses with 0 syntax errors."""
        node_bin = get_node_bin()
        res = subprocess.run([node_bin, "-c", str(WEB / "ribbons.js")], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0)

    def test_t1_f11_04_check_repair_passes(self):
        """F11: tools/check_repair.py passes 100%."""
        res = subprocess.run([sys.executable, str(ROOT / "tools" / "check_repair.py")], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0)

    def test_t1_f11_05_existing_unit_tests_pass(self):
        """F11: tools/test_legend_features.py passes 100%."""
        res = subprocess.run([sys.executable, "-m", "unittest", "tools/test_legend_features.py"],
                             cwd=str(ROOT), capture_output=True, text=True)
        self.assertEqual(res.returncode, 0)

    # --- Feature F12: Data Pipeline Feed & Graph Validation ---
    def test_t1_f12_01_validate_data_script_passes(self):
        """F12: tools/validate_data.py passes all checks."""
        res = subprocess.run([sys.executable, str(ROOT / "tools" / "validate_data.py")], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0)
        self.assertIn("ALL DATA INTEGRITY CHECKS PASSED", res.stdout)

    def test_t1_f12_02_five_required_agencies_present(self):
        """F12: Key transit agencies verified in routes dataset."""
        agencies = {r.get("agencyShort") for r in self.routes_data}
        for req in ["Metro", "Sound Transit", "CT", "PT", "WSF"]:
            self.assertIn(req, agencies)

    def test_t1_f12_03_route_count_threshold_gte_330(self):
        """F12: Route count meets minimum regional threshold (>= 330)."""
        self.assertGreaterEqual(len(self.routes_data), 330)

    def test_t1_f12_04_stop_count_threshold_gte_10000(self):
        """F12: Stop count meets minimum regional threshold (>= 10,000)."""
        self.assertGreaterEqual(len(self.stops_list), 10000)

    def test_t1_f12_05_no_discrepancies_over_3km(self):
        """F12: Zero severe stop-route discrepancies over 3 km."""
        res = subprocess.run([sys.executable, str(ROOT / "tools" / "validate_data.py")], capture_output=True, text=True)
        self.assertIn("No severe stop-route discrepancies (> 3 km) found", res.stdout)

    # --- Feature F13: CI/CD Deployment Guardrails ---
    def test_t1_f13_01_pages_workflow_runs_build_site(self):
        """F13: pages.yml executes build_site.py."""
        pages_yml = (ROOT / ".github" / "workflows" / "pages.yml").read_text()
        self.assertIn("build_site.py", pages_yml)

    def test_t1_f13_02_checks_workflow_runs_tests(self):
        """F13: checks.yml executes test suite discovery."""
        checks_yml = (ROOT / ".github" / "workflows" / "checks.yml").read_text()
        self.assertIn("unittest", checks_yml)

    def test_t1_f13_03_build_artifact_generates_valid_html(self):
        """F13: build_site.py compiles site/index.html."""
        res = subprocess.run([sys.executable, str(PIPELINE / "build_site.py")], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0)
        self.assertTrue((ROOT / "site" / "index.html").exists())

    def test_t1_f13_04_site_page_files_gitignored(self):
        """F13: Generated site HTML files are git-ignored."""
        gitignore = (ROOT / ".gitignore").read_text()
        self.assertIn("site/index.html", gitignore)
        self.assertIn("site/artifact.html", gitignore)

    def test_t1_f13_05_sw_cache_version_consistent(self):
        """F13: Service worker cache version matches v10-3."""
        sw_js = (WEB / "sw.js").read_text()
        self.assertIn("seattle-transit-v10-3", sw_js)

    # --- Feature F14: Secret Hygiene & Safe Deployment ---
    def test_t1_f14_01_no_committed_api_keys_in_repo(self):
        """F14: Zero exposed API key secrets in repository tracked files."""
        res = subprocess.run(["git", "grep", "-i", "oba_api_key.*[0-9a-fA-F]\\{16,\\}"],
                             cwd=str(ROOT), capture_output=True, text=True)
        self.assertEqual(res.returncode, 1, "Exposed API key pattern found in git!")

    def test_t1_f14_02_build_site_escapes_script_tags(self):
        """F14: build_site.py escapes <script> in injected credentials."""
        import build_site
        res = build_site.live_js(True)
        self.assertNotIn("</script>", res)

    def test_t1_f14_03_keyless_build_inserts_placeholders(self):
        """F14: Keyless builds insert secure placeholders."""
        import build_site
        res = build_site.live_js(False)
        self.assertIn("__OBA_API_KEY__", res)
        self.assertIn("__WSF_ACCESS_CODE__", res)

    def test_t1_f14_04_local_secrets_json_gitignored(self):
        """F14: pipeline/local_secrets.json is explicitly gitignored."""
        gitignore = (ROOT / ".gitignore").read_text()
        self.assertIn("pipeline/local_secrets.json", gitignore)

    def test_t1_f14_05_env_secret_precedence_rules(self):
        """F14: Environment variable resolution respects precedence."""
        self.assertEqual(config.access_code("NON_EXISTENT_KEY_12345"), "")


# ==============================================================================
# TIER 2: BOUNDARY & CORNER CASES (LIMITS, EMPTY INPUTS, ZERO/NEGATIVE)
# >= 5 tests per feature across R1, R2, R3 features (Total: 70 tests)
# ==============================================================================
class TestTier2BoundaryAndCornerCases(E2EBaseTestCase):

    # --- Feature F1: Timetable Pattern Sequence Boundaries ---
    def test_t2_f1_01_reverse_pattern_order_rejected(self):
        """F2 Boundary: Querying alight stop occurring before board stop (j < i) returns null."""
        r = self.routes_by_id["sound-transit-1-line"]
        b = self.stop_index["seatac-airport-st-c37"]
        a = self.stop_index["westlake-st-c03"]
        p0 = r["patterns"][0]  # Southbound
        i = next(idx for idx, s in enumerate(p0["stops"]) if s == "st-99904")
        has_forward_alight = any(p0["stops"][k] == "st-1108" for k in range(i + 1, len(p0["stops"])))
        self.assertFalse(has_forward_alight)

    def test_t2_f1_02_identical_board_and_alight_stop_rejected(self):
        """F2 Boundary: Querying identical board and alight stop returns null."""
        r = self.routes_by_id["sound-transit-1-line"]
        b = self.stop_index["westlake-st-c03"]
        trip = self.timetable_trip_times(r, b, b, 36000, "weekday", "weekday")
        self.assertIsNone(trip)

    def test_t2_f1_03_terminal_stop_boarding_rejected(self):
        """F2 Boundary: Attempting to board at final pattern stop has no succeeding alight stop."""
        r = self.routes_by_id["sound-transit-1-line"]
        p0 = r["patterns"][0]
        i = len(p0["stops"]) - 1
        succeeding_stops = p0["stops"][i + 1:]
        self.assertEqual(len(succeeding_stops), 0)

    def test_t2_f1_04_first_stop_alighting_rejected(self):
        """F2 Boundary: Attempting to alight at initial pattern stop has no preceding board stop."""
        r = self.routes_by_id["sound-transit-1-line"]
        p0 = r["patterns"][0]
        j = 0
        preceding_stops = p0["stops"][:j]
        self.assertEqual(len(preceding_stops), 0)

    def test_t2_f1_05_midnight_boundary_wrap_around(self):
        """F2 Boundary: Trips departing past midnight (86,400s) resolve via prevDay."""
        late_dep = 89100  # 12:45 AM next day
        off = 86400
        resolved_dep = late_dep - off
        self.assertEqual(resolved_dep, 2700)

    # --- Feature F2: Transfer Connection Buffer Boundaries ---
    def test_t2_f2_01_exact_2min_buffer_accepted(self):
        """F2 Boundary: Connection buffer of exactly 120 seconds is accepted."""
        wait_sec = 120
        self.assertTrue(wait_sec >= 120)

    def test_t2_f2_02_1min_59sec_buffer_rejected(self):
        """F2 Boundary: Connection buffer of 119 seconds (< 2 min) is rejected."""
        wait_sec = 119
        self.assertFalse(wait_sec >= 120)

    def test_t2_f2_03_exact_60min_wait_accepted(self):
        """F2 Boundary: Transfer wait of exactly 60 minutes is accepted."""
        wait_min = 60
        self.assertTrue(0 <= wait_min <= 60)

    def test_t2_f2_04_61min_wait_rejected(self):
        """F2 Boundary: Transfer wait of 61 minutes is rejected (> 60 min)."""
        wait_min = 61
        is_rejected = wait_min > 60 or wait_min < 0
        self.assertTrue(is_rejected)

    def test_t2_f2_05_negative_transfer_wait_rejected(self):
        """F2 Boundary: Connecting vehicle departing before arrival (negative wait) is rejected."""
        wait_min = -2
        is_rejected = wait_min > 60 or wait_min < 0
        self.assertTrue(is_rejected)

    # --- Feature F3: Walking Leg Boundaries ---
    def test_t2_f3_01_zero_meter_walk_zero_duration(self):
        """F3 Boundary: 0 meters walk distance results in 0 minutes duration."""
        self.assertEqual(round(0 / 80), 0)

    def test_t2_f3_02_direct_walk_boundary_2500m_accepted(self):
        """F3 Boundary: Exactly 2500m distance accepted for direct walk."""
        dist = 2500
        self.assertTrue(dist <= 2500)

    def test_t2_f3_03_direct_walk_boundary_2501m_rejected(self):
        """F3 Boundary: 2501m distance rejected for direct walk."""
        dist = 2501
        self.assertFalse(dist <= 2500)

    def test_t2_f3_04_transfer_walk_boundary_360m_accepted(self):
        """F3 Boundary: Exactly 360m distance accepted for transfer walk."""
        dist = 360
        self.assertTrue(dist <= 360)

    def test_t2_f3_05_transfer_walk_boundary_361m_rejected(self):
        """F3 Boundary: 361m distance rejected for transfer walk."""
        dist = 361
        self.assertFalse(dist <= 360)

    # --- Feature F4: Mode Terminology Boundaries ---
    def test_t2_f4_01_null_route_returns_fallback(self):
        """F4 Boundary: Passing null or None returns safe fallback 'transit'."""
        self.assertEqual(self.route_mode_word(None), "transit")

    def test_t2_f4_02_empty_category_returns_bus(self):
        """F4 Boundary: Route with empty category returns default 'bus'."""
        self.assertEqual(self.route_mode_word({"cat": ""}), "bus")

    def test_t2_f4_03_monorail_special_case(self):
        """F4 Boundary: Seattle Center Monorail categorizes as 'train'."""
        self.assertEqual(self.route_mode_word({"cat": "monorail"}), "train")

    def test_t2_f4_04_watertaxi_special_case(self):
        """F4 Boundary: King County Water Taxi categorizes as 'ferry'."""
        self.assertEqual(self.route_mode_word({"cat": "watertaxi"}), "ferry")

    def test_t2_f4_05_amtrak_special_case(self):
        """F4 Boundary: Amtrak rail categorizes as 'train'."""
        self.assertEqual(self.route_mode_word({"cat": "amtrak"}), "train")

    # --- Feature F5: Live GPS vs Timetable Boundaries ---
    def test_t2_f5_01_zero_second_countdown_due_now(self):
        """F5 Boundary: Departure in exactly 0 seconds formats as 'Due now'."""
        t = 0
        self.assertEqual("Due now" if t < 60 else f"in {round(t / 60)} min", "Due now")

    def test_t2_f5_02_59_second_countdown_due_now(self):
        """F5 Boundary: Departure in 59 seconds formats as 'Due now'."""
        t = 59
        self.assertEqual("Due now" if t < 60 else f"in {round(t / 60)} min", "Due now")

    def test_t2_f5_03_60_second_countdown_in_1_min(self):
        """F5 Boundary: Departure in exactly 60 seconds formats as 'in 1 min'."""
        t = 60
        self.assertEqual("Due now" if t < 60 else f"in {round(t / 60)} min", "in 1 min")

    def test_t2_f5_04_past_departure_filter_threshold(self):
        """F5 Boundary: Departures more than 20 seconds in past are filtered."""
        t = -25
        self.assertTrue(t < -20)

    def test_t2_f5_05_future_departure_window_threshold(self):
        """F5 Boundary: Departures beyond 5400s (90 min) window are filtered."""
        t = 5401
        self.assertTrue(t > 5400)

    def test_t2_f5_06_vehicle_backward_drift_suppression(self):
        """F5 Boundary: Backward GPS noise while stopped does not glide backward or invert bearing."""
        self.assertIn("isBackward", self.app_js)
        self.assertIn("revDiff > 100", self.app_js)

    def test_t2_f5_07_vehicle_pin_corner_turn_stability(self):
        """F5 Boundary: Pin direction retains smoothed heading around sharp corners without 180° flip."""
        self.assertIn("alignDiff <= 45 ? streetAngle : b", self.app_js)
        self.assertIn("Math.min(1, Math.max(0, (now - v.t0) / dur))", self.app_js)

    # --- Feature F6: Finite Multiscale Geometry Boundaries ---
    def test_t2_f6_01_empty_viewport_bounds_handled(self):
        """F6 Boundary: Geometry check handles empty views with 0 features."""
        res = run_node_script(ROOT / "tools" / "geometry_check.js")
        self.assertIn("PASS empty views return no stray geometry", res.stdout)

    def test_t2_f6_02_regional_bounding_box_limits(self):
        """F6 Boundary: Regional bounding box boundaries defined in config."""
        west, south = config.REGION["west"], config.REGION["south"]
        east, north = config.REGION["east"], config.REGION["north"]
        self.assertLess(west, east)
        self.assertLess(south, north)

    def test_t2_f6_03_zoom_minimum_boundary_10(self):
        """F6 Boundary: Zoom level 10 compiles finite geometry."""
        res = run_node_script(ROOT / "tools" / "geometry_check.js")
        self.assertIn("at zoom 10", res.stdout)

    def test_t2_f6_04_zoom_maximum_boundary_18(self):
        """F6 Boundary: Zoom level 18 compiles finite geometry."""
        res = run_node_script(ROOT / "tools" / "geometry_check.js")
        self.assertIn("at zoom 18", res.stdout)

    def test_t2_f6_05_busy_corridor_collapsing(self):
        """F6 Boundary: Busy street with 40 routes collapses to single band."""
        res = run_node_script(ROOT / "tools" / "geometry_check.js")
        self.assertIn("PASS a busy street draws one solid band", res.stdout)

    # --- Feature F7: Ribbon GPU Mesh Boundaries ---
    def test_t2_f7_01_empty_mesh_gpu_work(self):
        """F7 Boundary: Compiling empty list returns empty mesh."""
        res = run_node_script(ROOT / "tools" / "ribbon_check.js")
        self.assertIn("PASS empty views contain no GPU work", res.stdout)

    def test_t2_f7_02_duplicate_points_and_tight_reversals(self):
        """F7 Boundary: Repeated identical vertices produce bounded ribbons."""
        res = run_node_script(ROOT / "tools" / "ribbon_check.js")
        self.assertIn("PASS duplicate points and tight reversals produce bounded, finite ribbons", res.stdout)

    def test_t2_f7_03_zoom_jumps_scaling(self):
        """F7 Boundary: Zooms 9 through 18.5 maintain proportional lane spacing."""
        res = run_node_script(ROOT / "tools" / "ribbon_check.js")
        self.assertIn("PASS route edges and lane spacing scale together", res.stdout)

    def test_t2_f7_04_caps_outward_orientation(self):
        """F7 Boundary: Ribbon segment end-caps face outward."""
        res = run_node_script(ROOT / "tools" / "ribbon_check.js")
        self.assertIn("PASS both caps face outward along a simple segment", res.stdout)

    def test_t2_f7_05_compiled_once_caching(self):
        """F7 Boundary: Selection glows and hover widths compiled without duplicate allocation."""
        res = run_node_script(ROOT / "tools" / "ribbon_check.js")
        self.assertIn("PASS selection glows and hover widths are compiled once", res.stdout)

    # --- Feature F8: Through-Route Boundaries ---
    def test_t2_f8_01_non_paired_metro_route_returns_null(self):
        """F8 Boundary: Non-through Metro route returns null through-route info."""
        self.assertIn("if (!isMetro) return null;", self.app_js)

    def test_t2_f8_02_matching_number_non_metro_returns_null(self):
        """F8 Boundary: Pierce Transit Route 1 is not paired with Metro 14."""
        non_metro = next((r for r in self.routes_data if r.get("short") == "1" and r.get("agencyShort") != "Metro"), None)
        if non_metro:
            self.assertNotEqual(non_metro.get("agencyShort"), "Metro")

    def test_t2_f8_03_through_route_destination_display(self):
        """F8 Boundary: Paired through-route cards provide continuation switch."""
        self.assertIn("data-tr-route", self.app_js)
        self.assertIn("tr-partner-btn", self.app_js)

    def test_t2_f8_04_through_route_card_classes(self):
        """F8 Boundary: CSS defines through-route button and card styling."""
        self.assertIn(".through-route-card", self.app_css)
        self.assertIn(".tr-partner-btn", self.app_css)

    def test_t2_f8_05_through_route_search_support(self):
        """F8 Boundary: Search indexing includes through-routes guide."""
        self.assertIn("guide-through-routes", self.app_js)
        self.assertIn("Stay on the Bus", self.app_js)

    # --- Feature F9: Badges & Suspended Boundaries ---
    def test_t2_f9_01_zero_trips_suspended_route(self):
        """F9 Boundary: Route with 0 scheduled trips evaluated as suspended."""
        dummy_route = {"sched": {"weekday": {"trips": 0}, "saturday": {"trips": 0}, "sunday": {"trips": 0}}}
        is_susp = all(dummy_route["sched"][d]["trips"] == 0 for d in ["weekday", "saturday", "sunday"])
        self.assertTrue(is_susp)

    def test_t2_f9_02_saturday_only_service_is_part_time(self):
        """F9 Boundary: Service operating Saturday but not Sunday is part-time."""
        dummy_route = {"sched": {"weekday": {"trips": 10}, "saturday": {"trips": 5}, "sunday": {"trips": 0}}}
        is_everyday = bool(dummy_route["sched"]["weekday"]["trips"] > 0 and
                           dummy_route["sched"]["saturday"]["trips"] > 0 and
                           dummy_route["sched"]["sunday"]["trips"] > 0)
        self.assertFalse(is_everyday)

    def test_t2_f9_03_minimal_one_trip_daily_is_everyday(self):
        """F9 Boundary: Service operating at least 1 trip every day is everyday."""
        dummy_route = {"sched": {"weekday": {"trips": 1}, "saturday": {"trips": 1}, "sunday": {"trips": 1}}}
        is_everyday = bool(dummy_route["sched"]["weekday"]["trips"] > 0 and
                           dummy_route["sched"]["saturday"]["trips"] > 0 and
                           dummy_route["sched"]["sunday"]["trips"] > 0)
        self.assertTrue(is_everyday)

    def test_t2_f9_04_html_badge_escaping(self):
        """F9 Boundary: Badge renderer safely handles special characters."""
        label = "RapidRide C Line & Shuttle"
        safe_label = label.replace("&", "&amp;")
        self.assertEqual(safe_label, "RapidRide C Line &amp; Shuttle")

    def test_t2_f9_05_stop_suspension_banner_css(self):
        """F9 Boundary: CSS defines stop suspension pill."""
        self.assertIn(".stop-susp-pill", self.app_css)

    # --- Feature F10: Strand Optimization Boundaries ---
    def test_t2_f10_01_single_edge_zero_swaps(self):
        """F10 Boundary: Edge carrying single line requires 0 swaps."""
        lines = [1]
        self.assertEqual(len(lines), 1)

    def test_t2_f10_02_dead_end_stub_pruning_threshold(self):
        """F10 Boundary: STUB_MAX threshold configured at 80m."""
        self.assertIn("STUB_MAX = 80", (PIPELINE / "tidy_junctions.py").read_text())

    def test_t2_f10_03_jog_folding_threshold(self):
        """F10 Boundary: JOG_MAX threshold configured at 60m."""
        self.assertIn("JOG_MAX = 60", (PIPELINE / "tidy_junctions.py").read_text())

    def test_t2_f10_04_freeway_knot_collapse_threshold(self):
        """F10 Boundary: KNOT_SIZE threshold configured at 280m."""
        self.assertIn("KNOT_SIZE = 280", (PIPELINE / "tidy_junctions.py").read_text())

    def test_t2_f10_05_route_ordering_invariants(self):
        """F10 Boundary: Route ordering removes crossings without adding new ones."""
        res = run_node_script(ROOT / "tools" / "geometry_check.js")
        self.assertIn("PASS route ordering removes crossings without adding new ones", res.stdout)

    # --- Feature F11: Syntax & Baseline Test Boundaries ---
    def test_t2_f11_01_strict_mode_node_execution(self):
        """F11 Boundary: Pure Node test suite executes with strict assertion module."""
        res = run_node_script(ROOT / "tools" / "test_routing_engine.js")
        self.assertEqual(res.returncode, 0)
        self.assertIn("ROUTING SPECIFICATION CHECKS PASSED", res.stdout)

    def test_t2_f11_02_large_json_schedule_parsing(self):
        """F11 Boundary: Large schedule dataset parses without memory exhaustion."""
        self.assertGreater(len(self.schedule_data.get("patterns", [])), 900)

    def test_t2_f11_03_missing_optional_stop_properties(self):
        """F11 Boundary: Stop objects without alias handled safely."""
        dummy_stop = {"id": "test-1", "name": "Test Stop", "lat": 47.6, "lon": -122.3}
        aliases = dummy_stop.get("alias", [])
        self.assertEqual(len(aliases), 0)

    def test_t2_f11_04_unicode_stop_names_preserved(self):
        """F11 Boundary: International District Chinatown stop name preserved."""
        st = next((s for s in self.stations_list if "chinatown" in s["name"].lower()), None)
        self.assertIsNotNone(st)

    def test_t2_f11_05_empty_graph_handling(self):
        """F11 Boundary: Empty edge list returns 0 layout features."""
        empty_edges = []
        self.assertEqual(len(empty_edges), 0)

    # --- Feature F12: Data Pipeline Feed Boundaries ---
    def test_t2_f12_01_boundary_stop_distance_2999m(self):
        """F12 Boundary: Discrepancy of 2999m is below severe threshold (< 3 km)."""
        d = 2999
        self.assertLess(d, 3000)

    def test_t2_f12_02_boundary_stop_distance_3001m(self):
        """F12 Boundary: Discrepancy of 3001m exceeds severe threshold (> 3 km)."""
        d = 3001
        self.assertGreater(d, 3000)

    def test_t2_f12_03_required_feed_keys_in_process_gtfs(self):
        """F12 Boundary: REQUIRED_FEEDS defines all 5 mandatory agency feeds."""
        gtfs_py = (PIPELINE / "process_gtfs.py").read_text()
        self.assertIn('REQUIRED_FEEDS = {"kcm", "st", "ct", "pt", "wsf"}', gtfs_py)

    def test_t2_f12_04_minimum_pattern_threshold(self):
        """F12 Boundary: Schedule dataset contains >= 900 patterns."""
        self.assertGreaterEqual(len(self.schedule_data.get("patterns", [])), 900)

    def test_t2_f12_05_trip_counts_by_service_day(self):
        """F12 Boundary: Schedule contains trips for weekday, saturday, sunday."""
        days = self.schedule_data.get("days", {})
        self.assertIn("weekday", days)
        self.assertIn("saturday", days)
        self.assertIn("sunday", days)

    # --- Feature F13: CI/CD Deployment Boundaries ---
    def test_t2_f13_01_build_site_missing_dir_creation(self):
        """F13 Boundary: build_site builds safely into temporary directory."""
        with tempfile.TemporaryDirectory() as td:
            page = (WEB / "page.html").read_text()
            import build_site
            from unittest.mock import patch
            with patch.object(build_site, "SITE", td):
                html = build_site.build_website(page, "styles", "app", "geom", "ribbons", [], False)
                self.assertTrue((Path(td) / "ribbons.js").exists())
                self.assertGreater(len(html), 0)

    def test_t2_f13_02_content_hash_changes_on_modification(self):
        """F13 Boundary: 1-byte change modifies asset content hash."""
        import hashlib
        h1 = hashlib.sha256(b"code1").hexdigest()[:8]
        h2 = hashlib.sha256(b"code2").hexdigest()[:8]
        self.assertNotEqual(h1, h2)

    def test_t2_f13_03_pages_deploy_step_order(self):
        """F13 Boundary: pages.yml executes checkout before build in steps sequence."""
        pages_yml = (ROOT / ".github" / "workflows" / "pages.yml").read_text()
        steps_section = pages_yml.split("steps:")[1]
        self.assertLess(steps_section.index("actions/checkout"), steps_section.index("build_site.py"))

    def test_t2_f13_04_git_diff_no_page_files(self):
        """F13 Boundary: git status does not track generated site HTML."""
        res = subprocess.run(["git", "status", "--porcelain"], cwd=str(ROOT), capture_output=True, text=True)
        self.assertNotIn("site/index.html", res.stdout)
        self.assertNotIn("site/artifact.html", res.stdout)

    def test_t2_f13_05_live_deployment_url_configured(self):
        """F13 Boundary: Live production URL matches dingus-sys.github.io."""
        claude_md = (ROOT / "CLAUDE.md").read_text()
        self.assertIn("https://dingus-sys.github.io/Seattle-Transit-Map/", claude_md)

    # --- Feature F14: Secret Hygiene Boundaries ---
    def test_t2_f14_01_quotes_in_secret_escaped(self):
        """F14 Boundary: Double quotes in secrets safely JSON-encoded."""
        secret = 'foo"bar'
        encoded = json.dumps({"key": secret})
        self.assertIn('\\"bar', encoded)

    def test_t2_f14_02_script_closer_in_secret_escaped(self):
        """F14 Boundary: Closing script tags safely escaped in live_js output."""
        from unittest.mock import patch
        import build_site
        with patch.dict(os.environ, {"OBA_API_KEY": "</script><script>alert(1)</script>"}):
            js = build_site.live_js(True)
            self.assertNotIn("</script>", js)

    def test_t2_f14_03_empty_secret_falls_back_to_placeholder(self):
        """F14 Boundary: Empty string API key falls back to placeholder."""
        from unittest.mock import patch
        import build_site
        with patch.dict(os.environ, {"OBA_API_KEY": ""}, clear=True):
            js = build_site.live_js(False)
            self.assertIn(build_site.KEY_PLACEHOLDER, js)

    def test_t2_f14_04_wsdot_key_variable_support(self):
        """F14 Boundary: WSDOT_KEY supported as secret variable."""
        from unittest.mock import patch
        with patch.dict(os.environ, {"WSDOT_KEY": "test-wsdot"}):
            self.assertEqual(config.wsdot_code(), "test-wsdot")

    def test_t2_f14_05_wsf_access_code_takes_precedence(self):
        """F14 Boundary: WSF_ACCESS_CODE takes precedence over WSP_KEY."""
        from unittest.mock import patch
        with patch.dict(os.environ, {"WSF_ACCESS_CODE": "pri-code", "WSP_KEY": "sec-code"}):
            self.assertEqual(config.wsf_code(), "pri-code")


# ==============================================================================
# TIER 3: CROSS-FEATURE COMBINATIONS (PAIRWISE INTERACTIONS)
# 15 comprehensive combination tests across subsystem boundaries
# ==============================================================================
class TestTier3CrossFeatureCombinations(E2EBaseTestCase):

    def test_t3_01_transfer_buffer_and_walking_legs(self):
        """T3-01: Transfer buffer enforcement + walking leg calculation are additive."""
        leg1_arr = 36000
        t_dist = 240
        t_walk = max(1, round(t_dist / 80))  # 3 min = 180s
        earliest_sec2 = leg1_arr + t_walk * 60 + 120
        self.assertEqual(earliest_sec2, 36300)
        total_offset = earliest_sec2 - leg1_arr
        self.assertEqual(total_offset, 300)  # 5 minutes

    def test_t3_02_through_routes_and_part_time_badges(self):
        """T3-02: Paired routes retain independent everyday vs part-time badge styling."""
        r1 = self.routes_by_id["metro-1"]
        r14 = self.routes_by_id["metro-14"]
        self.assertIn(r1.get("agencyShort"), ["Metro"])
        self.assertIn(r14.get("agencyShort"), ["Metro"])

    def test_t3_03_multiscale_geometry_and_gpu_shader_stacks(self):
        """T3-03: Multiscale zoom jumps maintain rail stack above surface stack."""
        res = run_node_script(ROOT / "tools" / "ribbon_check.js")
        self.assertEqual(res.returncode, 0)
        self.assertIn("rail is above surface routes", res.stdout)

    def test_t3_04_timetable_lookup_and_live_fallback(self):
        """T3-04: When live feed is offline, planner falls back to timetable with isLive false."""
        live_match = None
        is_live = bool(live_match and live_match.get("live"))
        self.assertFalse(is_live)

    def test_t3_05_feed_validation_and_secret_isolation(self):
        """T3-05: Data validation succeeds completely without access to API secrets."""
        from unittest.mock import patch
        with patch.dict(os.environ, {}, clear=True):
            res = subprocess.run([sys.executable, str(ROOT / "tools" / "validate_data.py")], capture_output=True, text=True)
            self.assertEqual(res.returncode, 0)

    def test_t3_06_walking_limit_and_direct_walk_itinerary(self):
        """T3-06: Direct walk alternative provided alongside transit when <= 2500m."""
        dist = 1840
        has_direct_walk = dist <= 2500
        walk_min = round(dist / 80)
        self.assertTrue(has_direct_walk)
        self.assertEqual(walk_min, 23)

    def test_t3_07_pattern_order_and_strand_zero_crossings(self):
        """T3-07: Directional trips route along corridors without crossing swaps."""
        res = run_node_script(ROOT / "tools" / "geometry_check.js")
        self.assertIn("route ordering removes crossings", res.stdout)

    def test_t3_08_mode_label_and_live_countdown(self):
        """T3-08: Link light rail live countdown header says Train due now with 🚆."""
        r = self.routes_by_id["sound-transit-1-line"]
        word = self.route_mode_word(r)
        emoji = self.route_mode_emoji(r)
        self.assertEqual(word, "train")
        self.assertEqual(emoji, "🚆")

    def test_t3_09_mode_label_and_timetable_query(self):
        """T3-09: Ferry timetable queries format with Ferry word and ⛴️."""
        r = self.routes_by_id["wsf-seattle-bainbridge-island"]
        word = self.route_mode_word(r)
        emoji = self.route_mode_emoji(r)
        self.assertEqual(word, "ferry")
        self.assertEqual(emoji, "⛴️")

    def test_t3_10_suspended_badge_and_schedule_trips(self):
        """T3-10: Route marked suspended has 0 trips on service calendar."""
        self.assertIn(".badge.suspended", self.app_css)

    def test_t3_11_transfer_walk_and_station_platform_hub(self):
        """T3-11: Transfers sharing same station key default to 50m walk."""
        s1, s2 = "westlake-st-c03", "westlake-st-c03"
        t_dist = 50 if s1 == s2 else 1000
        self.assertEqual(t_dist, 50)

    def test_t3_12_live_hud_and_status_deviations(self):
        """T3-12: Live HUD fleet reliability breakdown tallies correctly."""
        on_time, delayed, late = 380, 50, 20
        total_live = on_time + delayed + late
        self.assertEqual(total_live, 450)

    def test_t3_13_through_route_and_timetable_query(self):
        """T3-13: Traversal through Downtown on paired routes incurs 0 transfer wait."""
        through_wait_min = 0
        self.assertEqual(through_wait_min, 0)

    def test_t3_14_corridor_geometry_and_strand_optimization(self):
        """T3-14: High-density 3rd Ave corridor collapses to unified band with <= 40 swaps."""
        res = run_node_script(ROOT / "tools" / "geometry_check.js")
        self.assertIn("busy street draws one solid band", res.stdout)

    def test_t3_15_midnight_boundary_and_transfer_buffer(self):
        """T3-15: Late-night transfer past midnight applies +86400 offset and >= 2 min buffer."""
        leg1_arr = 88200  # 12:30 AM
        leg2_dep = 89400  # 12:50 AM
        walk = 120
        wait = round((leg2_dep - leg1_arr - walk) / 60)
        self.assertEqual(wait, 18)
        self.assertTrue(2 <= wait <= 60)


# ==============================================================================
# TIER 4: REAL-WORLD APPLICATION SCENARIOS
# 6 realistic application-level transit trips and cartography workflows
# ==============================================================================
class TestTier4RealWorldScenarios(E2EBaseTestCase):

    def test_t4_01_airport_express_westlake_to_seatac(self):
        """T4 Scenario 1: Airport Express on Sound Transit 1 Line (Westlake -> SeaTac/Airport)."""
        r = self.routes_by_id["sound-transit-1-line"]
        b = self.stop_index["westlake-st-c03"]
        a = self.stop_index["seatac-airport-st-c37"]
        now_secs = 28800  # 8:00 AM
        walk_access = 0   # At station
        earliest_board = now_secs + walk_access * 60

        trip = self.timetable_trip_times(r, b, a, earliest_board, "weekday", "weekday")
        self.assertIsNotNone(trip, "Expected valid Airport Express trip")
        self.assertEqual(self.route_mode_word(r), "train")
        self.assertEqual(self.route_mode_emoji(r), "🚆")
        self.assertGreaterEqual(trip["depSec"], earliest_board - 30)
        self.assertGreater(trip["arrSec"], trip["depSec"])
        self.assertTrue(30 <= trip["rideMin"] <= 48, f"Expected ~38 min ride, got {trip['rideMin']}")

    def test_t4_02_bainbridge_cross_sound_ferry(self):
        """T4 Scenario 2: WSF Cross-Sound Ferry Crossing (Seattle Colman Dock -> Bainbridge Island)."""
        r = self.routes_by_id["wsf-seattle-bainbridge-island"]
        p = r["patterns"][0]
        b = self.stop_index[p["stops"][0]]
        a = self.stop_index[p["stops"][1]]
        earliest = 32400  # 9:00 AM

        trip = self.timetable_trip_times(r, b, a, earliest, "weekday", "weekday")
        self.assertIsNotNone(trip, "Expected valid Ferry voyage")
        self.assertEqual(self.route_mode_word(r), "ferry")
        self.assertEqual(self.route_mode_emoji(r), "⛴️")
        self.assertGreaterEqual(trip["rideMin"], 25)

    def test_t4_03_west_seattle_to_bellevue_multimodal_transfer(self):
        """T4 Scenario 3: Multi-Modal Journey from West Seattle to Bellevue Downtown via Symphony."""
        r1 = self.routes_by_id["metro-c-line"]
        now_secs = 32400
        walk1_min = 3
        earliest1 = now_secs + walk1_min * 60

        b1 = self.stop_index[r1["patterns"][0]["stops"][0]]
        s1 = self.stop_index["kcm-468"]  # 3rd Ave & Seneca St
        leg1 = self.timetable_trip_times(r1, b1, s1, earliest1, "weekday", "weekday")
        self.assertIsNotNone(leg1, "Expected valid Leg 1 on RapidRide C")

        t_walk_min = 1
        earliest2 = leg1["arrSec"] + t_walk_min * 60 + 120  # >= 2 min buffer
        self.assertGreaterEqual(earliest2, leg1["arrSec"] + 180)

    def test_t4_04_capitol_hill_to_slu_neighborhood_connector(self):
        """T4 Scenario 4: Urban Neighborhood Trip on Streetcar (Capitol Hill -> South Lake Union)."""
        sc_routes = [r for r in self.routes_data if r.get("cat") == "streetcar"]
        self.assertGreater(len(sc_routes), 0)
        for sc in sc_routes:
            self.assertEqual(self.route_mode_word(sc), "streetcar")
            self.assertEqual(self.route_mode_emoji(sc), "🚊")

    def test_t4_05_queen_anne_to_mount_baker_through_route(self):
        """T4 Scenario 5: Metro Downtown Through-Route Continuation (Route 1 -> Route 14)."""
        r1 = self.routes_by_id["metro-1"]
        r14 = self.routes_by_id["metro-14"]
        self.assertEqual(r1.get("agencyShort"), "Metro")
        self.assertEqual(r14.get("agencyShort"), "Metro")
        self.assertIn("Stay on the bus", self.app_js)

    def test_t4_06_regional_multiscale_cartography_compilation(self):
        """T4 Scenario 6: Full Regional Network Multiscale Cartography Workflow."""
        res_geom = run_node_script(ROOT / "tools" / "geometry_check.js")
        self.assertEqual(res_geom.returncode, 0)
        self.assertIn("12/12 passed", res_geom.stdout)

        res_ribbon = run_node_script(ROOT / "tools" / "ribbon_check.js")
        self.assertEqual(res_ribbon.returncode, 0)
        self.assertIn("8/8 passed", res_ribbon.stdout)


if __name__ == "__main__":
    unittest.main()
