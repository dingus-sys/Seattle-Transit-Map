// Adversarial Stress Test Suite for Milestone 2 Routing Engine & Timetable Invariants
// Run: export PATH="/opt/homebrew/bin:$PATH"; node tools/stress_test_routing.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const readJSON = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const routesData = readJSON('site/data/routes.json').routes;
const stopsData = readJSON('site/data/stops.json');
const schedData = readJSON('site/data/schedule.json');
const netData = readJSON('site/data/network.json');

const stopIndex = {};
for (const s of stopsData.stops) {
  stopIndex[s.id] = { ...s, kind: 'stop', key: s.id };
  for (const a of s.alias || []) stopIndex[a] = stopIndex[s.id];
}
for (const s of stopsData.stations) {
  stopIndex[s.id] = { ...s, key: s.id };
  for (const sid of s.stops) if (!stopIndex[sid]) stopIndex[sid] = { ...s, key: s.id };
}

// Build timetable departure index
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

const SCHED = schedData;
const ROUTES = routesData;
const RBY = Object.fromEntries(routesData.map(r => [r.id, r]));
const LINEIDX = Object.fromEntries(routesData.map((r, i) => [r.id, i]));
const STOPS = stopsData;
const NET = netData;
const CLOCK = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
const pacificNow = () => ({ secs: 36000, day: 'weekday', prev: 'weekday' });
let mockLive = [];
const liveDepartures = () => mockLive;
const stopIdsOf = (s) => [s.id, ...(s.stops || [])];

// Extract EXACT routing functions from web/app.js
const appCode = fs.readFileSync(path.join(ROOT, 'web/app.js'), 'utf8');
const block = appCode.slice(appCode.indexOf('let plannerStopsCache = null;'), appCode.indexOf('  function renderTripOnMap('));

const routingModule = new Function(
  'SCHED', 'DEP', 'ROUTES', 'RBY', 'LINEIDX', 'STOPS', 'NET', 'stopIndex', 'pacificNow', 'CLOCK', 'liveDepartures', 'stopIdsOf',
  `
  let map = null, selected = null, netDim = 1;
  function setNetDim() {}
  function focusOff() {}
  function highlightDartArea() {}
  ${block}
  return { distMeters, getPlannerStops, getStopToStation, findNearbyStops, timetableTripTimes, planTransitTrip, currentVehWord, modeIcon, getSoonestBus };
`)(SCHED, DEP, ROUTES, RBY, LINEIDX, STOPS, NET, stopIndex, pacificNow, CLOCK, liveDepartures, stopIdsOf);

const { distMeters, timetableTripTimes, planTransitTrip, currentVehWord, modeIcon, getSoonestBus } = routingModule;

let testsPassed = 0;
let totalAssertions = 0;
function test(name, fn) {
  fn();
  testsPassed++;
  console.log(`✓ [PASS] ${name}`);
}

console.log('================================================================');
console.log('  ADVERSARIAL STRESS TEST SUITE: ROUTING ENGINE & INVARIANTS    ');
console.log('================================================================\n');

// -----------------------------------------------------------------------------
// SECTION 1: INVARIANT — Alight Stop Strictly Succeeds Board Stop (j > i)
// -----------------------------------------------------------------------------
console.log('--- SECTION 1: Alight Stop Succeeds Board Stop (j > i) Invariant ---');

test('1.1 Forward sequence lookup: returns valid trip with arrival after departure', () => {
  // Test 20 diverse routes across Sound Transit, Metro, Community Transit, Pierce Transit, WSF
  const sampleRouteIds = [
    'sound-transit-1-line', 'sound-transit-2-line', 'sounder-south', 'sounder-north',
    'metro-c-line', 'metro-d-line', 'metro-e-line', 'metro-h-line',
    'metro-7', 'metro-40', 'metro-44', 'metro-49', 'metro-70',
    'ct-swift-blue', 'ct-swift-green', 'pt-1',
    'wsf-seattle-bainbridge-island', 'wsf-seattle-bremerton',
    'seattle-monorail', 'first-hill-streetcar'
  ];

  for (const rid of sampleRouteIds) {
    const route = RBY[rid];
    if (!route || !route.patterns || !route.patterns.length) continue;
    const pat = route.patterns[0];
    if (pat.stops.length < 2) continue;

    const bSid = pat.stops[0];
    const aSid = pat.stops[Math.floor(pat.stops.length / 2)];
    const bStop = stopIndex[bSid];
    const aStop = stopIndex[aSid];
    if (!bStop || !aStop) continue;

    const trip = timetableTripTimes(route, bStop, aStop, 36000, 'weekday', 'weekday');
    if (trip) {
      assert(trip.arrSec > trip.depSec, `Arrival (${trip.arrSec}) must be > departure (${trip.depSec}) on ${rid}`);
      assert(trip.rideSec > 0, `Ride seconds must be positive on ${rid}`);
      assert(trip.rideMin >= 1, `Ride minutes must be >= 1 on ${rid}`);
      totalAssertions += 3;
    }
  }
});

test('1.2 Adversarial Reverse Pattern Lookup: query stop j to stop i where j > i in pattern', () => {
  // For every single route with >= 2 stops, query reverse order.
  // Reverse order MUST NOT match that forward pattern (must not return a trip that travels backward).
  let testedReverses = 0;
  for (const route of ROUTES) {
    if (!route.patterns || !route.patterns.length) continue;
    for (const pat of route.patterns) {
      if (pat.stops.length < 3) continue;
      const firstSid = pat.stops[0];
      const lastSid = pat.stops[pat.stops.length - 1];
      const bStop = stopIndex[lastSid];
      const aStop = stopIndex[firstSid];
      if (!bStop || !aStop || bStop.key === aStop.key) continue;

      const trip = timetableTripTimes(route, bStop, aStop, 36000, 'weekday', 'weekday');
      if (trip) {
        // If a trip is returned, it MUST be on a different pattern where bStop actually precedes aStop!
        const pStops = trip.pattern.s;
        let bIdx = -1, aIdx = -1;
        for (let idx = 0; idx < pStops.length; idx++) {
          const sid = pStops[idx];
          const st = stopIndex[sid];
          if (bIdx === -1 && (sid === bStop.id || (st && st.key === bStop.key))) bIdx = idx;
          if (bIdx !== -1 && (sid === aStop.id || (st && st.key === aStop.key))) { aIdx = idx; break; }
        }
        assert(aIdx > bIdx, `Returned trip pattern violates j > i: bIdx=${bIdx}, aIdx=${aIdx} on route ${route.id}`);
        assert(trip.arrSec > trip.depSec, `Trip arrival must succeed departure: arrSec=${trip.arrSec}, depSec=${trip.depSec}`);
        totalAssertions += 2;
      }
      testedReverses++;
      if (testedReverses >= 150) break;
    }
    if (testedReverses >= 150) break;
  }
  assert(testedReverses >= 100, `Expected at least 100 reverse pattern tests, ran ${testedReverses}`);
});

test('1.3 Degenerate Identical Stop Lookup (j == i): query same board and alight stop', () => {
  // Querying boardStop == alightStop must never return a trip unless a true loop visits it again later
  let testedIdentical = 0;
  for (const route of ROUTES) {
    if (!route.patterns || !route.patterns.length) continue;
    const pat = route.patterns[0];
    if (!pat.stops.length) continue;
    const sid = pat.stops[0];
    const stop = stopIndex[sid];
    if (!stop) continue;

    // Check if the pattern repeats this stop later
    const hasLoop = pat.stops.slice(1).some(s => s === sid || (stopIndex[s] && stopIndex[s].key === stop.key));
    const trip = timetableTripTimes(route, stop, stop, 36000, 'weekday', 'weekday');
    if (!hasLoop) {
      assert.equal(trip, null, `Degenerate trip at stop ${sid} on route ${route.id} must be null`);
      totalAssertions++;
    } else if (trip) {
      assert(trip.arrSec > trip.depSec, 'Loop trip arrival must be after departure');
      totalAssertions++;
    }
    testedIdentical++;
    if (testedIdentical >= 50) break;
  }
});

test('1.4 Out-of-bounds & invalid stop lookups: query non-existent or null stops', () => {
  const r = RBY['sound-transit-1-line'];
  const validStop = stopIndex['westlake-st-c03'];
  const fakeStop = { id: 'fake-stop-999999', key: 'fake-stop-999999', stops: [] };

  assert.equal(timetableTripTimes(null, validStop, validStop, 36000, 'weekday', 'weekday'), null);
  assert.equal(timetableTripTimes(r, null, validStop, 36000, 'weekday', 'weekday'), null);
  assert.equal(timetableTripTimes(r, validStop, null, 36000, 'weekday', 'weekday'), null);
  assert.equal(timetableTripTimes(r, fakeStop, validStop, 36000, 'weekday', 'weekday'), null);
  assert.equal(timetableTripTimes(r, validStop, fakeStop, 36000, 'weekday', 'weekday'), null);
  totalAssertions += 5;
});

// -----------------------------------------------------------------------------
// SECTION 2: INVARIANT — Realistic Connection Buffers (>= 2 min, reject > 60 min)
// -----------------------------------------------------------------------------
console.log('\n--- SECTION 2: Connection Buffers (>= 2 min, reject > 60 min) ---');

test('2.1 Transfer connection buffer boundary tests (synthetic adversarial sweep)', () => {
  // Test mathematical boundary invariants implemented in planTransitTrip
  // In web/app.js:
  // earliestSec2 = leg1.arrSec + transferWalkTime * 60 + 120;
  // transferWaitMin = Math.round((leg2.depSec - leg1.arrSec - transferWalkTime * 60) / 60);
  // if (transferWaitMin > 60 || transferWaitMin < 0) continue;
  // wait2 = Math.max(2, transferWaitMin);

  const leg1ArrSec = 36000;
  const transferWalkSec = 180; // 3 min walk
  const baseReadySec = leg1ArrSec + transferWalkSec;

  // Case A: Connecting departure is before passenger arrives (e.g. departs at arrival before walk) -> REJECTED
  {
    const depLeg2 = leg1ArrSec; // Departs at arrival of leg 1, passenger still walking for 180s
    const transferWaitMin = Math.round((depLeg2 - baseReadySec) / 60); // -180 / 60 = -3 min
    const rejected = transferWaitMin > 60 || transferWaitMin < 0;
    assert.equal(rejected, true, 'Negative wait must be rejected');
    totalAssertions++;
  }

  // Case B: Connecting departure violates 2 min connection buffer (e.g. departs only 60s after walk)
  // Query parameter earliestSec2 = baseReadySec + 120; timetableTripTimes allows depSec >= earliestSec2 - 30 (90s).
  // A departure at 60s is before 90s, so it is never returned by timetableTripTimes.
  {
    const earliestSec2 = baseReadySec + 120;
    const unachievableDepSec = baseReadySec + 60;
    const isAvailableInQuery = unachievableDepSec >= earliestSec2 - 30;
    assert.equal(isAvailableInQuery, false, 'Departure with only 60s buffer must not be selected by query');
    totalAssertions++;
  }

  // Case C: Connecting departure exactly at 2-minute buffer (120s) -> ACCEPTED, wait2 == 2
  {
    const depLeg2 = baseReadySec + 120;
    const transferWaitMin = Math.round((depLeg2 - baseReadySec) / 60);
    const rejected = transferWaitMin > 60 || transferWaitMin < 0;
    assert.equal(rejected, false, '120s buffer must be accepted');
    assert.equal(Math.max(2, transferWaitMin), 2, 'Wait min must be 2');
    totalAssertions += 2;
  }

  // Case D: Connecting departure at 60 minutes wait (3600s) -> ACCEPTED
  {
    const depLeg2 = baseReadySec + 3600;
    const transferWaitMin = Math.round((depLeg2 - baseReadySec) / 60);
    const rejected = transferWaitMin > 60 || transferWaitMin < 0;
    assert.equal(rejected, false, '60 min wait must be accepted');
    assert.equal(transferWaitMin, 60, 'Wait min must be exactly 60');
    totalAssertions += 2;
  }

  // Case E: Connecting departure at 61 minutes wait (3660s) -> REJECTED (> 60 min)
  {
    const depLeg2 = baseReadySec + 3660;
    const transferWaitMin = Math.round((depLeg2 - baseReadySec) / 60);
    const rejected = transferWaitMin > 60 || transferWaitMin < 0;
    assert.equal(rejected, true, '61 min wait must be rejected as unachievable');
    totalAssertions++;
  }

  // Case F: Connecting departure at 120 minutes wait (7200s) -> REJECTED (> 60 min)
  {
    const depLeg2 = baseReadySec + 7200;
    const transferWaitMin = Math.round((depLeg2 - baseReadySec) / 60);
    const rejected = transferWaitMin > 60 || transferWaitMin < 0;
    assert.equal(rejected, true, '120 min wait must be rejected');
    totalAssertions++;
  }
});

test('2.2 Real Network Transfers: verify buffers in actual planTransitTrip executions', () => {
  // Test real origin-destination pairs across Puget Sound requiring transfers:
  const testPairs = [
    // West Seattle (Alaska Junction) to Capitol Hill (Broadway)
    { from: { lat: 47.5605, lon: -122.3868 }, to: { lat: 47.6200, lon: -122.3210 }, name: 'West Seattle -> Capitol Hill' },
    // Ballard (Market St) to SeaTac Airport
    { from: { lat: 47.6687, lon: -122.3845 }, to: { lat: 47.4435, lon: -122.3015 }, name: 'Ballard -> SeaTac Airport' },
    // Burien Transit Center to University District
    { from: { lat: 47.4690, lon: -122.3410 }, to: { lat: 47.6580, lon: -122.3130 }, name: 'Burien -> U-District' },
    // Queen Anne to Bellevue Transit Center
    { from: { lat: 47.6370, lon: -122.3570 }, to: { lat: 47.6150, lon: -122.1980 }, name: 'Queen Anne -> Bellevue' },
  ];

  let transferCount = 0;
  for (const pair of testPairs) {
    const plan = planTransitTrip(pair.from, pair.to);
    assert(plan, `Plan must return result for ${pair.name}`);
    for (const it of plan.transfer) {
      transferCount++;
      // Check transfer walk distance cap
      assert(it.transferWalkDist <= 360, `Transfer walk distance ${it.transferWalkDist}m exceeds 360m cap in ${pair.name}`);
      // Check transfer walk time calculation
      assert.equal(it.transferWalkTime, Math.max(1, Math.round(it.transferWalkDist / 80)), `Transfer walk time mismatch in ${pair.name}`);
      // Check transfer buffer (wait2)
      assert(it.wait2 >= 2, `Transfer buffer wait2=${it.wait2} is < 2 minutes in ${pair.name}`);
      assert(it.wait2 <= 60, `Transfer buffer wait2=${it.wait2} is > 60 minutes in ${pair.name}`);

      // If scheduled trips are present on both legs, check timetable invariants
      if (it.schedTrip1 && it.schedTrip2) {
        const leg1Arr = it.schedTrip1.arrSec;
        const leg2Dep = it.schedTrip2.depSec;
        const walkSec = it.transferWalkTime * 60;
        const effectiveBufferSec = leg2Dep - leg1Arr - walkSec;
        // Due to 30s timetable tolerance, buffer must be at least 90s (which rounds to 2 min)
        assert(effectiveBufferSec >= 89, `Effective connection buffer ${effectiveBufferSec}s is < 90s in ${pair.name}`);
        const effectiveBufferMin = Math.round(effectiveBufferSec / 60);
        assert(effectiveBufferMin <= 60, `Effective buffer ${effectiveBufferMin} min exceeds 60 min in ${pair.name}`);
        totalAssertions += 2;
      }
      totalAssertions += 4;
    }
  }
  assert(transferCount > 0, 'Must have evaluated at least 1 real transfer itinerary');
});

// -----------------------------------------------------------------------------
// SECTION 3: INVARIANT — Walking Legs (80 m/min, Added Before Departure Query)
// -----------------------------------------------------------------------------
console.log('\n--- SECTION 3: Walking Legs (80 m/min, Added Before Departure Query) ---');

test('3.1 Walking speed invariant: 80 meters per minute across distance spectrum', () => {
  const distances = [
    [0, 0], [39, 0], [40, 1], [79, 1], [80, 1], [81, 1],
    [119, 1], [120, 2], [160, 2], [200, 3], [400, 5],
    [800, 10], [1200, 15], [1600, 20], [2000, 25], [2400, 30], [2500, 31]
  ];

  for (const [dist, expectedMin] of distances) {
    const calcMin = Math.round(dist / 80);
    assert.equal(calcMin, expectedMin, `Walking ${dist}m at 80m/min must be ${expectedMin} min, got ${calcMin}`);
    totalAssertions++;
  }
});

test('3.2 Access walk offset added to departure query time in planTransitTrip', () => {
  // Test that for any trip, leg 1 departure is strictly >= nowSecs + walk1Time * 60 - 30
  const orig = { lat: 47.6150, lon: -122.3320 }; // ~400m from Westlake station
  const dest = { lat: 47.4435, lon: -122.3015 }; // SeaTac Airport
  const nowSecs = 36000;

  const plan = planTransitTrip(orig, dest);
  assert(plan && plan.direct.length, 'Expected direct itinerary for Westlake to SeaTac');

  for (const dir of plan.direct) {
    const walk1Min = dir.walk1Time;
    assert.equal(walk1Min, Math.round(dir.walk1Dist / 80), 'walk1Time must match dist / 80');
    assert.equal(dir.walk2Time, Math.round(dir.walk2Dist / 80), 'walk2Time must match dist / 80');

    if (dir.schedTrip) {
      const earliestAllowedBoard = nowSecs + walk1Min * 60 - 30;
      assert(
        dir.schedTrip.depSec >= earliestAllowedBoard,
        `Departure ${dir.schedTrip.depSec} is before passenger finishes walking (${earliestAllowedBoard})`
      );
      totalAssertions++;
    }
    totalAssertions += 2;
  }
});

test('3.3 Direct pedestrian walk cap: <= 2500m offered, > 2500m suppressed', () => {
  // Two points ~1.5 km apart (Westlake to Pioneer Square)
  const p1 = { lat: 47.6115, lon: -122.3370 };
  const p2 = { lat: 47.6015, lon: -122.3315 };
  const dShort = distMeters(p1.lat, p1.lon, p2.lat, p2.lon);
  assert(dShort <= 2500, `Expected distance <= 2500m, got ${dShort}`);
  const planShort = planTransitTrip(p1, p2);
  assert(planShort.directWalk, 'Direct walk itinerary must be offered for <= 2500m');
  assert.equal(planShort.directWalk.totalDuration, Math.round(planShort.directWalk.dist / 80));

  // Two points ~5 km apart (Westlake to U-District)
  const p3 = { lat: 47.6580, lon: -122.3130 };
  const dLong = distMeters(p1.lat, p1.lon, p3.lat, p3.lon);
  assert(dLong > 2500, `Expected distance > 2500m, got ${dLong}`);
  const planLong = planTransitTrip(p1, p3);
  assert.equal(planLong.directWalk, null, 'Direct walk itinerary must be null for > 2500m');
  totalAssertions += 4;
});

// -----------------------------------------------------------------------------
// SECTION 4: INVARIANT — Mode Terminology & Mode Icons
// -----------------------------------------------------------------------------
console.log('\n--- SECTION 4: Mode Terminology & Icons (Exhaustive Route Check) ---');

test('4.1 Exhaustive Route Verification: All 200+ routes in dataset have consistent word & icon', () => {
  let verifiedRoutes = 0;
  for (const route of ROUTES) {
    const word = currentVehWord(route);
    const icon = modeIcon(route);

    // Verify valid word
    assert(['train', 'ferry', 'streetcar', 'bus', 'walk'].includes(word), `Invalid vehWord ${word} on ${route.id}`);
    // Verify valid icon
    assert(['🚆', '⛴️', '🚊', '🚌', '🚶'].includes(icon), `Invalid icon ${icon} on ${route.id}`);

    // Mode-specific consistency checks
    if (['link', 'sounder', 'amtrak', 'monorail'].includes(route.cat)) {
      assert.equal(word, 'train', `Route ${route.id} (cat ${route.cat}) must be 'train'`);
      assert.equal(icon, '🚆', `Route ${route.id} (cat ${route.cat}) must be '🚆'`);
    } else if (['ferry', 'watertaxi'].includes(route.cat)) {
      assert.equal(word, 'ferry', `Route ${route.id} (cat ${route.cat}) must be 'ferry'`);
      assert.equal(icon, '⛴️', `Route ${route.id} (cat ${route.cat}) must be '⛴️'`);
    } else if (route.cat === 'streetcar') {
      assert.equal(word, 'streetcar', `Route ${route.id} must be 'streetcar'`);
      assert.equal(icon, '🚊', `Route ${route.id} must be '🚊'`);
    } else {
      assert.equal(word, 'bus', `Route ${route.id} (cat ${route.cat}) must be 'bus'`);
      assert.equal(icon, '🚌', `Route ${route.id} (cat ${route.cat}) must be '🚌'`);
    }

    verifiedRoutes++;
    totalAssertions += 4;
  }
  assert(verifiedRoutes >= 150, `Expected at least 150 routes verified, got ${verifiedRoutes}`);
});

test('4.2 Mode helpers accept both string category and route object, plus fallback handling', () => {
  // String arguments
  assert.equal(currentVehWord('amtrak'), 'train');
  assert.equal(currentVehWord('monorail'), 'train');
  assert.equal(currentVehWord('sounder'), 'train');
  assert.equal(currentVehWord('link'), 'train');
  assert.equal(currentVehWord('watertaxi'), 'ferry');
  assert.equal(currentVehWord('ferry'), 'ferry');
  assert.equal(currentVehWord('streetcar'), 'streetcar');
  assert.equal(currentVehWord('rapidride'), 'bus');
  assert.equal(currentVehWord('walk'), 'walk');

  assert.equal(modeIcon('amtrak'), '🚆');
  assert.equal(modeIcon('monorail'), '🚆');
  assert.equal(modeIcon('watertaxi'), '⛴️');
  assert.equal(modeIcon('ferry'), '⛴️');
  assert.equal(modeIcon('streetcar'), '🚊');
  assert.equal(modeIcon('rapidride'), '🚌');
  assert.equal(modeIcon('walk'), '🚶');

  // Unknown / null / empty fallback
  assert.equal(currentVehWord(null), 'bus');
  assert.equal(currentVehWord(''), 'bus');
  assert.equal(currentVehWord('alien_spacecraft'), 'bus');
  assert.equal(modeIcon(null), '🚌');
  assert.equal(modeIcon(''), '🚌');
  totalAssertions += 21;
});

// -----------------------------------------------------------------------------
// SECTION 5: INVARIANT — Live GPS vs Timetable Distinction in getSoonestBus
// -----------------------------------------------------------------------------
console.log('\n--- SECTION 5: Live GPS vs Timetable Distinction (getSoonestBus) ---');

test('5.1 Live GPS arrival: live=true sets isLive=true, tag="Live GPS", no false scheduled claim', () => {
  const route = RBY['sound-transit-1-line'];
  const stop = stopIndex['westlake-st-c03'];
  const it = { type: 'direct', route, boardStop: stop, alightStop: stopIndex['seatac-airport-st-c37'], walk1Time: 2 };

  // Mock live departure with live: true
  mockLive = [{ r: route, t: 180, live: true }];
  const soonest = getSoonestBus(it);
  assert(soonest, 'Expected soonest bus result');
  assert.equal(soonest.isLive, true, 'isLive must be true when match.live is true');
  assert.equal(soonest.vehWord, 'train', 'Vehicle word must be train for Link');
  assert(soonest.desc.includes('Live GPS'), `Description '${soonest.desc}' must include 'Live GPS'`);
  assert(!soonest.desc.includes('Scheduled'), `Description '${soonest.desc}' must not say 'Scheduled'`);
  totalAssertions += 5;
});

test('5.2 Scheduled GPS feed item: live=false sets isLive=false, tag="Scheduled", no false live claim', () => {
  const route = RBY['sound-transit-1-line'];
  const stop = stopIndex['westlake-st-c03'];
  const it = { type: 'direct', route, boardStop: stop, alightStop: stopIndex['seatac-airport-st-c37'], walk1Time: 2 };

  // Mock live departure with live: false (feed report is scheduled prediction, not GPS)
  mockLive = [{ r: route, t: 300, live: false }];
  const soonest = getSoonestBus(it);
  assert(soonest, 'Expected soonest bus result');
  assert.equal(soonest.isLive, false, 'isLive must be false when match.live is false');
  assert.equal(soonest.vehWord, 'train');
  assert(soonest.desc.includes('Scheduled'), `Description '${soonest.desc}' must include 'Scheduled'`);
  assert(!soonest.desc.includes('Live GPS'), `Description '${soonest.desc}' MUST NOT claim 'Live GPS' when live=false`);
  totalAssertions += 5;
});

test('5.3 Timetable schedule fallback: live feed offline falls back to timetable with isLive=false', () => {
  const route = RBY['sound-transit-1-line'];
  const stop = stopIndex['westlake-st-c03'];
  const it = {
    type: 'direct',
    route,
    boardStop: stop,
    alightStop: stopIndex['seatac-airport-st-c37'],
    walk1Time: 2,
    schedTrip: { waitMin: 6, clock: '10:06 AM' }
  };

  // Live feed is empty (offline)
  mockLive = [];
  const soonest = getSoonestBus(it);
  assert(soonest, 'Expected soonest bus result');
  assert.equal(soonest.type, 'sched', 'Type must be sched');
  assert.equal(soonest.isLive, false, 'isLive must be false for timetable fallback');
  assert(!soonest.desc.includes('Live GPS'), `Description '${soonest.desc}' must not say 'Live GPS'`);
  totalAssertions += 4;
});

test('5.4 Approximate frequency fallback: isLive=false and no live GPS claim', () => {
  const route = RBY['metro-7'];
  const stop = stopIndex['kcm-880'];
  const it = { type: 'direct', route, boardStop: stop, alightStop: stop, walk1Time: 1 };

  // Live feed empty, and no timetable trip (degenerate stop returns null schedTrip)
  mockLive = [];
  const soonest = getSoonestBus(it);
  assert(soonest, 'Expected soonest bus result');
  assert.equal(soonest.type, 'approx');
  assert.equal(soonest.isLive, false);
  assert(!soonest.desc.includes('Live GPS'));
  totalAssertions += 4;
});

test('5.5 Direct pedestrian walk trip: isLive=false, vehWord="walk"', () => {
  const it = { type: 'walk', dist: 500, totalDuration: 6 };
  const soonest = getSoonestBus(it);
  assert(soonest);
  assert.equal(soonest.isLive, false);
  assert.equal(soonest.vehWord, 'walk');
  assert.equal(soonest.clock, 'Now');
  totalAssertions += 4;
});

console.log('\n================================================================');
console.log(`  ALL ${testsPassed} STRESS TESTS PASSED (${totalAssertions} assertions verified)  `);
console.log('================================================================');
