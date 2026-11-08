// Automated test suite for Route Departures and Live ETA (Transit App UI pattern)
const fs = require('fs');
const assert = require('assert');

console.log('=== TEST SUITE: Route Departures & Live ETA ===');

const appJs = fs.readFileSync('web/app.js', 'utf8');
const appCss = fs.readFileSync('web/app.css', 'utf8');
const sched = JSON.parse(fs.readFileSync('site/data/schedule.json'));
const routesData = JSON.parse(fs.readFileSync('site/data/routes.json'));
const stopsData = JSON.parse(fs.readFileSync('site/data/stops.json'));

// 1. Verify CSS styles for Route Departures Card
assert(appCss.includes('.route-departures-card'), 'app.css must define .route-departures-card');
assert(appCss.includes('.rd-card-body'), 'app.css must define .rd-card-body');
assert(appCss.includes('.rd-hero-eta'), 'app.css must define .rd-hero-eta');
assert(appCss.includes('.rd-dep-row'), 'app.css must define .rd-dep-row');
assert(appCss.includes('.stop-row-btn.is-active'), 'app.css must define .stop-row-btn.is-active');
assert(appCss.includes('.stop-active-badge'), 'app.css must define .stop-active-badge');
console.log('PASS 1: CSS definitions for Route Departures Card and stop selection present');

// 2. Verify JS components and handlers in app.js
assert(appJs.includes('function getRouteDeparturesForStop('), 'app.js must define getRouteDeparturesForStop');
assert(appJs.includes('function routeDeparturesCardHTML('), 'app.js must define routeDeparturesCardHTML');
assert(appJs.includes('function handleRouteStopClick('), 'app.js must define handleRouteStopClick');
assert(appJs.includes('function refreshRouteDeparturesCard('), 'app.js must define refreshRouteDeparturesCard');
assert(appJs.includes('id="routeViewDepsBtn"'), 'app.js must include Departures button in card-actions');
assert(appJs.includes('id="routeDepsCardSlot"'), 'app.js must include routeDepsCardSlot in showRoute');
console.log('PASS 2: JavaScript departure functions and UI slots present in app.js');

// 3. Verify Map Click Delegation in app.js
assert(appJs.includes('if (selected && selected.type === "route" && typeof handleRouteStopClick === "function" && handleRouteStopClick(onStation[0].properties.id)) return;'),
  'Station map clicks while in route view must delegate to handleRouteStopClick');
assert(appJs.includes('if (selected && selected.type === "route" && typeof handleRouteStopClick === "function" && handleRouteStopClick(f.properties.id))'),
  'Stop map clicks while in route view must delegate to handleRouteStopClick');
console.log('PASS 3: Map stop/station click delegation to active route stop verified');

// 4. Test Departure Calculation Engine for Route 255 at kcm-9575
const stopIndex = {};
for (const s of stopsData.stops) stopIndex[s.id] = { ...s, key: s.id };
for (const s of stopsData.stations) stopIndex[s.id] = { ...s, key: s.id };

const DEP = new Map();
sched.patterns.forEach((p, pi) => {
  (p.s || []).forEach((sid, i) => {
    const st = stopIndex[sid], k = st ? st.key : sid;
    if (!DEP.has(k)) DEP.set(k, []);
    DEP.get(k).push([pi, i]);
  });
});

const byPat = {};
for (const [day, trips] of Object.entries(sched.days)) {
  const m = new Map();
  for (const [pi, s0, du] of trips) {
    if (!m.has(pi)) m.set(pi, []);
    m.get(pi).push([s0, du]);
  }
  byPat[day] = m;
}

const r255 = routesData.routes.find((x) => x.id === 'metro-255');
assert(r255, 'Route metro-255 exists');
const pat = r255.patterns[0];
const stopId = 'kcm-9575'; // NE Campus Pkwy & University Way NE - Bay 2
const st = stopIndex[stopId];
assert(st, 'Stop kcm-9575 exists');

// Simulate departures at 2:26 PM (nowSecs = 51960)
const nowSecs = 51960;
const schedMatches = [];
for (const [pi, i] of DEP.get(st.key) || []) {
  const p = sched.patterns[pi];
  if (!p || !p.f || i >= p.f.length - 1) continue;
  const rObj = routesData.routes[p.r];
  if (!rObj || (rObj.id !== r255.id && rObj.label !== r255.label)) continue;
  for (const [s0, du] of (byPat['weekday'] && byPat['weekday'].get(pi)) || []) {
    const t = s0 + p.f[i] * du - nowSecs;
    if (t < -20 || t > 7200) continue;
    schedMatches.push({ t, waitMin: Math.round(t / 60) });
  }
}
schedMatches.sort((a, b) => a.t - b.t);

assert(schedMatches.length > 0, 'Must produce departures for Route 255 at kcm-9575');
assert(schedMatches[0].waitMin >= 0 && schedMatches[0].waitMin <= 20, 'Soonest departure within 20 min');
console.log('PASS 4: Schedule departure engine produced', schedMatches.length, 'departures. Next in', schedMatches[0].waitMin, 'min');

// 5. Test Link Light Rail 1 Line departures at Westlake
const r1Line = routesData.routes.find((x) => x.id === 'sound-transit-1-line');
assert(r1Line, '1 Line exists');
const westlakePat = r1Line.patterns[0];
const firstStop = westlakePat.stops[0];
const westlakeSt = stopIndex[firstStop] || { key: firstStop, id: firstStop };
const line1Matches = [];
for (const [pi, i] of DEP.get(westlakeSt.key) || []) {
  const p = sched.patterns[pi];
  if (!p || !p.f || i >= p.f.length - 1) continue;
  const rObj = routesData.routes[p.r];
  if (!rObj || (rObj.id !== r1Line.id && rObj.label !== r1Line.label)) continue;
  for (const [s0, du] of (byPat['weekday'] && byPat['weekday'].get(pi)) || []) {
    const t = s0 + p.f[i] * du - nowSecs;
    if (t < -20 || t > 7200) continue;
    line1Matches.push({ t, waitMin: Math.round(t / 60) });
  }
}
line1Matches.sort((a, b) => a.t - b.t);
assert(line1Matches.length > 0, 'Must produce departures for 1 Line');
console.log('PASS 5: 1 Line produced', line1Matches.length, 'departures. Next in', line1Matches[0].waitMin, 'min');

console.log('\nALL ROUTE DEPARTURES & LIVE ETA CHECKS PASSED!');
