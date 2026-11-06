"""Keep compact, one-way turnarounds that the corridor cleanup can flatten."""

import math

import numpy as np
import shapely
from shapely.geometry import LineString, Point, Polygon


def line_parts(geom):
    return [p for p in shapely.get_parts(geom) if p.geom_type == "LineString" and p.length > 0.1]


def ends(line):
    return line.coords[0], line.coords[-1]


def travel_direction(line, parts):
    """Read the direction from ordered trip shapes close to the line."""
    if not parts:
        return 0
    d = np.linspace(0, line.length, 34)
    xy = shapely.get_coordinates(shapely.line_interpolate_point(line, d))
    points, tangents = xy[1:-1], xy[2:] - xy[:-2]
    tangents /= np.maximum(np.linalg.norm(tangents, axis=1, keepdims=True), 1e-9)

    coords = [np.asarray(p.coords) for p in parts]
    start = np.concatenate([c[:-1] for c in coords])
    delta = np.concatenate([np.diff(c, axis=0) for c in coords])
    length = np.linalg.norm(delta, axis=1)
    unit = delta / np.maximum(length[:, None], 1e-9)
    offset = points[:, None, :] - start
    along = np.clip(np.einsum("ijk,jk->ij", offset, unit), 0, length)
    nearby = np.linalg.norm(offset - along[:, :, None] * unit, axis=2) < 3
    angle = tangents @ unit.T
    forward = (nearby & (angle > 0.5)).any(axis=1).mean()
    backward = (nearby & (angle < -0.5)).any(axis=1).mean()
    if max(forward, backward) >= 0.875 and min(forward, backward) <= 0.1875:
        return 1 if forward > backward else 2
    return 0


def turnaround_candidates(shape):
    # Noding all directions together also closes a turnaround whose arrival and
    # departure shapes meet at a stop on the circle. The grid absorbs rounding.
    noded = shapely.union_all(shape.geoms, grid_size=1.0)
    for poly in shapely.get_parts(shapely.polygonize(shapely.get_parts(noded))):
        if not 28 <= poly.length <= 750 or poly.area < 45:
            continue
        roundness = 4 * math.pi * poly.area / poly.length ** 2
        if roundness < 0.20 or (roundness < 0.35 and poly.buffer(-7).area < 40):
            continue
        ring = LineString(poly.exterior)
        if len(ring.simplify(1).coords) < 4:
            continue
        local = line_parts(shape.intersection(poly.buffer(5)))
        if travel_direction(ring, local):
            yield poly, ring

    # Separate entry and exit lanes can keep a circle open or stretch its
    # polygon along the entire approach. A narrow buffer locates the turn.
    # Its outline is only used to find the loop. The replacement uses the
    # trip shapes themselves, including the two sides of the approach.
    for band in shapely.get_parts(shape.buffer(4)):
        for interior in band.interiors:
            hole = Polygon(interior)
            if hole.area < 18 or 4 * math.pi * hole.area < 0.3 * hole.length ** 2:
                continue
            poly = hole.buffer(4)
            if poly.length > 750:
                continue
            ring = LineString(poly.exterior)
            if travel_direction(ring, line_parts(shape.intersection(poly.buffer(5)))):
                yield poly, ring


def exits_at(lines, boundary, tolerance):
    return {p for line in lines for p in ends(line) if boundary.distance(Point(p)) < tolerance}


def plan_replacement(shape, ring, area, edges):
    """Clip the old drawing and the source at the same boundary, then join their approaches."""
    boundary = area.boundary
    changed, cuts = [], set()
    for eid, line in edges:
        inside = line_parts(line.intersection(area))
        outside = line_parts(line.difference(area)) if inside else [line]
        cuts.update(exits_at(outside, boundary, 0.05))
        if inside:
            changed.append((eid, line, inside, outside))
    if not cuts:
        return None

    local = [p for line in shape.geoms for p in line_parts(line.intersection(area))]
    source = line_parts(shapely.line_merge(shapely.union_all(local, grid_size=1.0)))
    exits = exits_at(source, boundary, 1.0)
    if not exits:
        return None
    moves = {p: min(cuts, key=lambda q: (math.dist(p, q), q)) for p in exits}
    if set(moves.values()) != cuts or any(math.dist(p, q) > 18 for p, q in moves.items()):
        return None

    joined = []
    for line in source:
        a, b = ends(line)
        coords = [moves.get(a, a), *list(line.coords)[1:-1], moves.get(b, b)]
        new = LineString(coords)
        if new.length >= 1:
            joined.append(new)
    drawn = shapely.union_all(joined)
    if ring.difference(drawn.buffer(5)).length >= 6:
        return None
    # Keep all the approaches connected through the replacement, even if the
    # source has several variants through this part of the route.
    connected = line_parts(drawn)
    at = {}
    for i, line in enumerate(connected):
        for p in ends(line):
            at.setdefault(p, []).append(i)
    seen, pending = set(), [min(cuts)]
    while pending:
        for i in at.get(pending.pop(), ()):
            if i not in seen:
                seen.add(i)
                pending.extend(ends(connected[i]))
    if len(seen) != len(connected) or not cuts <= at.keys():
        return None

    # A pair of lanes can meet the same approach. Keep that junction as an
    # endpoint even when line_merge joins the lanes into one closed path.
    replacement = []
    for line in line_parts(shapely.line_merge(drawn)):
        coords = list(line.coords)
        breaks = [0, *(i for i, p in enumerate(coords[1:-1], 1) if p in cuts), len(coords) - 1]
        replacement.extend(LineString(coords[a:b + 1]) for a, b in zip(breaks, breaks[1:]))
    return changed, replacement, local


def restore_turnarounds(graph, surface, raw):
    nodes = {p: n for n, p in graph.pos.items()}
    next_node = max(graph.pos, default=-1) + 1
    shared = {}

    def node(p):
        nonlocal next_node
        if p not in nodes:
            nodes[p] = next_node
            graph.pos[next_node] = p
            next_node += 1
        return nodes[p]

    def add(line, slugs, order, directions):
        coords = tuple(line.coords)
        reverse = coords[::-1]
        key = min(coords, reverse)
        eid = shared.get(key)
        if eid in graph.edges:
            edge = graph.edges[eid]
            if tuple(edge["c"]) != coords:
                directions = {slug: 3 - d if d else 0 for slug, d in directions.items()}
            edge["lines"] |= slugs
            edge["dirs"].update(directions)
        else:
            a, b = ends(line)
            eid = graph.add(node(a), node(b), coords, slugs)
            graph.edges[eid].update(order=order, dirs=directions)
            shared[key] = eid

    restored = 0
    for slug, matched in surface.items():
        # The matcher can sometimes take a shortcut around a very small circle.
        # Keep the original agency shape available for those turns.
        sources = (matched, raw[slug]) if slug in raw else (matched,)
        repaired = []
        for shape in sources:
            for poly, ring in turnaround_candidates(shape):
                if any(poly.centroid.distance(p) < 16 for p in repaired):
                    continue
                if shape is matched and slug in raw:
                    nearby = raw[slug].intersection(poly.buffer(14)).buffer(10)
                    if ring.difference(nearby).length > 0.15 * ring.length:
                        continue
                # Verify the same approach immediately outside the circle. A
                # larger patch can then reach a stem that was removed entirely.
                close = poly.buffer(10)
                exits = exits_at(line_parts(shape.intersection(close)), close.boundary, 0.05)
                if not exits or any(math.dist(p, q) > 24 for p in exits for q in exits):
                    continue
                near = poly.buffer(600)
                edges = [(i, line) for i, e in graph.edges.items() if slug in e["lines"]
                         if (line := LineString(e["c"])).intersects(near)]
                drawn = shapely.union_all([line for _, line in edges])
                if drawn.is_empty:
                    continue
                if ring.difference(drawn.buffer(5)).length < 6:
                    repaired.append(poly.centroid)
                    continue
                distance = drawn.distance(poly)
                paddings = [pad for pad in (10, 18, 28, 42, 65, 90) if pad > distance]
                if distance >= 60:
                    paddings.extend(pad for extra in (14, 30, 54, 85)
                                    if 90 < (pad := math.ceil(distance) + extra) <= 600)
                plan = None
                for padding in paddings:
                    plan = plan_replacement(shape, ring, poly.buffer(padding), edges)
                    if plan is not None:
                        break
                if plan is None:
                    continue
                changed, new, local = plan
                for eid, old, inside, outside in changed:
                    edge = graph.remove(eid)
                    for pieces, slugs in ((outside, edge["lines"]), (inside, edge["lines"] - {slug})):
                        if not slugs:
                            continue
                        order = [s for s in edge.get("order", ()) if s in slugs]
                        dirs = {s: d for s, d in edge.get("dirs", {}).items() if s in slugs}
                        for part in pieces:
                            a, b = ends(part)
                            if old.project(Point(a)) > old.project(Point(b)):
                                part = LineString(list(part.coords)[::-1])
                            add(part, slugs, order, dirs.copy())
                for line in new:
                    add(line, frozenset({slug}), [slug], {slug: travel_direction(line, local)})
                repaired.append(poly.centroid)
                restored += 1
    return restored
