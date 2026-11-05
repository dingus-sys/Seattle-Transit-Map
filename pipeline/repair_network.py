"""Restore route continuity and turnarounds after junction simplification.

The short-gap repair during tracing runs before junctions are folded and has a 2.5 km
limit. Run it once more on the finished surface network, allowing long freeway gaps.
Every added path comes from that route's own shape and joins existing route edges.
Rail and ferry geometry is preserved. This step never invents straight-line bridges.
"""
import json
import os

import build_graph as graph
import numpy as np
import shapely
from shapely.geometry import LineString, Point
from shapely.ops import substring, unary_union

from restore_turnarounds import restore_turnarounds


def restore_spans(g, routes):
    """Restore large source-path omissions, including branches that have no loose end.

    A removed terminal loop can leave the route connected elsewhere, so degree-based
    repair never sees it. Require a source span of at least 300 m more than 160 m
    from the drawing. Walk back to existing coverage at each end and join there.
    At most one end may be a new, genuine source-path endpoint. Never bridge by air.
    """
    restored, shared = 0, {}
    for slug, shape in routes.items():
        def mine():
            return [(k, LineString(e["c"])) for k, e in g.edges.items() if slug in e["lines"]]

        drawn = unary_union([line for _, line in mine()])
        cover = drawn.buffer(160)
        for part in shape.geoms:
            missing = part.difference(cover)
            if max((p.length for p in getattr(missing, "geoms", [missing])), default=0) < 300:
                continue
            ds = np.append(np.arange(0, part.length, 20.0), part.length)
            distances = shapely.distance(shapely.line_interpolate_point(part, ds), drawn)
            far = distances > 160
            starts = np.flatnonzero(far & ~np.r_[False, far[:-1]])
            ends = np.flatnonzero(far & ~np.r_[far[1:], False])
            for first, last in zip(starts, ends):
                if ds[last] - ds[first] < 280:
                    continue
                lo, hi = first, last
                while lo > 0 and distances[lo] > 80:
                    lo -= 1
                while hi < len(ds) - 1 and distances[hi] > 80:
                    hi += 1
                if ds[hi] - ds[lo] > 20000:
                    continue
                sub = substring(part, ds[lo], ds[hi])
                # A previous direction/variant of this route may already have filled it.
                if sub.difference(cover).length < 300:
                    continue
                anchors, new_ends = [], 0
                for d in (ds[lo], ds[hi]):
                    p = part.interpolate(d)
                    candidates = mine()  # splitting the first anchor can change edge ids
                    k, line = min(candidates, key=lambda item: item[1].distance(p))
                    if line.distance(p) <= 100:
                        anchors.append(("edge", k, p.coords[0]))
                    elif d == 0 or d == part.length:
                        anchors.append(("end", None, p.coords[0]))
                        new_ends += 1
                    else:
                        anchors = []
                        break
                if len(anchors) != 2 or new_ends > 1:
                    continue
                nodes = []
                for kind, _, p in anchors:
                    if kind == "end":
                        n = max(g.pos) + 1
                        g.pos[n] = p
                    else:
                        k, _ = min(mine(), key=lambda item: item[1].distance(Point(p)))
                        n = graph.split_edge(g, k, p)
                    nodes.append(n)
                a, b = nodes
                key = frozenset(nodes)
                coords = [g.pos[a]] + list(sub.coords)[1:-1] + [g.pos[b]]
                same = next((k for k in shared.get(key, []) if k in g.edges and LineString(g.edges[k]["c"]).hausdorff_distance(LineString(coords)) < 80), None)
                if same is not None:
                    g.edges[same]["lines"] |= {slug}
                else:
                    shared.setdefault(key, []).append(g.add(a, b, coords, frozenset({slug})))
                restored += 1
                drawn = unary_union([line for _, line in mine()])
                cover = drawn.buffer(160)
    return restored


def main():
    path = os.path.join(graph.SITE, "data", "network.json")
    with open(path) as f:
        net = json.load(f)
    routes, rank, _ = graph.load_routes()
    surface = {slug: shape for slug, (layer, shape) in routes.items() if layer == "surface"}
    nodes, positions, raw, metadata, other = {}, {}, [], [], []
    for edge in net["edges"]:
        slugs = [net["lines"][i] for i in edge["l"]]
        if slugs[0] not in surface:
            other.append(edge)
            continue
        ends = [tuple(edge["c"][0]), tuple(edge["c"][-1])]
        for end in ends:
            if end not in nodes:
                nodes[end] = len(positions)
                positions[nodes[end]] = graph.fwd.transform(*end)
        coords = list(LineString(zip(*graph.fwd.transform(*zip(*edge["c"])))).simplify(2.0).coords)
        raw.append((nodes[ends[0]], nodes[ends[1]], coords))
        metadata.append((slugs, edge.get("d", [0] * len(slugs))))
    g = graph.Graph(positions, raw)
    for edge, (slugs, directions) in zip(g.edges.values(), metadata):
        edge.update(lines=frozenset(slugs), order=slugs, dirs=dict(zip(slugs, directions)))
    mask = graph.freeway_mask()
    filled = graph.fill_gaps(g, surface, mask, max_span=20000)
    bridged = graph.bridge_loose_ends(g, surface, mask, max_span=20000)
    restored = restore_spans(g, surface)
    raw = {}
    if graph.MATCHED:
        raw_routes, _, _ = graph.load_routes(prefer_matched=False)
        raw = {slug: shape for slug, (layer, shape) in raw_routes.items() if layer == "surface"}
    turnarounds = restore_turnarounds(g, surface, raw)
    print(f"final continuity: {filled} gaps filled, {bridged} loose ends reconnected, "
          f"{restored} omitted spans and {turnarounds} turnarounds restored", flush=True)
    # Infer direction only for new links; split links retain their original metadata.
    new = graph.Graph(g.pos, [])
    source_ids = {}
    for k, edge in g.edges.items():
        if "dirs" not in edge:
            j = new.add(edge["a"], edge["b"], edge["c"], edge["lines"])
            source_ids[j] = k
    graph.edge_directions(new, surface, mask)
    for j, k in source_ids.items():
        g.edges[k]["dirs"] = new.edges[j].get("dirs", {})
    line_index = {slug: i for i, slug in enumerate(net["lines"])}
    for edge in g.edges.values():
        slugs = edge.get("order", [])
        slugs = slugs + sorted(edge["lines"] - set(slugs), key=lambda s: rank[s])
        # Two meters is below the map's useful street detail. Remove the densely
        # sampled matching trace at build time while keeping every junction fixed.
        simple = LineString(edge["c"]).simplify(2.0)
        lon, lat = graph.inv.transform(*zip(*simple.coords))
        coords = [[round(x, 6), round(y, 6)] for x, y in zip(lon, lat)]
        coords = [coords[0]] + [c for p, c in zip(coords, coords[1:]) if c != p]
        if len(coords) < 2:
            continue
        rec = {"c": coords, "l": [line_index[s] for s in slugs]}
        directions = [edge.get("dirs", {}).get(s, 0) for s in slugs]
        if any(directions):
            rec["d"] = directions
        other.append(rec)
    net["edges"] = other
    with open(path, "w") as f:
        json.dump(net, f, separators=(",", ":"))


if __name__ == "__main__":
    main()
