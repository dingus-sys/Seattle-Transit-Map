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
 6. the Burke-Gilman Trail is one route of its full length;
 7. inside Seattle it is SDOT's own network (pipeline/sdot_bikes.json.gz, its bike map's
    "Existing Bike Facilities" and "Multi-use Trails"): every one of its eight kinds is drawn, as
    that kind, along nearly all of its length;
 8. no gaps at corners: where SDOT's own lines meet (the end of one on another), the map's lines
    meet too (43rd Ave W stopped 11 m short of Discovery Park Blvd; 485 of 1,885 corners had a gap);
 9. every county trail through Seattle is drawn its whole length, except where it runs beside one
    of SDOT's own street lines (the Green Lake loop was cut wherever the protected lanes on the
    lake's streets came within 30 m of it).
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
SDOT_SHARE = 0.97      # share of each kind of SDOT's network drawn as that kind, within SDOT_M
SDOT_M = 15.0          # (its lines run down the street's middle; the map's follow OpenStreetMap's)
NETWORK = {"pbl", "offst", "buffered", "lane", "climb", "greenway", "sharrow", "unknown"}
CORNER_SHARE = 0.96    # share of SDOT's corners where the map's lines meet too (within CORNER_M)
CORNER_M = 1.0
TRAIL_SHARE = 0.92     # share of each county trail through Seattle drawn, as that trail or beside SDOT's line
SDOT_KIND = {"BKF-NGW": "greenway", "BKF-PBL": "pbl", "BKF-BBL": "buffered", "BKF-BL": "lane",
             "BKF-CLMB": "climb", "BKF-SHW": "sharrow", "BKF-OFFST": "offst"}


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
            # two kinds with two names (a trail ending where a bike lane starts) are two routes, and
            # two of SDOT's street kinds are two networks (pipeline/clean_bikes.py NETWORK_KINDS)
            if kind[i] == kind[j] or (name[i] and name[i] == name[j] and not (kind[i] in NETWORK and kind[j] in NETWORK)):
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

    # 7. SDOT's network, kind by kind (a multi-use trail may be drawn from a county's survey of it;
    #    where SDOT has two kinds on one block, the map draws the better one: pipeline/clean_bikes.py RANK)
    sd = json.load(gzip.open(os.path.join(ROOT, "pipeline", "sdot_bikes.json.gz"), "rt"))["layers"]
    order = ["trail", "pbl", "offst", "buffered", "lane", "climb", "greenway", "sharrow", "unknown"]
    by_kind = defaultdict(list)
    for i, f in enumerate(feats):
        by_kind[kind[i]].append(lines[i])
        if f["properties"].get("region") == "Seattle" and kind[i] in order:
            for worse in order[order.index(kind[i]) + 1:]:
                by_kind["over:" + worse].append(lines[i])
    trees = {k: STRtree(v) for k, v in by_kind.items()}
    have, want, miles = defaultdict(float), defaultdict(float), defaultdict(float)
    for lay, fs in sd.items():
        for f in fs["features"]:
            k = "trail" if lay == "trails" else SDOT_KIND.get(f["properties"].get("CATEGORY"), "unknown")
            g = f["geometry"]
            for c in ([g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]):
                m = to_m(c)
                miles[k] += LineString(m).length / 1609.344
                pts, _ = resample(m, 10.0)
                want[k] += len(pts)
                hit = np.zeros(len(pts), bool)
                for t in (k, "over:" + k):
                    if t in trees:
                        hit[trees[t].query(shapely.points(pts), predicate="dwithin", distance=SDOT_M)[0]] = True
                have[k] += hit.sum()
    share = {k: have[k] / want[k] for k in want}
    low = [k for k in share if share[k] < SDOT_SHARE]
    check("Seattle is SDOT's own bike map: all eight kinds and its trails, each drawn as itself", len(want) >= 9 and not low,
          ", ".join(f"{k} {share[k]:.1%} of {miles[k]:.1f} mi" for k in sorted(share, key=lambda k: -miles[k])))

    # 8. corners: SDOT's merged lines (one per street, kind and state, as pipeline/clean_bikes.py
    #    makes them) whose end lies on another's; the map's lines of those two streets near there
    sys.path.insert(0, os.path.join(ROOT, "pipeline"))
    import clean_bikes
    src = []
    for f in clean_bikes.sdot_lines()[0]:
        g = f["geometry"]
        for c in ([g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]):
            src.append(((f["properties"].get("street"), f["properties"]["facility"]), LineString(to_m(c))))
    drawn = defaultdict(list)
    for f, l in zip(feats, lines):
        if f["properties"].get("region") == "Seattle":
            drawn[(f["properties"].get("street"), f["properties"]["k"])].append(l)
    st = STRtree([l for _, l in src])
    corners, apart = 0, []
    for i, (ka, la) in enumerate(src):
        for e in (la.coords[0], la.coords[-1]):
            E = shapely.Point(e)
            for j in st.query(E, predicate="dwithin", distance=1.5):
                kb = src[j][0]
                if j == i or kb == ka:
                    continue
                A = [l for l in drawn.get(ka, []) if l.distance(E) < 40]
                B = [l for l in drawn.get(kb, []) if l.distance(E) < 40]
                if not A or not B:
                    continue  # one of them is drawn as a better kind there
                corners += 1
                d = min(a.distance(b) for a in A for b in B)
                if d > CORNER_M:
                    apart.append((d, ka[0], kb[0]))
    apart.sort(reverse=True)
    check("where SDOT's lines meet at a corner, the map's lines meet (no gaps)", 1 - len(apart) / max(corners, 1) >= CORNER_SHARE,
          f"{1 - len(apart) / max(corners, 1):.1%} of {corners} corners, at least {CORNER_SHARE:.0%}; widest: "
          + "; ".join(f"{a} / {b} {d:.0f} m" for d, a, b in apart[:3]))

    # 9. the county trails through Seattle (the Green Lake loop is not in SDOT's trail layer)
    ct = json.load(open(os.path.join(ROOT, "pipeline", "trails_saved.json")))["features"]
    sdot_t = STRtree([l for _, l in src])
    name_t = defaultdict(list)
    for f, l in zip(feats, lines):
        name_t[re.sub(r"[^a-z]", "", (f["properties"].get("name") or "").lower())].append(l)
    short = []
    for f in ct:
        p = f["properties"]
        if p.get("region") == "Seattle" or p.get("surface") == "unpaved":
            continue
        g = f["geometry"]
        nm = re.sub(r"[^a-z]", "", (p.get("name") or "").lower())
        own = STRtree(name_t[nm]) if name_t.get(nm) else None
        for c in ([g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]):
            m = to_m(c)
            pts, _ = resample(m, 10.0)
            P = shapely.points(pts)
            near_sdot = np.zeros(len(pts), bool)
            near_sdot[sdot_t.query(P, predicate="dwithin", distance=SDOT_M)[0]] = True
            if not near_sdot.any() and len(sdot_t.query(shapely.MultiPoint(pts), predicate="dwithin", distance=300)) == 0:
                continue  # beyond Seattle
            ok = near_sdot.copy()
            if own is not None:
                # the county's line is coarse (points 50-250 m apart): its chords cut the curves by up to 30 m
                ok[own.query(P, predicate="dwithin", distance=35.0)[0]] = True
            share = ok.mean()
            if share < TRAIL_SHARE and len(pts) > 5:
                short.append((share, p.get("name"), len(pts) * 10))
    short.sort()
    check("every county trail through Seattle is drawn its whole length (no gaps)", not short,
          "; ".join(f"{n} {s:.0%} of {L / 1000:.1f} km" for s, n, L in short[:5]))

    print(f"{len(fails)} of 10 checks failed" if fails else "all 10 bike checks passed")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
