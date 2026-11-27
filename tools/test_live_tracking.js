// Live vehicles ride their own route like a control-room display: one WTA bus is fed in fix by
// fix (GPS noise of ~12 m to the side, a bearing of 0 the way many feeds say "unknown", a fix
// that drifts back at a stop, and one answer that leaves the bus out). At every moment the marker
// must be on its route's line, face along it in the way it is going (or show no pointer while
// that isn't known yet), never drive backwards, and never vanish or jump.
// Usage (site served on :8765): node tools/test_live_tracking.js
const { loadPlaywright } = require('./pw.js');
const fs = require('fs');
const SITE = process.env.SITE || 'http://127.0.0.1:8765';
const MAPLIBRE_JS = process.env.MAPLIBRE_JS || '';

const varint = (n) => { const b = []; do { let x = n & 0x7f; n = Math.floor(n / 128); if (n) x |= 0x80; b.push(x); } while (n); return b; };
const field = (no, wt, body) => [...varint(no * 8 + wt), ...body];
const bytes = (no, buf) => field(no, 2, [...varint(buf.length), ...buf]);
const str = (no, s) => bytes(no, [...Buffer.from(s)]);
const f32 = (no, x) => { const b = Buffer.alloc(4); b.writeFloatLE(x); return field(no, 5, [...b]); };
function feed(fix) {
  const now = Math.floor(Date.now() / 1000);
  const head = bytes(1, [...str(1, '2.0'), ...field(3, 0, varint(now))]);
  if (!fix) return Buffer.from(head);
  const vp = [...bytes(1, [...str(1, 'trip1'), ...str(5, fix.route)]), ...bytes(2, [...f32(1, fix.lat), ...f32(2, fix.lon), ...f32(3, 0)]),
    ...field(5, 0, varint(now)), ...bytes(8, str(1, 'BUS1'))];
  return Buffer.from([...head, ...bytes(2, [...str(1, 'eBUS1'), ...bytes(4, vp)])]);
}

// the route's longest path, in metres around its middle
const sched = JSON.parse(fs.readFileSync('site/data/schedule.json'));
const routes = JSON.parse(fs.readFileSync('site/data/routes.json')).routes;
const RID = 'wta-331', ri = routes.findIndex((r) => r.id === RID);
const pat = sched.patterns.filter((p) => p.r === ri && p.c).sort((a, b) => b.c.length - a.c.length)[0];
const LAT0 = pat.c[0][1], KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110540;
const P = pat.c.map(([x, y]) => [(x - pat.c[0][0]) * KX, (y - LAT0) * KY]);
const cum = [0]; for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
const at = (s) => { let k = 0; while (k < cum.length - 2 && cum[k + 1] < s) k++; const t = (s - cum[k]) / ((cum[k + 1] - cum[k]) || 1);
  const dx = P[k + 1][0] - P[k][0], dy = P[k + 1][1] - P[k][1], L = Math.hypot(dx, dy) || 1;
  return { x: P[k][0] + dx * t, y: P[k][1] + dy * t, nx: -dy / L, ny: dx / L, b: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360 }; };
const toLL = (x, y) => [pat.c[0][0] + x / KX, LAT0 + y / KY];
const project = (lon, lat) => { const m = [(lon - pat.c[0][0]) * KX, (lat - LAT0) * KY]; let best = null;
  for (let k = 0; k < P.length - 1; k++) { const dx = P[k + 1][0] - P[k][0], dy = P[k + 1][1] - P[k][1], L2 = dx * dx + dy * dy;
    const u = L2 ? Math.max(0, Math.min(1, ((m[0] - P[k][0]) * dx + (m[1] - P[k][1]) * dy) / L2)) : 0;
    const d = Math.hypot(P[k][0] + dx * u - m[0], P[k][1] + dy * u - m[1]);
    if (!best || d < best.d) best = { d, s: cum[k] + Math.sqrt(L2) * u, b: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360 }; }
  return best; };
const S0 = cum[cum.length - 1] * 0.3;
// metres along the path at each poll, and how far to the side the GPS puts the bus (null: left out)
const plan = [[S0, 10], [S0 + 140, -12], [S0 + 290, 12], [S0 + 272, -8], null, [S0 + 520, 10], [S0 + 660, -12], [S0 + 800, 6]];
const angle = (a, b) => Math.abs((((b - a) % 360) + 540) % 360 - 180);

(async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const results = [];
  const check = (name, ok, info = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${info ? ' (' + info + ')' : ''}`); };
  try {
    const page = await (await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1100, height: 800 } })).newPage();
    await page.route(/^https:\/\//, (r) => r.abort());
    if (MAPLIBRE_JS) await page.route(/maplibre-gl\.js$/, (r) => r.fulfill({ path: MAPLIBRE_JS, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } }));
    let fix = null;
    await page.route('https://bustracker.ridewta.com/gtfsrt/vehicles', (r) => r.fulfill({ body: feed(fix), contentType: 'application/x-protobuf', headers: { 'Access-Control-Allow-Origin': '*' } }));
    const setFix = (step) => {
      if (!step) { fix = null; return; }
      const q = at(step[0]), [lon, lat] = toLL(q.x + q.nx * step[1], q.y + q.ny * step[1]);
      fix = { route: '331', lat, lon };
    };
    setFix(plan[0]);
    await page.goto(SITE + '/index.html');
    await page.waitForFunction(() => document.getElementById('loading')?.hidden === true, null, { timeout: 90000 });
    const mid = at(S0 + 400), c = toLL(mid.x, mid.y);
    await page.evaluate((c) => window.__map.jumpTo({ center: c, zoom: 14.6 }), c);
    await page.waitForTimeout(800); await page.evaluate(() => window.__atlas.idle());
    const sample = () => page.evaluate(() => {
      const d = window.__map.getSource('vehicles')._data, f = (d.features || []).find((x) => x.properties.id === 'wta_BUS1');
      return f ? { c: f.geometry.coordinates, b: f.properties.b, o: f.properties.o } : null;
    });
    const samples = [];
    let firstSeen = -1;
    for (let i = 0; i < plan.length; i++) {
      setFix(plan[i]);
      // the poll runs while the map is watched (it takes a few seconds: it asks every feed in turn)
      const polled = page.evaluate(() => window.__atlas.pollLive());
      for (let k = 0; k < 24; k++) {
        await page.waitForTimeout(250);
        const v = await sample();
        if (v && firstSeen < 0) firstSeen = samples.length;
        samples.push({ i, v });
      }
      await polled;
    }
    check('the bus appears', firstSeen >= 0);
    const after = samples.slice(firstSeen);
    const missing = after.filter((x) => !x.v);
    check('it never vanishes (not even when one answer leaves it out)', !missing.length, `${missing.length} of ${after.length} moments missing`);
    const seen = after.filter((x) => x.v);
    const proj = seen.map((x) => ({ ...x, p: project(x.v.c[0], x.v.c[1]) }));
    const off = Math.max(...proj.map((x) => x.p.d));
    check('it stays on its route\'s line', off < 25, `farthest ${off.toFixed(1)} m off the path`);
    let back = 0, jump = 0, jumpAt = '';
    for (let k = 1; k < proj.length; k++) { const ds = proj[k].p.s - proj[k - 1].p.s; back = Math.min(back, ds); if (ds > jump) { jump = ds; jumpAt = `poll ${proj[k].i}, ${(proj[k - 1].p.s - S0).toFixed(0)} -> ${(proj[k].p.s - S0).toFixed(0)} m`; } }
    if (process.env.DBG) console.log(proj.map((x) => `${x.i}:${(x.p.s - S0).toFixed(0)}/${x.v.b}`).join(' '));
    check('it never drives backwards', back > -3, `largest step back ${(-back).toFixed(1)} m`);
    check('it moves in small steps, not jumps', jump < 25, `largest step ${jump.toFixed(1)} m in 0.25 s, ${jumpAt}`);
    const pointed = proj.filter((x) => x.v.b >= 0);
    // along the route there: the line's direction at the bus, or (turning a corner) just before or
    // after it; the drawn line is simplified at this zoom, so a bend on it can differ by up to 45°
    const along = (x) => Math.min(...[-15, 0, 15].map((ds) => angle(x.v.b, at(x.p.s + ds).b)));
    const wrong = pointed.filter((x) => along(x) > 45);
    check('its pointer faces along the line, the way it is going', pointed.length > 0 && !wrong.length,
      `${pointed.length} moments with a pointer, ${wrong.length} not along the route (e.g. ${wrong.slice(0, 3).map((x) => x.v.b + ' vs ' + x.p.b.toFixed(0)).join(', ')})`);
    const fadeIn = after.slice(0, 3).map((x) => x.v && x.v.o);
    check('it fades in rather than popping', fadeIn[0] != null && fadeIn[0] < 1, `opacity ${fadeIn.join(', ')}`);
  } catch (e) {
    console.log('ERROR', e.message); results.push(false);
  } finally {
    await browser.close();
  }
  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} checks passed`);
  process.exit(ok === results.length ? 0 : 1);
})();
