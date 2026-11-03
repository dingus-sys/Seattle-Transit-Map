"""Build the shared-corridor ("bundled") line graph.

Problem: where many routes use the same street (3rd Ave, the Ave in the U District,
Rainier Ave ...), their GTFS shapes sit on top of each other and the map becomes a
smear. Fix, in four steps:

1. Rasterize every route (clipped to the map area) as a band 2*R wide and thin the
   union to a 1-pixel centerline. Routes that run within ~2R of each other collapse
   onto one centerline; parallel streets a block apart stay separate.
2. Turn the centerline into a graph (nodes at junctions and ends), prune noise,
   and smooth the geometry.
3. Work out which routes use each edge (by distance to each route's own shape).
4. Order the routes on every edge so they cross as little as possible: for any two
   routes sharing an edge, follow them together until they split; the one that
   turns more to the left is drawn on the left. Following both directions gives
   the same answer all along a shared stretch, so ribbons do not swap places.

The web page draws each (edge, route) pair with a pixel offset derived from that order.
"""
import json
import math
import os
import sys
from collections import defaultdict
from functools import cmp_to_key

import numpy as np
import shapely
from PIL import Image, ImageDraw
from pyproj import Transformer
from shapely.geometry import LineString, MultiLineString, box
from skan import Skeleton
from skimage.morphology import skeletonize

sys.path.insert(0, os.path.dirname(__file__))
from config import CACHE, REGION, SITE  # noqa: E402

# Networks built separately, so trains in tunnels (Link under 3rd Ave, Sounder under
# 4th Ave) and ferries at the docks are not bundled with the buses on the street above.
LAYERS = {
    "rail": {"link", "sounder", "amtrak", "monorail"},
    "water": {"ferry", "watertaxi"},
}

RES = 4.0      # raster cell size in meters
R = 15.0       # merge radius: shapes closer than ~2R share a corridor
SNAP = R + 7   # distance at which a route is considered to use an edge

fwd = Transformer.from_crs(4326, 32610, always_xy=True)
inv = Transformer.from_crs(32610, 4326, always_xy=True)


def layer_of(cat):
    for name, cats in LAYERS.items():
        if cat in cats:
            return name
    return "surface"


def load_routes():
    shapes = json.load(open(os.path.join(CACHE, "route_shapes.json")))
    meta = json.load(open(os.path.join(SITE, "data", "routes.json")))
    rank = {r["id"]: i for i, r in enumerate(meta["routes"])}
    region = box(REGION["west"], REGION["south"], REGION["east"], REGION["north"])
    routes = {}
    for slug, s in shapes.items():
        parts = []
        for line in s["lines"]:
            g = LineString(line).intersection(region)
            for p in getattr(g, "geoms", [g]):
                if p.geom_type == "LineString" and len(p.coords) > 1:
                    xs, ys = fwd.transform(*zip(*p.coords))
                    parts.append(LineString(list(zip(xs, ys))))
        if parts:
            routes[slug] = (layer_of(s["cat"]), MultiLineString(parts))
    return routes, rank


def rasterize(routes):
    xs, ys = fwd.transform([REGION["west"], REGION["east"], REGION["west"], REGION["east"]],
                           [REGION["south"], REGION["south"], REGION["north"], REGION["north"]])
    x0, x1, y0, y1 = min(xs) - 50, max(xs) + 50, min(ys) - 50, max(ys) + 50
    W, H = int((x1 - x0) / RES) + 1, int((y1 - y0) / RES) + 1
    img = Image.new("1", (W, H), 0)
    d = ImageDraw.Draw(img)
    w = int(round(2 * R / RES)) | 1
    rr = R / RES
    for g in routes.values():
        for p in g.geoms:
            pts = [((x - x0) / RES, (y1 - y) / RES) for x, y in p.coords]
            d.line(pts, fill=1, width=w, joint="curve")
            for px, py in (pts[0], pts[-1]):
                d.ellipse([px - rr, py - rr, px + rr, py + rr], fill=1)
    arr = np.array(img, dtype=bool)
    # Fill pinholes where two nearly-parallel shapes almost touch; they would become tiny
    # rings in the centerline. ~500 m² is far smaller than a city block, so streets survive.
    from scipy import ndimage
    lab, n = ndimage.label(~arr, output=np.int32)
    sizes = np.bincount(lab.ravel())
    small = sizes < int(500 / RES ** 2)
    small[0] = False
    arr |= small[lab]
    del lab
    return arr, (x0, y1)


def skeleton_graph(arr, origin):
    x0, y1 = origin
    # Lee's thinning (the default Zhang routine crashes on rasters this size)
    sk = Skeleton(skeletonize(arr.astype(np.uint8), method="lee") > 0)
    nodes, edges = {}, []
    for i in range(sk.n_paths):
        pix = sk.path(i)
        rc = sk.path_coordinates(i)
        coords = [(x0 + c * RES, y1 - r * RES) for r, c in rc]
        a, b = int(pix[0]), int(pix[-1])
        for n in (a, b):
            if n not in nodes:
                r, c = sk.coordinates[n]
                nodes[n] = (x0 + c * RES, y1 - r * RES)
        if len(coords) < 2 or (a == b and len(coords) < 4):
            continue
        edges.append([a, b, coords])
    return nodes, edges


class Graph:
    def __init__(self, nodes, edges):
        self.pos = dict(nodes)
        self.edges = {}
        self.adj = defaultdict(set)
        self._next = 0
        for a, b, c in edges:
            self.add(a, b, c)

    def add(self, a, b, coords, lines=None):
        eid = self._next
        self._next += 1
        self.edges[eid] = {"a": a, "b": b, "c": list(coords), "lines": lines}
        self.adj[a].add(eid)
        self.adj[b].add(eid)
        return eid

    def remove(self, eid):
        e = self.edges.pop(eid)
        self.adj[e["a"]].discard(eid)
        self.adj[e["b"]].discard(eid)
        return e

    def deg(self, n):
        return len(self.adj[n])

    def length(self, eid):
        return LineString(self.edges[eid]["c"]).length

    def other(self, eid, n):
        e = self.edges[eid]
        return e["b"] if e["a"] == n else e["a"]

    def coords_from(self, eid, n):
        """Edge coordinates oriented to start at node n."""
        e = self.edges[eid]
        return e["c"] if e["a"] == n else e["c"][::-1]


def prune_spurs(g, min_len):
    changed = True
    while changed:
        changed = False
        for eid in list(g.edges):
            if eid not in g.edges:
                continue
            e = g.edges[eid]
            if e["a"] == e["b"]:
                continue
            da, db = g.deg(e["a"]), g.deg(e["b"])
            if (da == 1 and db >= 3 or db == 1 and da >= 3) and g.length(eid) < min_len:
                g.remove(eid)
                changed = True


def merge_chains(g, same=lambda e1, e2: True):
    """Join edges through degree-2 nodes (optionally only when `same`)."""
    for n in list(g.adj):
        if g.deg(n) != 2:
            continue
        e1, e2 = list(g.adj[n])
        if e1 == e2 or not same(g.edges[e1], g.edges[e2]):
            continue
        a = g.other(e1, n)
        b = g.other(e2, n)
        if a == n or b == n:
            continue
        c1 = g.coords_from(e1, a)
        c2 = g.coords_from(e2, n)
        lines = g.edges[e1]["lines"]
        lines2 = g.edges[e2]["lines"]
        g.remove(e1)
        g.remove(e2)
        g.add(a, b, c1 + c2[1:], lines if lines is not None else lines2)
        del g.adj[n]


def contract_short(g, max_len):
    """Collapse short junction-to-junction edges into a single node."""
    changed = True
    while changed:
        changed = False
        for eid in sorted(g.edges, key=lambda k: g.length(k) if k in g.edges else 0):
            if eid not in g.edges:
                continue
            e = g.edges[eid]
            a, b = e["a"], e["b"]
            if a == b or g.length(eid) >= max_len or g.deg(a) < 3 and g.deg(b) < 3:
                continue
            if g.deg(a) == 1 or g.deg(b) == 1:
                continue
            g.remove(eid)
            pa, pb = g.pos[a], g.pos[b]
            mid = ((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2)
            g.pos[a] = mid
            for other in list(g.adj[b]):
                oe = g.edges[other]
                if oe["a"] == b:
                    oe["a"] = a
                if oe["b"] == b:
                    oe["b"] = a
                g.adj[a].add(other)
            del g.adj[b]
            for k in g.adj[a]:
                oe = g.edges[k]
                if oe["a"] == a:
                    oe["c"][0] = mid
                if oe["b"] == a:
                    oe["c"][-1] = mid
            changed = True
            break


def chaikin(coords, n=2):
    pts = np.asarray(coords)
    for _ in range(n):
        if len(pts) < 3:
            break
        q = 0.75 * pts[:-1] + 0.25 * pts[1:]
        r = 0.25 * pts[:-1] + 0.75 * pts[1:]
        mid = np.empty((2 * len(q), 2))
        mid[0::2], mid[1::2] = q, r
        pts = np.vstack([pts[:1], mid[1:-1], pts[-1:]])
    return [tuple(p) for p in pts]


def smooth(g):
    for e in g.edges.values():
        ls = LineString(e["c"]).simplify(RES * 0.9, preserve_topology=False)
        c = list(ls.coords)
        c[0], c[-1] = e["c"][0], e["c"][-1]
        e["c"] = chaikin(c, 2) if len(c) > 2 else c


def assign_lines(g, routes):
    eids = list(g.edges)
    geoms = [LineString(g.edges[k]["c"]) for k in eids]
    tree = shapely.STRtree(geoms)
    members = defaultdict(set)
    for slug, rg in routes.items():
        for idx in tree.query(rg, predicate="dwithin", distance=SNAP):
            line = geoms[idx]
            L = line.length
            trim = min(2 * R, L * 0.25)
            n = max(3, int((L - 2 * trim) / 6))
            pts = [line.interpolate(trim + (L - 2 * trim) * t / (n - 1)) for t in range(n)]
            ok = shapely.dwithin(pts, rg, SNAP)
            if ok.mean() >= 0.7:
                members[eids[idx]].add(slug)
    for k in eids:
        g.edges[k]["lines"] = frozenset(members.get(k, ()))
        if not g.edges[k]["lines"]:
            g.remove(k)
    for n in [n for n, s in g.adj.items() if not s]:
        del g.adj[n]


def repair_gaps(g, routes, max_gap=700.0):
    """Reconnect routes whose coarse agency shapes miss a short stretch of street.

    A route that dead-ends at a junction that is not one of its real termini, with
    another loose end nearby, gets the shortest street path between the two ends —
    as long as that path stays close to the route's own shape."""
    import heapq
    length = {eid: g.length(eid) for eid in g.edges}
    added = 0
    for slug, rg in routes.items():
        ends = [pt for p in rg.geoms for pt in (p.coords[0], p.coords[-1])]
        deg = defaultdict(int)
        for e in g.edges.values():
            if slug in e["lines"]:
                deg[e["a"]] += 1
                deg[e["b"]] += 1
        loose = [n for n, d in deg.items() if d == 1 and min(math.dist(g.pos[n], t) for t in ends) > 4 * R]
        used = set()
        for a in loose:
            if a in used:
                continue
            targets = set(loose) - used - {a}
            if not targets:
                break
            dist, prev, pq, found = {a: 0.0}, {}, [(0.0, a)], None
            while pq:
                d, n = heapq.heappop(pq)
                if d > dist.get(n, 1e18):
                    continue
                if n in targets:
                    found = n
                    break
                if d > max_gap:
                    break
                for eid in g.adj[n]:
                    if slug in g.edges[eid]["lines"]:
                        continue
                    m = g.other(eid, n)
                    nd = d + length[eid]
                    if nd < dist.get(m, 1e18):
                        dist[m], prev[m] = nd, (n, eid)
                        heapq.heappush(pq, (nd, m))
            if found is None:
                continue
            path, n = [], found
            while n != a:
                n, eid = prev[n]
                path.append(eid)
            if not all(LineString(g.edges[k]["c"]).interpolate(0.5, normalized=True).distance(rg) < 4 * R for k in path):
                continue
            for k in path:
                g.edges[k]["lines"] = g.edges[k]["lines"] | {slug}
            used |= {a, found}
            added += len(path)
    return added


def refine_geometry(g, routes, rank):
    """Put the network back on the real streets.

    The traced centerline is only approximate: a junction lands at the middle of the merged
    band, which near freeway ramps can be tens of meters from the actual intersection.
    1. Move each junction to where its routes' own shapes pass (median of nearest points).
    2. Redraw each segment from the agency shape of the route that matches it best.
    """
    from shapely.geometry import Point
    from shapely.ops import nearest_points, substring
    moved = 0
    for n, inc in g.adj.items():
        if not inc:
            continue
        p = Point(g.pos[n])
        lines = set().union(*(g.edges[e]["lines"] for e in inc))
        near = []
        for l in lines:
            q = nearest_points(routes[l], p)[0]
            if q.distance(p) < 3 * R:
                near.append((q.x, q.y))
        if near:
            xs, ys = sorted(c[0] for c in near), sorted(c[1] for c in near)
            m = len(near) // 2
            new = (xs[m], ys[m]) if len(near) % 2 else ((xs[m - 1] + xs[m]) / 2, (ys[m - 1] + ys[m]) / 2)
            d = Point(new).distance(p)
            if d > 1.6 * R:  # never move a junction more than ~25 m
                f = 1.6 * R / d
                new = (p.x + (new[0] - p.x) * f, p.y + (new[1] - p.y) * f)
            moved += d > 5
            g.pos[n] = new
    replaced = 0
    for e in g.edges.values():
        a, b = g.pos[e["a"]], g.pos[e["b"]]
        old = LineString(e["c"])
        best = None
        if e["a"] != e["b"]:
            for l in e["lines"]:
                for part in routes[l].geoms:
                    da, db = part.project(Point(a)), part.project(Point(b))
                    if part.interpolate(da).distance(Point(a)) > 2 * R or part.interpolate(db).distance(Point(b)) > 2 * R:
                        continue
                    if abs(db - da) < 1:
                        continue
                    sub = substring(part, min(da, db), max(da, db))
                    # must run the same way as the traced segment, without detours or doubling back
                    if sub.length < 0.75 * old.length or sub.length > 1.2 * old.length + 8:
                        continue
                    h = sub.hausdorff_distance(old)
                    if h > 1.4 * R:
                        continue
                    key = (round(h / 4), rank.get(l, 0))
                    if best is None or key < best[0]:
                        best = (key, list(sub.coords)[:: 1 if da < db else -1])
        coords = best[1] if best else list(e["c"])
        replaced += best is not None
        coords[0], coords[-1] = a, b
        e["c"] = coords
    return moved, replaced


def bearing_at(g, eid, n, dist=25.0):
    c = g.coords_from(eid, n)
    ls = LineString(c)
    p = ls.interpolate(min(dist, ls.length * 0.5))
    return math.atan2(p.y - c[0][1], p.x - c[0][0])


def turn(a_in, a_out):
    t = a_out - a_in
    while t <= -math.pi:
        t += 2 * math.pi
    while t > math.pi:
        t -= 2 * math.pi
    return t


def order_lines(g, rank):
    """Order the routes on every segment, left to right in the segment's a->b direction.

    1. For two routes sharing a segment, follow them together (both ways) until they split;
       the one that turns more to the left goes on the left. A route that simply ends
       gives no information, so the other direction decides.
    2. Pairs that never split nearby are undecided. Their order is copied across straight
       continuations from neighbors that do know, so a pair keeps the same side along a
       whole corridor.
    3. Whatever is still undecided gets one consistent tie-break per corridor, seeded once
       and propagated the same way.
    """
    from collections import deque
    from itertools import combinations
    cont_cache = {}

    def cont(eid, n, line):
        key = (eid, n, line)
        if key in cont_cache:
            return cont_cache[key]
        a_in = bearing_at(g, eid, n) + math.pi
        best, best_t = None, None
        for k in g.adj[n]:
            if k == eid or line not in g.edges[k]["lines"]:
                continue
            t = abs(turn(a_in, bearing_at(g, k, n)))
            if best is None or t < best_t:
                best, best_t = k, t
        cont_cache[key] = best
        return best

    def walk(eid, n, A, B, limit=80):
        depth, seen = 0, set()
        while depth < limit:
            nA, nB = cont(eid, n, A), cont(eid, n, B)
            if nA is None or nB is None:
                return 0, depth
            if nA == nB:
                if (nA, n) in seen:
                    return 0, depth
                seen.add((nA, n))
                eid, n = nA, g.other(nA, n)
                depth += 1
                continue
            a_in = bearing_at(g, eid, n) + math.pi
            tA, tB = turn(a_in, bearing_at(g, nA, n)), turn(a_in, bearing_at(g, nB, n))
            if abs(tA - tB) < 1e-6:
                return 0, depth
            return (1 if tA > tB else -1), depth
        return 0, depth

    # 1. divergence-based decisions (+1: A left of B going a->b)
    rel = {}
    for eid, e in g.edges.items():
        r = {}
        for A, B in combinations(sorted(e["lines"]), 2):
            sF, dF = walk(eid, e["b"], A, B)
            sB, dB = walk(eid, e["a"], A, B)
            sB = -sB
            r[(A, B)] = (sF if dF <= dB else sB) if (sF and sB and sF != sB) else (sF or sB)
        rel[eid] = r

    # straight continuations: (other edge, factor mapping this edge's frame to the other's)
    links = defaultdict(list)
    for n, inc in g.adj.items():
        inc = [k for k in inc if g.edges[k]["a"] != g.edges[k]["b"]]
        for e1, e2 in combinations(inc, 2):
            if math.cos(bearing_at(g, e1, n) - bearing_at(g, e2, n)) > -0.5:
                continue
            f = (1 if g.edges[e1]["b"] == n else -1) * (1 if g.edges[e2]["a"] == n else -1)
            links[e1].append((e2, f))
            links[e2].append((e1, f))

    def propagate(queue):
        while queue:
            eid, pair = queue.popleft()
            v = rel[eid][pair]
            for other, f in links[eid]:
                r2 = rel[other]
                if pair in r2 and r2[pair] == 0:
                    r2[pair] = v * f
                    queue.append((other, pair))

    # 2. spread known decisions to undecided neighbors
    propagate(deque((eid, pair) for eid, r in rel.items() for pair, v in r.items() if v))

    # 3. seed remaining ties once per corridor, then spread
    for eid, r in rel.items():
        e = g.edges[eid]
        (xa, ya), (xb, yb) = e["c"][0], e["c"][-1]
        canon = 1 if (xb - xa > 1 or (abs(xb - xa) <= 1 and yb > ya)) else -1
        for pair, v in r.items():
            if v == 0:
                A, B = pair
                r[pair] = canon * (1 if rank.get(A, 0) < rank.get(B, 0) else -1)
                propagate(deque([(eid, pair)]))

    for eid, e in g.edges.items():
        r = rel[eid]

        def cmp(A, B):
            if A == B:
                return 0
            v = r[(A, B)] if (A, B) in r else -r[(B, A)]
            return -1 if v > 0 else 1

        e["order"] = sorted(e["lines"], key=cmp_to_key(cmp))


def build_layer(routes, rank, name):
    import time
    t0 = time.time()
    arr, origin = rasterize(routes)
    nodes, edges = skeleton_graph(arr, origin)
    g = Graph(nodes, edges)
    for _ in range(3):
        prune_spurs(g, 2.2 * R)
        merge_chains(g)
    contract_short(g, 2.8 * R)  # junctions closer than ~40 m become one (city blocks are 70 m+)
    merge_chains(g)
    smooth(g)
    assign_lines(g, routes)
    merge_chains(g, same=lambda e1, e2: e1["lines"] == e2["lines"])
    for eid in [k for k, e in g.edges.items() if e["a"] == e["b"] and g.length(k) < 150]:
        g.remove(eid)  # leftover rings and tight turnaround loops draw as blobs when bundled
    fixed = repair_gaps(g, routes)
    merge_chains(g, same=lambda e1, e2: e1["lines"] == e2["lines"])
    moved, replaced = refine_geometry(g, routes, rank)
    order_lines(g, rank)
    print(f"  {name}: {len(routes)} routes -> {len(g.edges)} edges, {fixed} gap segments filled, "
          f"{moved} junctions moved, {replaced} segments on real shapes ({time.time() - t0:.0f}s)", flush=True)
    return g


def main():
    all_routes, rank = load_routes()
    print(f"{len(all_routes)} routes clipped to region")
    lines = sorted(all_routes, key=lambda s: rank.get(s, 0))
    li = {s: i for i, s in enumerate(lines)}
    out_edges = []
    for name in ("water", "surface", "rail"):
        routes = {k: g for k, (lay, g) in all_routes.items() if lay == name}
        if not routes:
            continue
        g = build_layer(routes, rank, name)
        for eid, e in g.edges.items():
            lon, lat = inv.transform(*zip(*e["c"]))
            coords = [[round(x, 5), round(y, 5)] for x, y in zip(lon, lat)]
            dedup = [coords[0]] + [c for p, c in zip(coords, coords[1:]) if c != p]
            if len(dedup) < 2:
                continue
            out_edges.append({"c": dedup, "l": [li[s] for s in e["order"]]})
    out = {"lines": lines, "edges": out_edges}
    path = os.path.join(SITE, "data", "network.json")
    json.dump(out, open(path, "w"), separators=(",", ":"))
    multi = sum(1 for e in out_edges if len(e["l"]) > 1)
    print(f"wrote {len(out_edges)} edges ({multi} shared), {os.path.getsize(path)/1e6:.2f} MB")


if __name__ == "__main__":
    main()
