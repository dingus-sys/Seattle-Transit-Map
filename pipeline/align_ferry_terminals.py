"""Snap offshore ferry pier endpoints to the shore-side terminal access point.

GTFS agencies reasonably locate a ferry stop at the end of its boarding pier.  On
this schematic map that can leave the route marker visibly detached from the road
and bus network, especially at Kitsap's small passenger docks.  This post-process
keeps the water crossing's published geometry, but moves only its endpoint to the
nearest terminal approach so every ferry line visibly reaches land.

Run after ``match_shapes.py`` and before ``build_graph.py``.  Both the source and
matched shape caches are updated because boats intentionally bypass street matching.
"""
import json
import math
import os

from config import CACHE, SITE


# Shore-side approach points, checked against the terminal access roads.  A point
# is listed only when the feed's pier coordinate is visibly offshore at map scale.
FERRY_SHORE_ENDPOINTS = {
    "kt-84": (-122.616580, 47.547701),   # Annapolis Foot Ferry / Park & Ride access
    "kt-82": (-122.624483, 47.561950),   # Bremerton foot-ferry landing approach
    "kt-83": (-122.635654, 47.542598),   # Port Orchard foot-ferry approach
    "kt-230": (-122.624469, 47.561839),  # Bremerton Fast Ferry / transportation center
    "kt-246": (-122.495381, 47.794091),  # Kingston Fast Ferry pier approach
}


def meters(a, b):
    """A sufficiently accurate local distance in metres for terminal matching."""
    return math.hypot((a[0] - b[0]) * 75000, (a[1] - b[1]) * 111000)


def reach_terminal(line, terminals, gap=150, reach=1200):
    """A crossing whose published path stops short of its own terminal (Mukilteo's moved in
    2020; the feed's path still ends at the old dock, 560 m west) is brought in to it: cut at
    the point of its approach nearest the terminal and finished with a straight run to it."""
    changed = False
    for index in (0, -1):
        if len(line) < 2 or not terminals:
            continue
        end = tuple(line[index])
        target = min(terminals, key=lambda t: meters(end, t))
        d = meters(end, target)
        if d <= gap or d > reach:
            continue
        pts = line if index == -1 else line[::-1]
        # the vertex of the approach (its last ~2 km) closest to the terminal
        acc, best = 0.0, len(pts) - 1
        for i in range(len(pts) - 1, 0, -1):
            if meters(pts[i], target) < meters(pts[best], target):
                best = i
            acc += meters(pts[i], pts[i - 1])
            if acc > 2000:
                break
        new = pts[: best + 1] + [list(target)]
        if index == -1:
            line[:] = new
        else:
            line[:] = new[::-1]
        changed = True
    return changed


def align(cache=CACHE, stops_path=None):
    """Update terminal stations and only matching ferry-shape endpoints.

    Returns the number of station records and geometry endpoints changed.  The
    conservative 450 m match radius prevents an unrelated crossing from being
    pulled to a terminal merely because it passes nearby.
    """
    stops_path = stops_path or os.path.join(SITE, "data", "stops.json")
    with open(stops_path) as f:
        stops_data = json.load(f)

    old_points = {}
    station_updates = 0
    for station in stops_data.get("stations", []):
        matching = [sid for sid in station.get("stops", []) if sid in FERRY_SHORE_ENDPOINTS]
        if not matching:
            continue
        sid = matching[0]
        old_points[sid] = (station["lon"], station["lat"])
        target = FERRY_SHORE_ENDPOINTS[sid]
        if (station["lon"], station["lat"]) != target:
            station["lon"], station["lat"] = target
            station_updates += 1

    with open(stops_path, "w") as f:
        json.dump(stops_data, f, separators=(",", ":"))

    # Every terminal a boat serves, by route: the station (or stop) records that list it.
    terminals = {}
    for rec in stops_data.get("stations", []) + stops_data.get("stops", []):
        for rid in rec.get("routes", []):
            terminals.setdefault(rid, []).append((rec["lon"], rec["lat"]))

    endpoint_updates = 0
    for filename in ("route_shapes.json", "route_shapes_matched.json"):
        path = os.path.join(cache, filename)
        if not os.path.exists(path):
            continue
        with open(path) as f:
            shapes = json.load(f)
        changed = False
        for rid, route in shapes.items():
            if route.get("cat") not in {"ferry", "watertaxi"}:
                continue
            for line in route.get("lines", []):
                if len(line) < 2:
                    continue
                for index in (0, -1):
                    point = tuple(line[index])
                    sid = min(old_points, key=lambda key: meters(point, old_points[key]), default=None)
                    if sid is not None and meters(point, old_points[sid]) <= 450:
                        target = list(FERRY_SHORE_ENDPOINTS[sid])
                        if line[index] != target:
                            line[index] = target
                            endpoint_updates += 1
                            changed = True
                if reach_terminal(line, terminals.get(rid, [])):
                    endpoint_updates += 1
                    changed = True
        if changed:
            with open(path, "w") as f:
                json.dump(shapes, f)
    return station_updates, endpoint_updates


def main():
    stations, endpoints = align()
    print(f"ferry terminals: aligned {stations} station points and {endpoints} water-route endpoints")


if __name__ == "__main__":
    main()
