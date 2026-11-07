/* King County Transit Map — line geometry engine.
 *
 * Turns the street network (site/data/network.json) into what the map draws for one view:
 * one continuous path per corridor with rounded corners and lanes kept through junctions,
 * the selected route on top, and the route-number tags. It is pure computation (no map, no
 * page), so the page runs it in a background worker and the map stays smooth while it works;
 * where workers aren't allowed the page runs the same code itself.
 *
 *   KCTMGeom.createEngine({ edges, lines, cat, gap }) -> { build(params) }
 *     edges  network.json edges: { c: [[lon, lat]...], l: [line index...] }
 *     lines  per line index: { cat, rank }
 *     cat    the corridor table (width, tier, priority, inner style per service type)
 *     gap    space between side-by-side corridors, in line units
 */
const KCTMGeom = (() => {
  "use strict";

  // Local flat coordinates in meters around Seattle (plenty accurate at city scale)
  const LAT0 = 47.61, LON0 = -122.33;
  const KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110574;
  // meters per pixel at zoom 0 (MapLibre's world is 512 pixels wide at zoom 0)
  const MPP0 = 78271.51696 * Math.cos(LAT0 * Math.PI / 180);
  const toM = (lon, lat) => [(lon - LON0) * KX, (lat - LAT0) * KY];
  const toLL = (p) => [Math.round((LON0 + p[0] / KX) * 1e6) / 1e6, Math.round((LAT0 + p[1] / KY) * 1e6) / 1e6];
  const VKEY = (cat) => (cat === "amtrak" ? "sounder" : cat); // Amtrak shares Sounder's tracks and line
  const dkey = (r) => (r.cat === "link" ? (r.label === "1" ? "link1" : r.label === "T" ? "linkT" : "link2") : VKEY(r.cat));

  function simplify(pts, tol) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]], t2 = tol * tol;
    while (stack.length) {
      const [i, j] = stack.pop();
      const [x1, y1] = pts[i], [x2, y2] = pts[j];
      const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
      let maxd = -1, idx = -1;
      for (let m = i + 1; m < j; m++) {
        const [x, y] = pts[m];
        let t = L2 ? ((x - x1) * dx + (y - y1) * dy) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = (x1 + t * dx - x) ** 2 + (y1 + t * dy - y) ** 2;
        if (d > maxd) { maxd = d; idx = m; }
      }
      if (maxd > t2) { keep[idx] = 1; stack.push([i, idx], [idx, j]); }
    }
    return pts.filter((_, i) => keep[i]);
  }
  function cumLen(p) {
    const c = [0];
    for (let i = 1; i < p.length; i++) c.push(c[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
    return c;
  }
  function pointAt(p, c, d) {
    const L = c[c.length - 1];
    if (d <= 0) return p[0];
    if (d >= L) return p[p.length - 1];
    let i = 1;
    while (c[i] < d) i++;
    const t = (d - c[i - 1]) / ((c[i] - c[i - 1]) || 1);
    return [p[i - 1][0] + t * (p[i][0] - p[i - 1][0]), p[i - 1][1] + t * (p[i][1] - p[i - 1][1])];
  }
  function miters(p) {
    const n = p.length, segN = [], m = new Array(n);
    for (let i = 0; i < n - 1; i++) {
      const dx = p[i + 1][0] - p[i][0], dy = p[i + 1][1] - p[i][1], L = Math.hypot(dx, dy) || 1;
      segN.push([dy / L, -dx / L]); // right-hand normal
    }
    for (let i = 0; i < n; i++) {
      if (i === 0) { m[i] = segN[0]; continue; }
      if (i === n - 1) { m[i] = segN[n - 2]; continue; }
      const a = segN[i - 1], b = segN[i];
      let x = a[0] + b[0], y = a[1] + b[1];
      const L = Math.hypot(x, y);
      if (L < 1e-6) { m[i] = b; continue; }
      x /= L; y /= L;
      const sc = 1 / Math.max(x * b[0] + y * b[1], 0.55);
      m[i] = [x * sc, y * sc];
    }
    return m;
  }
  const unitVec = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1; return [dx / L, dy / L]; };

  // Continuous paths through a set of segments: at each junction the segments that line up best
  // are joined. One route (`through`) always carries on where it has just two segments at a
  // junction, however sharp the turn: it does pass through there.
  function chainsFor(edges, through = false) {
    const dirAt = (E, end) => {
      const p = E.pts, n = p.length, c = E.cum || (E.cum = cumLen(p)), L = c[n - 1];
      const look = Math.min(L * 0.5, 30);
      return end === "a" ? unitVec(p[0], pointAt(p, c, look)) : unitVec(p[n - 1], pointAt(p, c, L - look));
    };
    const at = new Map();
    for (const E of edges) {
      for (const end of ["a", "b"]) {
        if (!at.has(E[end])) at.set(E[end], []);
        at.get(E[end]).push({ E, end });
      }
    }
    const link = new Map();
    const key = (x) => `${x.E.k}${x.end}`;
    for (const list of at.values()) {
      if (list.length < 2) continue;
      const dirs = list.map((x) => dirAt(x.E, x.end));
      const cand = [];
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (list[i].E !== list[j].E) cand.push([dirs[i][0] * dirs[j][0] + dirs[i][1] * dirs[j][1], i, j]);
        }
      }
      cand.sort((a, b) => a[0] - b[0]);
      const used = new Set();
      for (const [d, i, j] of cand) {
        if (used.has(i) || used.has(j)) continue;
        if (!(through && list.length === 2) && (d > 0.8 || (list.length > 2 && d > 0.3))) continue;
        used.add(i); used.add(j);
        link.set(key(list[i]), list[j]);
        link.set(key(list[j]), list[i]);
      }
    }
    const seen = new Set(), chains = [];
    const walk = (E, from) => {
      const steps = [];
      while (E && !seen.has(E.k)) {
        seen.add(E.k);
        const fwd = from === "a";
        steps.push({ E, fwd });
        const nxt = link.get(`${E.k}${fwd ? "b" : "a"}`);
        if (!nxt) break;
        E = nxt.E; from = nxt.end;
      }
      return steps;
    };
    for (const E of edges) for (const end of ["a", "b"]) if (!seen.has(E.k) && !link.has(`${E.k}${end}`)) chains.push(walk(E, end));
    for (const E of edges) if (!seen.has(E.k)) chains.push(walk(E, "a"));
    return chains.filter((c) => c.length);
  }

  // Sample a polyline (with cumulative lengths c) at sorted distances ds, in one pass.
  function sampleAt(p, c, ds) {
    const out = [];
    let i = 1;
    for (const d of ds) {
      while (i < p.length - 1 && c[i] < d) i++;
      const t = Math.max(0, Math.min(1, (d - c[i - 1]) / ((c[i] - c[i - 1]) || 1)));
      out.push([p[i - 1][0] + t * (p[i][0] - p[i - 1][0]), p[i - 1][1] + t * (p[i][1] - p[i - 1][1])]);
    }
    return out;
  }

  // Offsetting a tight bend can make a strand curl back across itself. Clip only
  // small, proper crossings; keep endpoints and genuine loops/long detours intact.
  function clipSmallLoops(points, limit) {
    const out = [], dist = [];
    for (const p of points) {
      if (out.length > 2) {
        const a = out[out.length - 1], vx = p[0] - a[0], vy = p[1] - a[1];
        for (let j = out.length - 3; j >= 0 && dist[dist.length - 1] - dist[j] <= limit; j--) {
          const b = out[j], c = out[j + 1], wx = c[0] - b[0], wy = c[1] - b[1];
          const den = vx * wy - vy * wx;
          if (Math.abs(den) < 1e-9) continue;
          const dx = b[0] - a[0], dy = b[1] - a[1];
          const t = (dx * wy - dy * wx) / den, u = (dx * vy - dy * vx) / den;
          if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) continue;
          const q = [a[0] + t * vx, a[1] + t * vy];
          if (dist[dist.length - 1] - dist[j] + t * Math.hypot(vx, vy) > limit) continue;
          out.length = dist.length = j + 1;
          dist.push(dist[j] + Math.hypot(q[0] - b[0], q[1] - b[1])); out.push(q);
          break;
        }
      }
      const a = out[out.length - 1];
      dist.push(a ? dist[dist.length - 1] + Math.hypot(p[0] - a[0], p[1] - a[1]) : 0);
      out.push(p);
    }
    return out;
  }

  // One continuous path along `steps`, in the lane laneOf(Lo, step) = [center, half width] (line
  // units, before shifting) of each segment. Corners are rounded to suit the bundle width; lane
  // changes are eased steps that may overlap, so a line crossing a busy street glides across
  // instead of jogging. With `fit`, where a corridor gets wider or narrower (routes joining or
  // leaving) the narrower piece starts right inside the wider one with no slant, so a thick line
  // splits cleanly into its routes. Calls emit(stepIndex, coords).
  function drawPath(laneOf, steps, lay, S, emit, water = false, fit = false, easeAt = null) {
    const pts = [], seg = [], joints = [];
    for (let k = 0; k < steps.length; k++) {
      const { E, fwd } = steps[k], Lo = lay[E.k];
      const hwk = (Lo.T / 2 + Math.abs(Lo.shift)) * S;
      let g = fwd ? Lo.simp : Lo.simp.slice().reverse();
      // Simplify to the scale of this corridor's corners before rounding them. A corner is an arc
      // that may use up to half of each neighbouring segment, and a street's outline keeps points
      // a metre or two apart around every intersection (a chamfer, a kerb): points that close to the
      // line can't show as a corner at the radius a corner here gets, but they leave the arc no room,
      // so it collapses into a sharp elbow. Ends stay put, so junctions and lanes still line up.
      if (g.length > 2 && !water) g = simplify(g, Math.min(0.25 * (1.25 * hwk + 6), 12));
      if (k > 0) { joints.push(pts.length - 1); g = g.slice(1); }
      for (const q of g) pts.push(q);
      const [c, h] = laneOf(Lo, steps[k]);
      seg.push({ o: (fwd ? 1 : -1) * (c + Lo.shift) * S, h: h * S, hw: hwk });
    }
    if (pts.length < 2) return;

    const line = [pts[0]], jointAt = [];
    let jk = 0;
    for (let v = 1; v < pts.length - 1; v++) {
      const P = pts[v], A = pts[v - 1], B = pts[v + 1];
      const isJ = joints[jk] === v;
      const dIn = unitVec(A, P), dOut = unitVec(P, B);
      const cos = dIn[0] * dOut[0] + dIn[1] * dOut[1];
      const hw = isJ ? Math.max(seg[jk].hw, seg[jk + 1].hw) : seg[jk].hw;
      // A corner is a circular arc. A bundle's inner strands run on arcs of radius (R - their
      // offset), so R has to stay clear of the bundle's half-width or those strands fold over
      // themselves and end in a sharp point. (A quadratic curve's tightest radius is only
      // t*cos(turn/2)/tan(turn/2), which collapses on sharp turns: a 120 degree turn got half of
      // what a 90 degree one did.) `want` is the radius a bundle this wide needs; where the
      // neighbouring points are too close for it, the arc takes what fits (up to ~half of each side).
      const turn = Math.acos(Math.max(-1, Math.min(1, cos))), half = Math.tan(turn / 2);
      const room = 0.48 * Math.min(Math.hypot(P[0] - A[0], P[1] - A[1]), Math.hypot(B[0] - P[0], B[1] - P[1]));
      const t = Math.min((1.25 * hw + 6) * half, room); // how far back from the corner the arc starts
      if (cos > 0.9995 || t < 0.4) {
        line.push(P);
        if (isJ) { jointAt.push(line.length - 1); jk++; }
        continue;
      }
      const R = t / half, k = (4 / 3) * Math.tan(turn / 4) * R; // handles of a cubic that follows a circular arc
      const p0 = [P[0] - dIn[0] * t, P[1] - dIn[1] * t], p3 = [P[0] + dOut[0] * t, P[1] + dOut[1] * t];
      const p1 = [p0[0] + dIn[0] * k, p0[1] + dIn[1] * k], p2 = [p3[0] - dOut[0] * k, p3[1] - dOut[1] * k];
      const N = Math.max(3, Math.min(18, Math.ceil(turn * 18 / Math.PI))); // about every 10 degrees
      for (let q = 0; q <= N; q++) {
        const s = q / N, m = 1 - s, a = m * m * m, b = 3 * m * m * s, c3 = 3 * m * s * s, d = s * s * s;
        line.push([a * p0[0] + b * p1[0] + c3 * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c3 * p2[1] + d * p3[1]]);
        if (isJ && q === (N >> 1)) jointAt.push(line.length - 1);
      }
      if (isJ) jk++;
    }
    line.push(pts[pts.length - 1]);

    const c = cumLen(line), total = c[c.length - 1];
    const D = jointAt.map((j) => c[j]);
    // a width change: the part of the step that keeps the narrower piece inside the wider one
    // happens right at the joint
    const jumps = D.map((d, k) => {
      if (!fit) return 0;
      const a = seg[k], b = seg[k + 1], room = Math.abs(a.h - b.h);
      return Math.max(-room, Math.min(room, b.o - a.o));
    });
    const moves = D.map((d, k) => {
      const delta = seg[k + 1].o - seg[k].o - jumps[k];
      // on the water, where ferry routes fan out from a dock, ease across slowly: a quick step
      // reads as a kink in a long straight crossing
      let L = water ? Math.max(220, 40 * Math.abs(delta), 30 * S) : Math.max(14, 3.4 * Math.abs(delta), 6 * S);
      // strands passing the same junction ease over the same length, so they stay side by side
      if (easeAt) L = Math.max(L, easeAt(steps[k].E.k, steps[k + 1].E.k));
      return { d, delta, L };
    }).filter((m) => Math.abs(m.delta) > 0.02);
    const ds = c.slice();
    for (const m of moves) for (let j = -8; j <= 8; j++) ds.push(m.d + (m.L * j) / 8);
    for (const d of D) ds.push(d);
    ds.sort((a, b) => a - b);
    const dd = [];
    for (const d of ds) if (d >= 0 && d <= total && (!dd.length || d - dd[dd.length - 1] > 0.02)) dd.push(d);
    if (dd.length < 2 || total < 0.5) return; // nothing left to draw (a tiny loop, simplified away)
    const P = sampleAt(line, c, dd);
    const mt = miters(P);

    // Where a corner is tighter than the corridor is wide, its inner strands would run on a circle
    // smaller than their own offset and fold over themselves (ending in a sharp point). So the whole
    // corridor draws a little narrower through such a corner and widens again after it: every strand's
    // offset is scaled together, keeping their order and spacing, and the scale eases in and out over
    // about the corridor's half-width. It depends only on the centerline, so all strands of one
    // corridor narrow in step.
    const hwAt = (d) => {
      let k = 0;
      while (k < D.length && d > D[k]) k++;
      let h = seg[Math.min(k, seg.length - 1)].hw;
      if (k > 0 && d - D[k - 1] < 25) h = Math.max(h, seg[k - 1].hw);
      if (k < D.length && D[k] - d < 25) h = Math.max(h, seg[k + 1].hw);
      return h;
    };
    const nL = line.length, tight = new Float64Array(nL).fill(1), narrow = new Float64Array(nL).fill(1);
    for (let i = 1; i < nL - 1; i++) {
      const ax = line[i][0] - line[i - 1][0], ay = line[i][1] - line[i - 1][1], bx = line[i + 1][0] - line[i][0], by = line[i + 1][1] - line[i][1];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la < 0.5 || lb < 0.5) continue; // closer than the line is accurate: no corner to judge
      const need = hwAt(c[i]) * Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by)) / ((la + lb) / 2); // offset / radius
      if (need > 0.75) tight[i] = Math.max(0.25, 0.75 / need);
    }
    for (let i = 0; i < nL; i++) { // each point takes the tightest squeeze within a half-width either way
      const W = Math.max(hwAt(c[i]), 4);
      let m = tight[i];
      for (let j = i - 1; j >= 0 && c[i] - c[j] <= W; j--) if (tight[j] < m) m = tight[j];
      for (let j = i + 1; j < nL && c[j] - c[i] <= W; j++) if (tight[j] < m) m = tight[j];
      narrow[i] = m;
    }
    const fine = new Float64Array(nL);
    for (let i = 0; i < nL; i++) { // ease the scale in and out: a moving average over half the reach
      const W = Math.max(hwAt(c[i]), 4) / 2;
      let sum = narrow[i], n = 1;
      for (let j = i - 1; j >= 0 && c[i] - c[j] <= W; j--) { sum += narrow[j]; n++; }
      for (let j = i + 1; j < nL && c[j] - c[i] <= W; j++) { sum += narrow[j]; n++; }
      fine[i] = sum / n;
    }
    let pi = 0;
    const Fd = dd.map((d) => {
      while (pi < nL - 2 && c[pi + 1] < d) pi++;
      const span = c[pi + 1] - c[pi], t = span > 1e-9 ? Math.min(1, Math.max(0, (d - c[pi]) / span)) : 0;
      return fine[pi] + (fine[pi + 1] - fine[pi]) * t;
    });

    const off = (d) => {
      let o = seg[0].o;
      for (const m of moves) {
        const t = (d - (m.d - m.L)) / (2 * m.L);
        if (t >= 1) o += m.delta;
        else if (t > 0) o += m.delta * t * t * (3 - 2 * t);
      }
      for (let k = 0; k < D.length; k++) if (jumps[k] && d > D[k] + 0.01) o += jumps[k];
      return o;
    };
    const Q = dd.map((d, j) => { const o = off(d) * Fd[j]; return [P[j][0] + mt[j][0] * o, P[j][1] + mt[j][1] * o]; });

    let from = 0;
    const cuts = D.map((d) => { let b = from; while (b < dd.length - 1 && dd[b] < d - 0.01) b++; from = b; return b; });
    cuts.push(dd.length - 1);
    let start = 0;
    cuts.forEach((end, s) => {
      // a piece after a width change starts already inside its new lane
      let q0 = Q[start];
      if (s > 0 && jumps[s - 1]) { const o = (off(dd[start]) + jumps[s - 1]) * Fd[start]; q0 = [P[start][0] + mt[start][0] * o, P[start][1] + mt[start][1] * o]; }
      const piece = [q0];
      for (let j = start + 1; j <= end; j++) {
        const a = piece[piece.length - 1];
        const fwd = (Q[j][0] - a[0]) * (P[j][0] - P[j - 1][0]) + (Q[j][1] - a[1]) * (P[j][1] - P[j - 1][1]);
        if (fwd > 0) piece.push(Q[j]);
        else if (j === end && piece.length > 0) {
          const dir = [P[j][0] - P[j - 1][0], P[j][1] - P[j - 1][1]];
          const L = Math.hypot(dir[0], dir[1]) || 1;
          const u = [dir[0] / L, dir[1] / L];
          const dot = (Q[j][0] - a[0]) * u[0] + (Q[j][1] - a[1]) * u[1];
          if (dot <= 0) piece.push([a[0] + u[0] * 0.05, a[1] + u[1] * 0.05]);
          else piece.push(Q[j]);
        }
      }
      const isLoop = steps[s].E.a === steps[s].E.b;
      if (isLoop && piece.length >= 3) piece.push(piece[0]);
      const clean = water || isLoop ? piece : clipSmallLoops(piece, Math.max(12, Math.min(160, 4 * seg[s].hw)));
      // Offset easing adds many points along straight stretches. Retain subpixel accuracy
      // without sending every sample to the renderer and map's tile workers.
      emit(s, simplify(clean, 0.1 * S));
      start = end;
    });
  }

  // The network as street segments (meters). Each knows its routes, its service types ("keys")
  // and the left-to-right order of those types along a->b. Shared with the page for hit tests.
  function prepEdges(edges, lines) {
    return edges.map((e, k) => {
      const g0 = lines[e.l[0]].group;
      const layer = g0 === "rail" ? "r" : g0 === "water" ? "w" : "s";
      const key = (c) => `${layer}${c[0]},${c[1]}`;
      const byKey = new Map(), sum = new Map();
      e.l.forEach((i, idx) => {
        const v = VKEY(lines[i].cat);
        if (!byKey.has(v)) { byKey.set(v, []); sum.set(v, 0); }
        byKey.get(v).push(i);
        sum.set(v, sum.get(v) + idx);
      });
      const order = [...byKey.keys()].sort((a, b) => sum.get(a) / byKey.get(a).length - sum.get(b) / byKey.get(b).length);
      // direction of travel: per line (1 along c, 2 against, 0 both ways), and per service type
      // when every route of that type on the segment goes the same single way
      const dirOf = (i) => (e.d ? e.d[e.l.indexOf(i)] || 0 : 0);
      const kdir = new Map();
      for (const [v, list] of byKey) { const d0 = dirOf(list[0]); kdir.set(v, d0 && list.every((i) => dirOf(i) === d0) ? d0 : 0); }
      return { k, layer, c: e.c, l: e.l, byKey, order, kdir, dirOf, a: key(e.c[0]), b: key(e.c[e.c.length - 1]) };
    });
  }

  function createEngine(init) {
    const CAT = init.cat, GAP = init.gap, LINES = init.lines;
    const group = (cat) => CAT[VKEY(cat)].group;
    const lines = LINES.map((r) => ({ ...r, group: group(r.cat) }));
    const EDGES = prepEdges(init.edges, lines);
    for (const E of EDGES) {
      const pts = E.c.map(([lon, lat]) => toM(lon, lat));
      E.pts = pts;
      E.len = pts.reduce((acc, p, j) => (j ? acc + Math.hypot(p[0] - pts[j - 1][0], p[1] - pts[j - 1][1]) : 0), 0);
      const bb = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [x, y] of pts) { if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (x > bb[2]) bb[2] = x; if (y > bb[3]) bb[3] = y; }
      E.bb = bb;
      E.simp = new Map();
    }
    // continuous paths for every corridor key and every route (static, done once)
    const byKey = new Map();
    for (const E of EDGES) for (const v of E.byKey.keys()) { if (!byKey.has(v)) byKey.set(v, []); byKey.get(v).push(E); }
    const KEY_CHAINS = new Map([...byKey].map(([v, edges]) => [v, chainsFor(edges)]));
    const byLine = LINES.map(() => []);
    for (const E of EDGES) for (const i of E.l) byLine[i].push(E);
    const ROUTE_CHAINS = byLine.map((edges) => chainsFor(edges, true));
    // where each route passes from one street segment to the next (for keeping its lane)
    const ROUTE_PAIRS = [];
    ROUTE_CHAINS.forEach((chains, i) => {
      for (const ch of chains) for (let k = 0; k + 1 < ch.length; k++) {
        if (ch[k].E !== ch[k + 1].E) ROUTE_PAIRS.push([i, ch[k].E.k, ch[k].fwd ? 1 : -1, ch[k + 1].E.k, ch[k + 1].fwd ? 1 : -1]);
      }
    });
    // Within each street's line of one service type, order the routes to match the streets they
    // come from and go on to, so their strands cross each other as little as possible (the order
    // the network was built with can disagree from one block to the next where routes join and
    // leave, and every disagreement is two strands swapping sides).
    const CONT = EDGES.map(() => []); // per segment: { i, F, f } — route i carries on into F; f relates the two sides
    for (const [i, e1, s1, e2, s2] of ROUTE_PAIRS) { CONT[e1].push({ i, F: e2, f: s1 * s2 }); CONT[e2].push({ i, F: e1, f: s1 * s2 }); }
    const keyOf = (i) => VKEY(LINES[i].cat);
    const xOf = (E, i) => { const list = E.byKey.get(keyOf(i)), j = list.indexOf(i); return j - (list.length - 1) / 2; };
    function swaps() {
      let n = 0;
      for (const E of EDGES) {
        const by = new Map(); // routes going on into the same segment the same way
        for (const c of CONT[E.k]) { const k = `${c.F}|${c.f}|${keyOf(c.i)}`; if (!by.has(k)) by.set(k, []); by.get(k).push(c); }
        for (const list of by.values()) {
          for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
            const p = list[a], q = list[b], F = EDGES[p.F];
            if ((xOf(E, p.i) - xOf(E, q.i)) * p.f * (xOf(F, p.i) - xOf(F, q.i)) < 0) n++;
          }
        }
      }
      return n / 2;
    }
    const before = swaps();
    let best = before, snap = EDGES.map((E) => new Map([...E.byKey].map(([v, l]) => [v, l.slice()])));
    for (let pass = 0; pass < 8 && best > 0; pass++) {
      for (const E of EDGES) {
        for (const [v, list] of E.byKey) {
          if (list.length < 2) continue;
          const want = new Map();
          for (const i of list) {
            const cs = CONT[E.k].filter((c) => c.i === i);
            want.set(i, cs.length ? cs.reduce((acc, c) => acc + c.f * xOf(EDGES[c.F], i), 0) / cs.length : xOf(E, i));
          }
          const cur = new Map(list.map((i, j) => [i, j]));
          list.sort((a, b) => (want.get(a) - want.get(b)) || (cur.get(a) - cur.get(b)));
        }
      }
      const n = swaps();
      if (n < best) { best = n; snap = EDGES.map((E) => new Map([...E.byKey].map(([v, l]) => [v, l.slice()]))); }
    }
    EDGES.forEach((E, k) => { for (const [v, l] of snap[k]) E.byKey.set(v, l); });
    // Averages can put a route between two neighbors it crosses at both ends. Minimize
    // actual inversions instead: move a strand only when the total at its joins falls.
    // Alternating direction avoids favoring whichever end was visited first.
    for (let pass = 0; pass < 16; pass++) {
      let changed = false;
      const scan = pass % 2 ? EDGES.slice().reverse() : EDGES;
      for (const E of scan) for (const [v, list] of E.byKey) {
        if (list.length < 2) continue;
        const votes = new Map(list.map((i) => [i, new Map()]));
        const groups = new Map();
        for (const c of CONT[E.k]) {
          if (keyOf(c.i) !== v) continue;
          const k = `${c.F}|${c.f}`;
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(c);
        }
        for (const cs of groups.values()) for (const a of cs) for (const b of cs) {
          if (a.i !== b.i && a.f * (xOf(EDGES[a.F], a.i) - xOf(EDGES[a.F], b.i)) > 0)
            votes.get(a.i).set(b.i, (votes.get(a.i).get(b.i) || 0) + 1);
        }
        for (let j = 0; j < list.length; j++) {
          const i = list[j], rest = list.filter((r) => r !== i);
          const costs = [rest.reduce((n, r) => n + (votes.get(i).get(r) || 0), 0)];
          for (const r of rest) costs.push(costs[costs.length - 1] - (votes.get(i).get(r) || 0) + (votes.get(r).get(i) || 0));
          let at = j;
          for (let q = 0; q < costs.length; q++) if (costs[q] < costs[at]) at = q;
          if (at !== j) { list.splice(j, 1); list.splice(at, 0, i); changed = true; }
        }
      }
      if (!changed) break;
    }
    // Carry an adjacent pair along its whole shared stretch before considering a swap.
    // Otherwise a long corridor can trap one crossing at each end: moving it one block
    // costs the same, so a strictly local optimizer can never remove the pair together.
    const pairLinks = EDGES.map(() => new Map());
    for (const E of EDGES) {
      const groups = new Map();
      for (const c of CONT[E.k]) {
        const k = `${c.F}|${c.f}|${keyOf(c.i)}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(c);
      }
      for (const cs of groups.values()) for (let a = 0; a < cs.length; a++) for (let b = a + 1; b < cs.length; b++) {
        const A = cs[a].i, B = cs[b].i, key = A < B ? `${A}|${B}` : `${B}|${A}`;
        if (!pairLinks[E.k].has(key)) pairLinks[E.k].set(key, []);
        pairLinks[E.k].get(key).push(cs[a]);
      }
    }
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      const seen = new Set();
      for (const E of EDGES) for (const list of E.byKey.values()) for (let j = 1; j < list.length; j++) {
        const A = Math.min(list[j - 1], list[j]), B = Math.max(list[j - 1], list[j]), key = `${A}|${B}`;
        if (seen.has(`${E.k}:${key}`)) continue;
        const todo = [E.k], comp = new Set(todo);
        for (let q = 0; q < todo.length; q++) {
          const e = todo[q], d = xOf(EDGES[e], A) - xOf(EDGES[e], B);
          seen.add(`${e}:${key}`);
          for (const c of pairLinks[e].get(key) || []) {
            const fd = xOf(EDGES[c.F], A) - xOf(EDGES[c.F], B);
            if (Math.abs(fd) === 1 && d * c.f * fd > 0 && !comp.has(c.F)) { comp.add(c.F); todo.push(c.F); }
          }
        }
        let delta = 0;
        for (const e of comp) for (const c of pairLinks[e].get(key) || []) if (!comp.has(c.F))
          delta += (xOf(EDGES[e], A) - xOf(EDGES[e], B)) * c.f * (xOf(EDGES[c.F], A) - xOf(EDGES[c.F], B)) < 0 ? -1 : 1;
        if (delta < 0) {
          for (const e of comp) {
            const l = EDGES[e].byKey.get(keyOf(A)), a = l.indexOf(A), b = l.indexOf(B);
            [l[a], l[b]] = [l[b], l[a]];
          }
          changed = true;
        }
      }
      if (!changed) break;
    }
    best = swaps();
    const strandStats = { before, after: best };

    const runsIn = (lay, steps, key) => {
      const out = [];
      let cur = [];
      for (const st of steps) {
        const Lo = lay[st.E.k];
        if (Lo && (typeof key === "number" ? Lo.sp.has(key) : Lo.pos.has(key))) cur.push(st);
        else if (cur.length) { out.push(cur); cur = []; }
      }
      if (cur.length) out.push(cur);
      return out;
    };
    let last = null; // the last view's layout, for routePath
    const tagOrder = (a, b) => (CAT[VKEY(LINES[a].cat)].prio - CAT[VKEY(LINES[b].cat)].prio) || (LINES[a].rank - LINES[b].rank);
    const HMODE = { glass: 1, solid: 2, dots: 3, ties: 4 };
    // one-way arrows: +1 points along the drawn line, -1 against it, 0 none (two-way)
    const arrow = (dir, fwd) => (!dir ? 0 : (dir === 1) === fwd ? 1 : -1);
    // A shared street is one readable band, growing gently with the number of routes.
    const GROW = (n) => Math.min(2.6, 1 + 0.4 * Math.log2(Math.max(1, n)));

    // One view. p: { z (zoom step), zNow, u (px per line unit), capU, keyOn {key: bool}, selIdx, routeFilter,
    //   view [x0, y0, x1, y1] in meters, tags { gap, every, busZ }, theme ("l"/"d"), colors {key: css} }
    function build(p) {
      // z: the zoom the lanes are laid out for (follows the map closely while it zooms); zs: its
      // quarter step, for what should stay put while zooming (simplified shapes, tag spacing)
      const { z, zNow, u, capU, keyOn, selIdx, routeFilter } = p, zs = p.zs != null ? p.zs : z;
      const filterSet = routeFilter && routeFilter.length ? new Set(routeFilter) : null;
      // every feature carries zu: pixels per line unit at zoom 0 for this layout, so the map can
      // size lines from the same zoom their lanes were laid out for (no gaps opening between them
      // while you zoom, before the next layout arrives)
      const zu = u / 2 ** z;
      const S = u * MPP0 / 2 ** z; // meters per unit at this zoom
      // line width per service type; all-day and rush-hour buses are drawn slimmer when zoomed out
      const W = (v) => CAT[v].w * ((p.wscale && p.wscale[v]) || 1);
      const selKey = selIdx >= 0 ? dkey(LINES[selIdx]) : null;
      const color = (key) => p.colors[key] || p.colors.local;

      // 1. each segment in (or near) view: which corridors show, their lanes and squeeze
      const V = p.view;
      const lay = new Array(EDGES.length);
      const mpp = MPP0 / 2 ** zs;
      for (const E of EDGES) {
        if (E.bb[2] < V[0] || E.bb[0] > V[2] || E.bb[3] < V[1] || E.bb[1] > V[3]) { lay[E.k] = null; continue; }
        const hasRoute = (v) => {
          if (!filterSet) return true;
          const list = E.byKey.get(v);
          return list && list.some((i) => filterSet.has(i));
        };
        const keys = E.order.filter((v) => (keyOn[v] && hasRoute(v)) || (v === selKey && E.l.includes(selIdx)));
        if (!keys.length) { lay[E.k] = null; continue; }
        // routes of each corridor here, in lane order (only the selected one when its type is hidden)
        const rl = new Map(keys.map((v) => {
          let list = keyOn[v] ? (E.byKey.get(v) || []) : [selIdx];
          if (filterSet) list = list.filter((i) => filterSet.has(i) || i === selIdx);
          if (!list.length && v === selKey && E.l.includes(selIdx)) list = [selIdx];
          return [v, list];
        }));
        // how wide each corridor is: a street line grows with the number of routes on it (two
        // routes, twice as wide; then more slowly), each route a strand of it. Trains sharing
        // track are one line split lengthwise (1 Line green on one half, 2 Line blue on the other).
        const nLink = keys.filter((v) => CAT[v].base === "link").length;
        const wk = new Map(keys.map((v) => {
          const c = CAT[v];
          // (the shared line is a little bolder than one Link line, so both halves read)
          if (c.base === "link") return [v, nLink > 1 ? W(v) * 1.3 / nLink : W(v)];
          return [v, c.group === "bus" || c.group === "rapid" ? W(v) * GROW(rl.get(v).length) : W(v)];
        }));
        let T = -GAP;
        for (const v of keys) T += wk.get(v) + GAP;
        const s = Math.min(1, capU / T);
        const pos = new Map(), sp = new Map(), sw = new Map();
        let x = -T / 2;
        // boats: no side-by-side lanes; ferry routes only meet at the docks, where shifting
        // lanes would put little kinks into otherwise straight crossings
        for (const v of keys) {
          const w = wk.get(v), list = rl.get(v), n = list.length;
          pos.set(v, E.layer === "w" ? 0 : (x + w / 2) * s);
          // each route's strand inside its corridor (Link lines: the whole half that is theirs)
          const own = CAT[v].base === "link" ? 1 : n;
          list.forEach((i, j) => { sp.set(i, E.layer === "w" ? 0 : (x + (own === 1 ? w / 2 : (j + 0.5) * w / n)) * s); sw.set(i, (own === 1 ? w : w / n) * s); });
          x += w + GAP;
        }
        const tol = 1.0 * mpp;
        const ck = `${zs}`;
        let simp = E.simp.get(ck);
        if (!simp) { simp = simplify(E.pts, tol); E.simp.set(ck, simp); }
        lay[E.k] = { keys, s, T: T * s, pos, shift: 0, simp, wk, rl, sp, sw };
      }
      const runs = (steps, key) => runsIn(lay, steps, key);

      // 2. slide whole bundles sideways so every route keeps its place through junctions: a
      //    corridor carries on in line, and where it splits each branch carries on from its own
      //    side of the wider line
      const cons = [], byEdge = new Map();
      for (const [i, e1, s1, e2, s2] of ROUTE_PAIRS) {
        if (filterSet && !filterSet.has(i) && i !== selIdx) continue;
        const A = lay[e1], B = lay[e2];
        if (!A || !B || !A.sp.has(i) || !B.sp.has(i)) continue;
        const v = VKEY(LINES[i].cat);
        const w = 1 / Math.min(A.rl.get(v).length, B.rl.get(v).length);
        const n = cons.push([i, e1, s1, e2, s2, w]) - 1;
        for (const e of [e1, e2]) { if (!byEdge.has(e)) byEdge.set(e, []); byEdge.get(e).push(n); }
      }
      for (let it = 0; it < 30; it++) {
        for (const [e, list] of byEdge) {
          const Le = lay[e];
          let num = 0, den = 0.35 * Le.keys.length;
          for (const n of list) {
            const [i, e1, s1, e2, s2, w] = cons[n];
            const [o, so, se] = e1 === e ? [e2, s2, s1] : [e1, s1, s2];
            num += w * (se * so * (lay[o].sp.get(i) + lay[o].shift) - Le.sp.get(i));
            den += w;
          }
          const lim = 0.3 * Le.T + 0.5;
          Le.shift = EDGES[e].layer === "w" ? 0 : Math.max(-lim, Math.min(lim, num / den));
        }
      }

      // one ease length per junction: long enough for the biggest lane change of any route there
      const easeLen = new Map();
      const ek = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
      for (const [i, e1, s1, e2, s2] of cons) {
        const d = Math.abs(s2 * (lay[e2].sp.get(i) + lay[e2].shift) - s1 * (lay[e1].sp.get(i) + lay[e1].shift)) * S;
        const key = ek(e1, e2), L = Math.max(14, 3.4 * d, 6 * S);
        if (!(easeLen.get(key) >= L)) easeLen.set(key, L);
      }
      const easeAt = (a, b) => easeLen.get(ek(a, b)) || 0;

      // 3. draw corridors, and the selected route on top
      const feats = [], selFeats = [];
      // One solid band per service type on a street. Individual route lanes are retained
      // for the selected/previewed route, instead of drawing dozens of hairlines at once.
      const hrOf = (c) => (c.inner === "glass" ? 0.34 : c.inner === "solid" ? 0.3 : c.inner === "dots" ? 0.32 : c.inner === "ties" ? 0.62 : 0);
      const keyLane = (v) => (Lo) => [Lo.pos.get(v), Lo.wk.get(v) * Lo.s / 2];
      for (const [v, chains] of KEY_CHAINS) {
        const c = CAT[v];
        if (!keyOn[v]) continue;
        const water = c.group === "water";
        for (const ch of chains) {
          for (const run of runs(ch, v)) {
            drawPath(keyLane(v), run, lay, S, (k, coords) => {
              if (coords.length < 2) return;
              const st = run[k], Lo = lay[st.E.k], w = Lo.wk.get(v) * Lo.s;
              feats.push({ type: "Feature", properties: { r: -1, cat: v, e: st.E.k, zu,
                wm: w + 0.14 * Lo.s, cm: w + 0.55 * Lo.s,
                hm: water || c.inner === "glass" && Lo.rl.get(v).length > 1 ? 0 : w * hrOf(c),
                sh: water ? 0 : w + 0.55 * Lo.s, ws: w * S, n: Lo.rl.get(v).length,
                g: c.group, c: color(v), s: 20 - c.prio, d: c.dash ? 1 : 0, h: HMODE[c.inner] || 0,
                ar: water ? 0 : arrow(st.E.kdir.get(v), st.fwd) },
                geometry: { type: "LineString", coordinates: coords.map(toLL) } });
            }, water, !water, easeAt);
          }
        }
      }
      // one route, in its own strand
      const strand = (i) => (Lo) => [Lo.sp.get(i), Lo.sw.get(i) / 2];
      if (selIdx >= 0) {
        const c = CAT[selKey], col = color(selKey);
        for (const ch of ROUTE_CHAINS[selIdx]) {
          for (const run of runs(ch, selIdx)) {
            drawPath(strand(selIdx), run, lay, S, (k, coords) => {
              if (coords.length < 2) return;
              selFeats.push({ type: "Feature", properties: { r: selIdx, cat: selKey, e: run[k].E.k, zu, c: col, d: c.dash ? 1 : 0, ar: c.group === "water" ? 0 : arrow(run[k].E.dirOf(selIdx), run[k].fwd),
                wm: c.w + 1.8, cm: c.w + 3.4, gm: c.w + 8, hm: (c.w + 1.8) * 0.3 },
              geometry: { type: "LineString", coordinates: coords.map(toLL) } });
            }, c.group === "water", false, easeAt);
          }
        }
      }
      last = { lay, S, z, W, easeAt, zu, colors: p.colors };

      // 4. route-number tags. Connected blocks carrying the same routes form one stretch; a
      //    stretch gets one tag (on its longest block), plus repeats along long blocks, and the
      //    same set of numbers never repeats close to itself.
      const TD = p.tags;
      const labelKey = (v) => CAT[v].group !== "bus" || zNow >= TD.busZ;
      const labels = [], selLabels = [];
      const tagKey = new Map();
      for (const E of EDGES) {
        const Lo = lay[E.k];
        if (!Lo || Lo.collapsed) continue;
        const rs = [];
        for (const v of Lo.keys) {
          if (labelKey(v) && keyOn[v]) {
            for (const i of (Lo.rl.get(v) || [])) {
              if (!filterSet || filterSet.has(i) || i === selIdx) rs.push(i);
            }
          }
        }
        if (!rs.length) continue;
        rs.sort(tagOrder);
        tagKey.set(E.k, { k: `${p.theme}:${rs.join(".")}`, p: CAT[VKEY(LINES[rs[0]].cat)].prio, rs });
      }
      const parent = new Map();
      const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
      const firstAt = new Map();
      for (const [e, t] of tagKey) {
        parent.set(e, e);
        for (const node of [EDGES[e].a, EDGES[e].b]) {
          const key = `${node}|${t.k}`;
          if (firstAt.has(key)) parent.set(find(e), find(firstAt.get(key))); else firstAt.set(key, e);
        }
      }
      const best = new Map();
      for (const e of tagKey.keys()) { const root = find(e); if (!best.has(root) || EDGES[e].len > EDGES[best.get(root)].len) best.set(root, e); }
      const minGap = TD.gap * mpp, every = TD.every * mpp;
      const anyGap = (TD.any || 0) * mpp, cell = Math.max(anyGap, 1), grid = new Map();
      const crowded = (q) => {
        if (!anyGap) return false;
        const gx = Math.floor(q[0] / cell), gy = Math.floor(q[1] / cell);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          for (const o of grid.get(`${gx + dx},${gy + dy}`) || []) if (Math.hypot(o[0] - q[0], o[1] - q[1]) < anyGap) return true;
        }
        return false;
      };
      const remember = (q) => { const key = `${Math.floor(q[0] / cell)},${Math.floor(q[1] / cell)}`; if (!grid.has(key)) grid.set(key, []); grid.get(key).push(q); };
      const placed = new Map();
      // trains, RapidRide and frequent buses claim their space first, then longer stretches first
      const cands = [...tagKey].filter(([e]) => best.get(find(e)) === e || EDGES[e].len >= 700)
        .sort((x, y) => (x[1].p - y[1].p) || (EDGES[y[0]].len - EDGES[x[0]].len));
      for (const [e, t] of cands) {
        const E = EDGES[e];
        const cum = E.cum || (E.cum = cumLen(E.pts));
        const near = placed.get(t.k) || [];
        placed.set(t.k, near);
        const n = Math.max(1, Math.floor(E.len / every));
        const order = [...Array(n).keys()].sort((i, j) => Math.abs(i - (n - 1) / 2) - Math.abs(j - (n - 1) / 2));
        for (const i of order) {
          const d = E.len * (i + 0.5) / n, q = pointAt(E.pts, cum, d);
          if (near.some((o) => Math.hypot(o[0] - q[0], o[1] - q[1]) < minGap) || crowded(q)) continue;
          near.push(q);
          remember(q);
          // the numbers read in the same order as the lines they sit on: left to right across
          // a north-south street, top to bottom across an east-west one
          const q1 = pointAt(E.pts, cum, Math.max(0, d - 10)), q2 = pointAt(E.pts, cum, Math.min(E.len, d + 10));
          const dx = q2[0] - q1[0], dy = q2[1] - q1[1], L = Math.hypot(dx, dy) || 1, nx = dy / L, ny = -dx / L;
          const Lo = lay[e], vertical = Math.abs(dy) >= Math.abs(dx);
          const side = (i) => { const o = Lo.sp.has(i) ? Lo.sp.get(i) : 0; return vertical ? nx * o : -ny * o; };
          const ordered = t.rs.slice().sort((a, b) => (side(a) - side(b)) || tagOrder(a, b));
          // Keep the badges themselves upright.  A vertical corridor receives a
          // stacked/grid badge sprite so parallel services do not form a long
          // horizontal bar across the road.
          labels.push({ type: "Feature", properties: { k: `${p.theme}:${ordered.join(".")}:${vertical ? "v" : "h"}`, p: t.p }, geometry: { type: "Point", coordinates: toLL(q) } });
        }
      }
      // the selected route's own tag: along its whole path about every 550 px, never two within ~380 px
      if (selIdx >= 0) {
        const gap = Math.max(760, TD.gap * 1.3) * mpp, step = Math.max(900, TD.every) * mpp, pts = [];
        for (const E of EDGES.filter((x) => x.l.includes(selIdx)).sort((a, b) => b.len - a.len)) {
          const cum = E.cum || (E.cum = cumLen(E.pts));
          const n = Math.max(1, Math.floor(E.len / step));
          for (let i = 0; i < n; i++) {
            const q = pointAt(E.pts, cum, E.len * (i + 0.5) / n);
            if (pts.some((o) => Math.hypot(o[0] - q[0], o[1] - q[1]) < gap)) continue;
            pts.push(q);
            selLabels.push({ type: "Feature", properties: { k: `${p.theme}:${selIdx}` }, geometry: { type: "Point", coordinates: toLL(q) } });
          }
        }
      }
      return { feats, selFeats, labels, selLabels, selIdx, zs };
    }
    // Paths of routes in the last view, in their lanes, exactly over their corridor lines (for
    // hover previews).
    function routePaths(idxs) {
      if (!last) return [];
      const { lay, S, W, easeAt, zu, colors } = last, out = [];
      for (const idx of idxs) {
        if (!LINES[idx]) continue;
        const v = dkey(LINES[idx]), c = CAT[v] || CAT.link;
        // drawn as one line of its type would be, centered on its own strand
        const wide = c.group === "bus" || c.group === "rapid";
        for (const ch of ROUTE_CHAINS[idx]) {
          for (const run of runsIn(lay, ch, idx)) {
            drawPath((Lo) => [Lo.sp.get(idx), Lo.sw.get(idx) / 2], run, lay, S, (k, coords) => {
              if (coords.length < 2) return;
              const Lo = lay[run[k].E.k], w = wide ? Math.min(Lo.wk.get(v), W(v)) * Lo.s : Lo.sw.get(idx);
              out.push({ type: "Feature", properties: { r: idx, cat: v, e: run[k].E.k, zu, c: colors[v] || colors.link || colors.local, d: c.dash ? 1 : 0,
                ar: c.group === "water" ? 0 : arrow(run[k].E.dirOf(idx), run[k].fwd), wm: w + 0.14, cm: w + 0.55, gm: w + 2.8 },
              geometry: { type: "LineString", coordinates: coords.map(toLL) } });
            }, c.group === "water", false, easeAt);
          }
        }
      }
      return out;
    }
    const routePath = (idx) => routePaths([idx]);
    return { build, routePath, routePaths, strandStats };
  }

  return { LAT0, LON0, KX, KY, MPP0, toM, toLL, VKEY, cumLen, prepEdges, createEngine };
})();

// In a worker: answer the page's messages ("init" once, then "build" per view).
if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  let engine = null, buildId = 0;
  self.onmessage = (e) => {
    const m = e.data;
    if (m.type === "init") {
      if (m.ribbonsURL) importScripts(m.ribbonsURL);
      engine = KCTMGeom.createEngine(m.init);
      self.postMessage({ type: "ready" });
    } else if (m.type === "route" && engine) {
      const feats = engine.routePaths(m.idxs);
      const mesh = typeof KCTMRibbons !== "undefined" ? KCTMRibbons.compile(feats, { hover: true, widthScale: 1.65 }) : null;
      self.postMessage({ type: "route", id: m.id, buildId, feats, mesh }, mesh ? mesh.map((b) => b.data.buffer) : []);
    } else if (m.type === "build" && engine) {
      const t = Date.now();
      const out = engine.build(m.p);
      buildId = m.id;
      const mesh = typeof KCTMRibbons !== "undefined" ? KCTMRibbons.compile(out.feats) : null;
      const selMesh = typeof KCTMRibbons !== "undefined" ? KCTMRibbons.compile(out.selFeats, { selected: true }) : null;
      const transfer = [...(mesh || []), ...(selMesh || [])].map((b) => b.data.buffer);
      self.postMessage({ type: "built", id: m.id, ms: Date.now() - t, ...out, mesh, selMesh }, transfer);
    }
  };
}
