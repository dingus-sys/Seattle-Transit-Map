"""The bike network is one clean line per bike route: no doubles, no breaks, no angles.

    python3 tools/check_bikes.py          # fails (exit 1) when any check is over its limit

pipeline/clean_bikes.py turns the saved bike network (points 50-200 m apart, two surveys of
some trails, one piece per street name) into pipeline/bikes_clean.json, and build_bikes.py ties
it to the transit network (site/data/bikes.json). Checked here:
 1. bikes.json was built from this network.json (its segment numbers mean these segments);
 2. it follows the real paths: most of it lies on OpenStreetMap's ways (pipeline/bike_osm.json.gz);
 3. no doubles: nowhere do two bike lines run on top of each other the same way (the
    Burke-Gilman Trail was drawn twice, once from each agency's survey);
 4. no breaks: where two pieces of one kind meet end to end they are one route (so hovering
    lights all of it, not one block) and meet at one point (no gap);
 5. no angles: no corner between two long straight stretches (a curve drawn as chords);
 6. the Burke-Gilman Trail is one route of its full length.
"""
import gzip
import hashlib
import json
import math
import os
import re
import sys
from collections import defaultdict

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import LineString
from shapely.strtree import STRtree

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
fwd = Transformer.from_crs(4326, 32610, always_xy=True)
NODE_M = 7.5        # (pipeline/clean_bikes.py joins ends within 8 m)
DOUBLE_M = 6.0        # two bike lines closer than this, the same way, are one line drawn twice
DOUBLE_LIMIT = 1500.0  # metres of doubled line allowed in all (short shared bits at junctions)
ON_OSM = 0.92          # share of the network that must lie on OpenStreetMap's ways (the saved survey: 83%)
ANGLE_LIMIT = 25       # corners between two long stretches allowed in all


def to_m(c):
    a = np.asarray(c, float)
    x, y = fwd.transform(a[:, 0], a[:, 1])
    return np.column_stack([x, y])


def resample(p, step):
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(p, axis=0).T))]
    n = max(2, int(math.ceil(d[-1] / step)) + 1)
    s = np.linspace(0, d[-1], n)
    return np.column_stack([np.interp(s, d, p[:, 0]), np.interp(s, d, p[:, 1])]), s


def heading(p):
    g = np.gradient(p, axis=0)
    return np.arctan2(g[:, 1], g[:, 0])


def main():
    fails = []

    def check(name, ok, info=""):
        print(f"{'PASS' if ok else 'FAIL'}: {name}{' (' + info + ')' if info else ''}")
        if not ok:
            fails.append(name)

    bikes = json.load(open(os.path.join(ROOT, "site", "data", "bikes.json")))
    net_raw = open(os.path.join(ROOT, "site", "data", "network.json"), "rb").read()
    net = json.loads(net_raw)
    nE = len(net["edges"])
    bad = [st for pc in bikes["pieces"] for st in pc["s"] if st[0] >= 0 and (st[0] >= nE or not (0 <= st[1] <= 1 and 0 <= st[2] <= 1))]
    check("bikes.json was built from this network.json", bikes.get("net") == hashlib.sha1(net_raw).hexdigest()[:16] and not bad,
          f"{len(bad)} bad segment steps; rerun pipeline/build_bikes.py" if bad or bikes.get("net") != hashlib.sha1(net_raw).hexdigest()[:16] else "")

    feats = json.load(open(os.path.join(ROOT, "pipeline", "bikes_clean.json")))["features"]
    P = [to_m(f["geometry"]["coordinates"]) for f in feats]
    B = [f["properties"]["b"] for f in feats]
    K = [f["properties"]["bn"] for f in feats]
    lines = [LineString(p) for p in P]
    total = sum(l.length for l in lines)

    # 2. on OpenStreetMap's ways
    ways = [LineString(to_m(c)) for _cls, _sub, _br, c in json.load(gzip.open(os.path.join(ROOT, "pipeline", "bike_osm.json.gz"), "rt"))["ways"] if len(c) >= 2]
    wt = STRtree(ways)
    on = n = 0
    for p in P:
        s, _ = resample(p, 10.0)
        pi, _ = wt.query(shapely.points(s), predicate="dwithin", distance=3.0)
        on += len(np.unique(pi))
        n += len(s)
    check("bike lines follow OpenStreetMap's paths and streets", on / max(n, 1) >= ON_OSM, f"{on / max(n, 1):.0%} on OSM, at least {ON_OSM:.0%}")

    # 3. doubles
    tree = STRtree(lines)
    doubled, worst = 0.0, defaultdict(float)
    for i, p in enumerate(P):
        s, d = resample(p, 4.0)
        hd = heading(s)
        inner = (d > 20) & (d < d[-1] - 20)  # ends meet other lines at junctions
        pi, li = tree.query(shapely.points(s), predicate="dwithin", distance=DOUBLE_M)
        keep = (li != i) & inner[pi]
        pi, li = pi[keep], li[keep]
        if not len(pi):
            continue
        G = np.asarray(lines, dtype=object)[li]
        loc = shapely.line_locate_point(G, shapely.points(s[pi]))
        L = shapely.length(G)
        inside = (loc > 20) & (loc < L - 20)
        qa = shapely.get_coordinates(shapely.line_interpolate_point(G, np.maximum(0, loc - 2)))
        qb = shapely.get_coordinates(shapely.line_interpolate_point(G, np.minimum(L, loc + 2)))
        dd = np.abs((np.arctan2(qb[:, 1] - qa[:, 1], qb[:, 0] - qa[:, 0]) - hd[pi] + np.pi) % (2 * np.pi) - np.pi)
        par = (np.minimum(dd, np.pi - dd) < math.radians(20)) & inside
        hit = np.unique(pi[par])
        doubled += len(hit) * 4.0 / 2  # each double is seen from both lines
        if len(hit):
            worst[K[i]] += len(hit) * 4.0 / 2
    top = ", ".join(f"{k} {v:.0f} m" for k, v in sorted(worst.items(), key=lambda x: -x[1])[:5])
    check("no bike line is drawn twice", doubled <= DOUBLE_LIMIT, f"{doubled:.0f} m doubled of {total / 1000:.0f} km, limit {DOUBLE_LIMIT:.0f}; most: {top}")

    # 4. joined end to end
    ends = []
    for i, p in enumerate(P):
        ends.append((i, p[0]))
        ends.append((i, p[-1]))
    et = STRtree(shapely.points(np.array([e[1] for e in ends])))
    a, b = et.query(shapely.points(np.array([e[1] for e in ends])), predicate="dwithin", distance=NODE_M)
    near = defaultdict(set)
    for x, y in zip(a.tolist(), b.tolist()):
        if ends[x][0] != ends[y][0]:
            near[x].add(y)
    split, gaps = [], []
    kind = [f["properties"].get("k") for f in feats]
    name = [re.sub(r"\s*\(.*?\)", "", (f["properties"].get("name") or "")).strip().lower() for f in feats]
    for x, ys in near.items():
        if len(ys) != 1:
            continue  # a junction of three or more: the routes may part there
        y = next(iter(ys))
        if len(near.get(y, ())) != 1 or x > y:
            continue
        i, j = ends[x][0], ends[y][0]
        if B[i] != B[j]:
            # two kinds with two names (a trail ending where a bike lane starts) are two routes
            if kind[i] == kind[j] or (name[i] and name[i] == name[j]):
                split.append(f"{K[i]} / {K[j]} at {feats[i]['geometry']['coordinates'][0 if x % 2 == 0 else -1]}")
        elif np.hypot(*(ends[x][1] - ends[y][1])) > 0.5:
            gaps.append(K[i])
    check("bike pieces that meet end to end are one route (no highlight stops at a corner)", not split, f"{len(split)} split: {'; '.join(split[:4])}")
    check("pieces of one route meet at one point (no gaps)", not gaps, f"{len(gaps)} gaps: {', '.join(gaps[:4])}")

    # 5. no angles between long straight stretches
    angles = []
    for i, p in enumerate(P):
        v = np.diff(p, axis=0)
        ln = np.hypot(v[:, 0], v[:, 1])
        h = np.arctan2(v[:, 1], v[:, 0])
        turn = np.degrees(np.abs((np.diff(h) + np.pi) % (2 * np.pi) - np.pi))
        long2 = (ln[:-1] > 15) & (ln[1:] > 15)
        for t in np.nonzero(long2 & (turn > 20))[0]:
            angles.append((K[i], round(float(turn[t])), feats[i]["geometry"]["coordinates"][t + 1]))
    check("no sharp corners on long straight stretches (curves are curves)", len(angles) <= ANGLE_LIMIT,
          f"{len(angles)}, limit {ANGLE_LIMIT}: {'; '.join(f'{n} {a} deg at {c}' for n, a, c in angles[:3])}")

    # 6. the Burke-Gilman
    bg = defaultdict(float)
    for f, l in zip(feats, lines):
        if re.sub(r"[^a-z]", "", (f["properties"].get("name") or "").lower()) == "burkegilmantrail":
            bg[f["properties"]["b"]] += l.length
    main_bg = max(bg.values()) if bg else 0
    check("the Burke-Gilman Trail is one route, its whole length", main_bg > 30000 and len(bg) == 1,
          f"{len(bg)} routes: " + ", ".join(f"{v / 1000:.1f} km" for v in sorted(bg.values(), reverse=True)[:4]))

    print(f"{len(fails)} of 7 checks failed" if fails else "all 7 bike checks passed")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
