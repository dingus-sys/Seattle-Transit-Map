"""Place the bike network beside the transit lines: site/data/bikes.json.

A bike lane on a street with buses was drawn from its own survey line, a few metres off the
street the bus band is drawn on and not quite parallel to it, so the two crossed, gapped and
overlapped. Here every bike line (pipeline/bikes_clean.json; the pieces of one route and one kind
that meet end to end are walked as one line) is walked every few metres; where it runs along a
street segment of the transit network (within ATTACH_M, the same way) it is tied to that segment:
from where to where along it (fractions, so the page's own projection is used) and on which side.
The page then draws it with the segment's own geometry, flush against the outside of whatever
bundle of lines that segment shows in the current view, and on its own line where no transit runs.

Where it leaves one street segment for the next one through the junction they share, or leaves a
segment for a few metres and comes back to it (a crossing, a jog round a bus island), or ends a
few metres past the end of its run along a street, it stays with the bundle: those short stretches
on its own line drew loops and hooks beside the band. Run after the network is built (build_all.py).

bikes.json: {net: network.json's hash, routes: [{n: name, k: kind, km}], pieces: [{b: route, k: kind,
  p: index into props, n: streets it runs along, s: [[edge, from, to, side(, off)] | [-1, [lon, lat], ...]]}],
  props: [source properties], stats: {sdot_miles: {kind: miles in SDOT's own network}, fetched}
  (the key's shares)}
  side: +1 right of the direction of travel, -1 left. off: its own distance from the street (m), when
  that is more than SLACK_M.
"""
import hashlib
import json
import math
import os
import sys
from collections import defaultdict

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import LineString
from shapely.strtree import STRtree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from config import SITE  # noqa: E402

CLEAN = os.path.join(HERE, "bikes_clean.json")
fwd = Transformer.from_crs(4326, 32610, always_xy=True)
inv = Transformer.from_crs(32610, 4326, always_xy=True)
STEP = 4.0
ATTACH_M = 35.0     # a bike line this close to a transit street, the same way, runs along it (a lane on
                    # the far roadway of a divided street, a trail across a verge or a parking strip)
SLACK_M = 12.0      # ...and one further off than this keeps its own distance where the map is zoomed in
                    # far enough to show it (flush against the band while the band is wider than that)
MIN_RUN = 30.0      # shorter stretches along a street are crossings, not shared streets
FAR_RUN = 120.0     # ...and a path further off than SLACK_M runs beside the street only for this long
BRIDGE_M = 150.0    # a stretch off the bundle shorter than this, between two runs along it, stays on it
TAIL_M = 40.0       # ...and so does one at either end of a line
END_M = 20.0        # a line ending this close to a transit street runs on to it
RAIL_WATER = {"link", "sounder", "amtrak", "ferry", "watertaxi"}


def to_m(coords):
    a = np.asarray(coords, float)
    x, y = fwd.transform(a[:, 0], a[:, 1])
    return np.column_stack([x, y])


def to_ll(pts):
    lon, lat = inv.transform(pts[:, 0], pts[:, 1])
    return [[round(float(a), 6), round(float(b), 6)] for a, b in zip(lon, lat)]


def resample(pts, step=STEP):
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(pts, axis=0).T))]
    n = max(2, int(math.ceil(d[-1] / step)) + 1)
    s = np.linspace(0, d[-1], n)
    return np.column_stack([np.interp(s, d, pts[:, 0]), np.interp(s, d, pts[:, 1])])


def runs(vals):
    out, i = [], 0
    while i < len(vals):
        j = i
        while j < len(vals) and vals[j] == vals[i]:
            j += 1
        out.append((vals[i], i, j))
        i = j
    return out


def chains(feats):
    """The pieces of one route and one kind that meet end to end (clean_bikes.py puts the ends of
    joined pieces on one point), in order: each chain is [(feature index, reversed), ...]."""
    groups = defaultdict(list)
    for i, f in enumerate(feats):
        groups[(f["properties"]["b"], f["properties"]["k"])].append(i)
    out = []
    for idx in groups.values():
        at = defaultdict(list)
        for i in idx:
            c = feats[i]["geometry"]["coordinates"]
            at[tuple(c[0])].append((i, 0))
            at[tuple(c[-1])].append((i, 1))
        seen = set()

        def walk(i, rev):
            ch = []
            while i is not None and i not in seen:
                seen.add(i)
                ch.append((i, rev))
                c = feats[i]["geometry"]["coordinates"]
                end = tuple(c[0] if rev else c[-1])
                nxt = [x for x in at[end] if x[0] != i and x[0] not in seen]
                if len(at[end]) != 2 or not nxt:
                    break
                i, rev = nxt[0][0], nxt[0][1] == 1
            return ch
        # start at an end that meets nothing (or a junction), then whatever is left (loops)
        for i in idx:
            c = feats[i]["geometry"]["coordinates"]
            for e, rev in ((tuple(c[0]), False), (tuple(c[-1]), True)):
                if i not in seen and len(at[e]) != 2:
                    out.append(walk(i, rev))
        for i in idx:
            if i not in seen:
                out.append(walk(i, False))
    return [ch for ch in out if ch]


def main():
    net_path = os.path.join(SITE, "data", "network.json")
    net = json.load(open(net_path))
    cats = {r["id"]: r["cat"] for r in json.load(open(os.path.join(SITE, "data", "routes.json")))["routes"]}
    lines = net["lines"]
    edges, eidx = [], []
    for k, e in enumerate(net["edges"]):
        if cats.get(lines[e["l"][0]]) in RAIL_WATER:
            continue  # the page draws rail and boats in their own layers; bikes go beside streets
        edges.append(LineString(to_m(e["c"])))
        eidx.append(k)
    tree, E = STRtree(edges), np.asarray(edges, dtype=object)
    ends = [(tuple(net["edges"][k]["c"][0]), tuple(net["edges"][k]["c"][-1])) for k in eidx]
    clean = json.load(open(CLEAN))
    feats = clean["features"]
    props, routes, pieces = [], {}, []
    pkey = {}
    attached_m = total_m = 0.0

    def prop_index(p):
        own = {k: v for k, v in p.items() if k not in ("b", "bn", "bkm", "k", "bk")}
        key = json.dumps(own, sort_keys=True)
        if key not in pkey:
            pkey[key] = len(props)
            props.append(own)
        return pkey[key]

    for ch in chains(feats):
        parts = []
        for i, rev in ch:
            c = to_m(feats[i]["geometry"]["coordinates"])
            parts.append(c[::-1] if rev else c)
        line = np.vstack([parts[0]] + [p[1:] for p in parts[1:]])
        if LineString(line).length < 1:
            continue
        # the chain's own details: those of its longest piece
        main_i = max(ch, key=lambda x: LineString(feats[x[0]]["geometry"]["coordinates"]).length)[0]
        p = feats[main_i]["properties"]
        b = p["b"]
        routes.setdefault(b, {"n": p["bn"], "k": p["bk"], "km": p["bkm"]})
        pts = resample(line)
        n = len(pts)
        g = np.gradient(pts, axis=0)
        hd = np.arctan2(g[:, 1], g[:, 0])
        # nearest transit street segment the same way, per sample
        best = np.full(n, -1)
        bestd = np.full(n, np.inf)
        loc = np.zeros(n)
        along = np.zeros(n, bool)  # going the segment's own way
        sd = np.zeros(n)  # how far to the right of travel the line is from the segment (metres)
        pi, wi = tree.query(shapely.points(pts), predicate="dwithin", distance=ATTACH_M)
        if len(pi):
            G = E[wi]
            P = shapely.points(pts[pi])
            L = shapely.length(G)
            lc = shapely.line_locate_point(G, P)
            q = shapely.get_coordinates(shapely.line_interpolate_point(G, lc))
            qa = shapely.get_coordinates(shapely.line_interpolate_point(G, np.maximum(0, lc - 2)))
            qb = shapely.get_coordinates(shapely.line_interpolate_point(G, np.minimum(L, lc + 2)))
            eh = np.arctan2(qb[:, 1] - qa[:, 1], qb[:, 0] - qa[:, 0])
            dd = np.abs((eh - hd[pi] + np.pi) % (2 * np.pi) - np.pi)
            par = np.minimum(dd, np.pi - dd) < math.radians(22)
            dist = np.hypot(q[:, 0] - pts[pi, 0], q[:, 1] - pts[pi, 1])
            for t in np.nonzero(par)[0]:
                i = pi[t]
                # stay on the segment already followed when it is about as close (no flicker
                # between two segments meeting at a junction)
                d = dist[t] - (1.5 if i and best[i - 1] == wi[t] else 0)
                if d < bestd[i]:
                    bestd[i], best[i] = d, wi[t]
                    loc[i] = lc[t] / max(L[t], 1e-9)
                    along[i] = dd[t] < math.pi / 2
                    # left of the segment's own direction is positive in x-east/y-north metres
                    left = (qb[t, 0] - qa[t, 0]) * (pts[i, 1] - q[t, 1]) - (qb[t, 1] - qa[t, 1]) * (pts[i, 0] - q[t, 0]) > 0
                    sd[i] = dist[t] * (1 if left != along[i] else -1)
        # drop short stretches: crossings and brushes past a junction, and a path that only comes
        # within reach of a street for a moment (it isn't running beside it)
        for v, i, j in runs(best.tolist()):
            if v >= 0 and (j - i) * STEP < (FAR_RUN if abs(float(np.median(sd[i:j]))) > SLACK_M else MIN_RUN):
                best[i:j] = -1

        def node(v, start, fw):
            """The junction where a run along segment v starts (start) or ends, going its own way (fw)."""
            a, z = ends[v]
            return (a if fw else z) if start else (z if fw else a)

        def frac(v, nd):
            return 0.0 if ends[v][0] == nd else 1.0

        # stay with the bundle over short stretches off it
        rr = runs(best.tolist())
        for t, (v, i, j) in enumerate(rr):
            if v >= 0:
                continue
            gap = (j - i) * STEP
            A = rr[t - 1][0] if t > 0 else -1
            B = rr[t + 1][0] if t < len(rr) - 1 else -1
            if A >= 0 and B >= 0 and gap < BRIDGE_M:
                if A == B:  # off the same segment and back on: along it all the way
                    best[i:j] = A
                    loc[i:j] = np.linspace(loc[i - 1], loc[j], j - i + 2)[1:-1]
                    along[i:j] = along[i - 1]
                    sd[i:j] = (sd[i - 1] + sd[j]) / 2
                    continue
                na, nb = node(A, False, along[i - 1]), node(B, True, along[j])
                if na == nb:  # on to the next segment through the junction they share
                    h = (i + j) // 2
                    best[i:h], best[h:j] = A, B
                    loc[i:h] = np.linspace(loc[i - 1], frac(A, na), h - i + 1)[1:]
                    loc[h:j] = np.linspace(frac(B, nb), loc[j], j - h + 1)[:-1]
                    along[i:h], along[h:j] = along[i - 1], along[j]
                    sd[i:h], sd[h:j] = sd[i - 1], sd[j]
            elif gap < TAIL_M and (A >= 0) != (B >= 0) and (i == 0 or j == n):
                # a short end past the run along a street: on along the street, as far as it goes
                if A >= 0:
                    L = E[A].length
                    s = 1 if along[i - 1] else -1
                    best[i:j], along[i:j], sd[i:j] = A, along[i - 1], sd[i - 1]
                    loc[i:j] = np.clip(loc[i - 1] + s * STEP * np.arange(1, j - i + 1) / L, 0, 1)
                else:
                    L = E[B].length
                    s = 1 if along[j] else -1
                    best[i:j], along[i:j], sd[i:j] = B, along[j], sd[j]
                    loc[i:j] = np.clip(loc[j] - s * STEP * np.arange(j - i, 0, -1) / L, 0, 1)
        total_m += n * STEP
        steps = []
        rr = runs(best.tolist())
        for t, (v, i, j) in enumerate(rr):
            if v < 0:
                # own geometry; it starts and ends where the neighbouring runs along a street
                # do, on that segment's line, so the path has no step at the change
                a, z = max(0, i - 1), min(n - 1, j)
                seg = pts[a:z + 1].copy()
                if i > 0 and best[i - 1] >= 0:
                    seg[0] = shapely.get_coordinates(shapely.line_interpolate_point(E[best[i - 1]], loc[i - 1], normalized=True))[0]
                if j < n and best[j] >= 0:
                    seg[-1] = shapely.get_coordinates(shapely.line_interpolate_point(E[best[j]], loc[j], normalized=True))[0]
                # a line that ends just short of a transit street (it meets a lane drawn beside the
                # band there, or the street itself) runs on to the street, so its end is under the
                # band rather than stopping short of the lines drawn beside it
                for at_end in ((i == 0, False), (j >= n, True)):
                    if not at_end[0]:
                        continue
                    q = seg[-1] if at_end[1] else seg[0]
                    hit = tree.query(shapely.Point(q), predicate="dwithin", distance=END_M)
                    if len(hit):
                        dd = shapely.distance(E[hit], shapely.Point(q))
                        g = E[hit[int(np.argmin(dd))]]
                        if float(dd.min()) > 0.5:
                            p2 = np.asarray(g.interpolate(g.project(shapely.Point(q))).coords[0])
                            seg = np.vstack([seg, p2]) if at_end[1] else np.vstack([p2, seg])
                seg = np.asarray(LineString(seg).simplify(0.15).coords)
                if len(seg) >= 2:
                    steps.append([-1] + to_ll(seg))
                continue
            attached_m += (j - i) * STEP
            f0, f1 = float(loc[i]), float(loc[j - 1])
            # straight on to the next segment through their junction: meet at the junction itself
            if t > 0 and rr[t - 1][0] >= 0:
                A = rr[t - 1][0]
                if node(A, False, along[i - 1]) == node(v, True, along[i]):
                    f0 = frac(v, node(v, True, along[i]))
            if t < len(rr) - 1 and rr[t + 1][0] >= 0:
                B = rr[t + 1][0]
                if node(v, False, along[j - 1]) == node(B, True, along[j]):
                    f1 = frac(v, node(v, False, along[j - 1]))
            if abs(f1 - f0) * E[v].length < 1.0:
                continue
            # a trail a little way off the street: how far, and on which side (a lane on the street
            # itself is placed by the side rule below)
            d = float(np.median(sd[i:j]))
            steps.append([int(eidx[v]), round(f0, 5), round(f1, 5), 1] + ([round(d * 2) / 2] if abs(d) > SLACK_M else []))
        if steps:
            pieces.append({"b": b, "p": prop_index(p), "k": p["k"], "n": len(ch), "s": steps})
    # Which sides of a stretch of street have another transit street running alongside close by (the
    # other half of a one-way pair, a freeway beside its frontage road): a bike line drawn flush on
    # that side would lie on the other street's band. As sides of the segment: +1 right of its way.
    local = {k: i for i, k in enumerate(eidx)}

    def crowded(v, f0, f1):
        g = E[local[v]]
        L = g.length
        a, b = sorted((f0 * L, f1 * L))
        at = np.linspace(a, b, max(2, int((b - a) / 15) + 1))
        p = shapely.get_coordinates(shapely.line_interpolate_point(g, at))
        q0 = shapely.get_coordinates(shapely.line_interpolate_point(g, np.maximum(0, at - 2)))
        q1 = shapely.get_coordinates(shapely.line_interpolate_point(g, np.minimum(L, at + 2)))
        t = q1 - q0
        t /= np.maximum(np.hypot(t[:, 0], t[:, 1]), 1e-9)[:, None]
        right = np.column_stack([t[:, 1], -t[:, 0]])
        hd = np.arctan2(t[:, 1], t[:, 0])
        out = set()
        for side in (1, -1):
            hit = np.zeros(len(p), bool)
            for r in (10.0, 20.0, 30.0):
                probe = p + side * r * right
                pi, wi = tree.query(shapely.points(probe), predicate="dwithin", distance=6.0)
                for i, w in zip(pi.tolist(), wi.tolist()):
                    if w == local[v] or hit[i]:
                        continue
                    G = E[w]
                    lc = G.project(shapely.Point(probe[i]))
                    u0, u1 = G.interpolate(max(0, lc - 2)), G.interpolate(min(G.length, lc + 2))
                    dh = abs((math.atan2(u1.y - u0.y, u1.x - u0.x) - hd[i] + math.pi) % (2 * math.pi) - math.pi)
                    hit[i] = min(dh, math.pi - dh) < math.radians(25)
            if hit.mean() > 0.4:
                out.add(side)
        return out

    # one side per route, the same all along it (a lane that hops sides at every block reads as
    # two lanes): the right of travel. Two routes on one street keep apart: the second takes the left.
    # Where most of a run along the streets has another street's band close alongside on that side
    # (and less on the other), the whole run takes the other side, leaving that side to the band.
    taken, moved = {}, 0
    seglen = lambda st: abs(st[2] - st[1]) * E[local[st[0]]].length
    for pc in sorted(pieces, key=lambda x: x["b"]):
        runs_, cur = [], []
        for st in pc["s"] + [[-1]]:
            if st[0] >= 0 and len(st) == 4:
                cur.append(st)
            elif cur:
                runs_.append(cur)
                cur = []
        for run in runs_:
            busyR = busyL = 0.0
            for st in run:
                busy = crowded(st[0], st[1], st[2])
                r = 1 if st[2] >= st[1] else -1  # right of travel, as a side of the segment
                busyR += seglen(st) * (r in busy)
                busyL += seglen(st) * (-r in busy)
            total = sum(seglen(st) for st in run)
            travel = -1 if busyR > 0.5 * total and busyL < 0.5 * busyR else 1
            moved += travel < 0
            for st in run:
                fwdE = st[2] >= st[1]
                sideE = travel if fwdE else -travel  # as a side of the segment
                prev = taken.get(st[0])
                if travel > 0 and prev is not None and prev[1] == sideE and prev[0] != pc["b"]:
                    sideE = -sideE
                taken.setdefault(st[0], (pc["b"], sideE))
                st[3] = sideE if fwdE else -sideE
        for st in pc["s"]:
            if st[0] >= 0 and len(st) > 4:  # a path off to one side: that side
                st[3] = 1 if st[4] > 0 else -1
    # which network the segment numbers refer to (tools/check_bikes.py checks they still match)
    net_id = hashlib.sha1(open(net_path, "rb").read()).hexdigest()[:16]
    # (a route's index is its number b)
    rlist = [routes.get(b, {"n": "", "k": "pbl", "km": 0}) for b in range(max(routes) + 1)] if routes else []
    out = {"net": net_id, "routes": rlist, "pieces": pieces, "props": props, "stats": clean.get("stats", {})}
    path = os.path.join(SITE, "data", "bikes.json")
    json.dump(out, open(path, "w"), separators=(",", ":"))
    print(f"bikes: {len(routes)} routes, {len(pieces)} lines; {attached_m / max(total_m, 1):.0%} of "
          f"{total_m / 1000:.0f} km runs beside transit lines ({moved} runs on the far side from a street "
          f"alongside); {os.path.getsize(path) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
