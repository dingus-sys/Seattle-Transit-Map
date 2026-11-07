"""Validate transit data files for publication safety.

Run before committing refreshed datasets to GitHub Pages:
    python tools/validate_data.py
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "site", "data")


def main():
    errors = []
    routes_file = os.path.join(DATA, "routes.json")
    stops_file = os.path.join(DATA, "stops.json")
    sched_file = os.path.join(DATA, "schedule.json")
    net_file = os.path.join(DATA, "network.json")

    for f in [routes_file, stops_file, sched_file, net_file]:
        if not os.path.exists(f):
            errors.append(f"Missing required data file: {os.path.basename(f)}")

    if errors:
        for err in errors:
            print(f"FAIL: {err}", file=sys.stderr)
        return 1

    with open(routes_file) as f:
        routes_data = json.load(f)
    with open(stops_file) as f:
        stops_data = json.load(f)
    with open(sched_file) as f:
        sched_data = json.load(f)
    with open(net_file) as f:
        net_data = json.load(f)

    routes = routes_data.get("routes", [])
    stops = stops_data.get("stops", [])
    stations = stops_data.get("stations", [])
    patterns = sched_data.get("patterns", [])
    days = sched_data.get("days", {})

    # 1. Route and stop counts
    if len(routes) < 340:
        errors.append(f"Route count drop anomaly: {len(routes)} routes (expected >= 340)")
    else:
        print(f"PASS: {len(routes)} routes verified")

    if len(stops) < 10000:
        errors.append(f"Stop count drop anomaly: {len(stops)} stops (expected >= 10000)")
    else:
        print(f"PASS: {len(stops)} stops, {len(stations)} stations verified")

    # 2. Key agencies representation
    agencies = {r.get("agencyShort") for r in routes if r.get("agencyShort")}
    required_agencies = {"Metro", "Sound Transit", "CT", "PT", "WSF"}
    missing_agencies = required_agencies - agencies
    if missing_agencies:
        errors.append(f"Missing key agency feeds: {missing_agencies}")
    else:
        print(f"PASS: Key transit agencies verified: {agencies & required_agencies}")

    # 3. Timetable schedule integrity
    if len(patterns) < 900:
        errors.append(f"Schedule pattern count too low: {len(patterns)} (expected >= 900)")
    else:
        print(f"PASS: {len(patterns)} schedule patterns verified")

    for day in ["weekday", "saturday", "sunday"]:
        trip_count = len(days.get(day, []))
        if trip_count < 10000:
            errors.append(f"Schedule trip count too low for {day}: {trip_count} (expected >= 10000)")
        else:
            print(f"PASS: {trip_count} trips verified for {day}")

    # 4. Geometry & coordinate bounds
    for e in net_data.get("edges", []):
        for pt in e.get("c", []):
            if len(pt) < 2 or not math.isfinite(pt[0]) or not math.isfinite(pt[1]):
                errors.append(f"Invalid coordinate in network edge: {pt}")
                break

    # 5. Stop-to-route association alignment check
    net_lines = net_data.get("lines", [])
    line_to_r = set(net_lines)
    r_to_pts = {r: [] for r in net_lines}
    for e in net_data.get("edges", []):
        for li in e.get("l", []):
            if li < len(net_lines):
                r_id = net_lines[li]
                r_to_pts[r_id].extend(e.get("c", []))

    pat_stops_by_slug = {r.get("id"): set(sid for p in r.get("patterns", []) for sid in p.get("stops", [])) for r in routes}

    discrepancy_count = 0
    severe_discrepancies = []
    for s in stops:
        slat, slon = s.get("lat", 0), s.get("lon", 0)
        sid = s.get("id")
        for rid in s.get("routes", []):
            if rid not in line_to_r:
                continue
            # Legitimate route stops in the route patterns are expected
            if sid in pat_stops_by_slug.get(rid, set()):
                continue
            pts = r_to_pts.get(rid, [])
            if not pts:
                continue
            min_d = min(math.hypot((px - slon) * 75000, (py - slat) * 111000) for px, py in pts)
            if min_d > 3000:
                severe_discrepancies.append((min_d, sid, s.get("name"), rid))
            if min_d > 500:
                discrepancy_count += 1

    if severe_discrepancies:
        for d, sid, sname, rid in severe_discrepancies[:10]:
            errors.append(f"Severe stop-route discrepancy ({d/1000:.1f} km): {sid} ({sname}) -> {rid}")
    else:
        print(f"PASS: No severe stop-route discrepancies (> 3 km) found in network")

    if errors:
        print("\nDATA VALIDATION FAILED:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        return 1

    print("\nALL DATA INTEGRITY CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
