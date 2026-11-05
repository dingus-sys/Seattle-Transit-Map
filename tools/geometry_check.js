// Pure Node regression checks; no browser or network needed.
// Run: node tools/geometry_check.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const geom = new Function(read('web/geom.js') + ';return KCTMGeom;')();
const app = read('web/app.js');
const cat = new Function(app.slice(app.indexOf('  const CAT = {'), app.indexOf('  const VKEY')) + ';return CAT;')();
const net = JSON.parse(read('site/data/network.json'));
const routes = new Map(JSON.parse(read('site/data/routes.json')).routes.map((r) => [r.id, r]));
const dkey = (r) => r.cat === 'link' ? (r.label === '1' ? 'link1' : r.label === 'T' ? 'linkT' : 'link2') : r.cat;
const lines = net.lines.map((id, rank) => ({ cat: dkey(routes.get(id)), rank }));
const engine = geom.createEngine({ edges: net.edges, lines, cat, gap: 0 });
const params = (z) => ({ z, zs: z, zNow: z, u: 2.4, capU: 14, selIdx: -1,
  keyOn: Object.fromEntries(Object.keys(cat).map((k) => [k, true])),
  view: [-100000, -150000, 100000, 150000], tags: { gap: 560, every: 1200, any: 88, busZ: 10 },
  theme: 'l', colors: Object.fromEntries(Object.keys(cat).map((k) => [k, '#444'])) });
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log('PASS', name); };
check('network has valid route memberships, coordinates and directions', () => {
  for (const e of net.edges) {
    assert(e.c.length >= 2 && e.l.length > 0);
    assert.equal(new Set(e.l).size, e.l.length);
    assert(e.l.every((i) => Number.isInteger(i) && lines[i]));
    assert(e.c.every((p) => p.length === 2 && p.every(Number.isFinite)));
    if (e.d) { assert.equal(e.d.length, e.l.length); assert(e.d.every((d) => [0, 1, 2].includes(d))); }
  }
});
check('route ordering removes crossings without adding new ones', () => {
  assert(engine.strandStats.after <= engine.strandStats.before);
  assert(engine.strandStats.after < 100, JSON.stringify(engine.strandStats));
});
for (const z of [10, 12, 14, 16, 18]) check(`all routes draw with finite, usable geometry at zoom ${z}`, () => {
  const b = engine.build(params(z));
  const drawn = new Set();
  for (const f of b.feats) {
    assert(f.geometry.coordinates.length >= 2);
    assert(f.geometry.coordinates.every((p) => p.every(Number.isFinite)));
    assert(Number.isFinite(f.properties.wm) && f.properties.wm > 0);
    if (f.properties.r >= 0) drawn.add(f.properties.r);
  }
  for (let i = 0; i < lines.length; i++) {
    if (!['ferry', 'watertaxi'].includes(lines[i].cat)) assert(drawn.has(i), `route ${net.lines[i]} disappeared`);
  }
});
check('selection and hover follow the same strand through junctions', () => {
  const p = params(15);
  for (const id of ['metro-8', 'metro-70', 'metro-193', 'sound-transit-1-line', 'wsf-seattle-bainbridge-island']) {
    const i = net.lines.indexOf(id);
    assert(i >= 0, id);
    const b = engine.build({ ...p, selIdx: i });
    const hover = engine.routePaths([i]);
    assert(b.selFeats.length > 0 && hover.length > 0, id);
    assert.deepEqual(hover.map((f) => f.geometry), b.selFeats.map((f) => f.geometry), id);
  }
});
check('a selected route stays visible when its category is hidden', () => {
  const i = net.lines.indexOf('metro-8'), p = params(15);
  const b = engine.build({ ...p, keyOn: {}, selIdx: i });
  assert.equal(b.feats.length, 0);
  assert(b.selFeats.length > 0);
});
check('empty views return no stray geometry', () => {
  const b = engine.build({ ...params(15), view: [1e7, 1e7, 1e7 + 100, 1e7 + 100] });
  assert.equal(b.feats.length, 0);
});
console.log(`${checks}/${checks} passed; strand swaps ${engine.strandStats.before} → ${engine.strandStats.after}`);
