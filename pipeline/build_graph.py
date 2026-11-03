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
R_FWY = 52.0   # merge radius on freeways: both carriageways and the ramps become one line
R = 15.0       # merge radius: shapes closer than ~2R share a corridor
SNAP = R + 7   # distance at which a route is considered to use an edge

fwd = Transformer.from_crs(4326, 32610, always_xy=True)
inv = Transformer.from_crs(32610, 4326, always_xy=True)


FREEWAYS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "freeways.json")


def freeway_lines():
    """Freeway centerlines (OpenMapTiles "motorway", ramps and short tunnels included) as
    lon/lat lists, read from the cached z12 base-map tiles. The result is saved to
    pipeline/freeways.json so builds without the tiles (the weekly refresh) can use it too."""
    import mapbox_vector_tile
    root = os.path.join(CACHE, "tiles_raw")
    z = 12
    n = 2 ** z
    x0 = int((REGION["west"] + 180) / 360 * n)
    x1 = int((REGION["east"] + 180) / 360 * n)
    lat2y = lambda lat: int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n)  # noqa: E731
    y0, y1 = lat2y(REGION["north"]), lat2y(REGION["south"])
    versions = sorted(os.listdir(root), reverse=True) if os.path.isdir(root) else []
    for v in versions:
        tiles = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
        path = lambda x, y: os.path.join(root, v, str(z), str(x), f"{y}.pbf")  # noqa: E731
        if not all(os.path.exists(path(x, y)) for x, y in tiles):
            continue
        out, tunnels = [], []
        for tx, ty in tiles:
            d = mapbox_vector_tile.decode(open(path(tx, ty), "rb").read(), default_options={"y_coord_down": True})
            tr = d.get("transportation")
            if not tr:
                continue
            ext = tr["extent"]
            for feat in tr["features"]:
                if feat["properties"].get("class") != "motorway":
                    continue
                geom = feat["geometry"]
                parts = [geom["coordinates"]] if geom["type"] == "LineString" else geom["coordinates"] if geom["type"] == "MultiLineString" else []
                for part in parts:
                    if len(part) < 2:
                        continue
                    line = [[round((tx + gx / ext) / n * 360 - 180, 5),
                             round(math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (ty + gy / ext) / n)))), 5)]
                            for gx, gy in part]
                    (tunnels if feat["properties"].get("brunnel") == "tunnel" else out).append(line)
        # Short freeway tunnels (I-90 under Mount Baker, the lids) count; long ones (SR 99 under
        # downtown) don't, so buses on the streets above aren't pulled onto them.
        from shapely.ops import linemerge
        merged = linemerge([LineString(t) for t in tunnels]) if tunnels else None
        for t in getattr(merged, "geoms", [merged] if merged is not None else []):
            xs, ys = fwd.transform(*zip(*t.coords))
            if LineString(list(zip(xs, ys))).length < 1600:
                out.append([list(c) for c in t.coords])
        if out:
            json.dump({"source": f"OpenFreeMap {v}, z{z}", "lines": out}, open(FREEWAYS, "w"), separators=(",", ":"))
            return out
    if os.path.exists(FREEWAYS):
        return json.load(open(FREEWAYS))["lines"]
    return []


def freeway_mask():
    """Freeway corridors as one polygon in meters. Routes inside it are drawn wider so that both
    directions of a freeway, which can run 30-80 m apart, collapse into a single line."""
    from shapely.ops import unary_union
    lines = []
    for part in freeway_lines():
        xs, ys = fwd.transform(*zip(*part))
        lines.append(LineString(list(zip(xs, ys))))
    if not lines:
        return None
    return unary_union([l.buffer(40, quad_segs=4) for l in lines]).simplify(5)


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


def rasterize(routes, mask=None):
    xs, ys = fwd.transform([REGION["west"], REGION["east"], REGION["west"], REGION["east"]],
                           [REGION["south"], REGION["south"], REGION["north"], REGION["north"]])
    x0, x1, y0, y1 = min(xs) - 50, max(xs) + 50, min(ys) - 50, max(ys) + 50
    W, H = int((x1 - x0) / RES) + 1, int((y1 - y0) / RES) + 1
    img = Image.new("1", (W, H), 0)
    d = ImageDraw.Draw(img)
    def draw(geom, radius):
        w, rr = int(round(2 * radius / RES)) | 1, radius / RES
        for p in getattr(geom, "geoms", [geom]):
            if p.geom_type != "LineString" or len(p.coords) < 2:
                continue
            pts = [((x - x0) / RES, (y1 - y) / RES) for x, y in p.coords]
            d.line(pts, fill=1, width=w, joint="curve")
            for px, py in (pts[0], pts[-1]):
                d.ellipse([px - rr, py - rr, px + rr, py + rr], fill=1)
    for g in routes.values():
        draw(g, R)
        if mask is not None and g.intersects(mask):
            draw(g.intersection(mask), R_FWY)
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


def assign_lines(g, routes, mask=None):
    eids = list(g.edges)
    geoms = [LineString(g.edges[k]["c"]) for k in eids]
    tree = shapely.STRtree(geoms)
    members = defaultdict(set)
    on_fwy = [mask is not None and line.interpolate(0.5, normalized=True).within(mask) for line in geoms]
    for slug, rg in routes.items():
        for idx in tree.query(rg, predicate="dwithin", distance=R_FWY + 10):
            line = geoms[idx]
            snap = R_FWY + 10 if on_fwy[idx] else SNAP
            L = line.length
            trim = min(2 * R, L * 0.25)
            n = max(3, int((L - 2 * trim) / 6))
            pts = [line.interpolate(trim + (L - 2 * trim) * t / (n - 1)) for t in range(n)]
            ok = shapely.dwithin(pts, rg, snap)
            if ok.mean() >= 0.7:
                members[eids[idx]].add(slug)
    for k in eids:
        g.edges[k]["lines"] = frozenset(members.get(k, ()))
        if not g.edges[k]["lines"]:
            g.remove(k)
    for n in [n for n, s in g.adj.items() if not s]:
        del g.adj[n]


def trim_stubs(g, routes, max_len=140.0, mask=None):
    """Drop a route from short dead-end pieces that aren't one of its real ends: leftovers
    of ramps and station loops that would draw as little hooks. Near freeways, where ramps
    run alongside the main line and pick up its routes, longer pieces (450 m) go too.

    Only redundant pieces go: where the route's own shape beside the piece is already drawn
    by its other segments. A dead end that is the only drawing of that stretch is the edge
    of a gap, and trimming it would only widen the gap."""
    from shapely.ops import unary_union

    def redundant(eid, slug, rg, mine):
        stub = LineString(g.edges[eid]["c"])
        snap = R_FWY + 10 if limit.get(eid, max_len) > max_len else SNAP
        beside = rg.intersection(stub.buffer(snap))
        if beside.is_empty or beside.length < 5:
            return True  # the route doesn't really run here
        others = [LineString(g.edges[k]["c"]) for k in mine if k != eid]
        others = [o for o in others if o.distance(stub) < 2 * snap + 50]
        if not others:
            return False
        drawn = beside.intersection(unary_union(others).buffer(snap)).length
        return drawn >= 0.6 * beside.length

    near_fwy = mask.buffer(60) if mask is not None else None
    limit = {}
    for eid, e in g.edges.items():
        mid = LineString(e["c"]).interpolate(0.5, normalized=True)
        limit[eid] = 450.0 if near_fwy is not None and near_fwy.contains(mid) else max_len
    removed = 0
    for slug, rg in routes.items():
        ends = [pt for p in rg.geoms for pt in (p.coords[0], p.coords[-1])]
        changed = True
        while changed:
            changed = False
            deg = defaultdict(list)
            mine = []
            for eid, e in g.edges.items():
                if slug in e["lines"]:
                    mine.append(eid)
                    if e["a"] != e["b"]:
                        deg[e["a"]].append(eid)
                        deg[e["b"]].append(eid)
            for n, eids in deg.items():
                if len(eids) != 1:
                    continue
                if min(math.dist(g.pos[n], t) for t in ends) < 4 * R:
                    continue
                eid = eids[0]
                other = g.other(eid, n)
                if len(deg.get(other, [])) < 2 or g.length(eid) > limit.get(eid, max_len):
                    continue
                if not redundant(eid, slug, rg, mine):
                    continue
                g.edges[eid]["lines"] = g.edges[eid]["lines"] - {slug}
                removed += 1
                changed = True
                break
    for eid in [k for k, e in g.edges.items() if not e["lines"]]:
        g.remove(eid)
    return removed


def fill_gaps(g, routes, mask=None, max_span=2500.0):
    """Bridge what is still missing of each route with the route's own shape.

    Where a route's shape cuts across a big interchange, the traced streets may not follow it
    and the route ends up with a hole: two loose ends with nothing drawn between them. Loose
    ends are paired along the shape, and an undrawn stretch between a pair becomes a segment
    of its own (shared by every route with the same two ends)."""
    from shapely.geometry import Point
    from shapely.ops import substring, unary_union
    near_fwy = mask.buffer(60) if mask is not None else None
    on_fwy = {k: near_fwy is not None and near_fwy.contains(LineString(e["c"]).interpolate(0.5, normalized=True))
              for k, e in g.edges.items()}
    added, filled = {}, 0
    for slug, rg in routes.items():
        mine = [k for k, e in g.edges.items() if slug in e["lines"]]
        if not mine:
            continue
        deg = defaultdict(int)
        for k in mine:
            e = g.edges[k]
            if e["a"] != e["b"]:
                deg[e["a"]] += 1
                deg[e["b"]] += 1
        ends = [pt for p in rg.geoms for pt in (p.coords[0], p.coords[-1])]
        loose = [n for n, d in deg.items() if d == 1 and min(math.dist(g.pos[n], t) for t in ends) > 4 * R]
        if len(loose) < 2:
            continue
        cover = unary_union([LineString(g.edges[k]["c"]).buffer(R_FWY + 10 if on_fwy.get(k) else SNAP + 8) for k in mine])
        for part in rg.geoms:
            on = sorted((part.project(Point(g.pos[n])), n) for n in loose if part.distance(Point(g.pos[n])) < 4 * R)
            for (s1, n1), (s2, n2) in zip(on, on[1:]):
                if n1 == n2 or not (2 * R < s2 - s1 < max_span):
                    continue
                sub = substring(part, s1, s2)
                missing = sub.difference(cover).length
                if missing < 40 or missing < 0.25 * sub.length:
                    continue  # already drawn: two loose ends side by side, not a hole
                key = frozenset((n1, n2))
                if key in added and added[key] in g.edges:
                    g.edges[added[key]]["lines"] = g.edges[added[key]]["lines"] | {slug}
                else:
                    a, b = (n1, n2)
                    coords = [g.pos[a]] + list(sub.coords)[1:-1] + [g.pos[b]]
                    added[key] = g.add(a, b, coords, frozenset({slug}))
                filled += 1
    return filled


def collapse_bubbles(g, mask=None):
    """Fold side-by-side detours into one line.

    Where a route's two directions take slightly different paths (the two ramps of a freeway
    interchange, a loop ramp, a pair of parallel carriageways) the network has a "bubble": two
    paths between the same junctions. When the second path carries every route of the first,
    the first is dropped and its routes move over. Near freeways bubbles up to 1.2 km long and
    160 m wide are folded; elsewhere only tiny ones (500 m, 60 m), so real one-way street pairs
    in town stay apart."""
    import heapq
    near_fwy = mask.buffer(150) if mask is not None else None
    folded = 0
    changed = True
    while changed:
        changed = False
        length = {k: g.length(k) for k in g.edges}
        for eid in sorted(g.edges, key=lambda k: -length[k]):
            if eid not in g.edges:
                continue
            e = g.edges[eid]
            a, b, L = e["a"], e["b"], length[eid]
            if a == b or L > 1200:
                continue
            line = LineString(e["c"])
            fwy = near_fwy is not None and near_fwy.contains(line.interpolate(0.5, normalized=True))
            max_len, max_sep = (1200.0, 160.0) if fwy else (500.0, 60.0)
            if L > max_len:
                continue
            limit = 1.6 * L + 100
            dist, prev, pq, found = {a: 0.0}, {}, [(0.0, a)], False
            while pq:
                d, n = heapq.heappop(pq)
                if d > dist.get(n, 1e18):
                    continue
                if n == b:
                    found = True
                    break
                for k in g.adj[n]:
                    if k == eid or not (g.edges[k]["lines"] & e["lines"]):
                        continue
                    m = g.other(k, n)
                    nd = d + length[k]
                    if m != n and nd <= limit and nd < dist.get(m, 1e18):
                        dist[m], prev[m] = nd, (n, k)
                        heapq.heappush(pq, (nd, m))
            if not found:
                continue
            path, n = [], b
            while n != a:
                n, k = prev[n]
                path.append(k)
            if not e["lines"] <= set().union(*(g.edges[k]["lines"] for k in path)):
                continue
            coords, n = [], a
            for k in reversed(path):
                c = g.coords_from(k, n)
                coords += c if not coords else c[1:]
                n = g.other(k, n)
            if line.hausdorff_distance(LineString(coords)) > max_sep:
                continue
            for k in path:
                g.edges[k]["lines"] = g.edges[k]["lines"] | e["lines"]
            g.remove(eid)
            folded += 1
            changed = True
    for n in [n for n, s in g.adj.items() if not s]:
        del g.adj[n]
    return folded


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


def unhook(g, mask=None, reach=120.0, max_angle=35.0):
    """Straighten segments that leave a freeway junction with a sideways jog.

    Freeways are traced wide, so a ramp's junction lands on the freeway line while the ramp
    itself runs 30-50 m to the side; redrawn on the real shape, the segment would start with a
    sharp hook out to the ramp. At junctions on freeways, points in the first stretch that lie
    more than `max_angle` off the segment's overall direction are dropped."""
    if mask is None:
        return 0
    from shapely.geometry import Point
    near_fwy = mask.buffer(30)
    cos_max = math.cos(math.radians(max_angle))
    fixed = 0
    for e in g.edges.values():
        if e["a"] == e["b"]:
            continue
        for rev in (False, True):
            c = e["c"][::-1] if rev else e["c"]
            ls = LineString(c)
            if ls.length < 1.5 * reach or not near_fwy.contains(Point(c[0])):
                continue
            n0 = np.asarray(c[0])
            t = np.asarray(ls.interpolate(min(2 * reach, ls.length / 2)).coords[0])
            d = (t - n0) / (np.linalg.norm(t - n0) or 1)
            run, last = 0.0, -1
            for i in range(1, len(c)):
                run += math.dist(c[i - 1], c[i])
                if run > reach:
                    break
                v = np.asarray(c[i]) - n0
                r = np.linalg.norm(v)
                if r > 1 and float(np.dot(v, d)) / r < cos_max:
                    last = i
            if 0 < last < len(c) - 1:
                c = [c[0]] + c[last + 1:]
                e["c"] = c[::-1] if rev else c
                fixed += 1
    return fixed


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


def build_layer(routes, rank, name, mask=None):
    import time
    t0 = time.time()
    arr, origin = rasterize(routes, mask)
    nodes, edges = skeleton_graph(arr, origin)
    g = Graph(nodes, edges)
    for _ in range(3):
        prune_spurs(g, 2.2 * R)
        merge_chains(g)
    contract_short(g, 2.8 * R)  # junctions closer than ~40 m become one (city blocks are 70 m+)
    merge_chains(g)
    smooth(g)
    assign_lines(g, routes, mask)
    merge_chains(g, same=lambda e1, e2: e1["lines"] == e2["lines"])
    for eid in [k for k, e in g.edges.items() if e["a"] == e["b"] and g.length(k) < 150]:
        g.remove(eid)  # leftover rings and tight turnaround loops draw as blobs when bundled
    fixed = repair_gaps(g, routes)
    trimmed = trim_stubs(g, routes, mask=mask)
    merge_chains(g, same=lambda e1, e2: e1["lines"] == e2["lines"])
    folded = collapse_bubbles(g, mask)
    trimmed += trim_stubs(g, routes, mask=mask)  # folding a ramp loop leaves its two sides as stubs
    fixed += fill_gaps(g, routes, mask)
    merge_chains(g, same=lambda e1, e2: e1["lines"] == e2["lines"])
    moved, replaced = refine_geometry(g, routes, rank)
    hooks = unhook(g, mask)
    order_lines(g, rank)
    print(f"  {name}: {len(routes)} routes -> {len(g.edges)} edges, {fixed} gap segments filled, "
          f"{trimmed} stubs trimmed, {folded} detours folded, {hooks} ramp hooks straightened, "
          f"{moved} junctions moved, "
          f"{replaced} segments on real shapes ({time.time() - t0:.0f}s)", flush=True)
    return g


def main():
    all_routes, rank = load_routes()
    mask = freeway_mask()
    print("freeway mask:", "none" if mask is None else f"{mask.area / 1e6:.1f} km²", flush=True)
    print(f"{len(all_routes)} routes clipped to region")
    lines = sorted(all_routes, key=lambda s: rank.get(s, 0))
    li = {s: i for i, s in enumerate(lines)}
    out_edges = []
    for name in ("water", "surface", "rail"):
        routes = {k: g for k, (lay, g) in all_routes.items() if lay == name}
        if not routes:
            continue
        g = build_layer(routes, rank, name, mask if name == "surface" else None)
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
