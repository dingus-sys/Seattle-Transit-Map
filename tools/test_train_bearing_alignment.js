const fs = require("fs");
const assert = require("assert");

// Load KCTMGeom
const geom = new Function(fs.readFileSync("web/geom.js", "utf8") + "; return KCTMGeom;")();
const { toM, MPP0, LAT0, LON0, KX, KY } = geom;
const toLonLat = (q) => [LON0 + q[0] / KX, LAT0 + q[1] / KY];
const geoDist = (a, b) => { const [x0, y0] = toM(a[0], a[1]), [x1, y1] = toM(b[0], b[1]); return Math.hypot(x1 - x0, y1 - y0); };
const geoBearing = (a, b) => { const [x0, y0] = toM(a[0], a[1]), [x1, y1] = toM(b[0], b[1]); return (Math.atan2(x1 - x0, y1 - y0) * 180 / Math.PI + 360) % 360; };

const net = JSON.parse(fs.readFileSync("site/data/network.json", "utf8"));
const routesData = JSON.parse(fs.readFileSync("site/data/routes.json", "utf8"));
const ROUTES = routesData.routes;
const RBY = {};
ROUTES.forEach((r, i) => { r._rank = i; RBY[r.id] = r; });
const LINES = net.lines.map((id) => RBY[id]);
const LINEIDX = {};
LINES.forEach((r, i) => { LINEIDX[r.id] = i; });

const CAT = {
  link:      { group: "rail",  w: 3.0,  tier: 0, prio: 0,  inner: "solid" },
  link1:     { group: "rail",  w: 3.2,  tier: 0, prio: 0,  inner: "solid", base: "link" },
  link2:     { group: "rail",  w: 3.2,  tier: 0, prio: 0.1, inner: "solid", base: "link" },
  linkT:     { group: "rail",  w: 3.0,  tier: 0, prio: 0.2, inner: "solid", base: "link" },
  sounder:   { group: "rail",  w: 2.5,  tier: 0, prio: 1,  inner: "ties" },
  streetcar: { group: "rapid", w: 2.2,  tier: 0, prio: 2,  inner: "solid" },
  monorail:  { group: "rapid", w: 2.2,  tier: 0, prio: 3,  inner: "solid" },
  rapidride: { group: "rapid", w: 2.7,  tier: 0, prio: 4,  inner: "dots" },
  swift:     { group: "rapid", w: 2.5,  tier: 0, prio: 5,  inner: "dots" },
  frequent:  { group: "bus",   w: 2.35, tier: 1, prio: 6,  inner: "glass" },
  local:     { group: "bus",   w: 1.9,  tier: 2, prio: 7,  inner: "glass" },
  peak:      { group: "bus",   w: 1.85, tier: 2, prio: 8,  dash: true },
  shuttle:   { group: "bus",   w: 1.7,  tier: 2, prio: 9,  inner: "glass" },
  dart:      { group: "bus",   w: 1.7,  tier: 2, prio: 10, dash: true },
  watertaxi: { group: "water", w: 1.9,  tier: 0, prio: 11, dash: true },
  ferry:     { group: "water", w: 1.9,  tier: 0, prio: 12, dash: true },
};

const VKEY = (cat) => (cat === "amtrak" ? "sounder" : cat);
const dkey = (r) => (r.cat === "link" ? (r.label === "1" ? "link1" : r.label === "T" ? "linkT" : "link2") : VKEY(r.cat));
const isRailRoute = (r) => !!(r && (CAT[dkey(r)]?.group === "rail" || r.cat === "link" || r.cat === "sounder" || r.cat === "amtrak" || r.cat === "streetcar" || r.cat === "monorail"));

const EDGES = geom.prepEdges(net.edges, LINES.map((r) => ({ cat: dkey(r), group: CAT[dkey(r)].group })));
const engine = geom.createEngine({
  edges: net.edges,
  lines: LINES.map((r) => ({ cat: dkey(r), rank: r._rank })),
  cat: CAT,
  gap: 0
});

const z = 12;
const u = MPP0 / 2 ** z;
const keyOn = {};
for (const k of Object.keys(CAT)) keyOn[k] = true;

const p = {
  z, zs: z, zNow: z, u, capU: 1, keyOn, routeFilter: null,
  selIdx: -1,
  view: [ -40000, -40000, 40000, 40000 ],
  tags: { every: 550, gap: 380, any: 160 },
  theme: "l", colors: {}, focusColors: {},
  wscale: 1
};
const out = engine.build(p);
const lastFeats = out.feats;

function segIndex(feats) {
  const cell = 160, grid = new Map(), segs = [];
  for (const f of feats) {
    const cs = f.geometry.coordinates;
    const P = cs.map(([x, y]) => toM(x, y));
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i], b = P[i + 1], n = segs.push([a, b, f.properties]) - 1;
      for (let gx = Math.floor(Math.min(a[0], b[0]) / cell); gx <= Math.floor(Math.max(a[0], b[0]) / cell); gx++)
        for (let gy = Math.floor(Math.min(a[1], b[1]) / cell); gy <= Math.floor(Math.max(a[1], b[1]) / cell); gy++) {
          const key = gx + "," + gy;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(n);
        }
    }
  }
  return { cell, grid, segs };
}

function nearestOn(ix, p, maxD, accept) {
  let best = null, bd = maxD, dir = null, bp = null;
  const r = Math.ceil(maxD / ix.cell), gx = Math.floor(p[0] / ix.cell), gy = Math.floor(p[1] / ix.cell), seen = new Set();
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
    for (const n of ix.grid.get((gx + dx) + "," + (gy + dy)) || []) {
      if (seen.has(n)) continue;
      seen.add(n);
      const [a, b, props] = ix.segs[n];
      if (accept && !accept(props)) continue;
      const vx = b[0] - a[0], vy = b[1] - a[1], L2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2));
      const q = [a[0] + t * vx, a[1] + t * vy], d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd) { bd = d; best = q; dir = [vx, vy]; bp = props; }
    }
  }
  return best ? { q: best, d: bd, dir, props: bp } : null;
}

const vehIx = segIndex(lastFeats);

function onLine(r, pos, b) {
  const i = LINEIDX[r.id], key = dkey(r);
  const isWater = CAT[key]?.group === "water";
  const isRail = isRailRoute(r);
  const ix = vehIx;
  if (!ix) return isWater ? [pos, b] : null;
  const mpp = MPP0 / 2 ** z;
  const reach = isWater ? 8000 : Math.max(50, 26 * mpp);
  const hit = nearestOn(ix, toM(pos[0], pos[1]), reach,
    (pr) => (pr.r >= 0 ? pr.r === i : pr.cat === key && EDGES[pr.e] && EDGES[pr.e].l.includes(i)));
  if (!hit) return isWater ? [pos, b] : null;
  if (isWater) return [toLonLat(hit.q), b];
  let finalB = b;
  if (b >= 0) {
    let hb = (Math.atan2(hit.dir[0], hit.dir[1]) * 180 / Math.PI + 360) % 360;
    const diff = Math.abs(((hb - b + 540) % 360) - 180);
    const streetAngle = diff > 90 ? (hb + 180) % 360 : hb;
    const alignDiff = Math.abs(((streetAngle - b + 540) % 360) - 180);
    finalB = isRail ? streetAngle : (alignDiff <= 45 ? streetAngle : b);
  }
  return [toLonLat(hit.q), finalB];
}

console.log("Running tests for train bearing alignment and motion...");

// 1. Test 2 Line on I-90 bridge: East-West track (~92° / 272°)
const r2 = ROUTES.find(r => r.short === "2 Line");
assert(r2, "2 Line route must exist");
assert(isRailRoute(r2), "2 Line must be recognized as rail route");

const pBridge = [-122.281, 47.590]; // I-90 bridge
for (const testAngle of [0, 45, 90, 135, 180, 225, 270, 315, 359]) {
  const snap = onLine(r2, pBridge, testAngle);
  assert(snap, `Train must snap on I-90 bridge for testAngle=${testAngle}`);
  const b = snap[1];
  // Track on bridge is ~92.2° (East) or ~272.2° (West).
  // The final bearing MUST be close to either ~92° or ~272° (parallel to track), NEVER perpendicular (~2° or ~182°)!
  const diffEast = Math.abs(((b - 92.2 + 540) % 360) - 180);
  const diffWest = Math.abs(((b - 272.2 + 540) % 360) - 180);
  const minDiff = Math.min(diffEast, diffWest);
  assert(minDiff < 5.0, `Bearing ${b.toFixed(1)}° must be parallel to track (near 92.2° or 272.2°), but minDiff=${minDiff.toFixed(1)}° for testAngle=${testAngle}`);
}
console.log("✓ Test 1 passed: 2 Line on I-90 bridge always aligns parallel to track across all 360° input angles");

// 2. Test 1 Line on MLK Jr Way / Rainier Valley: North-South track (~162° / 342°)
const r1 = ROUTES.find(r => r.short === "1 Line");
assert(r1, "1 Line route must exist");
assert(isRailRoute(r1), "1 Line must be recognized as rail route");

const pRainier = [-122.288, 47.545];
for (const testAngle of [0, 45, 90, 135, 180, 225, 270, 315, 359]) {
  const snap = onLine(r1, pRainier, testAngle);
  assert(snap, `Train must snap on MLK Jr Way for testAngle=${testAngle}`);
  const b = snap[1];
  const diffSouth = Math.abs(((b - 161.9 + 540) % 360) - 180);
  const diffNorth = Math.abs(((b - 341.9 + 540) % 360) - 180);
  const minDiff = Math.min(diffSouth, diffNorth);
  assert(minDiff < 5.0, `Bearing ${b.toFixed(1)}° must be parallel to track (near 161.9° or 341.9°), but minDiff=${minDiff.toFixed(1)}° for testAngle=${testAngle}`);
}
console.log("✓ Test 2 passed: 1 Line in Rainier Valley always aligns parallel to track across all 360° input angles");

// 3. Test multi-step motion simulation with cross-track GPS drift at station
let prevSim = null;
const simSteps = [
  { lat: 47.5901, lon: -122.2850, expB: -1, desc: "initial observation" },
  { lat: 47.5901, lon: -122.2810, expNear: 92.2, desc: "moving East +300m" },
  { lat: 47.5903, lon: -122.2810, expNear: 92.2, desc: "stopped with 22m North GPS drift into water" },
  { lat: 47.5901, lon: -122.2860, expNear: 272.2, desc: "departs station Westbound -370m" }
];

for (const step of simSteps) {
  const to = [step.lon, step.lat];
  if (!prevSim) {
    prevSim = { to, b: -1 };
  } else {
    let from = prevSim.to;
    let targetTo = to;
    let b = prevSim.b;
    const sFrom = onLine(r2, from, -1);
    const sTo = onLine(r2, targetTo, -1);
    if (sFrom && sTo) {
      const trackD = geoDist(sFrom[0], sTo[0]);
      if (trackD < 10) {
        from = targetTo = sTo[0];
      } else {
        from = sFrom[0];
        targetTo = sTo[0];
        const moveB = geoBearing(from, targetTo);
        const sMove = onLine(r2, targetTo, moveB);
        b = sMove && sMove[1] >= 0 ? sMove[1] : moveB;
      }
    }
    prevSim = { from, to: targetTo, b };
  }
  const snap = onLine(r2, prevSim.to, prevSim.b);
  if (step.expB != null) {
    assert.strictEqual(snap[1], step.expB, `Step ${step.desc}: expected ${step.expB}, got ${snap[1]}`);
  } else if (step.expNear != null) {
    const diff = Math.abs(((snap[1] - step.expNear + 540) % 360) - 180);
    assert(diff < 5.0, `Step ${step.desc}: expected bearing near ${step.expNear}°, got ${snap[1]}° (diff=${diff.toFixed(1)}°)`);
  }
}
console.log("✓ Test 3 passed: Multi-step motion simulation on rail eliminates cross-track drift and maintains correct heading");

console.log("\nAll train bearing alignment tests passed successfully!");
