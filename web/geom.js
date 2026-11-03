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
  const MPP0 = 156543.03392 * Math.cos(LAT0 * Math.PI / 180); // meters per pixel at zoom 0
  const toM = (lon, lat) => [(lon - LON0) * KX, (lat - LAT0) * KY];
  const toLL = (p) => [Math.round((LON0 + p[0] / KX) * 1e6) / 1e6, Math.round((LAT0 + p[1] / KY) * 1e6) / 1e6];
  const VKEY = (cat) => (cat === "amtrak" ? "sounder" : cat); // Amtrak shares Sounder's tracks and line

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

  function chainsFor(edges) {
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
        if (used.has(i) || used.has(j) || d > 0.8 || (list.length > 2 && d > 0.3)) continue;
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

  // One continuous path along `steps`, sitting in lane `key` of each segment. Corners are
  // rounded to suit the bundle width; lane changes are eased steps that may overlap, so a
  // line crossing a busy street glides across instead of jogging. Calls emit(stepIndex, coords).
  // Simplify a run's centerline across its junctions (schematic: small jogs and hooks go),
  // keeping every junction as a vertex but moved onto the simplified line, so lane changes
  // still happen at the right place.
  function simplifyRun(pts, joints, tol) {
    if (pts.length < 3 || tol <= 0) return [pts, joints];
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
    const jset = new Set(joints), out = [], newJ = [];
    let prevKept = 0;
    const nextKept = (i) => { let j = i + 1; while (!keep[j]) j++; return j; };
    for (let i = 0; i < pts.length; i++) {
      if (keep[i]) { out.push(pts[i]); prevKept = i; if (jset.has(i)) newJ.push(out.length - 1); continue; }
      if (!jset.has(i)) continue;
      // a junction dropped by the simplification: put it back, on the simplified line
      const a = pts[prevKept], b = pts[nextKept(i)], q = pts[i];
      const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2));
      out.push([a[0] + t * dx, a[1] + t * dy]);
      newJ.push(out.length - 1);
    }
    return [out, newJ];
  }

  function drawPath(key, steps, lay, S, emit, water = false, schematic = 0, center = false) {
    let pts = [], seg = [], joints = [];
    for (let k = 0; k < steps.length; k++) {
      const { E, fwd } = steps[k], Lo = lay[E.k];
      let g = fwd ? Lo.simp : Lo.simp.slice().reverse();
      if (k > 0) { joints.push(pts.length - 1); g = g.slice(1); }
      for (const q of g) pts.push(q);
      // center: a highlighted route runs down the middle of its street (no lanes, so no lane
      // changes to jog through)
      seg.push({ o: center ? 0 : (fwd ? 1 : -1) * (Lo.pos.get(key) + Lo.shift) * S, hw: (Lo.T / 2 + Math.abs(Lo.shift)) * S });
    }
    if (pts.length < 2) return;
    if (schematic > 0) [pts, joints] = simplifyRun(pts, joints, schematic);

    const line = [pts[0]], jointAt = [];
    let jk = 0;
    for (let v = 1; v < pts.length - 1; v++) {
      const P = pts[v], A = pts[v - 1], B = pts[v + 1];
      const isJ = joints[jk] === v;
      const dIn = unitVec(A, P), dOut = unitVec(P, B);
      const cos = dIn[0] * dOut[0] + dIn[1] * dOut[1];
      const hw = isJ ? Math.max(seg[jk].hw, seg[jk + 1].hw) : seg[jk].hw;
      const r = Math.min(1.5 * hw + 5, 0.48 * Math.hypot(P[0] - A[0], P[1] - A[1]), 0.48 * Math.hypot(B[0] - P[0], B[1] - P[1]));
      if (cos > 0.9995 || r < 0.4) {
        line.push(P);
        if (isJ) { jointAt.push(line.length - 1); jk++; }
        continue;
      }
      const p0 = [P[0] - dIn[0] * r, P[1] - dIn[1] * r], p2 = [P[0] + dOut[0] * r, P[1] + dOut[1] * r];
      const N = cos > 0.8 ? 4 : 8;
      for (let q = 0; q <= N; q++) {
        const t = q / N, m = 1 - t;
        line.push([m * m * p0[0] + 2 * m * t * P[0] + t * t * p2[0], m * m * p0[1] + 2 * m * t * P[1] + t * t * p2[1]]);
        if (isJ && q === N / 2) jointAt.push(line.length - 1);
      }
      if (isJ) jk++;
    }
    line.push(pts[pts.length - 1]);

    const c = cumLen(line), total = c[c.length - 1];
    const D = jointAt.map((j) => c[j]);
    const moves = D.map((d, k) => {
      const delta = seg[k + 1].o - seg[k].o;
      // on the water, where ferry routes fan out from a dock, ease across slowly: a quick step
      // reads as a kink in a long straight crossing
      const L = water ? Math.max(220, 40 * Math.abs(delta), 30 * S) : Math.max(14, 3.4 * Math.abs(delta), 6 * S);
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
    const Q = dd.map((d, j) => {
      let o = seg[0].o;
      for (const m of moves) {
        const t = (d - (m.d - m.L)) / (2 * m.L);
        if (t >= 1) o += m.delta;
        else if (t > 0) o += m.delta * t * t * (3 - 2 * t);
      }
      return [P[j][0] + mt[j][0] * o, P[j][1] + mt[j][1] * o];
    });

    let from = 0;
    const cuts = D.map((d) => { let b = from; while (b < dd.length - 1 && dd[b] < d - 0.01) b++; from = b; return b; });
    cuts.push(dd.length - 1);
    let start = 0;
    cuts.forEach((end, s) => {
      const piece = [Q[start]];
      for (let j = start + 1; j <= end; j++) {
        const a = piece[piece.length - 1];
        const fwd = (Q[j][0] - a[0]) * (P[j][0] - P[j - 1][0]) + (Q[j][1] - a[1]) * (P[j][1] - P[j - 1][1]);
        if (fwd > 0 || j === end) piece.push(Q[j]);
      }
      emit(s, piece);
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
    const ROUTE_CHAINS = byLine.map((edges) => chainsFor(edges));
    const runsIn = (lay, steps, key) => {
      const out = [];
      let cur = [];
      for (const st of steps) {
        const Lo = lay[st.E.k];
        if (Lo && Lo.pos.has(key)) cur.push(st);
        else if (cur.length) { out.push(cur); cur = []; }
      }
      if (cur.length) out.push(cur);
      return out;
    };
    // physical lane point of corridor `v` on edge F at its end node n (meters)
    const lanePoint = (lay, F, n, v, S, ahead = 0) => {
      const Lo = lay[F.k], q = atAOrder(Lo.simp, F.a === n);
      // walk `ahead` meters into F from node n
      let i = 0, left = ahead, p = q[0];
      while (i < q.length - 1) {
        const d = Math.hypot(q[i + 1][0] - q[i][0], q[i + 1][1] - q[i][1]);
        if (d >= left) { const t = d ? left / d : 0; p = [q[i][0] + t * (q[i + 1][0] - q[i][0]), q[i][1] + t * (q[i + 1][1] - q[i][1])]; break; }
        left -= d; i++; p = q[i];
      }
      const a = q[Math.min(i, q.length - 2)], b = q[Math.min(i, q.length - 2) + 1];
      let dx = b[0] - a[0], dy = b[1] - a[1];
      if (F.a !== n) { dx = -dx; dy = -dy; } // the normal is taken in F's own a->b direction
      const L = Math.hypot(dx, dy) || 1, off = (Lo.pos.get(v) + Lo.shift) * S;
      return [p[0] + (dy / L) * off, p[1] + (-dx / L) * off];
    };
    const atAOrder = (q, atA) => (atA ? q : q.slice().reverse());
    const away = (lay, F, n) => { // unit direction leaving node n along F
      const q = lay[F.k].simp, atA = F.a === n;
      const p0 = atA ? q[0] : q[q.length - 1], p1 = atA ? q[Math.min(2, q.length - 1)] : q[Math.max(0, q.length - 3)];
      const dx = p1[0] - p0[0], dy = p1[1] - p0[1], L = Math.hypot(dx, dy) || 1;
      return [dx / L, dy / L];
    };
    let last = null; // the last view's layout, for routePath
    const tagOrder = (a, b) => (CAT[VKEY(LINES[a].cat)].prio - CAT[VKEY(LINES[b].cat)].prio) || (LINES[a].rank - LINES[b].rank);
    const HMODE = { glass: 1, solid: 2, dots: 3, ties: 4 };
    // one-way arrows: +1 points along the drawn line, -1 against it, 0 none (two-way)
    const arrow = (dir, fwd) => (!dir ? 0 : (dir === 1) === fwd ? 1 : -1);

    // One view. p: { z (zoom step), zNow, u (px per line unit), capU, keyOn {key: bool}, selIdx,
    //   view [x0, y0, x1, y1] in meters, tags { gap, every, busZ }, theme ("l"/"d"), colors {key: css} }
    function build(p) {
      const { z, zNow, u, capU, keyOn, selIdx } = p;
      const S = u * MPP0 / 2 ** z; // meters per unit at this zoom
      // line width per service type; all-day and rush-hour buses are drawn slimmer when zoomed out
      const W = (v) => CAT[v].w * ((p.wscale && p.wscale[v]) || 1);
      // highlighted routes are drawn schematically: jogs under ~5 px (and 12 m) are straightened out
      const schem = Math.max(12, 5 * MPP0 / 2 ** z);
      const selKey = selIdx >= 0 ? VKEY(LINES[selIdx].cat) : null;
      const color = (key) => p.colors[key] || p.colors.local;

      // 1. each segment in (or near) view: which corridors show, their lanes and squeeze
      const V = p.view;
      const lay = new Array(EDGES.length);
      for (const E of EDGES) {
        if (E.bb[2] < V[0] || E.bb[0] > V[2] || E.bb[3] < V[1] || E.bb[1] > V[3]) { lay[E.k] = null; continue; }
        const keys = E.order.filter((v) => keyOn[v] || (v === selKey && E.l.includes(selIdx)));
        if (!keys.length) { lay[E.k] = null; continue; }
        let T = -GAP;
        for (const v of keys) T += W(v) + GAP;
        const s = Math.min(1, capU / T);
        const pos = new Map();
        let x = -T / 2;
        // boats: no side-by-side lanes; ferry routes only meet at the docks, where shifting
        // lanes would put little kinks into otherwise straight crossings
        for (const v of keys) { pos.set(v, E.layer === "w" ? 0 : (x + W(v) / 2) * s); x += W(v) + GAP; }
        const tol = Math.min(0.25 * S + 0.1 * T * s * S, Math.max(9, 1.6 * MPP0 / 2 ** z));
        const ck = `${z}|${tol.toFixed(1)}`;
        let simp = E.simp.get(ck);
        if (!simp) { simp = simplify(E.pts, tol); E.simp.set(ck, simp); }
        lay[E.k] = { keys, s, T: T * s, pos, shift: 0, simp };
      }
      const runs = (steps, key) => runsIn(lay, steps, key);

      // 2. slide whole bundles sideways so corridors keep their lane through junctions
      const cons = [], byEdge = new Map();
      for (const [v, chains] of KEY_CHAINS) {
        for (const ch of chains) {
          for (const run of runs(ch, v)) {
            for (let k = 0; k + 1 < run.length; k++) {
              const A = run[k], B = run[k + 1];
              if (A.E === B.E) continue;
              const n = cons.push([v, A.E.k, A.fwd ? 1 : -1, B.E.k, B.fwd ? 1 : -1]) - 1;
              for (const e of [A.E.k, B.E.k]) { if (!byEdge.has(e)) byEdge.set(e, []); byEdge.get(e).push(n); }
            }
          }
        }
      }
      for (let it = 0; it < 30; it++) {
        for (const [e, list] of byEdge) {
          const Le = lay[e];
          let num = 0, den = 0.35 * Le.keys.length;
          for (const n of list) {
            const [v, e1, s1, e2, s2] = cons[n];
            const [o, so, se] = e1 === e ? [e2, s2, s1] : [e1, s1, s2];
            num += se * so * (lay[o].pos.get(v) + lay[o].shift) - Le.pos.get(v);
            den += 1;
          }
          const lim = 0.3 * Le.T + 0.5;
          Le.shift = EDGES[e].layer === "w" ? 0 : Math.max(-lim, Math.min(lim, num / den));
        }
      }

      // 3. draw corridors, and the selected route on top
      const feats = [], selFeats = [];
      const props = (key, Lo, e) => {
        const c = CAT[key], s = Lo.s;
        const hr = c.inner === "glass" ? 0.34 : c.inner === "solid" ? 0.3 : c.inner === "dots" ? 0.32 : c.inner === "ties" ? 0.62 : 0;
        const w = W(key);
        return { r: -1, cat: key, e, wm: w * s * S, cm: (w + GAP * 1.4) * s * S, hm: w * hr * s * S,
          g: c.group, c: color(key), s: 20 - c.prio, d: c.dash ? 1 : 0, h: HMODE[c.inner] || 0 };
      };
      // where a corridor ends at a junction that its service type carries on from (three
      // lines of one color meeting, only two of which can continue each other), the end is
      // joined into the lane it meets instead of stopping short beside it
      const nodeEdges = new Map();
      for (const E of EDGES) {
        const Lo = lay[E.k];
        if (!Lo) continue;
        for (const v of Lo.keys) for (const n of [E.a, E.b]) {
          const key = v + "|" + n;
          if (!nodeEdges.has(key)) nodeEdges.set(key, []);
          nodeEdges.get(key).push(E);
        }
      }
      const joinPoint = (v, E, n) => {
        if (CAT[v].group === "water") return null;
        const others = (nodeEdges.get(v + "|" + n) || []).filter((F) => F !== E && F.a !== F.b);
        if (!others.length) return null;
        const d0 = away(lay, E, n);
        let best = null, bd = 0.7; // no joining back on itself (hairpin)
        for (const F of others) {
          const d1 = away(lay, F, n), dot = d0[0] * d1[0] + d0[1] * d1[1];
          if (dot < bd) { bd = dot; best = F; }
        }
        if (!best) return null;
        const Lo = lay[best.k], ahead = Math.min(0.35 * best.len, Math.max(12, 1.2 * Lo.T * S));
        return lanePoint(lay, best, n, v, S, ahead);
      };
      for (const [v, chains] of KEY_CHAINS) {
        for (const ch of chains) {
          for (const run of runs(ch, v)) {
            const pieces = [];
            drawPath(v, run, lay, S, (k, coords) => { if (coords.length >= 2) pieces.push([k, coords]); }, CAT[v].group === "water");
            if (!pieces.length) continue;
            const first = run[0], lastSt = run[run.length - 1];
            const n0 = first.fwd ? first.E.a : first.E.b, n1 = lastSt.fwd ? lastSt.E.b : lastSt.E.a;
            if (pieces[0][0] === 0) { const j = joinPoint(v, first.E, n0); if (j) pieces[0][1].unshift(j); }
            const lp = pieces[pieces.length - 1];
            if (lp[0] === run.length - 1) { const j = joinPoint(v, lastSt.E, n1); if (j) lp[1].push(j); }
            for (const [k, coords] of pieces) {
              const pr = props(v, lay[run[k].E.k], run[k].E.k);
              pr.ar = CAT[v].group === "water" ? 0 : arrow(run[k].E.kdir.get(v), run[k].fwd);
              feats.push({ type: "Feature", properties: pr, geometry: { type: "LineString", coordinates: coords.map(toLL) } });
            }
          }
        }
      }
      if (selIdx >= 0) {
        const c = CAT[selKey], col = color(selKey);
        for (const ch of ROUTE_CHAINS[selIdx]) {
          for (const run of runs(ch, selKey)) {
            drawPath(selKey, run, lay, S, (k, coords) => {
              if (coords.length < 2) return;
              selFeats.push({ type: "Feature", properties: { r: selIdx, cat: selKey, e: run[k].E.k, c: col, d: c.dash ? 1 : 0, ar: c.group === "water" ? 0 : arrow(run[k].E.dirOf(selIdx), run[k].fwd),
                wm: (c.w + 0.9) * S, cm: (c.w + 2.6) * S, gm: (c.w + 7) * S, hm: (c.w + 0.9) * 0.3 * S },
              geometry: { type: "LineString", coordinates: coords.map(toLL) } });
            }, c.group === "water", schem, true);
          }
        }
      }
      last = { lay, S, z, schem };

      // 4. route-number tags. Connected blocks carrying the same routes form one stretch; a
      //    stretch gets one tag (on its longest block), plus repeats along long blocks, and the
      //    same set of numbers never repeats close to itself.
      const TD = p.tags;
      const labelKey = (v) => CAT[v].group !== "bus" || zNow >= TD.busZ;
      const labels = [], selLabels = [];
      const tagKey = new Map();
      for (const E of EDGES) {
        const Lo = lay[E.k];
        if (!Lo) continue;
        const rs = [];
        for (const v of Lo.keys) if (labelKey(v) && keyOn[v]) for (const i of E.byKey.get(v)) rs.push(i);
        if (!rs.length) continue;
        rs.sort(tagOrder);
        tagKey.set(E.k, { k: `${p.theme}:${rs.join(".")}`, p: CAT[VKEY(LINES[rs[0]].cat)].prio });
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
      const mpp = MPP0 / 2 ** z, minGap = TD.gap * mpp, every = TD.every * mpp;
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
          const q = pointAt(E.pts, cum, E.len * (i + 0.5) / n);
          if (near.some((o) => Math.hypot(o[0] - q[0], o[1] - q[1]) < minGap) || crowded(q)) continue;
          near.push(q);
          remember(q);
          labels.push({ type: "Feature", properties: { k: t.k, p: t.p }, geometry: { type: "Point", coordinates: toLL(q) } });
        }
      }
      // the selected route's own tag: along its whole path about every 550 px, never two within ~380 px
      if (selIdx >= 0) {
        const gap = Math.max(380, TD.gap * 1.3) * mpp, step = Math.max(450, TD.every) * mpp, pts = [];
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
      return { feats, selFeats, labels, selLabels, selIdx };
    }
    function routePath(idx) {
      if (!last || !LINES[idx]) return [];
      const { lay, S, schem } = last, v = VKEY(LINES[idx].cat), c = CAT[v], out = [];
      for (const ch of ROUTE_CHAINS[idx]) {
        for (const run of runsIn(lay, ch, v)) {
          drawPath(v, run, lay, S, (k, coords) => {
            if (coords.length < 2) return;
            const w = c.w;
            out.push({ type: "Feature", properties: { r: idx, cat: v, e: run[k].E.k, d: c.dash ? 1 : 0,
              ar: c.group === "water" ? 0 : arrow(run[k].E.dirOf(idx), run[k].fwd), wm: w * S, cm: (w + GAP * 1.4) * S },
            geometry: { type: "LineString", coordinates: coords.map(toLL) } });
          }, c.group === "water", schem, true);
        }
      }
      return out;
    }
    return { build, routePath };
  }

  return { LAT0, LON0, KX, KY, MPP0, toM, toLL, VKEY, cumLen, prepEdges, createEngine };
})();

// In a worker: answer the page's messages ("init" once, then "build" per view).
if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  let engine = null;
  self.onmessage = (e) => {
    const m = e.data;
    if (m.type === "init") {
      engine = KCTMGeom.createEngine(m.init);
      self.postMessage({ type: "ready" });
    } else if (m.type === "route" && engine) {
      self.postMessage({ type: "route", id: m.id, idx: m.idx, feats: engine.routePath(m.idx) });
    } else if (m.type === "build" && engine) {
      const t = Date.now();
      const out = engine.build(m.p);
      self.postMessage({ type: "built", id: m.id, ms: Date.now() - t, ...out });
    }
  };
}
