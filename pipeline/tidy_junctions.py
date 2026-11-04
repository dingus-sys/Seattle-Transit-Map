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

3. A knotted interchange. A freeway station or interchange where buses ramp on and off, loop
   through a park & ride and turn back is traced as a knot of short links that draws as blobs
   and loops. A small knot of short links on a freeway, which loops back on itself or which a
   route winds through, becomes one junction.

4. A corridor bent into a junction. Where a busy straight line (often a freeway) passes a
   junction that was placed on a street beside it, the whole bundle dips to the junction and
   back. The junction is moved onto the corridor's own line, and the side streets bend to it.

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
KNOT_LINK = 160.0   # links in a knotted interchange are shorter than this (m)
KNOT_SIZE = 280.0   # and the whole knot fits in this (m)
BEND_MAX = 75.0     # farthest a junction moves onto its corridor's line (m)


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

    def move_end(j, end, M):
        """move edge j's `end` onto M, easing back to the old line over a short stretch"""
        p = edges[j]["p"] if end == 0 else edges[j]["p"][::-1]
        v = (M[0] - p[0][0], M[1] - p[0][1])
        T = max(40.0, 1.6 * math.hypot(*v))
        T = min(T, 0.6 * length(p)) if length(p) > 1 else T
        out, acc = [], 0.0
        for i, pt in enumerate(p):
            if i:
                acc += math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])
            w = 0.5 * (1 + math.cos(math.pi * acc / T)) if acc < T else 0.0
            out.append((pt[0] + v[0] * w, pt[1] + v[1] * w))
        out[0] = M
        edges[j]["p"] = out if end == 0 else out[::-1]

    # freeways (from build_graph's mask), to tell an interchange from a city street grid
    fw_grid, CELL = defaultdict(list), 250.0
    fw_path = os.path.join(HERE, "freeways.json")
    if os.path.exists(fw_path):
        for ln in json.load(open(fw_path))["lines"]:
            q = [to_m(c) for c in ln]
            for i in range(len(q) - 1):
                a, b = q[i], q[i + 1]
                for gx in range(int(min(a[0], b[0]) // CELL), int(max(a[0], b[0]) // CELL) + 1):
                    for gy in range(int(min(a[1], b[1]) // CELL), int(max(a[1], b[1]) // CELL) + 1):
                        fw_grid[(gx, gy)].append((a, b))

    def to_freeway(pt):
        best = 1e9
        gx, gy = int(pt[0] // CELL), int(pt[1] // CELL)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for a, b in fw_grid.get((gx + dx, gy + dy), ()):
                    vx, vy = b[0] - a[0], b[1] - a[1]
                    L2 = vx * vx + vy * vy or 1.0
                    t = max(0.0, min(1.0, ((pt[0] - a[0]) * vx + (pt[1] - a[1]) * vy) / L2))
                    best = min(best, math.hypot(a[0] + t * vx - pt[0], a[1] + t * vy - pt[1]))
        return best

    def node_pt(n):
        return (n[1], n[2])

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
                    if j != k and edges[j] is not None:
                        move_end(j, end, M)
            edges[k] = None
            folded += 1
        # a short loop left behind (two links between the same pair of junctions)
        for j, e in enumerate(edges):
            if e is not None and nkey(e, 0) == nkey(e, 1) and length(e["p"]) < 150:
                edges[j] = None

    # 3. knotted interchanges
    knots, centers = 0, set()
    at = index()
    adj = defaultdict(list)
    for k, e in enumerate(edges):
        if e is None or e["lay"] != "s" or length(e["p"]) > KNOT_LINK:
            continue
        na, nb = nkey(e, 0), nkey(e, 1)
        if na != nb:
            adj[na].append((nb, k))
            adj[nb].append((na, k))
    seen = set()
    for n0 in list(adj):
        if n0 in seen:
            continue
        comp, inner, todo = {n0}, set(), [n0]
        while todo:
            n = todo.pop()
            for m, k in adj[n]:
                inner.add(k)
                if m not in comp:
                    comp.add(m)
                    todo.append(m)
        seen |= comp
        if not 3 <= len(comp) <= 8:
            continue
        pts = [node_pt(n) for n in comp]
        if max(math.hypot(a[0] - b[0], a[1] - b[1]) for a in pts for b in pts) > KNOT_SIZE:
            continue
        if min(to_freeway(q) for q in pts) > 45:
            continue  # not at a freeway: a city block, leave it be
        uses = defaultdict(int)
        for k in inner:
            for r in edges[k]["l"]:
                uses[r] += 1
        if not (len(inner) >= len(comp) or max(uses.values(), default=0) >= 3):
            continue  # a plain chain of junctions, not a knot
        M = (sum(q[0] for q in pts) / len(pts), sum(q[1] for q in pts) / len(pts))
        centers.add(("s", round(M[0], 1), round(M[1], 1)))
        for k in inner:
            edges[k] = None
        for n in comp:
            for j, end in at[n]:
                if edges[j] is not None:
                    move_end(j, end, M)
        knots += 1
    # links that now start and end at the same junction (a loop through a park & ride)
    at = index()
    for j, e in enumerate(edges):
        if e is not None and nkey(e, 0) == nkey(e, 1) and length(e["p"]) < 800:
            edges[j] = None
    # two links between a knot's new junction and the same neighbor, side by side (two ramps
    # that now meet in one place): one link carrying both. Elsewhere, two links between the same
    # junctions are usually a one-way pair on two streets, and stay as they are.
    merged = 0
    pairs = {}
    for j, e in enumerate(edges):
        if e is None:
            continue
        a, b = nkey(e, 0), nkey(e, 1)
        if a not in centers and b not in centers:
            continue
        key = (a, b) if a <= b else (b, a)
        if key in pairs:
            i = pairs[key]
            f = edges[i]
            if max(length(e["p"]), length(f["p"])) <= 1.35 * min(length(e["p"]), length(f["p"])):
                same = nkey(f, 0) == a
                for r, d in zip(e["l"], e["d"]):
                    if r in f["l"]:
                        fi = f["l"].index(r)
                        dd = d if same else {1: 2, 2: 1}.get(d, 0)
                        if f["d"][fi] != dd:
                            f["d"][fi] = 0
                    else:
                        f["l"].append(r)
                        f["d"].append(d if same else {1: 2, 2: 1}.get(d, 0))
                edges[j] = None
                merged += 1
                continue
        pairs[key] = j

    # 4. corridors bent into a junction
    bent = 0
    for _ in range(2):
        at = index()
        for n, ends in list(at.items()):
            if n[0] != "s" or len(ends) < 3 or any(edges[j] is None for j, _ in ends):
                continue
            best = None
            for x in range(len(ends)):
                for y in range(x + 1, len(ends)):
                    (j1, e1), (j2, e2) = ends[x], ends[y]
                    shared = set(edges[j1]["l"]) & set(edges[j2]["l"])
                    if len(shared) < 2:
                        continue
                    p1, p2 = leaving(j1, e1), leaving(j2, e2)
                    L1, L2 = length(p1), length(p2)
                    if min(L1, L2) < 120:
                        continue
                    A, B = point_at(p1, min(150.0, 0.6 * L1)), point_at(p2, min(150.0, 0.6 * L2))
                    o = node_pt(n)
                    fa = ((A[0] - o[0]), (A[1] - o[1])); fb = ((B[0] - o[0]), (B[1] - o[1]))
                    na_, nb_ = math.hypot(*fa) or 1, math.hypot(*fb) or 1
                    if (fa[0] * fb[0] + fa[1] * fb[1]) / (na_ * nb_) > -0.85:
                        continue  # not a straight line through the junction
                    if not best or len(shared) > best[0]:
                        best = (len(shared), j1, e1, j2, e2, A, B)
            if not best:
                continue
            _, j1, e1, j2, e2, A, B = best
            o = node_pt(n)
            vx, vy = B[0] - A[0], B[1] - A[1]
            L2 = vx * vx + vy * vy or 1.0
            t = max(0.0, min(1.0, ((o[0] - A[0]) * vx + (o[1] - A[1]) * vy) / L2))
            P = (A[0] + t * vx, A[1] + t * vy)
            dv = math.hypot(P[0] - o[0], P[1] - o[1])
            if dv < 8 or dv > BEND_MAX:
                continue
            # only a real kink: the line turns sharply right at the junction (a curving street,
            # whose junction sits on its curve, is left alone)
            kinked = False
            for j, e, far in ((j1, e1, A), (j2, e2, B)):
                near = out_dir(leaving(j, e), 25.0)
                fx, fy = far[0] - o[0], far[1] - o[1]
                fl = math.hypot(fx, fy) or 1
                if near[0] * fx / fl + near[1] * fy / fl < math.cos(math.radians(20)):
                    kinked = True
            if not kinked:
                continue
            for j, e in ends:
                move_end(j, e, P)
            bent += 1

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
    print(f"tidy junctions: {folded} split crossings folded, {knots} knotted interchanges made one junction "
          f"({merged} side-by-side links merged), {bent} corridors straightened through a junction, "
          f"{removed} route stubs removed, {len(out)} edges")
    return folded + knots + merged + bent + removed


if __name__ == "__main__":
    # one change can make room for another (a straightened corridor lines up a crossing): go
    # again until nothing changes
    for _ in range(4):
        if not main():
            break
