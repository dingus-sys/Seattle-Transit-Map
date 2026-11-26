"""Every stop on a route's representative patterns lies near that route's drawn line.

    python3 tools/check_stop_coverage.py [--max-far N]

validate_data.py skips the stops on a route's own patterns (they are "legitimate"), so a branch the
tracing dropped from the drawing went unnoticed: on WTA 27 the stops Church Rd S / Bakerview Park Dr,
Vista Dr / Seamount Dr and Church Rd / Crestline St sat 835, 604 and 444 m from the line, WTA 26
and 71X had Guide Meridian at Laurel Rd 794 and 621 m away, while each agency shape ran through
every one of them (0 m). This measures the distance from each such stop to the nearest drawn
SEGMENT (not vertex) of its route, and fails past FAR_M for more than --max-far stops.
"""
import json
import math
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "site", "data")
FAR_M = 400
KX, KY = 75000.0, 111000.0  # metres per degree at this latitude (the validators use the same)


def seg_dist(p, a, b):
    """Distance in metres from points p (n,2) to segments a-b (m,2), minimum over the segments, per point."""
    px, py = p[:, 0:1] * KX, p[:, 1:2] * KY
    ax, ay, bx, by = a[:, 0] * KX, a[:, 1] * KY, b[:, 0] * KX, b[:, 1] * KY
    dx, dy = bx - ax, by - ay
    L2 = np.maximum(dx * dx + dy * dy, 1e-9)
    t = np.clip(((px - ax) * dx + (py - ay) * dy) / L2, 0, 1)
    return np.hypot(px - (ax + t * dx), py - (ay + t * dy)).min(axis=1)


def main():
    max_far = 0
    if "--max-far" in sys.argv:
        max_far = int(sys.argv[sys.argv.index("--max-far") + 1])
    net = json.load(open(os.path.join(DATA, "network.json")))
    meta = json.load(open(os.path.join(DATA, "routes.json")))
    routes, region = meta["routes"], meta["meta"]["region"]
    stops = {s["id"]: s for s in json.load(open(os.path.join(DATA, "stops.json")))["stops"]}
    for st in json.load(open(os.path.join(DATA, "stops.json")))["stations"]:
        for sid in st["stops"]:
            stops.setdefault(sid, {"lon": st["lon"], "lat": st["lat"], "name": st["name"]})
    index = {line: i for i, line in enumerate(net["lines"])}
    segs = {}
    for e in net["edges"]:
        c = e["c"]
        for li in e["l"]:
            segs.setdefault(li, []).append(np.array(c))
    far = []
    for r in routes:
        li = index.get(r["id"])
        if li is None or li not in segs:
            continue
        a = np.vstack([c[:-1] for c in segs[li] if len(c) > 1])
        b = np.vstack([c[1:] for c in segs[li] if len(c) > 1])
        # the network ends at the map's edge, so only stops inside it can be measured
        ids = sorted({sid for p in r.get("patterns", []) for sid in p.get("stops", []) if sid in stops
                      and region["west"] <= stops[sid]["lon"] <= region["east"] and region["south"] <= stops[sid]["lat"] <= region["north"]})
        if not ids:
            continue
        pts = np.array([[stops[s]["lon"], stops[s]["lat"]] for s in ids])
        for sid, d in zip(ids, seg_dist(pts, a, b)):
            if d > FAR_M:
                far.append((round(float(d)), r["id"], stops[sid]["name"], sid))
    far.sort(reverse=True)
    print(f"{len(far)} route-stop pairs farther than {FAR_M} m from their route's drawn line")
    for d, rid, name, sid in far[:25]:
        print(f"  {d:5d} m  {rid:28s} {name} ({sid})")
    if len(far) > max_far:
        print(f"FAIL: more than {max_far} (stops that the route's own pattern serves must sit on its drawn line)")
        sys.exit(1)
    print("PASS")


if __name__ == "__main__":
    main()
