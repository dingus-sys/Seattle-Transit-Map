// World-space renderer regressions: node tools/ribbon_check.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const code = fs.readFileSync(path.join(__dirname, '../web/ribbons.js'), 'utf8');
const r = new Function(code + ';return KCTMRibbons')();
const feature = (properties = {}, coordinates = [[-122.33, 47.61], [-122.329, 47.61]]) => ({
  type: 'Feature', properties: { zu: 2.4 / 2 ** 15, wm: 2, cm: 2.6, hm: 0, sh: 0, c: '#009977', g: 'bus', cat: 'frequent', ...properties },
  geometry: { type: 'LineString', coordinates },
});
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('PASS', name); };
const valid = (mesh) => { for (const b of mesh) { assert.equal(b.data.length % (r.STRIDE * 3), 0); assert(b.data.every(Number.isFinite)); } };
check('empty views contain no GPU work', () => assert.deepEqual(r.compile([]), []));
check('duplicate points and tight reversals produce bounded, finite ribbons', () => {
  const mesh = r.compile([feature({}, [[-122.33, 47.61], [-122.33, 47.61], [-122.329, 47.61], [-122.33, 47.61]])]);
  valid(mesh);
  for (const b of mesh) for (let i = 0; i < b.data.length; i += r.STRIDE) assert(Math.hypot(b.data[i + 2], b.data[i + 3]) <= 2.001 * b.data[i + 5]);
});
check('route edges and lane spacing scale together across large zoom jumps', () => {
  const f = feature(), body = r.compile([f]).find((b) => b.role === 'body').data;
  const half = body[5];
  for (const z of [9, 12, 14.4, 16, 18.5]) {
    const pixels = 512 * 2 ** z;
    const expected = f.properties.wm * f.properties.zu * 2 ** z;
    assert(Math.abs(2 * half * pixels - expected) < expected * 1e-6);
    const lane = 3 * f.properties.zu / 512;
    assert(Math.abs((lane * pixels) / (2 * half * pixels) - 1.5) < 1e-6);
  }
});
check('both caps face outward along a simple segment', () => {
  const b = r.compile([feature()]).find((b) => b.role === 'body').data;
  const end = r.project([-122.329, 47.61])[0];
  let left = 0, right = 0;
  for (let i = 0; i < b.length; i += r.STRIDE) { const x = b[i] + b[i + 2]; if (x < 0) left++; if (x > end) right++; }
  assert(left > 0 && right > 0);
});
check('rail is above surface routes, with separate casing and body passes', () => {
  const m = r.compile([feature({ g: 'rail', cat: 'link1' }), feature()]); valid(m);
  assert(m.findIndex((b) => b.stack === 1) > m.map((b) => b.stack).lastIndexOf(0));
  assert.deepEqual(m.filter((b) => b.stack === 0).map((b) => b.role), ['case', 'body']);
});
check('ferries, RapidRide dots and rail ties keep their distinct patterns', () => {
  for (const [p, role, pattern] of [[{ d: 1 }, 'dash', 1], [{ h: 3, hm: 0.8 }, 'dots', 2], [{ h: 4, hm: 1.2 }, 'ties', 3]]) {
    const m = r.compile([feature(p)]); valid(m); assert.equal(m.find((b) => b.role === role).pattern, pattern);
  }
});
check('selection glows and hover widths are compiled once', () => {
  const f = feature({ gm: 8 });
  assert(r.compile([f], { selected: true }).some((b) => b.role === 'glow'));
  const body = r.compile([f], { hover: true, widthScale: 1.65 }).find((b) => b.role === 'body');
  assert(Math.abs(body.data[5] / (f.properties.wm * f.properties.zu / 1024) - 1.65) < 1e-6);
});
check('worker meshes transfer without copying or losing their vertices', () => {
  const mesh = r.compile([feature()]), length = mesh[0].data.length;
  const copy = structuredClone(mesh, { transfer: mesh.map((b) => b.data.buffer) });
  assert.equal(mesh[0].data.byteLength, 0); assert.equal(copy[0].data.length, length); valid(copy);
});
console.log(`${passed}/${passed} passed`);
