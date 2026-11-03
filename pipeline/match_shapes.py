"""Snap every bus and streetcar route onto the real street network.

Agency route shapes are drawn loosely: they cut corners diagonally across intersections,
wander a few meters off the street, and sit between the two halves of divided roads. Built
straight from them, the map's junctions came out at odd angles. Here each shape is matched to
OpenStreetMap's streets (from the base-map tiles already downloaded, z14), the way a GPS trace
is matched: a hidden Markov model whose states are positions on nearby streets, scored by how
close each is to the shape (emission) and by whether getting from one to the next along the
streets takes about as far as the shape itself goes (transition). The best sequence (Viterbi)
is a path along real streets, turning at real intersections.

Output: CACHE/route_shapes_matched.json, same layout as route_shapes.json. Trains and boats keep
their own shapes. A matched path that disagrees with the shape (much longer, or far from it) is
not used; that route keeps its shape.
"""
import heapq
import json
import math
import os
import sys
import time
from collections import defaultdict

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import LineString, Point, box

sys.path.insert(0, os.path.dirname(__file__))
from config import CACHE, REGION  # noqa: E402

fwd = Transformer.from_crs(4326, 32610, always_xy=True)
inv = Transformer.from_crs(32610, 4326, always_xy=True)

ROAD_CLASSES = {"motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service", "busway", "bus_guideway"}
SKIP_CATS = {"link", "sounder", "amtrak", "monorail", "ferry", "watertaxi"}
Z = 14
STEP = 18.0          # shape resampled every 18 m
RADIUS = 30.0        # streets considered within 30 m of the shape (60 m if none)
SIGMA = 8.0          # how far shapes typically sit off the street centerline
BETA = 10.0          # tolerance for path length vs. shape length between samples
CONTRAFLOW = 3.0     # cost factor for going against a one-way (bus lanes exist, but rarely)
NEAR_ROUTES = 80.0   # only streets within 80 m of some route are kept


# ---------------------------------------------------------------- street graph from tiles
def tile_range():
    n = 2 ** Z
    lat2y = lambda lat: int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n)  # noqa: E731
    x0 = int((REGION["west"] + 180) / 360 * n)
    x1 = int((REGION["east"] + 180) / 360 * n)
    return [(x, y) for x in range(x0, x1 + 1) for y in range(lat2y(REGION["north"]), lat2y(REGION["south"]) + 1)]


def tile_dir():
    root = os.path.join(CACHE, "tiles_raw")
    for v in (sorted(os.listdir(root), reverse=True) if os.path.isdir(root) else []):
        if os.path.isdir(os.path.join(root, v, str(Z))):
            return os.path.join(root, v, str(Z))
    return None


def download_tiles():
    from concurrent.futures import ThreadPoolExecutor
    import build_basemap as bm
    import urllib.request
    from config import TILEJSON_URL
    req = urllib.request.Request(TILEJSON_URL, headers={"User-Agent": "seattle-transit-map build (personal, non-commercial)"})
    tmpl = json.load(urllib.request.urlopen(req, timeout=30))["tiles"][0]
    version = tmpl.split("/planet/")[1].split("/")[0]
    tiles = tile_range()
    print(f"downloading {len(tiles)} z{Z} street tiles (OpenFreeMap {version})", flush=True)
    with ThreadPoolExecutor(8) as ex:
        list(ex.map(lambda t: bm.fetch(tmpl.format(z=Z, x=t[0], y=t[1]), os.path.join(CACHE, "tiles_raw", version, f"{Z}/{t[0]}/{t[1]}.pbf")), tiles))


def load_roads(near):
    """Road pieces (meters) from the z14 tiles, clipped to their tile, with class, one-way and
    level. `near` is an STRtree of route geometry: roads farther than NEAR_ROUTES are skipped."""
    import mapbox_vector_tile
    base = tile_dir()
    n = 2 ** Z
    out = []
    for tx, ty in tile_range():
        f = os.path.join(base, str(tx), f"{ty}.pbf")
        if not os.path.exists(f):
            continue
        d = mapbox_vector_tile.decode(open(f, "rb").read(), default_options={"y_coord_down": True})
        tr = d.get("transportation")
        if not tr:
            continue
        ext = tr["extent"]
        tile_lines = []
        for ft in tr["features"]:
            p = ft["properties"]
            if p.get("class") not in ROAD_CLASSES:
                continue
            g = ft["geometry"]
            parts = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"] if g["type"] == "MultiLineString" else []
            for part in parts:
                if len(part) < 2:
                    continue
                ls = shapely.clip_by_rect(LineString(part), 0, 0, ext, ext)
                for seg in getattr(ls, "geoms", [ls]):
                    if seg.is_empty or seg.geom_type != "LineString" or seg.length == 0:
                        continue
                    c = np.asarray(seg.coords)
                    lon = (tx + c[:, 0] / ext) / n * 360 - 180
                    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (ty + c[:, 1] / ext) / n))))
                    xs, ys = fwd.transform(lon, lat)
                    tile_lines.append((LineString(list(zip(xs, ys))), p))
        if not tile_lines:
            continue
        geoms = [g for g, _ in tile_lines]
        keep = near.query(geoms, predicate="dwithin", distance=NEAR_ROUTES)
        keep_idx = set(keep[0].tolist())
        out.extend([tile_lines[i] + ((tx, ty),) for i in sorted(keep_idx)])
    return out


def level_of(p):
    b = p.get("brunnel") or ""
    return (b if b in ("bridge", "tunnel") else "", int(p.get("layer") or 0))


def node_pieces(roads):
    """Split roads where they meet. At grade, every crossing is a junction (in OpenStreetMap
    crossing streets share a node, but the tiles may simplify that node away); bridges and
    tunnels only meet other roads at their ends. Done per tile: roads are clipped to tiles, so
    every crossing lies inside one tile."""
    by_tile = defaultdict(list)
    for g, p, t in roads:
        by_tile[t].append((g, p))
    pieces = []
    for t, lines in by_tile.items():
        geoms = [g for g, _ in lines]
        tree = shapely.STRtree(geoms)
        cuts = [[] for _ in lines]
        for i, (g, p) in enumerate(lines):
            lv = level_of(p)
            for j in tree.query(g, predicate="dwithin", distance=0.6):
                if j <= i:
                    continue
                h, q = lines[j]
                same = level_of(q) == lv
                if same:
                    x = g.intersection(h)
                    pts = [x] if x.geom_type == "Point" else [pp for pp in getattr(x, "geoms", []) if pp.geom_type == "Point"]
                    for pt in pts:
                        cuts[i].append(g.project(pt))
                        cuts[j].append(h.project(pt))
                # an end of one road on (or just off) the other: a T junction; bridges join here too
                for a, A, b, B in ((g, i, h, j), (h, j, g, i)):
                    for end in (Point(a.coords[0]), Point(a.coords[-1])):
                        dd = b.distance(end)
                        if dd < 0.6 and (same or min(Point(b.coords[0]).distance(end), Point(b.coords[-1]).distance(end)) < 0.6):
                            cuts[B].append(b.project(end))
        for i, (g, p) in enumerate(lines):
            L = g.length
            ds = sorted({0.0, L, *[min(max(d, 0.0), L) for d in cuts[i]]})
            ds = [d for k, d in enumerate(ds) if k == 0 or d - ds[k - 1] > 0.05]
            if ds[-1] < L:
                ds[-1] = L
            for a, b in zip(ds, ds[1:]):
                if b - a < 0.05:
                    continue
                sub = shapely.ops.substring(g, a, b)
                if sub.geom_type == "LineString" and sub.length > 0:
                    pieces.append((sub, p))
    return pieces


class Graph:
    def __init__(self, pieces):
        self.key = {}
        self.xy = []
        grid = {}

        def node(c):
            k = (round(c[0] * 2), round(c[1] * 2))   # half-meter cells
            if k in self.key:
                return self.key[k]
            # an end within 0.7 m of a known node is the same node (tile edges, snapping)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for nid in grid.get((k[0] // 2 + dx, k[1] // 2 + dy), ()):
                        if math.dist(self.xy[nid], c) < 0.7:
                            self.key[k] = nid
                            return nid
            nid = len(self.xy)
            self.xy.append((c[0], c[1]))
            self.key[k] = nid
            grid.setdefault((k[0] // 2, k[1] // 2), []).append(nid)
            return nid

        self.eu, self.ev, self.elen, self.egeom, self.eway, self.ecls = [], [], [], [], [], []
        self.adj = defaultdict(list)  # node -> [(nbr, edge, cost, forward)]
        for g, p in pieces:
            c = list(g.coords)
            u, v = node(c[0]), node(c[-1])
            if u == v:
                continue
            e = len(self.eu)
            ow = int(p.get("oneway") or 0)
            L = g.length
            self.eu.append(u); self.ev.append(v); self.elen.append(L); self.egeom.append(g)
            self.eway.append(ow); self.ecls.append(p.get("class"))
            self.adj[u].append((v, e, L * (CONTRAFLOW if ow == -1 else 1.0), True))
            self.adj[v].append((u, e, L * (CONTRAFLOW if ow == 1 else 1.0), False))
        self.tree = shapely.STRtree(self.egeom)
        print(f"street graph: {len(self.xy)} junctions, {len(self.eu)} street pieces", flush=True)

    def dist_from(self, src, cutoff):
        dist = {src: 0.0}
        prev = {}
        pq = [(0.0, src)]
        while pq:
            d, n = heapq.heappop(pq)
            if d > dist.get(n, 1e18) or d > cutoff:
                continue
            for m, e, c, f in self.adj[n]:
                nd = d + c
                if nd < dist.get(m, 1e18):
                    dist[m] = nd
                    prev[m] = (n, e, f)
                    heapq.heappush(pq, (nd, m))
        return dist, prev


# ---------------------------------------------------------------- matching
def resample(ls, step):
    L = ls.length
    n = max(2, int(math.ceil(L / step)) + 1)
    return [ls.interpolate(L * i / (n - 1)) for i in range(n)], L / (n - 1)


def heading(a, b):
    return math.atan2(b[1] - a[1], b[0] - a[0])


def match(G, ls):
    """Viterbi over street positions for one shape (meters). Returns the matched polyline
    (list of xy) or None."""
    pts, step = resample(ls, STEP)
    P = np.array([[p.x, p.y] for p in pts])
    hd = [heading(P[max(0, i - 1)], P[min(len(P) - 1, i + 1)]) for i in range(len(P))]
    near = G.tree.query([Point(x) for x in P], predicate="dwithin", distance=RADIUS)
    cand = defaultdict(list)
    for pi, ei in zip(near[0].tolist(), near[1].tolist()):
        cand[pi].append(ei)
    states = []  # per point: list of (edge, offset, cost)
    for i in range(len(P)):
        es = cand.get(i)
        if not es:
            es = G.tree.query(Point(P[i]), predicate="dwithin", distance=2 * RADIUS).tolist()
        opts = []
        p = Point(P[i])
        for e in es:
            g = G.egeom[e]
            off = g.project(p)
            q = g.interpolate(off)
            d = q.distance(p)
            # the street's direction here vs. the shape's: a cross street at an intersection
            # is a poor match for a shape going straight through
            a = g.interpolate(max(0, off - 3)); b = g.interpolate(min(g.length, off + 3))
            de = heading((a.x, a.y), (b.x, b.y))
            ang = abs((hd[i] - de + math.pi) % (2 * math.pi) - math.pi)
            ang = min(ang, math.pi - ang)
            cost = 0.5 * (d / SIGMA) ** 2 + (3.0 if ang > math.radians(55) else 0.0)
            opts.append((e, off, cost))
        opts.sort(key=lambda o: o[2])
        states.append(opts[:7])

    cache = {}

    def sp(src, cutoff):
        if src not in cache or cache[src][2] < cutoff:
            d, pr = G.dist_from(src, cutoff)
            cache[src] = (d, pr, cutoff)
        return cache[src]

    def trans(a, b, gc):
        """Street distance from state a to state b (and how: None = along the same piece)."""
        ea, oa, _ = a
        eb, ob, _ = b
        cutoff = 3 * gc + 120
        best = (1e18, None)
        if ea == eb:
            ow = G.eway[ea]
            if ob >= oa:
                best = ((ob - oa) * (CONTRAFLOW if ow == -1 else 1), None)
            else:
                best = ((oa - ob) * (CONTRAFLOW if ow == 1 else 1), None)
            if best[0] <= 2 * gc + 30:
                return best
        La, Lb = G.elen[ea], G.elen[eb]
        owa, owb = G.eway[ea], G.eway[eb]
        exits = ((G.ev[ea], (La - oa) * (CONTRAFLOW if owa == -1 else 1)), (G.eu[ea], oa * (CONTRAFLOW if owa == 1 else 1)))
        entries = ((G.eu[eb], ob * (CONTRAFLOW if owb == -1 else 1)), (G.ev[eb], (Lb - ob) * (CONTRAFLOW if owb == 1 else 1)))
        for xn, xc in exits:
            if xc > cutoff:
                continue
            dist, _, _ = sp(xn, cutoff)
            for yn, yc in entries:
                if yn in dist:
                    t = xc + dist[yn] + yc
                    if t < best[0]:
                        best = (t, (xn, yn))
        return best

    INF = 1e18
    costs = [[o[2] for o in states[0]]]
    backs = [[None] * len(states[0])]
    breaks = set()
    for i in range(1, len(P)):
        gc = float(np.hypot(*(P[i] - P[i - 1])))
        cur, prev_c = states[i], costs[-1]
        nc, nb = [], []
        for b in cur:
            bestc, bestk = INF, None
            for k, a in enumerate(states[i - 1]):
                if prev_c[k] >= INF:
                    continue
                d, _ = trans(a, b, gc)
                if d >= INF:
                    continue
                c = prev_c[k] + abs(d - gc) / BETA + b[2]
                if c < bestc:
                    bestc, bestk = c, k
            nc.append(bestc)
            nb.append(bestk)
        if not cur or all(c >= INF for c in nc):
            # no street path from here to there: start over (the gap keeps the shape)
            breaks.add(i)
            nc = [o[2] for o in cur]
            nb = [None] * len(cur)
        costs.append(nc)
        backs.append(nb)
        if len(cache) > 4000:
            cache.clear()

    # backtrack
    best = lambda i: (min(range(len(costs[i])), key=lambda j: costs[i][j]) if states[i] else None)  # noqa: E731
    chosen = [None] * len(P)
    i, k = len(P) - 1, best(len(P) - 1)
    while i >= 0:
        chosen[i] = k
        kb = backs[i][k] if k is not None else None
        i -= 1
        if i < 0:
            break
        k = kb if kb is not None else best(i)

    # rebuild the polyline along the streets
    out, used = [], []

    def push(seq):
        for c in seq:
            if not out or math.dist(out[-1], c) > 0.05:
                out.append(tuple(c))

    def along(e, o1, o2):
        used.append(e)
        g = G.egeom[e]
        if abs(o2 - o1) < 0.05:
            return [tuple(g.interpolate(o1).coords[0])]
        sub = shapely.ops.substring(g, min(o1, o2), max(o1, o2))
        c = list(sub.coords)
        return c if o2 >= o1 else c[::-1]

    def node_path(xn, yn, cutoff):
        _, prev, _ = sp(xn, cutoff)
        seq, n = [], yn
        while n != xn:
            m, e, f = prev[n]
            used.append(e)
            c = list(G.egeom[e].coords)
            seq.append(c if f else c[::-1])
            n = m
        coords = []
        for c in reversed(seq):
            coords.extend(c if not coords else c[1:])
        return coords

    bset = breaks
    for i in range(len(P)):
        if chosen[i] is None:
            continue
        e, o, _ = states[i][chosen[i]]
        if i == 0 or i in bset or chosen[i - 1] is None:
            if out and i in bset:
                push([tuple(P[i - 1]), tuple(P[i])])  # the gap: the shape's own line
            push([tuple(G.egeom[e].interpolate(o).coords[0])])
            continue
        a = states[i - 1][chosen[i - 1]]
        gc = float(np.hypot(*(P[i] - P[i - 1])))
        d, how = trans(a, (e, o, 0), gc)
        if how is None:
            push(along(e, a[1], o))
        else:
            xn, yn = how
            ea, oa, _ = a
            push(along(ea, oa, G.elen[ea] if xn == G.ev[ea] else 0.0))
            push(node_path(xn, yn, 3 * gc + 120))
            push(along(e, 0.0 if yn == G.eu[e] else G.elen[e], o))
    return (out, used) if len(out) > 1 else None


def accept(raw, m):
    """A matched path is used only if it really is the same trip: about as long, and never far."""
    ml = LineString(m)
    if not (0.85 * raw.length < ml.length < 1.25 * raw.length + 150):
        return False
    probe = [ml.interpolate(t, normalized=True) for t in np.linspace(0, 1, 60)]
    return max(raw.distance(p) for p in probe) < 70


G = None


def work(item):
    slug, idx, coords = item
    xs, ys = fwd.transform(*zip(*coords))
    raw = LineString(list(zip(xs, ys)))
    if raw.length < 30:
        return slug, idx, None, "short", []
    try:
        r = match(G, raw)
    except Exception as e:  # noqa: BLE001
        return slug, idx, None, f"error {e}", []
    if not r or not accept(raw, r[0]):
        return slug, idx, None, "rejected", []
    m, used = r
    lon, lat = inv.transform(*zip(*m))
    return slug, idx, [[round(x, 6), round(y, 6)] for x, y in zip(lon, lat)], "ok", sorted(set(used))


def main():
    global G
    t0 = time.time()
    if tile_dir() is None:
        # no street tiles cached (the weekly refresh builds without the base map): fetch just the
        # z14 tiles of the map area from OpenFreeMap
        try:
            download_tiles()
        except Exception as e:  # noqa: BLE001
            print(f"street tiles unavailable ({e})")
    if tile_dir() is None:
        # still none: build_graph uses the agencies' own shapes with its wider merge band
        for f in ("route_shapes_matched.json", "street_junctions.json"):
            if os.path.exists(os.path.join(CACHE, f)):
                os.remove(os.path.join(CACHE, f))
        print("no z14 street tiles: routes keep their own shapes")
        return
    shapes = json.load(open(os.path.join(CACHE, "route_shapes.json")))
    region = box(REGION["west"], REGION["south"], REGION["east"], REGION["north"])
    items, geo = [], []
    for slug, s in shapes.items():
        if s["cat"] in SKIP_CATS:
            continue
        for i, line in enumerate(s["lines"]):
            if len(line) < 2 or not LineString(line).intersects(region):
                continue
            items.append((slug, i, line))
            xs, ys = fwd.transform(*zip(*line))
            geo.append(LineString(list(zip(xs, ys))))
    near = shapely.STRtree(geo)
    roads = load_roads(near)
    print(f"{len(roads)} road pieces near routes ({time.time() - t0:.0f}s)", flush=True)
    G = Graph(node_pieces(roads))
    print(f"graph built ({time.time() - t0:.0f}s); matching {len(items)} shapes", flush=True)
    from multiprocessing import Pool
    res = {}
    stats = defaultdict(int)
    used_edges = set()
    with Pool(4) as pool:
        for k, (slug, idx, m, why, used) in enumerate(pool.imap_unordered(work, items, chunksize=2)):
            stats[why.split()[0]] += 1
            if m:
                res[(slug, idx)] = m
                used_edges.update(used)
            if (k + 1) % 100 == 0:
                print(f"  {k + 1}/{len(items)} ({time.time() - t0:.0f}s) {dict(stats)}", flush=True)
    out = {}
    for slug, s in shapes.items():
        lines = [res.get((slug, i), line) for i, line in enumerate(s["lines"])]
        out[slug] = {**s, "lines": lines, "matched": [int((slug, i) in res) for i in range(len(s["lines"]))]}
    path = os.path.join(CACHE, "route_shapes_matched.json")
    json.dump(out, open(path, "w"))
    # Junctions of the streets the routes use: where three or more used street pieces meet.
    # build_graph pins its junctions to these, so lines meet exactly at real intersections.
    deg = defaultdict(int)
    for e in used_edges:
        deg[G.eu[e]] += 1
        deg[G.ev[e]] += 1
    jn = [n for n, d in deg.items() if d >= 3]
    lon, lat = inv.transform([G.xy[n][0] for n in jn], [G.xy[n][1] for n in jn])
    json.dump([[round(x, 6), round(y, 6)] for x, y in zip(lon, lat)], open(os.path.join(CACHE, "street_junctions.json"), "w"))
    print(f"{len(jn)} street junctions on route paths")
    print(f"matched {len(res)}/{len(items)} shapes to streets {dict(stats)} in {time.time() - t0:.0f}s -> {path}")


if __name__ == "__main__":
    main()
