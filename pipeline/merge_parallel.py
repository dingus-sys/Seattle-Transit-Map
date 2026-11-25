"""Put routes that run along the same street onto one shared edge.

build_graph merges routes by tracing one centerline for all of them. The repair steps
after it (restore_spans, restore_stop_spans, bridge_route_components, restore_turnarounds)
add each route's missing piece from that route's own shape, so two routes repaired along
the same street, or a repaired route beside an existing corridor, become separate edges a
few meters apart. The page lays out each edge on its own, so those routes overlap and cross
(at Totem Lake Transit Center the 225, 239, 255 and 930 each had their own loop) instead of
sitting side by side in one bundle.

`merge_parallel_copies` finds every stretch where one edge runs alongside another (within
`tol`, roughly parallel) and moves the weaker edge's routes onto the stronger edge, joining
what is left of the weaker edge to it where the two separate. A separation shorter than
`max_split` (a corner cut, a short pull-in) is folded into the bundle. Two paths between
the same two junctions that both stay on a freeway (one route in the express lanes or at a
freeway station, another on the main lanes) are one line when within `fwy_tol`, as both
carriageways are in build_graph. Only such a closed bubble: a surface street that runs
under or beside a freeway (Eastlake under I-5) keeps the street tolerance. A fork, where two
edges leave a junction at a shallow angle, is not a shared stretch: the tapering ends of a
stretch are trimmed back to where the two edges run parallel.
"""
import math

import numpy as np
import shapely
from shapely import STRtree
from shapely.geometry import LineString
from shapely.ops import substring

TOL = 15.0        # two paths closer than this run along the same street (the user's choice)
FWY_TOL = 40.0    # two paths between the same two junctions, both on a freeway, are one line
MAX_SPLIT = 60.0  # a separation shorter than this is folded into the bundle
MIN_RUN = 25.0    # shortest shared stretch worth merging (a whole short duplicate always is)
STEP = 4.0        # sample spacing along an edge
COS_MIN = 0.8     # parallel: within about 37 degrees
SNAP = 5.0        # a cut this close to an edge's end uses the end node
KNOT = 12.0       # junctions closer than this, where merged routes part, become one


def _flip(dirs):
    return {s: 3 - d if d else 0 for s, d in dirs.items()}


def _strength(g, eid):
    """Which of two copies keeps its geometry: the one carrying more routes, then the longer."""
    e = g.edges[eid]
    return (len(e["lines"]), round(LineString(e["c"]).length, 3), -eid)


def _bend_start(c, shift, cap, reach=20.0):
    """Move the first point of polyline `c` by `shift`, keeping the line's shape. The part of
    the move along the direction the line leaves its start only lengthens or shortens its first
    stretch (a street meeting a junction a few meters further along); the sideways part bends
    the line, fading out over a short distance (never more than `cap`) so a corner further back
    stays where it is."""
    c = np.array(c, float)
    if len(c) < 2:
        return c + shift
    along = np.r_[0, np.cumsum(np.hypot(*np.diff(c, axis=0).T))]
    L = along[-1]
    j = int(min(len(c) - 1, max(1, np.searchsorted(along, min(10.0, L)))))
    t = c[0] - c[j]
    n = float(np.hypot(*t))
    t = t / n if n > 1e-9 else np.zeros(2)
    side = shift - float(shift @ t) * t
    r = max(1e-6, min(max(reach, 3 * float(np.hypot(*side))), cap))
    w = np.clip(1 - along / r, 0, 1)
    out = c + w[:, None] * side
    out[0] = c[0] + shift
    # shortened: drop the points the new start has passed, so the line doesn't double back
    k = 1
    while k < len(out) - 1 and (out[k] - out[0]) @ t > 0:
        k += 1
    return np.vstack([out[:1], out[k:]])


def _tangents(line, d, h=3.0):
    L = line.length
    p = shapely.get_coordinates(shapely.line_interpolate_point(line, np.clip(d + h, 0, L)))
    q = shapely.get_coordinates(shapely.line_interpolate_point(line, np.clip(d - h, 0, L)))
    t = p - q
    return t / np.maximum(np.linalg.norm(t, axis=1, keepdims=True), 1e-9)


class _Merger:
    def __init__(self, g, tol, max_split, min_run, mask=None, fwy_tol=FWY_TOL):
        self.g, self.tol, self.max_split, self.min_run = g, tol, max_split, min_run
        self.mask, self.fwy_tol = mask, fwy_tol
        if mask is not None:
            shapely.prepare(mask)
        self.next_node = max(g.pos, default=-1) + 1
        self.touched_nodes = set()

    # -- graph edits -------------------------------------------------------------------

    def add(self, a, b, coords, lines, order, dirs):
        k = self.g.add(a, b, coords, frozenset(lines))
        self.g.edges[k].update(order=list(order), dirs=dict(dirs))
        return k

    def split(self, eid, d):
        """Cut edge `eid` at distance `d` along it: (node, piece before, piece after)."""
        g = self.g
        e = g.edges[eid]
        ls = LineString(e["c"])
        L = ls.length
        if d <= SNAP:
            return e["a"], None, eid
        if d >= L - SNAP:
            return e["b"], eid, None
        c1, c2 = substring(ls, 0, d), substring(ls, d, L)
        nid = self.next_node
        self.next_node += 1
        g.pos[nid] = c1.coords[-1]
        g.remove(eid)
        order, dirs = e.get("order", sorted(e["lines"])), e.get("dirs", {})
        k1 = self.add(e["a"], nid, list(c1.coords), e["lines"], order, dirs)
        k2 = self.add(nid, e["b"], list(c2.coords), e["lines"], order, dirs)
        return nid, k1, k2

    def move_node(self, src, dst):
        """Re-attach every edge at node `src` to node `dst`, bending the end of each edge
        over a short distance so it meets `dst` without a kink."""
        g = self.g
        if src == dst:
            return
        shift = np.subtract(g.pos[dst], g.pos[src])
        end = tuple(g.pos[dst])
        for k in list(g.adj[src]):
            e = g.edges[k]
            c = np.asarray(e["c"], float)
            cap = LineString(c).length / (2 if e["a"] == src and e["b"] == src else 1)
            if e["a"] == src:
                c = _bend_start(c, shift, cap)
                e["a"] = dst
            if e["b"] == src:
                c = _bend_start(c[::-1], shift, cap)[::-1]
                e["b"] = dst
            c = [tuple(p) for p in c]
            if e["a"] == dst:
                c[0] = end
            if e["b"] == dst:
                c[-1] = end
            e["c"] = c
            g.adj[dst].add(k)
        del g.adj[src]
        self.touched_nodes.add(dst)

    def drop_knots(self, nodes):
        """Remove what moving nodes together can leave behind: edges of (almost) no length."""
        g = self.g
        for n in list(nodes):
            for k in list(g.adj.get(n, ())):
                if k not in g.edges:
                    continue
                e = g.edges[k]
                L = LineString(e["c"]).length
                if e["a"] == e["b"] and L < 20:
                    g.remove(k)
                elif e["a"] != e["b"] and L < 1.0:
                    g.remove(k)
                    self.move_node(e["b"], e["a"])

    # -- finding a shared stretch ------------------------------------------------------

    def best_run(self, b, candidates):
        g, tol = self.g, self.tol
        lb = LineString(g.edges[b]["c"])
        Lb = lb.length
        if Lb < 8:
            return None
        s = np.linspace(0, Lb, max(2, int(math.ceil(Lb / STEP)) + 1))
        pts = shapely.line_interpolate_point(lb, s)
        tb = _tangents(lb, s)
        best = None
        for a in candidates:
            la = LineString(g.edges[a]["c"])
            d = shapely.distance(pts, la)
            near = d <= tol
            if near.sum() < 2:
                continue
            u = shapely.line_locate_point(la, pts)
            cos = (_tangents(la, u) * tb).sum(1)
            ok = near & (np.abs(cos) >= COS_MIN)
            for run in self.runs(s, d, u, cos, ok, Lb, la.length):
                if best is None or run[1] - run[0] > best[2][1] - best[2][0]:
                    best = (a, la.length, run)
        return best

    def runs(self, s, d, u, cos, ok, Lb, La):
        """Stretches of b that follow a: (s0, s1, u0, u1, sign)."""
        idx = np.flatnonzero(ok)
        if len(idx) < 2:
            return
        groups, cur = [], [idx[0]]
        for i, j in zip(idx, idx[1:]):
            ds = s[j] - s[i]
            sign = 1 if cos[i] > 0 else -1
            du = sign * (u[j] - u[i])
            same_way = (cos[j] > 0) == (cos[i] > 0)
            if same_way and ds <= self.max_split + STEP and 0.3 * ds <= du <= 3 * ds + 2 * self.tol:
                cur.append(j)
            else:
                groups.append(cur)
                cur = [j]
        groups.append(cur)
        for grp in groups:
            if len(grp) < 2:
                continue
            i0, i1 = 0, len(grp) - 1
            # trim a taper: the ends where the two paths are steadily drawing apart
            while i1 > i0 and d[grp[i1]] > 3 and d[grp[i1]] > d[grp[i1 - 1]] + 0.15 * (s[grp[i1]] - s[grp[i1 - 1]]):
                i1 -= 1
            while i0 < i1 and d[grp[i0]] > 3 and d[grp[i0]] > d[grp[i0 + 1]] + 0.15 * (s[grp[i0 + 1]] - s[grp[i0]]):
                i0 += 1
            if i1 <= i0:
                continue
            p, q = grp[i0], grp[i1]
            s0, s1 = s[p], s[q]
            whole = s0 <= SNAP and s1 >= Lb - SNAP
            if s1 - s0 < (8 if whole else self.min_run) or abs(u[q] - u[p]) < (8 if whole else 0.5 * self.min_run):
                continue
            yield s0, s1, u[p], u[q], 1 if cos[p] > 0 else -1

    # -- merging one stretch -----------------------------------------------------------

    def apply(self, b, a, La, run):
        g = self.g
        s0, s1, u0, u1, sign = run
        lo, hi = min(u0, u1), max(u0, u1)
        eb, ea = g.edges[b], g.edges[a]
        Lb = LineString(eb["c"]).length
        # Which existing nodes the cuts would land on (None: a new node). b's ends map onto a's.
        na_lo = ea["a"] if lo <= SNAP else None
        na_hi = ea["b"] if hi >= La - SNAP else None
        nb0 = eb["a"] if s0 <= SNAP else None
        nb1 = eb["b"] if s1 >= Lb - SNAP else None
        to0, to1 = (na_lo, na_hi) if sign > 0 else (na_hi, na_lo)
        a_nodes = {ea["a"], ea["b"]}
        # a closed b (a loop) is joined at its one node only
        joins = ((nb0, to0),) if nb0 is not None and nb0 == nb1 else ((nb0, to0), (nb1, to1))
        for nb, na in joins:
            if nb is not None and nb in a_nodes and nb != na:
                # that would drag a's own end across: fine only to close a loop that a leaves
                # open by a few meters
                if na is None or math.dist(g.pos[nb], g.pos[na]) > KNOT:
                    return None
        if hi - lo < SNAP + 2 or s1 - s0 < SNAP + 2:
            return None
        # cut a: the shared stretch becomes its own edge `mid`
        n_hi, before, _ = self.split(a, hi)
        n_lo, _, mid = self.split(before, lo)
        # cut b the same way and take the shared stretch out
        m_hi, before_b, _ = self.split(b, s1)
        m_lo, _, mid_b = self.split(before_b, s0)
        gone = g.remove(mid_b)
        dirs_b = gone.get("dirs", {})
        if sign < 0:
            dirs_b = _flip(dirs_b)
        e = g.edges[mid]
        dirs = dict(e.get("dirs", {}))
        for slug in gone["lines"]:
            db = dirs_b.get(slug, 0)
            dirs[slug] = db if slug not in e["lines"] else (dirs.get(slug, 0) if dirs.get(slug, 0) == db else 0)
        order = list(e.get("order", sorted(e["lines"])))
        order += [x for x in gone.get("order", sorted(gone["lines"])) if x not in order]
        order += sorted(gone["lines"] - set(order))
        e.update(lines=frozenset(e["lines"] | gone["lines"]), order=order, dirs=dirs)
        # join what is left of b to a where they part
        t0, t1 = (n_lo, n_hi) if sign > 0 else (n_hi, n_lo)
        self.touched_nodes |= {n_lo, n_hi}
        if m_lo == m_hi:
            self.move_node(m_lo, t0)
        else:
            self.move_node(m_lo, t0)
            self.move_node(m_hi, t1)
        self.drop_knots({n_lo, n_hi})
        return mid

    def on_freeway(self, line):
        return self.mask is not None and line.intersection(self.mask).length >= 0.9 * line.length

    def merge_multi_edges(self):
        """Two edges between the same pair of nodes (or two loops at one node) that lie within
        `tol` of each other, or `fwy_tol` when both stay on a freeway, are one edge."""
        g = self.g
        merged = 0
        groups = {}
        for k, e in g.edges.items():
            groups.setdefault(frozenset((e["a"], e["b"])), []).append(k)
        for ks in groups.values():
            if len(ks) < 2:
                continue
            kept = []
            for k in sorted(ks, key=lambda k: _strength(g, k), reverse=True):
                eo = g.edges[k]
                lo = LineString(eo["c"])
                keep = next((t for t in kept if self.same_path(LineString(g.edges[t]["c"]), lo)), None)
                if keep is None:
                    kept.append(k)
                    continue
                ek = g.edges[keep]
                if ek["a"] == ek["b"]:  # two loops at one node: do they go the same way round?
                    same = (len(ek["c"]) < 4 or len(eo["c"]) < 4
                            or shapely.LinearRing(ek["c"]).is_ccw == shapely.LinearRing(eo["c"]).is_ccw)
                else:
                    same = eo["a"] == ek["a"]
                g.remove(k)
                dirs_o = eo.get("dirs", {}) if same else _flip(eo.get("dirs", {}))
                dirs = dict(ek.get("dirs", {}))
                for slug in eo["lines"]:
                    do = dirs_o.get(slug, 0)
                    dirs[slug] = do if slug not in ek["lines"] else (dirs.get(slug, 0) if dirs.get(slug, 0) == do else 0)
                order = list(ek.get("order", sorted(ek["lines"])))
                order += [x for x in eo.get("order", sorted(eo["lines"])) if x not in order]
                order += sorted(eo["lines"] - set(order))
                ek.update(lines=frozenset(ek["lines"] | eo["lines"]), order=order, dirs=dirs)
                self.touched_nodes |= {ek["a"], ek["b"]}
                merged += 1
        return merged

    def same_path(self, la, lb):
        gap = la.hausdorff_distance(lb)
        if gap <= self.tol:
            return True
        return gap <= self.fwy_tol and self.on_freeway(la) and self.on_freeway(lb)

    def contract_knots(self, max_len=KNOT):
        """Merging leaves junctions a few meters apart where the routes peel off one by one
        (a 7 m piece, then an 8 m piece...). Pull the ends of each such piece into one node,
        so the pieces that ran beside each other become duplicate edges that merge."""
        g = self.g
        done = 0
        for k in sorted([k for n in self.touched_nodes if n in g.adj for k in g.adj[n]]):
            if k not in g.edges:
                continue
            e = g.edges[k]
            a, b = e["a"], e["b"]
            if a == b or LineString(e["c"]).length >= max_len or len(g.adj[a]) < 2 or len(g.adj[b]) < 2:
                continue
            g.remove(k)
            keep, drop = (a, b) if len(g.adj[a]) >= len(g.adj[b]) else (b, a)
            self.move_node(drop, keep)
            self.drop_knots({keep})
            done += 1
        # junctions left a few meters apart with no piece between them (a loop that ends just
        # short of where it began, beside the street it turns off) are one junction too
        near = KNOT * 0.8
        nodes = sorted(n for n in self.touched_nodes if g.adj.get(n))
        cells = {}
        for n in nodes:
            x, y = g.pos[n]
            cells.setdefault((int(x // near), int(y // near)), []).append(n)
        for n in nodes:
            if not g.adj.get(n):
                continue
            x, y = g.pos[n]
            cx, cy = int(x // near), int(y // near)
            for m in [m for i in (-1, 0, 1) for j in (-1, 0, 1) for m in cells.get((cx + i, cy + j), ())]:
                if m == n or not g.adj.get(m) or math.dist(g.pos[n], g.pos[m]) > near:
                    continue
                keep, drop = (n, m) if (len(g.adj[n]), -n) >= (len(g.adj[m]), -m) else (m, n)
                self.move_node(drop, keep)
                self.drop_knots({keep})
                done += 1
                if drop == n:
                    break
        return done

    def join_chains(self):
        """Weld the pieces left at nodes this pass created, where the same routes go straight
        through in the same directions, back into one edge."""
        g = self.g
        joined = 0
        for n in list(self.touched_nodes):
            if n not in g.adj or len(g.adj[n]) != 2:
                continue
            k1, k2 = list(g.adj[n])
            e1, e2 = g.edges[k1], g.edges[k2]
            if e1["lines"] != e2["lines"] or e1["a"] == e1["b"] or e2["a"] == e2["b"]:
                continue
            a = e1["a"] if e1["b"] == n else e1["b"]
            b = e2["b"] if e2["a"] == n else e2["a"]
            d1 = e1.get("dirs", {}) if e1["b"] == n else _flip(e1.get("dirs", {}))
            d2 = e2.get("dirs", {}) if e2["a"] == n else _flip(e2.get("dirs", {}))
            if any(d1.get(s, 0) != d2.get(s, 0) for s in e1["lines"]):
                continue
            c1 = g.coords_from(k1, a)
            c2 = g.coords_from(k2, n)
            g.remove(k1)
            g.remove(k2)
            self.add(a, b, list(c1) + list(c2)[1:], e1["lines"], e1.get("order", sorted(e1["lines"])), d1)
            del g.adj[n]
            joined += 1
        return joined


def merge_parallel_copies(g, tol=TOL, max_split=MAX_SPLIT, min_run=MIN_RUN, rounds=40, mask=None):
    """Merge every stretch where routes run as separate copies along the same street.
    Edges need "lines"; "order" and "dirs" (direction per route along the edge) are kept.
    `mask` is the freeway corridor (build_graph.freeway_mask()), where `FWY_TOL` applies.
    Returns (stretches merged, duplicate edges merged, edges welded back together)."""
    m = _Merger(g, tol, max_split, min_run, mask)
    for e in g.edges.values():
        e.setdefault("order", sorted(e["lines"]))
        e.setdefault("dirs", {})
    stretches = multi = joined = 0
    dirty = None
    for _ in range(6):
        s, mm, dirty = _merge_stretches(g, m, tol, rounds, dirty)
        knots = m.contract_knots()
        mm += m.merge_multi_edges()
        j = m.join_chains()
        mm += m.merge_multi_edges()
        stretches, multi, joined = stretches + s, multi + mm, joined + j
        if not (s or knots or mm or j):
            break
        dirty = {k for n in m.touched_nodes if n in g.adj for k in g.adj[n]}
    return stretches, multi, joined


def _merge_stretches(g, m, tol, rounds, dirty):
    stretches = 0
    multi = m.merge_multi_edges()
    for _ in range(rounds):
        ids = list(g.edges)
        geoms = [LineString(g.edges[k]["c"]) for k in ids]
        tree = STRtree(geoms)
        where = {k: i for i, k in enumerate(ids)}
        busy, created = set(), set()
        changed = 0
        for b in sorted(ids, key=lambda k: _strength(g, k)):
            if b in busy or b not in g.edges:
                continue
            near = [ids[j] for j in tree.query(geoms[where[b]], predicate="dwithin", distance=tol)]
            if dirty is not None and b not in dirty and not any(a in dirty for a in near):
                continue
            mine = _strength(g, b)
            cands = [a for a in near if a != b and a in g.edges and a not in busy
                     and _strength(g, a) > mine and g.edges[a]["lines"] != g.edges[b]["lines"]]
            if not cands:
                continue
            found = m.best_run(b, cands)
            if found is None:
                continue
            a, La, run = found
            before = set(g.edges)
            if m.apply(b, a, La, run) is None:
                busy |= set(g.edges) - before
                continue
            new = set(g.edges) - before
            busy |= new | {a, b}
            created |= new
            changed += 1
        stretches += changed
        multi += m.merge_multi_edges()
        if not changed:
            break
        dirty = {k for k in created if k in g.edges}
        # the end pieces of b and a that were cut but not merged are dirty too
        dirty |= {k for n in m.touched_nodes if n in g.adj for k in g.adj[n]}
    return stretches, multi, dirty
