"""Tidy the street network's junctions after build_graph.py (site/data/network.json, in place).

Two leftovers of tracing routes onto streets make intersections look broken on the map:

1. A crossing split in two. Where a street (often a freeway with its ramps) meets another at two
   points a few dozen meters apart, a route going across has to jog along the other line
   between them, and draws as a little "+", S or hop into the other line's bundle. Such a short
   link between two junctions, which a route only uses to get across (it turns onto it at one
   end and off it at the other), is folded into one junction at its middle, so the route
   crosses in one clean line and turning routes turn there.

2. Route stubs. A route sometimes picks up a short dead-end piece next to a junction where it
   actually turns (a ramp traced onto the wrong side of the junction). It draws as a line that
   pops out and stops. A route is taken off a short segment whose far end leads nowhere for it
   while the route goes on elsewhere at the near end.

Run after build_graph.py; running it again changes nothing.
"""
import json
import math
import os
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(HERE, "..", "site", "data")

LAT0 = 47.61
KX = 111320 * math.cos(math.radians(LAT0))
KY = 110574

JOG_MAX = 60.0      # longest link that can be folded (m)
STUB_MAX = 80.0     # longest piece a route can be taken off (m)
RIDE_MAX = 50.0     # longest link a route can just borrow to cross another line (m)


def to_m(c):
    return ((c[0] + 122.33) * KX, (c[1] - LAT0) * KY)


def to_ll(p):
    return [round(p[0] / KX - 122.33, 6), round(p[1] / KY + LAT0, 6)]


def length(pts):
    return sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1))


def point_at(pts, d):
    acc = 0.0
    for i in range(len(pts) - 1):
        s = math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
        if acc + s >= d and s > 0:
            t = (d - acc) / s
            return (pts[i][0] + t * (pts[i + 1][0] - pts[i][0]), pts[i][1] + t * (pts[i + 1][1] - pts[i][1]))
        acc += s
    return pts[-1]


def out_dir(pts, look=25.0):
    """unit direction leaving pts[0], looking `look` meters along"""
    q = point_at(pts, min(look, max(1.0, length(pts) * 0.5)))
    dx, dy = q[0] - pts[0][0], q[1] - pts[0][1]
    d = math.hypot(dx, dy) or 1.0
    return (dx / d, dy / d)


def main():
    path = os.path.join(SITE, "network.json")
    net = json.load(open(path))
    routes = json.load(open(os.path.join(SITE, "routes.json")))
    routes = routes["routes"] if isinstance(routes, dict) and "routes" in routes else routes
    cat = {r["id"]: r.get("cat") for r in routes}
    layer_of_cat = lambda c: "r" if c in ("link", "sounder", "amtrak", "monorail") else "w" if c in ("ferry", "watertaxi") else "s"
    lines = net["lines"]

    edges = []
    for e in net["edges"]:
        lay = layer_of_cat(cat.get(lines[e["l"][0]]))
        edges.append({"p": [to_m(c) for c in e["c"]], "l": list(e["l"]), "d": list(e.get("d") or [0] * len(e["l"])), "lay": lay})

    def nkey(e, end):
        p = e["p"][0] if end == 0 else e["p"][-1]
        return (e["lay"], round(p[0], 1), round(p[1], 1))

    def index():
        at = defaultdict(list)
        for k, e in enumerate(edges):
            if e is None:
                continue
            at[nkey(e, 0)].append((k, 0))
            at[nkey(e, 1)].append((k, 1))
        return at

    def leaving(k, end):  # points of edge k starting at its `end`
        p = edges[k]["p"]
        return p if end == 0 else p[::-1]

    # 1. fold split crossings
    folded = 0
    for _ in range(6):
        at = index()
        cands = []
        for k, e in enumerate(edges):
            if e is None or e["lay"] != "s":
                continue
            L = length(e["p"])
            if L > JOG_MAX:
                continue
            na, nb = nkey(e, 0), nkey(e, 1)
            if na == nb or len(at[na]) < 3 or len(at[nb]) < 3:
                continue
            dx = out_dir(e["p"])                 # along the link, leaving its a end
            dxb = out_dir(leaving(k, 1))          # along the link, leaving its b end
            jog = False
            for r in e["l"]:
                A = [x for x in at[na] if x[0] != k and r in edges[x[0]]["l"]]
                B = [x for x in at[nb] if x[0] != k and r in edges[x[0]]["l"]]
                for a in A:
                    da = out_dir(leaving(*a))
                    for b in B:
                        db = out_dir(leaving(*b))
                        dab = da[0] * db[0] + da[1] * db[1]
                        # the link runs across the route, which goes straight on past it
                        if abs(da[0] * dx[0] + da[1] * dx[1]) <= 0.6 and dab < -0.8:
                            jog = True
                        # or the route only borrows the link to get across or around a corner:
                        # it turns onto it at one end and off it at the other (a 26 m ride
                        # along a freeway's line to cross it), without turning back on itself
                        turn_a = da[0] * dx[0] + da[1] * dx[1] > -0.82
                        turn_b = db[0] * dxb[0] + db[1] * dxb[1] > -0.82
                        if L <= RIDE_MAX and turn_a and turn_b and dab < 0.3:
                            jog = True
            if jog:
                cands.append((L, k))
        if not cands:
            break
        cands.sort()
        touched = set()
        for L, k in cands:
            e = edges[k]
            na, nb = nkey(e, 0), nkey(e, 1)
            if na in touched or nb in touched:
                continue
            touched.update([na, nb])
            M = point_at(e["p"], L / 2)
            for node in (na, nb):
                for j, end in at[node]:
                    if j == k or edges[j] is None:
                        continue
                    p = edges[j]["p"] if end == 0 else edges[j]["p"][::-1]
                    v = (M[0] - p[0][0], M[1] - p[0][1])
                    T = max(40.0, 1.6 * math.hypot(*v))
                    T = min(T, 0.6 * length(p)) if length(p) > 1 else T
                    # move the end onto the new junction, easing back to the old line over T meters
                    out, acc = [], 0.0
                    for i, pt in enumerate(p):
                        if i:
                            acc += math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])
                        w = 0.5 * (1 + math.cos(math.pi * acc / T)) if acc < T else 0.0
                        out.append((pt[0] + v[0] * w, pt[1] + v[1] * w))
                    out[0] = M
                    edges[j]["p"] = out if end == 0 else out[::-1]
            edges[k] = None
            folded += 1
        # a short loop left behind (two links between the same pair of junctions)
        for j, e in enumerate(edges):
            if e is not None and nkey(e, 0) == nkey(e, 1) and length(e["p"]) < 150:
                edges[j] = None

    # 2. route stubs
    removed = 0
    for _ in range(5):
        at = index()
        changed = False
        for k, e in enumerate(edges):
            if e is None or e["lay"] == "w" or length(e["p"]) > STUB_MAX:
                continue
            ends = [nkey(e, 0), nkey(e, 1)]
            for r in list(e["l"]):
                deg = [sum(1 for j, _ in at[x] if edges[j] is not None and r in edges[j]["l"]) for x in ends]
                if min(deg) == 1 and max(deg) >= 3:
                    i = e["l"].index(r)
                    e["l"].pop(i)
                    e["d"].pop(i)
                    removed += 1
                    changed = True
            if not e["l"]:
                edges[k] = None
        if not changed:
            break

    out = []
    for e in edges:
        if e is None:
            continue
        rec = {"c": [to_ll(p) for p in e["p"]], "l": e["l"]}
        if any(e["d"]):
            rec["d"] = e["d"]
        out.append(rec)
    net["edges"] = out
    json.dump(net, open(path, "w"), separators=(",", ":"))
    print(f"tidy junctions: {folded} split crossings folded, {removed} route stubs removed, {len(out)} edges")


if __name__ == "__main__":
    sys.exit(main())
