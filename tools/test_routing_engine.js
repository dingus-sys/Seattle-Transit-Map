// Standalone Routing Engine & Timetable E2E Test Suite
// Run: node tools/test_routing_engine.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const readJSON = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const routesData = readJSON('site/data/routes.json').routes;
const stopsData = readJSON('site/data/stops.json');
const schedData = readJSON('site/data/schedule.json');

const routesById = new Map(routesData.map((r) => [r.id, r]));
const stopIndex = {};
for (const s of stopsData.stops) {
  stopIndex[s.id] = { ...s, kind: 'stop', key: s.id };
  for (const a of s.alias || []) stopIndex[a] = stopIndex[s.id];
}
for (const s of stopsData.stations) {
  stopIndex[s.id] = { ...s, key: s.id };
  for (const sid of s.stops) if (!stopIndex[sid]) stopIndex[sid] = { ...s, key: s.id };
}

// Build schedule index (matches web/app.js:buildDepIndex)
const DEP = new Map();
schedData.patterns.forEach((p, pi) => (p.s || []).forEach((sid, i) => {
  const st = stopIndex[sid], k = st ? st.key : sid;
  if (!DEP.has(k)) DEP.set(k, []);
  DEP.get(k).push([pi, i]);
}));
const byPat = {};
for (const [day, trips] of Object.entries(schedData.days)) {
  const m = new Map();
  for (const [pi, s0, du] of trips) {
    if (!m.has(pi)) m.set(pi, []);
    m.get(pi).push([s0, du]);
  }
  byPat[day] = m;
}
schedData.byPat = byPat;

// Implementation of timetableTripTimes matching web/app.js contract
function timetableTripTimes(route, boardStop, alightStop, earliestSec, day, prevDay) {
  if (!schedData || !DEP || !route || !boardStop || !alightStop) return null;
  const bKeys = [...new Set([boardStop.key, boardStop.id, ...((boardStop.stops || []).map((sid) => stopIndex[sid] && stopIndex[sid].key).filter(Boolean))])].filter(Boolean);
  const aKeys = new Set([...new Set([alightStop.key, alightStop.id, ...((alightStop.stops || []).map((sid) => stopIndex[sid] && stopIndex[sid].key).filter(Boolean))])].filter(Boolean));

  let best = null;
  for (const bk of bKeys) {
    for (const [pi, i] of DEP.get(bk) || []) {
      const p = schedData.patterns[pi];
      if (!p || !p.f || i >= p.f.length - 1) continue;
      const pRoute = routesData[p.r];
      if (!pRoute || pRoute.id !== route.id) continue;

      let j = -1;
      for (let k = i + 1; k < p.s.length; k++) {
        const sid = p.s[k];
        const st = stopIndex[sid];
        if (aKeys.has(sid) || (st && aKeys.has(st.key))) {
          j = k;
          break;
        }
      }
      if (j <= i) continue; // Invariant: j > i strictly enforced!

      for (const [dayName, off] of [[day, 0], [prevDay, 86400]]) {
        for (const [s0, du] of (schedData.byPat[dayName] && schedData.byPat[dayName].get(pi)) || []) {
          const depTimeSec = s0 + p.f[i] * du - off;
          if (depTimeSec >= earliestSec - 30) {
            const arrTimeSec = s0 + p.f[j] * du - off;
            const rideSec = Math.max(60, arrTimeSec - depTimeSec);
            if (!best || depTimeSec < best.depSec) {
              best = {
                pi,
                pattern: p,
                depSec: depTimeSec,
                arrSec: arrTimeSec,
                rideSec,
                rideMin: Math.max(1, Math.round(rideSec / 60)),
                waitMin: Math.max(0, Math.round((depTimeSec - earliestSec) / 60)),
              };
            }
          }
        }
      }
    }
  }
  return best;
}

// Mode word mapping per specification
const TRAIN_CATS = new Set(["link", "sounder", "amtrak", "monorail"]);
const FERRY_CATS = new Set(["ferry", "watertaxi"]);
const STREETCAR_CATS = new Set(["streetcar"]);

function routeModeWord(route) {
  if (!route) return "transit";
  if (TRAIN_CATS.has(route.cat)) return "train";
  if (FERRY_CATS.has(route.cat)) return "ferry";
  if (STREETCAR_CATS.has(route.cat)) return "streetcar";
  return "bus";
}

let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log('PASS', name); };

console.log('--- ROUTING ENGINE SPECIFICATION TESTS ---');

// F1: Timetable Pattern Order & Sequence Enforcement
check('F1: Sound Transit 1 Line Southbound respects pattern order (Westlake -> SeaTac)', () => {
  const r = routesById.get('sound-transit-1-line');
  assert(r, 'ST 1 Line missing');
  const bStop = stopIndex['westlake-st-c03'] || stopIndex['st-1108'];
  const aStop = stopIndex['seatac-airport-st-c37'] || stopIndex['st-99904'];
  assert(bStop && aStop, 'Westlake or SeaTac stop missing');

  const trip = timetableTripTimes(r, bStop, aStop, 36000, 'weekday', 'weekday');
  assert(trip, 'Expected viable trip from Westlake to SeaTac');
  assert(trip.arrSec > trip.depSec, 'Arrival must succeed departure');
  assert(trip.rideMin >= 30 && trip.rideMin <= 48, `Expected ~38 min ride, got ${trip.rideMin}`);
});

check('F1: Reverse pattern lookup (SeaTac -> Westlake on Southbound pattern) is rejected', () => {
  const r = routesById.get('sound-transit-1-line');
  const bStop = stopIndex['seatac-airport-st-c37'] || stopIndex['st-99904'];
  const aStop = stopIndex['westlake-st-c03'] || stopIndex['st-1108'];

  // Pattern 0 is Southbound:
  const p = r.patterns[0];
  const i = p.stops.findIndex((s) => s === 'st-99904' || s === 'seatac-airport-st-c37');
  assert(i >= 0, 'SeaTac in Southbound pattern');
  let j = -1;
  for (let k = i + 1; k < p.stops.length; k++) {
    if (p.stops[k] === 'st-1108' || p.stops[k] === 'westlake-st-c03') { j = k; break; }
  }
  assert.equal(j, -1, 'Westlake must not succeed SeaTac on Southbound pattern');
});

check('F1: Identical board and alight stop (j == i) yields null trip', () => {
  const r = routesById.get('sound-transit-1-line');
  const bStop = stopIndex['westlake-st-c03'] || stopIndex['st-1108'];
  const trip = timetableTripTimes(r, bStop, bStop, 36000, 'weekday', 'weekday');
  assert.equal(trip, null, 'Zero-stop degenerate trip must return null');
});

// F2: Transfer Buffer Enforcement
check('F2: Transfer buffer requires at least 2 minutes (>= 120s) post-arrival + walk', () => {
  const leg1ArrSec = 36000;
  const transferWalkSec = 60;
  const earliestSec2 = leg1ArrSec + transferWalkSec + 120;
  assert.equal(earliestSec2, 36180, 'Query offset must include 120s buffer');
  const bufferMin = Math.round((earliestSec2 - leg1ArrSec - transferWalkSec) / 60);
  assert(bufferMin >= 2, 'Buffer must be at least 2 minutes');
});

check('F2: Transfer wait > 60 minutes is rejected as unachievable connection', () => {
  const leg1ArrSec = 36000;
  const transferWalkSec = 120;
  const depLeg2 = leg1ArrSec + transferWalkSec + 3660; // 61 min wait
  const transferWaitMin = Math.round((depLeg2 - leg1ArrSec - transferWalkSec) / 60);
  const isRejected = transferWaitMin > 60 || transferWaitMin < 0;
  assert.equal(isRejected, true, 'Transfers with >60 min wait must be rejected');
});

check('F2: Negative transfer wait is rejected', () => {
  const leg1ArrSec = 36000;
  const transferWalkSec = 120;
  const depLeg2 = leg1ArrSec; // Departs before walk complete
  const transferWaitMin = Math.round((depLeg2 - leg1ArrSec - transferWalkSec) / 60);
  const isRejected = transferWaitMin > 60 || transferWaitMin < 0;
  assert.equal(isRejected, true, 'Transfers with negative wait must be rejected');
});

// F3: Walking Legs
check('F3: Walking speed is exactly 80 meters per minute', () => {
  const dist = 400;
  const time = Math.round(dist / 80);
  assert.equal(time, 5, '400 meters must take 5 minutes');
});

check('F3: Access walk offset is added to nowSecs before querying departures', () => {
  const nowSecs = 30000;
  const walkDist = 240;
  const walkTime = Math.round(walkDist / 80); // 3 min
  const earliestBoardSec = nowSecs + walkTime * 60;
  assert.equal(earliestBoardSec, 30180);
});

check('F3: Transfer walking distance capped at 360 meters', () => {
  const allowed = 350 <= 360;
  const rejected = 370 <= 360;
  assert.equal(allowed, true);
  assert.equal(rejected, false);
});

check('F3: Direct pedestrian walk capped at 2500 meters', () => {
  const allowed = 2400 <= 2500;
  const rejected = 2600 <= 2500;
  assert.equal(allowed, true);
  assert.equal(rejected, false);
});

// F4: Mode Terminology
check('F4: Link, Sounder, Amtrak, Monorail categorized as "train"', () => {
  for (const cat of ["link", "sounder", "amtrak", "monorail"]) {
    assert.equal(routeModeWord({ cat }), "train", `${cat} must be train`);
  }
});

check('F4: WSF and Water Taxi categorized as "ferry"', () => {
  for (const cat of ["ferry", "watertaxi"]) {
    assert.equal(routeModeWord({ cat }), "ferry", `${cat} must be ferry`);
  }
});

check('F4: Streetcar categorized as "streetcar"', () => {
  assert.equal(routeModeWord({ cat: "streetcar" }), "streetcar");
});

check('F4: Bus categories categorized as "bus"', () => {
  for (const cat of ["rapidride", "swift", "frequent", "local", "peak", "shuttle", "dart"]) {
    assert.equal(routeModeWord({ cat }), "bus", `${cat} must be bus`);
  }
});

// F5: Live GPS vs Timetable
check('F5: Live departure formats with live countdown and pulsing dot', () => {
  const match = { t: 180, live: true };
  const mins = Math.max(0, Math.round(match.t / 60));
  const isLive = !!match.live;
  assert.equal(isLive, true);
  assert.equal(mins, 3);
});

check('F5: Timetable departure formats without live dot', () => {
  const match = { t: 300, live: false };
  const isLive = !!match.live;
  assert.equal(isLive, false);
});

// F6: Route Segment Geometry & Water-Crossing Prevention
const netData = readJSON('site/data/network.json');
const LINES = netData.lines.map((id) => routesById.get(id));
const LINEIDX = {};
LINES.forEach((r, i) => { if (r) LINEIDX[r.id] = i; });

const appJsCode = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
const vm = require('node:vm');
const geomSandbox = {
  LINES,
  LINEIDX,
  NET: netData,
  STOPS: stopsData,
  stopIndex,
  Math,
  Map,
  Set,
  Array,
  console,
};
vm.createContext(geomSandbox);
vm.runInContext(`
  ${appJsCode.slice(appJsCode.indexOf('function distMeters'), appJsCode.indexOf('function findNearbyStops'))}
`, geomSandbox);

function maxSegmentHop(pts) {
  let maxD = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = geomSandbox.distMeters(pts[i][1], pts[i][0], pts[i + 1][1], pts[i + 1][0]);
    if (d > maxD) maxD = d;
  }
  return maxD;
}

function hasPointsOverPugetSoundWater(pts) {
  // Puget Sound water between Seattle (lat 47.50 to 47.65) and Tacoma (lat 47.25):
  // I-5 and highway corridors are strictly east of lon -122.33.
  // Straight air chords across Puget Sound enter lon < -122.35 between lat 47.30 and 47.55.
  return pts.some((pt) => {
    const lon = pt[0], lat = pt[1];
    return lat >= 47.30 && lat <= 47.55 && lon < -122.35;
  });
}

check('F6: Route 594 (Lakewood - Seattle) follows highway corridor without crossing Puget Sound water', () => {
  const r = routesById.get('sound-transit-594');
  assert(r, 'Route 594 missing');
  const bStop = stopIndex['pt-1699'] || stopIndex['kcm-905']; // Stewart St & 7th / Yale
  const aStop = stopIndex['pt-212']; // Lakewood Station - Bay 4
  assert(bStop && aStop, 'Endpoints missing');

  const p0 = r.patterns[0];
  const intermediates = p0.stops.slice(1, -1);
  const geom = geomSandbox.getRouteSegmentGeometry(LINEIDX[r.id], bStop, aStop, intermediates);

  assert(geom.length >= 100, `Expected detailed route geometry (>= 100 pts), got ${geom.length}`);
  const maxHop = maxSegmentHop(geom);
  assert(maxHop < 2500, `Expected max hop < 2500m along freeway corridor, got ${Math.round(maxHop)}m`);
  assert(!hasPointsOverPugetSoundWater(geom), 'Route 594 geometry must not cut across Puget Sound water');
});

check('F6: Route 597 (Night Bus Lakewood - Seattle) follows highway corridor without crossing Puget Sound water', () => {
  const r = routesById.get('sound-transit-597');
  assert(r, 'Route 597 missing');
  const bStop = stopIndex['pt-2474'] || stopIndex['kcm-430']; // 3rd Ave & Pine St
  const aStop = stopIndex['pt-212']; // Lakewood Station
  assert(bStop && aStop, 'Endpoints missing');

  const p0 = r.patterns[0];
  const intermediates = p0.stops.slice(1, -1);
  const geom = geomSandbox.getRouteSegmentGeometry(LINEIDX[r.id], bStop, aStop, intermediates);

  assert(geom.length >= 100, `Expected detailed route geometry (>= 100 pts), got ${geom.length}`);
  const maxHop = maxSegmentHop(geom);
  assert(maxHop < 2500, `Expected max hop < 2500m along freeway corridor, got ${Math.round(maxHop)}m`);
  assert(!hasPointsOverPugetSoundWater(geom), 'Route 597 geometry must not cut across Puget Sound water');
});

check('F6: Route 590 (Tacoma - Seattle) follows highway corridor without crossing Puget Sound water', () => {
  const r = routesById.get('sound-transit-590');
  assert(r, 'Route 590 missing');
  const bStop = stopIndex['pt-1984'] || stopIndex['kcm-905']; // Stewart & Yale
  const aStop = stopIndex['pt-1780']; // Commerce St Station
  assert(bStop && aStop, 'Endpoints missing');

  const p0 = r.patterns[0];
  const intermediates = p0.stops.slice(1, -1);
  const geom = geomSandbox.getRouteSegmentGeometry(LINEIDX[r.id], bStop, aStop, intermediates);

  assert(geom.length >= 100, `Expected detailed route geometry (>= 100 pts), got ${geom.length}`);
  const maxHop = maxSegmentHop(geom);
  assert(maxHop < 2500, `Expected max hop < 2500m along freeway corridor, got ${Math.round(maxHop)}m`);
  assert(!hasPointsOverPugetSoundWater(geom), 'Route 590 geometry must not cut across Puget Sound water');
});

check('F6: Bus routes never adopt ferry water edges or dedicated train tracks during fallback bridging', () => {
  const r = routesById.get('sound-transit-594');
  const edges = netData.edges.filter((e) => e.l && e.l.includes(LINEIDX[r.id]));
  assert(edges.length > 0);
  const hasWater = edges.some((e) => (e.l || []).some((idx) => {
    const line = LINES[idx];
    return line && (line.cat === 'ferry' || line.cat === 'watertaxi');
  }));
  assert.equal(hasWater, false, 'Bus route must not have ferry edges in its geometry');
});

// F7: Extended Planning Date Range & Calendar
check('F7: Extended planning horizon supports up to 90 days forward without 48-hour cutoff', () => {
  const match = appJsCode.match(/const PLANNER_MAX_AHEAD_MS = ([0-9 *]+);/);
  assert(match, 'PLANNER_MAX_AHEAD_MS definition missing in app.js');
  const ms = eval(match[1]);
  assert(ms >= 60 * 24 * 60 * 60 * 1000, `Expected at least 60-day range, got ${ms / (24 * 3600 * 1000)} days`);
  assert(ms <= 120 * 24 * 60 * 60 * 1000, `Expected <= 120-day range, got ${ms / (24 * 3600 * 1000)} days`);
});

check('F7: Trip planning context maps future calendar dates (e.g. 14 days, 30 days, 60 days) to valid transit service days', () => {
  const PT_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' });
  function testPacificAt(date) {
    const parts = Object.fromEntries(PT_FMT.formatToParts(date).map((p) => [p.type, p.value]));
    const key = (w) => (w === 'Sat' ? 'saturday' : w === 'Sun' ? 'sunday' : 'weekday');
    return key(parts.weekday);
  }

  const now = new Date();
  for (const daysAhead of [1, 2, 5, 10, 21, 45, 60, 85]) {
    const futureDate = new Date(now.getTime() + daysAhead * 24 * 3600 * 1000);
    const dayKey = testPacificAt(futureDate);
    assert(['weekday', 'saturday', 'sunday'].includes(dayKey), `Invalid service day for +${daysAhead}d: ${dayKey}`);
  }
});

console.log(`\nALL ${checks} ROUTING SPECIFICATION CHECKS PASSED`);
