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
from config import CACHE, RAIL_REGION, REGION, SITE  # noqa: E402

# Networks built separately, so trains in tunnels (Link under 3rd Ave, Sounder under
# 4th Ave) and ferries at the docks are not bundled with the buses on the street above.
LAYERS = {
    "rail": {"link", "sounder", "amtrak", "monorail"},
    "water": {"ferry", "watertaxi"},
}

RES = 4.0      # raster cell size in meters
R_FWY = 34.0   # merge radius on freeways: both carriageways become one line (ramps stay apart)
# Routes are matched onto street centerlines first (match_shapes.py), so routes on the same
# street coincide exactly: a narrow band is enough to merge them, and it keeps junctions on the
# real intersections. 8 m still merges the two halves of most divided streets (8-16 m apart).
# (without matched shapes, e.g. in a build without street tiles, the agencies' shapes need the
# old 15 m band to merge routes on the same street)
MATCHED = os.path.exists(os.path.join(CACHE, "route_shapes_matched.json"))
R = 8.0 if MATCHED else 15.0  # merge radius: shapes closer than ~2R share a corridor
SNAP = R + 7   # distance at which a route is considered to use an edge
# distance scale of the cleanup steps (stubs, gaps, loose ends): kept from the wide-band days,
# since agency shapes that couldn't be matched still sit up to ~15 m off their street
RC = 15.0
# the biggest side-by-side detour in town that gets folded into one line (collapse_bubbles), in meters
TOWN_BUBBLE_LEN, TOWN_BUBBLE_SEP = 900.0, 130.0

fwd = Transformer.from_crs(4326, 32610, always_xy=True)
inv = Transformer.from_crs(32610, 4326, always_xy=True)


FREEWAYS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "freeways.json")
JUNCTIONS = os.path.join(CACHE, "street_junctions.json")


def freeway_lines():
    """Freeway centerlines (OpenMapTiles "motorway" main carriageways, short tunnels included) as
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
                if feat["properties"].get("class") != "motorway" or feat["properties"].get("ramp") in (1, "1", True):
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
        # A tunnel comes in pieces (split at tile edges, one per carriageway) that don't always
        # join end to end, so pieces within 40 m of each other count as one tunnel, measured
        # by its overall span: SR 99 is two ~1.1 km pieces under Belltown, but 3 km in all.
        from shapely.ops import linemerge, unary_union
        parts = [LineString(list(zip(*fwd.transform(*zip(*t))))) for t in tunnels]
        blobs = unary_union([p.buffer(20) for p in parts]) if parts else None
        for blob in getattr(blobs, "geoms", [blobs] if blobs is not None else []):
            hull = list(blob.convex_hull.exterior.coords)
            span = max(math.dist(p, q) for p in hull for q in hull)
            if span >= 1600:
                continue
            merged = linemerge([LineString(t) for t, p in zip(tunnels, parts) if blob.intersects(p)])
            out += [[list(c) for c in m.coords] for m in getattr(merged, "geoms", [merged])]
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
    return unary_union([l.buffer(25, quad_segs=4) for l in lines]).simplify(5)


def layer_of(cat):
    for name, cats in LAYERS.items():
        if cat in cats:
            return name
    return "surface"


def load_routes():
    # the shapes matched to the street network (match_shapes.py), else the agencies' own
    matched = os.path.join(CACHE, "route_shapes_matched.json")
    shapes = json.load(open(matched if os.path.exists(matched) else os.path.join(CACHE, "route_shapes.json")))
    meta = json.load(open(os.path.join(SITE, "data", "routes.json")))
    rank = {r["id"]: i for i, r in enumerate(meta["routes"])}
    region = box(REGION["west"], REGION["south"], REGION["east"], REGION["north"])
    rail_box = box(RAIL_REGION["west"], RAIL_REGION["south"], RAIL_REGION["east"], RAIL_REGION["north"])
    routes, beyond = {}, {}
    for slug, s in shapes.items():
        parts, outer = [], []
        for line in s["lines"]:
            ls = LineString(line)
            g = ls.intersection(region)
            for p in getattr(g, "geoms", [g]):
                if p.geom_type == "LineString" and len(p.coords) > 1:
                    xs, ys = fwd.transform(*zip(*p.coords))
                    parts.append(LineString(list(zip(xs, ys))))
            if s["cat"] == "amtrak":
                # the Cascades line carries on past the map's edge, out to RAIL_REGION
                g = ls.intersection(rail_box).difference(region)
                for p in getattr(g, "geoms", [g]):
                    if p.geom_type == "LineString" and len(p.coords) > 1:
                        xs, ys = fwd.transform(*zip(*p.coords))
                        outer.append(LineString(list(zip(xs, ys))))
        if parts:
            routes[slug] = (layer_of(s["cat"]), MultiLineString(parts))
        if outer:
            beyond[slug] = outer
    return routes, rank, beyond


def extend_rail(out_edges, beyond, li):
    """The Cascades line past the map's edge, drawn straight from its own shape (the track is
    alone out there: no street network, no bundles to untangle). Each piece is joined to the end
    of the same line inside the map, so the line runs on without a break."""
    from math import hypot
    added = 0
    for slug, pieces in beyond.items():
        if slug not in li:
            continue
        here = li[slug]
        ends = [(tuple(e["c"][0]), e) for e in out_edges if here in e["l"]] + [(tuple(e["c"][-1]), e) for e in out_edges if here in e["l"]]
        from shapely.ops import unary_union
        kept = []
        for part in sorted(pieces, key=lambda p: -p.length):
            part = part.simplify(8)
            if part.length < 200:
                continue
            # the same track again (the other direction, or a shape that stops elsewhere): once is enough
            if kept and part.difference(unary_union(kept).buffer(60)).length < 0.2 * part.length:
                continue
            kept.append(part)
            c = list(part.coords)
            lon, lat = inv.transform(*zip(*c))
            coords = [[round(x, 5), round(y, 5)] for x, y in zip(lon, lat)]
            # join each end of the piece to the nearest end of an edge already on this line
            for k in (0, -1):
                px, py = fwd.transform(*coords[k])
                best = min(((hypot(px - fwd.transform(*q)[0], py - fwd.transform(*q)[1]), q) for q, _ in ends), default=None)
                if best and best[0] < 3000:
                    coords[k] = list(best[1])
            dedup = [coords[0]] + [c2 for p2, c2 in zip(coords, coords[1:]) if c2 != p2]
            if len(dedup) < 2:
                continue
            out_edges.append({"c": dedup, "l": [here]})
            added += 1
    print(f"  rail: {added} stretches added past the map's edge", flush=True)


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


def split_at_line_ends(g, routes, near=None):
    """Trains: where a line ends partway along a stretch that another line carries on along
    (Sounder N at Everett, where Amtrak goes on north), split the stretch there. Otherwise the
    line that ends covers most of the stretch and is drawn on past its last station."""
    from shapely.geometry import Point
    near = near or SNAP
    split = 0
    for slug, rg in routes.items():
        for part in getattr(rg, "geoms", [rg]):
            for pt in (part.coords[0], part.coords[-1]):
                P = Point(pt)
                best = None
                for eid, e in g.edges.items():
                    line = LineString(e["c"])
                    d = line.distance(P)
                    if d < near and (best is None or d < best[0]):
                        best = (d, eid, line)
                if best is None:
                    continue
                _, eid, line = best
                at = line.project(P)
                if at < 200 or at > line.length - 200:
                    continue  # already ends near a junction
                e = g.edges[eid]
                coords, first, acc = e["c"], [], 0.0
                q = line.interpolate(at)
                rest = None
                for i, c in enumerate(coords):
                    if i:
                        acc += math.dist(coords[i - 1], c)
                    if acc < at:
                        first.append(c)
                    else:
                        rest = coords[i:]
                        break
                if not first or not rest:
                    continue
                nid = max(g.pos) + 1
                g.pos[nid] = (q.x, q.y)
                a, b = e["a"], e["b"]
                g.remove(eid)
                g.add(a, nid, first + [(q.x, q.y)])
                g.add(nid, b, [(q.x, q.y)] + list(rest))
                split += 1
    return split


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
                if min(math.dist(g.pos[n], t) for t in ends) < 4 * RC:
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
        loose = [n for n, d in deg.items() if d == 1 and min(math.dist(g.pos[n], t) for t in ends) > 4 * RC]
        if len(loose) < 2:
            continue
        cover = unary_union([LineString(g.edges[k]["c"]).buffer(R_FWY + 10 if on_fwy.get(k) else SNAP + 8) for k in mine])
        for part in rg.geoms:
            on = sorted((part.project(Point(g.pos[n])), n) for n in loose if part.distance(Point(g.pos[n])) < 4 * RC)
            for (s1, n1), (s2, n2) in zip(on, on[1:]):
                if n1 == n2 or not (2 * RC < s2 - s1 < max_span):
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


def split_edge(g, eid, pt):
    """Cut a segment at the point nearest `pt`; returns the node there (an existing end node
    when the point is within 8 m of it)."""
    from shapely.geometry import Point
    from shapely.ops import substring
    e = g.edges[eid]
    ls = LineString(e["c"])
    d = ls.project(Point(pt))
    if d < 8:
        return e["a"]
    if d > ls.length - 8:
        return e["b"]
    c1, c2 = substring(ls, 0, d), substring(ls, d, ls.length)
    nid = max(g.pos) + 1
    g.pos[nid] = c1.coords[-1]
    lines = e["lines"]
    g.remove(eid)
    for a, b, c in ((e["a"], nid, c1), (nid, e["b"], c2)):
        k = g.add(a, b, list(c.coords), lines)
        for field in ("order", "dirs"):
            if field in e:
                g.edges[k][field] = e[field].copy()
    return nid


def bridge_loose_ends(g, routes, mask=None, max_span=2500.0, step=10.0):
    """Reconnect a route that breaks off on one side only.

    fill_gaps joins two loose ends. Often only one side is loose: the route's line stops short
    (say, partway down a one-way street) while the other side of the hole is in the middle of
    a segment the route does use. From the loose end, walk along the route's own shape away
    from what is drawn until the shape is covered again, and draw that stretch, splitting the
    segment where it lands if no junction is there."""
    from shapely.geometry import Point
    from shapely.ops import substring, unary_union
    near_fwy = mask.buffer(60) if mask is not None else None
    added = 0
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
        loose = [n for n, d in deg.items() if d == 1 and min(math.dist(g.pos[n], t) for t in ends) > 4 * RC]
        if not loose:
            continue
        snap = lambda k: R_FWY + 10 if near_fwy is not None and near_fwy.contains(LineString(g.edges[k]["c"]).interpolate(0.5, normalized=True)) else SNAP + 8  # noqa: E731
        cover = unary_union([LineString(g.edges[k]["c"]).buffer(snap(k)) for k in mine])
        for n in loose:
            P = Point(g.pos[n])
            best = None
            for part in rg.geoms:
                if part.distance(P) > 4 * RC:
                    continue
                s0 = part.project(P)
                for sign in (1, -1):
                    # leave the drawn part within ~80 m, then find where the shape is drawn again
                    s, out_at, back_at = s0, None, None
                    while abs(s - s0) < max_span:
                        s += sign * step
                        if s < 0 or s > part.length:
                            break
                        covered = cover.contains(part.interpolate(s))
                        if out_at is None:
                            if not covered:
                                out_at = s
                            elif abs(s - s0) > 80:
                                break
                        elif covered:
                            back_at = s
                            break
                    if out_at is None or back_at is None or abs(back_at - out_at) < 40:
                        continue
                    if best is None or abs(back_at - s0) < abs(best[2] - best[1]):
                        best = (part, s0, back_at)
            if best is None:
                continue
            part, s0, s1 = best
            land = part.interpolate(s1)
            near = [k for k in g.edges if slug in g.edges[k]["lines"] and LineString(g.edges[k]["c"]).distance(land) < SNAP + 8]
            if not near:
                continue
            k = min(near, key=lambda k: LineString(g.edges[k]["c"]).distance(land))
            m = split_edge(g, k, land.coords[0])
            if m == n:
                continue
            sub = substring(part, min(s0, s1), max(s0, s1))
            mid = list(sub.coords)[1:-1]
            if s1 < s0:
                mid = mid[::-1]
            g.add(n, m, [g.pos[n]] + mid + [g.pos[m]], frozenset({slug}))
            added += 1
    return added


def edge_directions(g, routes, mask=None):
    """Which way each route travels along each segment: 0 both ways (or unknown), 1 only a->b,
    2 only b->a. Read from the agencies' shapes, which run in the direction of travel: every
    piece of a route's shape passing the middle of the segment votes with its direction."""
    near_fwy = mask.buffer(60) if mask is not None else None
    parts = {slug: [np.asarray(p.coords) for p in rg.geoms if len(p.coords) > 1] for slug, rg in routes.items()}
    for e in g.edges.values():
        ls = LineString(e["c"])
        L = ls.length
        dirs = {}
        if e["a"] == e["b"] or L < 30:
            e["dirs"] = {}
            continue
        m = np.asarray(ls.interpolate(0.5, normalized=True).coords[0])
        p1 = np.asarray(ls.interpolate(max(0, L / 2 - 15)).coords[0])
        p2 = np.asarray(ls.interpolate(min(L, L / 2 + 15)).coords[0])
        t = (p2 - p1) / (np.linalg.norm(p2 - p1) or 1)
        snap = R_FWY + 10 if near_fwy is not None and near_fwy.contains(LineString([m, m + 0.01])) else SNAP + 8
        for slug in e["lines"]:
            fwd = back = False
            for c in parts[slug]:
                a, b = c[:-1], c[1:]
                ab = b - a
                l2 = (ab ** 2).sum(1)
                tt = np.clip(((m - a) * ab).sum(1) / np.maximum(l2, 1e-9), 0, 1)
                dist = np.hypot(*(a + ab * tt[:, None] - m).T)
                cos = (ab @ t) / np.sqrt(np.maximum(l2, 1e-9))
                near = (dist < snap) & (np.abs(cos) > 0.6)
                fwd |= bool((cos[near] > 0).any())
                back |= bool((cos[near] < 0).any())
            dirs[slug] = 1 if fwd and not back else 2 if back and not fwd else 0
        e["dirs"] = dirs
    return sum(1 for e in g.edges.values() for v in e["dirs"].values() if v)


def collapse_bubbles(g, mask=None):
    """Fold side-by-side detours into one line.

    Where a route's two directions take slightly different paths (the two ramps of a freeway
    interchange, a loop ramp, a pair of parallel carriageways) the network has a "bubble": two
    paths between the same junctions. When the second path carries every route of the first,
    the first is dropped and its routes move over. Near freeways bubbles up to 1.2 km long and
    160 m wide are folded. In town they are folded up to 900 m long and 130 m apart: a block or
    a bit more, so a one-way pair or a route that takes the next street over for a stretch is
    drawn as one bundle on the busier street instead of two lines that part and rejoin. (Wider
    pairs, such as 2nd and 4th Ave, stay apart.)"""
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
            max_len, max_sep = (1200.0, 160.0) if fwy else (TOWN_BUBBLE_LEN, TOWN_BUBBLE_SEP)
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
        loose = [n for n, d in deg.items() if d == 1 and min(math.dist(g.pos[n], t) for t in ends) > 4 * RC]
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
            if not all(LineString(g.edges[k]["c"]).interpolate(0.5, normalized=True).distance(rg) < 4 * RC for k in path):
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
    moved = pinned = 0
    street_jn = None
    if os.path.exists(JUNCTIONS):
        pts = json.load(open(JUNCTIONS))
        xs, ys = fwd.transform([q[0] for q in pts], [q[1] for q in pts])
        geoms = [Point(x, y) for x, y in zip(xs, ys)]
        street_jn = (geoms, shapely.STRtree(geoms))
    for n, inc in g.adj.items():
        if not inc:
            continue
        p = Point(g.pos[n])
        lines = set().union(*(g.edges[e]["lines"] for e in inc))
        near = []
        for l in lines:
            q = nearest_points(routes[l], p)[0]
            if q.distance(p) < 3 * RC:
                near.append((q.x, q.y))
        if near:
            xs, ys = sorted(c[0] for c in near), sorted(c[1] for c in near)
            m = len(near) // 2
            new = (xs[m], ys[m]) if len(near) % 2 else ((xs[m - 1] + xs[m]) / 2, (ys[m - 1] + ys[m]) / 2)
            # the real intersection: the street junction (where the routes' streets meet) that
            # the routes here pass through, nearest to the traced junction
            if street_jn is not None and len(inc) >= 2:
                best = None
                for k in street_jn[1].query(p, predicate="dwithin", distance=18.0):
                    q = street_jn[0][k]
                    through = sum(1 for l in lines if routes[l].distance(q) < 3.0)
                    if through >= min(2, len(lines)):
                        dq = q.distance(p) - 4.0 * through  # prefer junctions more routes use
                        if best is None or dq < best[0]:
                            best = (dq, (q.x, q.y))
                if best:
                    new = best[1]
                    pinned += 1
            d = Point(new).distance(p)
            if d > 18.0:  # never move a junction more than 18 m
                f = 18.0 / d
                new = (p.x + (new[0] - p.x) * f, p.y + (new[1] - p.y) * f)
            moved += d > 5
            g.pos[n] = new
    # junctions pinned to the same intersection are one junction
    merged = 0
    changed = True
    while changed:
        changed = False
        for eid in list(g.edges):
            e = g.edges.get(eid)
            if e is None or e["a"] == e["b"]:
                continue
            a, b = e["a"], e["b"]
            if math.dist(g.pos[a], g.pos[b]) > 1.5:
                continue
            g.remove(eid)
            for other in list(g.adj[b]):
                oe = g.edges[other]
                if oe["a"] == b:
                    oe["a"] = a
                if oe["b"] == b:
                    oe["b"] = a
                g.adj[a].add(other)
            del g.adj[b]
            merged += 1
            changed = True
    for eid in [k for k, e in g.edges.items() if e["a"] == e["b"] and LineString(e["c"]).length < 60]:
        g.remove(eid)
    print(f"    {pinned} junctions pinned to street intersections, {merged} merged", flush=True)
    replaced = 0
    for e in g.edges.values():
        a, b = g.pos[e["a"]], g.pos[e["b"]]
        old = LineString(e["c"])
        best = None
        if e["a"] != e["b"]:
            for l in e["lines"]:
                for part in routes[l].geoms:
                    da, db = part.project(Point(a)), part.project(Point(b))
                    if part.interpolate(da).distance(Point(a)) > 12 or part.interpolate(db).distance(Point(b)) > 12:
                        continue
                    if abs(db - da) < 1:
                        continue
                    sub = substring(part, min(da, db), max(da, db))
                    # must run the same way as the traced segment, without detours or doubling back
                    if sub.length < 0.75 * old.length or sub.length > 1.2 * old.length + 8:
                        continue
                    h = sub.hausdorff_distance(old)
                    if h > 2.0 * R + 4:
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


def smooth_run(coords, sigma=80.0, step=8.0, taper=150.0, max_move=18.0):
    """Gaussian-smooth a polyline (meters) along its length, keeping both ends where they are.

    Freeway segments come from the traced middle of several route shapes that hop between
    carriageways and ramps, so they drift 10-20 m side to side over a few hundred meters. A
    smoothing window of a few hundred meters takes that out while keeping freeway curves
    (radius 500 m and up) within a few meters. The smoothing fades in over `taper` meters from
    each end so the segment still meets its junctions exactly."""
    ls = LineString(coords)
    L = ls.length
    if L < 3 * step:
        return list(coords)
    n = int(L // step) + 1
    d = np.linspace(0, L, n)
    P = np.array([ls.interpolate(x).coords[0] for x in d])
    half = int(3 * sigma / step)
    k = np.exp(-0.5 * (np.arange(-half, half + 1) * step / sigma) ** 2)
    pad = np.vstack([2 * P[0] - P[half:0:-1], P, 2 * P[-1] - P[-2:-half - 2:-1]])  # odd reflection: keeps straight ends straight
    sm = np.column_stack([np.convolve(pad[:, j], k / k.sum(), mode="valid") for j in (0, 1)])
    w = np.clip(np.minimum(d, L - d) / taper, 0, 1)
    w = w * w * (3 - 2 * w)
    delta = (sm - P) * w[:, None]
    # never more than max_move: enough to take out the drift, not enough to flatten a loop ramp
    mag = np.hypot(delta[:, 0], delta[:, 1])
    delta *= np.minimum(1, max_move / np.maximum(mag, 1e-9))[:, None]
    out = P + delta
    out[0], out[-1] = coords[0], coords[-1]
    return list(LineString(out).simplify(0.6).coords)


def straighten_freeways(g, mask, min_run=250.0):
    """Smooth the parts of segments that run along freeways (see smooth_run). Street parts are
    left alone: there a bend is usually a real turn."""
    if mask is None:
        return 0
    from shapely.prepared import prep
    inside = prep(mask)
    from shapely.geometry import Point
    done = 0
    for e in g.edges.values():
        c = e["c"]
        if len(c) < 4:
            continue
        flag = [inside.contains(Point(p)) for p in c]
        out, i, changed = [], 0, False
        while i < len(c):
            j = i
            while j + 1 < len(c) and flag[j + 1] == flag[i]:
                j += 1
            run = c[i:j + 1]
            if flag[i] and len(run) >= 4 and LineString(run).length >= min_run:
                run = smooth_run(run)
                changed = True
            out.extend(run if not out else run[(1 if out[-1] == run[0] else 0):])
            i = j + 1
        if changed:
            out[0], out[-1] = c[0], c[-1]
            e["c"] = out
            done += 1
    return done


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
    contract_short(g, 22.0)  # junctions closer than ~22 m become one (city blocks are 60 m+)
    merge_chains(g)
    smooth(g)
    if name == "rail":
        split_at_line_ends(g, routes)
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
    fixed += bridge_loose_ends(g, routes, mask)
    merge_chains(g, same=lambda e1, e2: e1["lines"] == e2["lines"])
    moved, replaced = refine_geometry(g, routes, rank)
    hooks = unhook(g, mask)
    smoothed = straighten_freeways(g, mask)
    order_lines(g, rank)
    oneway = edge_directions(g, routes, mask)
    print(f"  {name}: {len(routes)} routes -> {len(g.edges)} edges, {fixed} gap segments filled, "
          f"{trimmed} stubs trimmed, {folded} detours folded, {hooks} ramp hooks straightened, "
          f"{smoothed} freeway stretches smoothed, {oneway} one-way route segments, "
          f"{moved} junctions moved, "
          f"{replaced} segments on real shapes ({time.time() - t0:.0f}s)", flush=True)
    return g


def water_direct(routes):
    """Boats get their own lines straight from their shapes. Bundling crossings that only meet
    at the docks traced little hooks where their paths fan out; ferries rarely share water,
    so each crossing is simply drawn as it is (one copy per route; the return trip, which
    retraces it, is left out)."""
    from shapely.ops import unary_union
    nodes, edges, meta = {}, [], []
    for slug, rg in routes.items():
        kept = []
        for part in sorted(rg.geoms, key=lambda p: -p.length):
            part = part.simplify(8)
            if part.length < 50:
                continue
            if kept and part.difference(unary_union(kept).buffer(120)).length < 0.2 * part.length:
                continue  # the same crossing again (return trip)
            kept.append(part)
            c = list(part.coords)
            a, b = len(nodes), len(nodes) + 1
            nodes[a], nodes[b] = c[0], c[-1]
            edges.append([a, b, c])
            meta.append(slug)
    g = Graph(nodes, edges)
    for (eid, e), slug in zip(sorted(g.edges.items()), meta):
        e["lines"] = frozenset({slug})
        e["order"] = [slug]
        e["dirs"] = {}
    print(f"  water: {len(routes)} routes -> {len(g.edges)} crossings, drawn from their own shapes", flush=True)
    return g


def main():
    all_routes, rank, beyond = load_routes()
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
        # trains keep their own (unmatched) shapes, whose tracks can sit 10-20 m apart: they need
        # the wider band; buses on matched shapes use the narrow one
        global R, SNAP
        R = 15.0 if (name != "surface" or not MATCHED) else 8.0
        SNAP = R + 7
        g = water_direct(routes) if name == "water" else build_layer(routes, rank, name, mask if name == "surface" else None)
        for eid, e in g.edges.items():
            lon, lat = inv.transform(*zip(*e["c"]))
            coords = [[round(x, 5), round(y, 5)] for x, y in zip(lon, lat)]
            dedup = [coords[0]] + [c for p, c in zip(coords, coords[1:]) if c != p]
            if len(dedup) < 2:
                continue
            rec = {"c": dedup, "l": [li[s] for s in e["order"]]}
            # direction of travel per route (same order as "l"): 1 = along c, 2 = against, 0 = both ways
            d = [e.get("dirs", {}).get(s, 0) for s in e["order"]]
            if any(d):
                rec["d"] = d
            out_edges.append(rec)
    extend_rail(out_edges, beyond, li)
    out = {"lines": lines, "edges": out_edges}
    path = os.path.join(SITE, "data", "network.json")
    json.dump(out, open(path, "w"), separators=(",", ":"))
    multi = sum(1 for e in out_edges if len(e["l"]) > 1)
    print(f"wrote {len(out_edges)} edges ({multi} shared), {os.path.getsize(path)/1e6:.2f} MB")


if __name__ == "__main__":
    main()
