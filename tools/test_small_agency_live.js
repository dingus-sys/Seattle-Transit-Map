// Island Transit, WTA (direct, open feeds) and Skagit Transit (through the live proxy) vehicles
// reach the map on their own routes. The feeds are stood in for with one vehicle each.
// Usage (site served on :8765, built with a LIVE_PROXY): node tools/test_small_agency_live.js
const { loadPlaywright } = require('./pw.js');
const SITE = process.env.SITE || 'http://127.0.0.1:8765';
const MAPLIBRE_JS = process.env.MAPLIBRE_JS || '';

// a minimal GTFS-realtime encoder: FeedMessage with one VehiclePosition entity
const varint = (n) => { const b = []; do { let x = n & 0x7f; n = Math.floor(n / 128); if (n) x |= 0x80; b.push(x); } while (n); return b; };
const field = (no, wt, body) => [...varint(no * 8 + wt), ...body];
const bytes = (no, buf) => field(no, 2, [...varint(buf.length), ...buf]);
const str = (no, s) => bytes(no, [...Buffer.from(s)]);
const f32 = (no, x) => { const b = Buffer.alloc(4); b.writeFloatLE(x); return field(no, 5, [...b]); };
function feed(route, trip, lat, lon, id) {
  const now = Math.floor(Date.now() / 1000);
  const vp = [...bytes(1, [...str(1, trip), ...str(5, route)]), ...bytes(2, [...f32(1, lat), ...f32(2, lon)]),
    ...field(5, 0, varint(now)), ...bytes(8, str(1, id))];
  return Buffer.from([...bytes(1, [...str(1, '2.0'), ...field(3, 0, varint(now))]), ...bytes(2, [...str(1, 'e' + id), ...bytes(4, vp)])]);
}

(async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const results = [];
  const check = (name, ok, info = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${info ? ' (' + info + ')' : ''}`); };
  try {
    const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
    await page.route(/^https:\/\//, (r) => r.abort());
    if (MAPLIBRE_JS) await page.route(/maplibre-gl\.js$/, (r) => r.fulfill({ path: MAPLIBRE_JS, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } }));
    const hits = {};
    const serve = (name, body) => (r) => { hits[name] = r.request().url(); r.fulfill({ body, contentType: 'application/x-protobuf', headers: { 'Access-Control-Allow-Origin': '*' } }); };
    await page.route('https://passio3.com/islandtransit/**/vehiclePositions', serve('island', feed('9404', 't1', 48.2, -122.6, 'I1')));
    await page.route('https://bustracker.ridewta.com/gtfsrt/vehicles', serve('wta', feed('190', 't2', 48.75, -122.48, 'W1')));
    await page.route(/\/skagit\/GTFS\/GTFS_VehiclePositions\.pb/, serve('skagit', feed('40X', 't3', 48.42, -122.33, 'S1')));
    const direct = [];
    page.on('request', (q) => { if (q.url().startsWith('https://strweb.skagittransit.org')) direct.push(q.url()); });
    await page.goto(SITE + '/index.html');
    await page.waitForFunction(() => document.getElementById('loading')?.hidden === true, null, { timeout: 60000 });
    await page.waitForFunction(() => { const c = window.__atlas.liveState().current || []; return ['island', 'wta', 'skagit'].every((a) => c.some((v) => v.r && v.r.id.startsWith(a + '-') && !v.est)); }, null, { timeout: 30000 }).catch(() => {});
    const got = await page.evaluate(() => (window.__atlas.liveState().current || []).filter((v) => !v.est && v.r && /^(island|wta|skagit)-/.test(v.r.id)).map((v) => v.r.id));
    check('Island Transit vehicle shows on route 1', got.includes('island-1'), got.join(' '));
    check('WTA vehicle shows on route 190', got.includes('wta-190'));
    check('Skagit vehicle shows on route 40X, fetched through the proxy', got.includes('skagit-40x') && /\/skagit\//.test(hits.skagit || '') && !direct.length, hits.skagit || 'not requested');
  } catch (e) {
    check('test ran', false, e.message);
  } finally {
    await browser.close();
  }
  console.log(`${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})();
