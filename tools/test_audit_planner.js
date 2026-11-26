// Planner regressions from the November 25, 2026 audit, on small made-up timetables so each case is exact.
//   node tools/test_audit_planner.js
// Covers: getting off a waiting bus at its arrival time (dwell), the agencies' minimum transfer times,
// staying aboard only where the same vehicle block goes on, the vehicle's own headsign, Arrive-by
// across midnight, and Arrive-by never asking for a departure that is already past.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const appCode = fs.readFileSync(path.join(ROOT, 'web/app.js'), 'utf8');
const glyphBlock = appCode.slice(appCode.indexOf('  function poiIconSVG('), appCode.indexOf('  function poiKindFromBadge('));
const block = appCode.slice(appCode.indexOf('let plannerStopsCache = null;'), appCode.indexOf('  function renderTripOnMap('));

const H = 3600;
// stops 0.05 degrees (3.8 km) apart: nobody walks between them, so only the vehicles connect them
const SP = 0.05;
const stopAt = (id, i) => ({ id, name: id.toUpperCase(), lat: 47.6, lon: -122.3 + i * SP, kind: 'stop', key: id, routes: [] });

// world: { stops: [id], routes: [{id, cat}], patterns: [{r, s:[ids], f:[], w?, h?}], days: {weekday:[[pi,s0,du]], prev:[...]}, through?, xfer? }
function planner(world, nowSecs = 8 * H) {
  const stops = world.stops.map((id, i) => stopAt(id, i));
  const stopIndex = Object.fromEntries(stops.map((s) => [s.id, s]));
  const routes = world.routes.map((r) => ({ short: r.id, label: r.id, agency: 'Test', agencyShort: 'T', name: r.id, patterns: [], sched: {}, ...r }));
  const RBY = Object.fromEntries(routes.map((r) => [r.id, r]));
  const LINEIDX = Object.fromEntries(routes.map((r, i) => [r.id, i]));
  const patterns = world.patterns.map((p) => ({ ...p, c: [], d: [] }));
  for (const r of routes) r.patterns = (world.routePatterns || {})[r.id] || [];
  const SCHED = { patterns, days: world.days, byPat: {}, through: world.through || [], xfer: world.xfer || [], thr: new Map(), xferMap: new Map() };
  for (const [a, sa, b, sb] of SCHED.through) { const k = a + '|' + sa; if (!SCHED.thr.has(k)) SCHED.thr.set(k, []); SCHED.thr.get(k).push([b, sb]); }
  for (const [fs_, ts, ra, rb, sec] of SCHED.xfer) { const k = fs_ + '|' + ts; if (!SCHED.xferMap.has(k)) SCHED.xferMap.set(k, []); SCHED.xferMap.get(k).push([ra, rb, sec]); }
  const DEP = new Map();
  patterns.forEach((p, pi) => p.s.forEach((sid, i) => { const k = stopIndex[sid].key; if (!DEP.has(k)) DEP.set(k, []); DEP.get(k).push([pi, i]); }));
  for (const [day, trips] of Object.entries(SCHED.days)) {
    const m = new Map();
    for (const [pi, s0, du] of trips) { if (!m.has(pi)) m.set(pi, []); m.get(pi).push([s0, du]); }
    SCHED.byPat[day] = m;
  }
  const CLOCK = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
  const placeName = (sid) => (stopIndex[sid] && stopIndex[sid].name) || '';
  const patternDest = (p) => (p && (p.h || placeName(p.s[p.s.length - 1]))) || '';
  const pacificNow = () => ({ secs: nowSecs, day: 'weekday', prev: 'prev', date: new Date() });
  const mod = new Function('SCHED', 'DEP', 'ROUTES', 'RBY', 'LINEIDX', 'STOPS', 'NET', 'stopIndex', 'pacificNow', 'CLOCK', 'liveDepartures', 'stopIdsOf', 'walkable', 'patternDest', 'placeName', `
    let map = null, selected = null, netDim = 1;
    function setNetDim() {}
    function focusOff() {}
    function highlightDartArea() {}
    ${glyphBlock}
    ${block}
    return { planTransitTrip, planArriveBy, raptorNetwork, raptorTrips, raptorEnds, raptorSearch };
  `)(SCHED, DEP, routes, RBY, LINEIDX, { stops, stations: [] }, { lines: [], edges: [] }, stopIndex, pacificNow, CLOCK, () => null, (s) => [s.id], () => true, patternDest, placeName);
  return { ...mod, stopIndex };
}
const at = (stopId, i) => ({ lat: 47.6, lon: -122.3 + i * SP, name: stopId });
const rows = [];
module.exports = { planner, at };
function test(name, fn) { if (require.main !== module) return; try { fn(); rows.push(['PASS', name]); } catch (e) { rows.push(['FAIL', name, e.message]); } }

// Line of stops s0..s3. Route A rides s0 -> s1 (a 2-stop pattern), route B rides s1 -> s2 -> s3.
const base = (over = {}) => ({
  stops: ['s0', 's1', 's2', 's3'],
  routes: [{ id: 'a', cat: 'local' }, { id: 'b', cat: 'local' }],
  patterns: [{ r: 0, s: ['s0', 's1'], f: [0, 1] }, { r: 1, s: ['s1', 's2'], f: [0, 1] }],
  days: { weekday: [[0, 8 * H, 1200], [1, 8 * H + 1320, 600]], prev: [] },
  ...over,
});
// only trips arriving the same morning (the test's day repeats at +24 h, and a next-day connection always exists)
const sameMorning = (x) => x.arrivalSec < 12 * H;
const planOne = (world, to = 2, now = 8 * H - 600) => {
  const P = planner(world, now);
  const plan = P.planTransitTrip(at('s0', 0), at('s' + to, to), { secs: now, day: 'weekday', prev: 'prev', date: new Date() });
  return plan && plan.options.filter(sameMorning);
};

test('baseline: A arrives 8:20, B leaves 8:22 (2 min): a transfer is offered', () => {
  const o = planOne(base());
  assert.ok(o && o.some((x) => x.type === 'transfer'), 'no transfer found');
});
test('a bus that waits at the stop is left at its arrival time, not its departure', () => {
  // A reaches s1 at 8:20 but stays until 8:30 (dwell 600 s; du 3600 s, f .5); B leaves 8:25: only catchable by getting off on arrival
  const w = base({
    patterns: [{ r: 0, s: ['s0', 's1', 's2'], f: [0, 0.5, 1], w: [0, 600, 0] }, { r: 1, s: ['s1', 's3'], f: [0, 1] }],
    days: { weekday: [[0, 8 * H, 3600], [1, 8 * H + 1500, 600]], prev: [] },
  });
  const o = planOne(w, 3);
  const it = o && o.find((x) => x.type === 'transfer');
  assert.ok(it, 'the connection during the dwell was not found');
  assert.equal(Math.round(it.schedTrip1.arrSec), 8 * H + 1200 - 0, 'arrival at s1 should be 8:20, the bus gets in 10 min before it leaves');
});
test('agency minimum transfer time: 179 s fails, 180 s works (rule 180 s at s1, route a to b)', () => {
  const mk = (gap) => base({ days: { weekday: [[0, 8 * H, 1200], [1, 8 * H + 1200 + gap, 600]], prev: [] }, xfer: [['s1', 's1', 0, 1, 180]] });
  const early = planOne(mk(179)), ok = planOne(mk(180));
  assert.ok(!(early || []).some((x) => x.type === 'transfer' && x.sig && x.sig.includes('a@')), '179 s should be refused');
  assert.ok((ok || []).some((x) => x.type === 'transfer'), '180 s should be allowed');
});
test('without a rule a 121 s change still works and 119 s does not', () => {
  const mk = (gap) => base({ days: { weekday: [[0, 8 * H, 1200], [1, 8 * H + 1200 + gap, 600]], prev: [] } });
  assert.ok((planOne(mk(121)) || []).some((x) => x.type === 'transfer'));
  assert.ok(!(planOne(mk(119)) || []).some((x) => x.type === 'transfer'));
});
test('stay aboard only when the vehicle block goes on: linked trips share a vehicle with no buffer', () => {
  const mk = (linked) => base({ days: { weekday: [[0, 8 * H, 1200], [1, 8 * H + 1200, 600]], prev: [] }, through: linked ? [[0, 8 * H, 1, 8 * H + 1200]] : [] });
  const yes = planOne(mk(true)), no = planOne(mk(false));
  const t = (yes || []).find((x) => x.type === 'transfer');
  assert.ok(t && t.stayOn === true, 'linked trips: a stay-aboard transfer with no wait');
  assert.ok(!(no || []).some((x) => x.type === 'transfer'), 'unlinked routes meeting with 0 s are not a connection');
});
test('the headsign is the trip\'s own sign, not the route pattern that overlaps most', () => {
  const w = base({
    patterns: [{ r: 0, s: ['s0', 's1', 's2'], f: [0, 0.5, 1], h: 'Northgate Station' }],
    routePatterns: { a: [{ headsign: 'Lynnwood City Center Station', stops: ['s0', 's1', 's2', 's3'] }] },
    days: { weekday: [[0, 8 * H, 1800]], prev: [] },
  });
  const o = planOne(w, 2);
  const d = (o || []).find((x) => x.type === 'direct');
  assert.ok(d, 'direct trip expected');
  assert.equal(d.pattern.headsign, 'Northgate Station');
});

// Arrive by
const ferry = (over = {}) => ({
  stops: ['dock1', 'dock2'], routes: [{ id: 'ferry', cat: 'ferry' }],
  patterns: [{ r: 0, s: ['dock1', 'dock2'], f: [0, 1] }],
  // the 11:30 PM sailing is the previous service day's: it ends 11:50 PM, before the new day starts
  days: { weekday: [], prev: [[0, 23 * H + 1800, 1200]] }, ...over,
});
test('Arrive by 12:05 AM finds the 11:30 PM sailing of the evening before', () => {
  const P = planner(ferry());
  const req = { secs: 300, day: 'weekday', prev: 'prev', date: new Date(Date.now() + 3 * 86400000) };
  const plan = P.planArriveBy(at('dock1', 0), at('dock2', 1), req);
  assert.ok(plan.options.length >= 1, `no option; got ${JSON.stringify(plan)}`);
  assert.ok(plan.options[0].arrivalSec <= 300 + 30);
});
test('Arrive by never asks for a departure already past', () => {
  // now = 11:55 AM (43500 s); deadline 12:05 PM; the only sailing left at 11:47 AM
  const P = planner({ ...ferry(), days: { weekday: [[0, 11 * H + 47 * 60, 960]], prev: [] } }, 43500);
  const req = { secs: 12 * H + 300, day: 'weekday', prev: 'prev', date: new Date(Date.now() + 10 * 60000) };
  const plan = P.planArriveBy(at('dock1', 0), at('dock2', 1), req);
  assert.equal(plan.options.length, 0, 'a 11:47 AM departure is in the past');
  assert.equal(!!plan.tooSoon, true, 'the plan should say the deadline cannot be reached from now');
});
test('Arrive by from now still offers a sailing that has not left', () => {
  const P = planner({ ...ferry(), days: { weekday: [[0, 12 * H, 960]], prev: [] } }, 43500);
  const req = { secs: 12 * H + 1200, day: 'weekday', prev: 'prev', date: new Date(Date.now() + 25 * 60000) };
  const plan = P.planArriveBy(at('dock1', 0), at('dock2', 1), req);
  assert.equal(plan.options.length, 1);
});

let failed = 0;
if (require.main === module) for (const [r, n, m] of rows) { console.log(`${r === 'PASS' ? '✓' : '✗'} ${r} ${n}${m ? '\n    ' + m : ''}`); if (r === 'FAIL') failed++; }
if (require.main === module) console.log(failed ? `${failed} FAILED` : `ALL ${rows.length} AUDIT PLANNER CHECKS PASSED`);
if (require.main === module) process.exit(failed ? 1 : 0);
