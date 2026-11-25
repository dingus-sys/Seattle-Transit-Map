"""Routes on one street must share one bundle, not run as separate copies side by side.

    python3 tools/check_parallel_copies.py            # summary + the worst places; fails over the limit
    python3 tools/check_parallel_copies.py --list 40  # show more places

Two surface edges that carry different routes and lie on top of each other (one runs within
10 m of the other for most of its length) are drawn as two bundles that overlap and cross
(Totem Lake Transit Center before pipeline/merge_parallel.py). Rail and boats are separate
layers and are not checked. Exits non-zero when the overlapping length is over the limit.
"""
import argparse
import json
import os
import sys
from collections import defaultdict

from pyproj import Transformer
from shapely import STRtree
from shapely.geometry import LineString

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SURFACE = {"local", "peak", "frequent", "dart", "rapidride", "swift", "shuttle", "streetcar"}
TOL = 10.0          # meters: two edges this close run along the same street
MIN_OVERLAP = 40.0  # meters of overlap before a pair counts
LIMIT_M = 2000.0    # the gate: total overlapping length allowed (was 309 km before the merge)


def find_copies(net, routes, tol=TOL):
    by = {r["id"]: r for r in routes}
    L, E = net["lines"], net["edges"]
    fwd = Transformer.from_crs(4326, 32610, always_xy=True)
    keys, lines = [], []
    for k, e in enumerate(E):
        if not all(by.get(L[i], {}).get("cat") in SURFACE for i in e["l"]):
            continue
        x, y = fwd.transform(*zip(*e["c"]))
        keys.append(k)
        lines.append(LineString(zip(x, y)))
    tree = STRtree(lines)
    pairs = []
    for i, a in enumerate(lines):
        if a.length < 25:
            continue
        for j in tree.query(a, predicate="dwithin", distance=tol):
            if j <= i or lines[j].length < 25 or set(E[keys[i]]["l"]) == set(E[keys[j]]["l"]):
                continue
            b = lines[j]
            short, other = (a, b) if a.length <= b.length else (b, a)
            inside = short.intersection(other.buffer(tol)).length
            if inside > 0.6 * short.length and inside > MIN_OVERLAP:
                pairs.append((inside, keys[i], keys[j]))
    return pairs


def places(net, routes, pairs):
    """Group overlapping pairs into places (connected groups of edges)."""
    by = {r["id"]: r for r in routes}
    L, E = net["lines"], net["edges"]
    parent = {}

    def root(x):
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for _, a, b in pairs:
        parent[root(a)] = root(b)
    groups = defaultdict(lambda: [0.0, set()])
    for m, a, b in pairs:
        g = groups[root(a)]
        g[0] += m
        g[1] |= {a, b}
    out = []
    for m, ks in groups.values():
        k = max(ks, key=lambda k: len(E[k]["c"]))
        c = E[k]["c"][len(E[k]["c"]) // 2]
        labels = sorted({by[L[i]]["label"] for k in ks for i in E[k]["l"] if L[i] in by})
        out.append((m, c, labels))
    return sorted(out, key=lambda p: -p[0])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", type=int, default=12)
    ap.add_argument("--limit", type=float, default=LIMIT_M)
    ap.add_argument("--network", default=os.path.join(ROOT, "site", "data", "network.json"))
    args = ap.parse_args()
    net = json.load(open(args.network))
    routes = json.load(open(os.path.join(ROOT, "site", "data", "routes.json")))
    routes = routes["routes"] if isinstance(routes, dict) else routes
    pairs = find_copies(net, routes)
    total = sum(p[0] for p in pairs)
    found = places(net, routes, pairs)
    print(f"parallel copies: {len(pairs)} overlapping edge pairs in {len(found)} places, "
          f"{total / 1000:.2f} km overlapping (limit {args.limit / 1000:.2f} km)")
    for m, c, labels in found[:args.list]:
        print(f"  {m:7.0f} m  {c[0]:.5f},{c[1]:.5f}  {' '.join(labels)[:100]}")
    if total > args.limit:
        print("FAIL: routes on the same street are drawn as separate copies; see pipeline/merge_parallel.py")
        sys.exit(1)


if __name__ == "__main__":
    main()
