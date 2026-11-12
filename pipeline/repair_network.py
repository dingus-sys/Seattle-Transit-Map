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


def load_stops_by_route():
    path = os.path.join(graph.SITE, "data", "stops.json")
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        data = json.load(f)
    stops_by_slug = {}
    for s in data.get("stops", []):
        pt = Point(graph.fwd.transform(s["lon"], s["lat"]))
        for r in s.get("routes", []):
            stops_by_slug.setdefault(r, []).append((pt, s["id"]))
    return stops_by_slug


def restore_stop_spans(g, routes, stops_by_slug):
    """Restore source-path spans for active transit stops that were omitted or collapsed away."""
    restored, shared = 0, {}
    for slug, shape in routes.items():
        if slug not in stops_by_slug:
            continue
        def mine():
            return [(k, LineString(e["c"])) for k, e in g.edges.items() if slug in e["lines"]]
        lines_list = mine()
        if not lines_list:
            continue
        drawn = unary_union([line for _, line in lines_list])
        uncovered = [pt for pt, sid in stops_by_slug[slug] if drawn.distance(pt) > 22.0]
        if not uncovered:
            continue

        cover = drawn.buffer(20.0)
        for part in shape.geoms:
            part_stops = [pt for pt in uncovered if part.distance(pt) < 18.0]
            if not part_stops:
                continue
            missing = part.difference(cover)
            if missing.is_empty:
                continue
            ds = np.append(np.arange(0, part.length, 10.0), part.length)
            distances = shapely.distance(shapely.line_interpolate_point(part, ds), drawn)
            far = distances > 20.0
            starts = np.flatnonzero(far & ~np.r_[False, far[:-1]])
            ends = np.flatnonzero(far & ~np.r_[far[1:], False])
            for first, last in zip(starts, ends):
                lo, hi = first, last
                while lo > 0 and distances[lo] > 8.0:
                    lo -= 1
                while hi < len(ds) - 1 and distances[hi] > 8.0:
                    hi += 1
                if ds[hi] - ds[lo] < 20 or ds[hi] - ds[lo] > 10000:
                    continue
                sub = substring(part, ds[lo], ds[hi])
                if not any(sub.distance(pt) < 18.0 for pt in part_stops):
                    continue
                anchors, new_ends = [], 0
                for d in (ds[lo], ds[hi]):
                    p = part.interpolate(d)
                    candidates = mine()
                    k, line = min(candidates, key=lambda item: item[1].distance(p))
                    if line.distance(p) <= 25:
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
                same = next((k for k in shared.get(key, []) if k in g.edges and LineString(g.edges[k]["c"]).hausdorff_distance(LineString(coords)) < 40), None)
                if same is not None:
                    g.edges[same]["lines"] |= {slug}
                else:
                    shared.setdefault(key, []).append(g.add(a, b, coords, frozenset({slug})))
                restored += 1
                drawn = unary_union([line for _, line in mine()])
                cover = drawn.buffer(20.0)
    return restored


def bridge_route_components(g, surface, max_gap=25000.0):
    """Reconnect broken route components across freeway or tracing gaps along the route's own shape."""
    bridged = 0
    for slug, shape in surface.items():
        mine = [k for k, e in g.edges.items() if slug in e["lines"]]
        if not mine:
            continue

        adj = {}
        for k in mine:
            e = g.edges[k]
            adj.setdefault(e["a"], []).append(e["b"])
            adj.setdefault(e["b"], []).append(e["a"])

        visited = set()
        comps = []
        for n in adj:
            if n not in visited:
                comp = []
                q = [n]
                visited.add(n)
                while q:
                    cur = q.pop()
                    comp.append(cur)
                    for nxt in adj.get(cur, []):
                        if nxt not in visited:
                            visited.add(nxt)
                            q.append(nxt)
                comps.append(comp)

        if len(comps) <= 1:
            continue

        def _connected_components():
            seen, out = set(), []
            for start in adj:
                if start in seen:
                    continue
                comp, q = [], [start]
                seen.add(start)
                while q:
                    cur = q.pop()
                    comp.append(cur)
                    for nxt in adj.get(cur, []):
                        if nxt not in seen:
                            seen.add(nxt)
                            q.append(nxt)
                out.append(comp)
            return out

        while len(comps) > 1:
            best = None
            best_score = float("inf")
            for part in getattr(shape, "geoms", [shape]):
                comp_projs = []
                for c in comps:
                    nodes_on = []
                    for n in c:
                        P = Point(g.pos[n])
                        dist = part.distance(P)
                        if dist < 60:
                            nodes_on.append((part.project(P), n, dist))
                    comp_projs.append(nodes_on)

                for c1_idx in range(len(comps)):
                    for c2_idx in range(c1_idx + 1, len(comps)):
                        for s1, n1, d1 in comp_projs[c1_idx]:
                            for s2, n2, d2 in comp_projs[c2_idx]:
                                gap = abs(s2 - s1)
                                if not (5 < gap < max_gap):
                                    continue
                                # Rank across all parts using path gap plus perpendicular endpoint offset so
                                # an opposite carriageway ~55 m away does not beat the actual carriageway.
                                score = gap + 2.0 * (d1 + d2)
                                if score < best_score:
                                    best_score = score
                                    best = (part, s1, n1, d1, s2, n2, d2, gap)

            if not best:
                break
            part, s1, n1, d1, s2, n2, d2, gap = best
            lo, hi = min(s1, s2), max(s1, s2)
            sub = substring(part, lo, hi)
            a = n1 if s1 < s2 else n2
            b = n2 if s1 < s2 else n1
            # Avoid drawing a sideways V-detour when the matched shape sits farther to the side than the bridge.
            if d1 + d2 > gap and gap < 80:
                coords = [g.pos[a], g.pos[b]]
            else:
                coords = [g.pos[a]] + list(sub.coords)[1:-1] + [g.pos[b]]

            key = frozenset((a, b))
            existing = None
            for k, e in g.edges.items():
                if frozenset((e["a"], e["b"])) == key:
                    existing = k
                    break
                elif LineString(e["c"]).hausdorff_distance(LineString(coords)) < 30:
                    existing = k
                    break

            if existing is not None:
                g.edges[existing]["lines"] |= {slug}
            else:
                g.add(a, b, coords, frozenset({slug}))
            bridged += 1

            adj.setdefault(a, []).append(b)
            adj.setdefault(b, []).append(a)
            comps = _connected_components()
    return bridged


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
    stops_by_slug = load_stops_by_route()
    stop_spans = restore_stop_spans(g, surface, stops_by_slug)
    comp_bridged = bridge_route_components(g, surface, max_gap=25000.0)
    raw = {}
    if graph.MATCHED:
        raw_routes, _, _ = graph.load_routes(prefer_matched=False)
        raw = {slug: shape for slug, (layer, shape) in raw_routes.items() if layer == "surface"}
    turnarounds = restore_turnarounds(g, surface, raw)
    print(f"final continuity: {filled} gaps filled, {bridged} loose ends reconnected, "
          f"{restored} omitted spans, {stop_spans} stop spans, {comp_bridged} component gaps reconnected and {turnarounds} turnarounds restored", flush=True)
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
