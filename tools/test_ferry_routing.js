// Test suite verifying ferry search indexing, ferry transfer distance thresholds,
// multi-leg regional Kitsap connections, and directions view protection.

const assert = require("assert");
const fs = require("fs");

const ROUTES = JSON.parse(fs.readFileSync("site/data/routes.json", "utf8")).routes;
const STOPS = JSON.parse(fs.readFileSync("site/data/stops.json", "utf8"));
const SCHED = JSON.parse(fs.readFileSync("site/data/schedule.json", "utf8"));

const LINES = ROUTES;
const LINEIDX = {};
LINES.forEach((r, i) => { LINEIDX[r.id] = i; });
const RBY = {};
LINES.forEach(r => { RBY[r.id] = r; });

const stopIndex = {};
for (const s of STOPS.stops) {
  stopIndex[s.id] = { ...s, kind: "stop", key: s.id };
  for (const a of s.alias || []) stopIndex[a] = stopIndex[s.id];
}
for (const s of STOPS.stations) {
  stopIndex[s.id] = { ...s, key: s.id };
  for (const sid of s.stops) if (!stopIndex[sid]) stopIndex[sid] = { ...s, key: s.id };
}

const DEP = new Map();
SCHED.patterns.forEach((p, pi) => (p.s || []).forEach((sid, i) => {
  const st = stopIndex[sid], k = st ? st.key : sid;
  if (!DEP.has(k)) DEP.set(k, []);
  DEP.get(k).push([pi, i]);
}));
const byPat = {};
for (const [day, trips] of Object.entries(SCHED.days)) {
  const m = new Map();
  for (const [pi, s0, du] of trips) {
    if (!m.has(pi)) m.set(pi, []);
    m.get(pi).push([s0, du]);
  }
  byPat[day] = m;
}
SCHED.byPat = byPat;

let plannerStopsCache = null;
const CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });
const pacificNow = () => new Date("2026-11-10T07:02:00-08:00");

// Load routing and search slices from web/app.js
const appJs = fs.readFileSync("web/app.js", "utf8");
const startMarker = "function distMeters";
const endMarker = "function clearTripMap";
const routingCode = appJs.slice(appJs.indexOf(startMarker), appJs.indexOf(endMarker));
eval(routingCode);

// Also extract buildSearch and search
const searchMarker = "function buildSearch()";
const searchEndMarker = "function selectTrail";
const buildSearchCode = appJs.slice(appJs.indexOf(searchMarker), appJs.indexOf(searchEndMarker));
const searchIndex = [];
const AREAS = {};
const PARK_AND_RIDES = [];
const STEEP_HILLS = [];
const KEY_DESTINATIONS = [];
var buildSearch, search, searchLocalStopsAndPois;
function routeTitle(r) { return r.name || ""; }
eval(buildSearchCode.replace("function buildSearch()", "buildSearch = function()").replace("function search(q)", "search = function(q)"));
buildSearch();

const localMarker = "function searchLocalStopsAndPois(q)";
const localEndMarker = "let currentDirSuggestions";
const localCode = appJs.slice(appJs.indexOf(localMarker), appJs.indexOf(localEndMarker));
function poiKindTitle() { return ""; }
function poiColor() { return "#000"; }
eval(localCode.replace("function searchLocalStopsAndPois(q)", "searchLocalStopsAndPois = function(q)"));

console.log("=== FERRY SEARCH & ROUTING VERIFICATION ===");

// 1. Search Indexing: "bremerton ferry" must return the WSF terminal and Kitsap fast ferry dock
const bremFerryResults = search("bremerton ferry");
const wsfBrem = bremFerryResults.find(r => r.kind === "station" && r.id === "bremerton-wsf-4");
const ktBrem = bremFerryResults.find(r => r.kind === "station" && r.id === "bremerton-fast-ferry-dock-kt-230");
assert(wsfBrem, "Search for 'bremerton ferry' must index bremerton-wsf-4");
assert(ktBrem, "Search for 'bremerton ferry' must index bremerton-fast-ferry-dock-kt-230");
console.log("PASS 1: 'bremerton ferry' search successfully indexes WSF and Kitsap fast ferry terminals");

// 2. Search Local Stops: station description must indicate 'Ferry terminal' for ferry docks
const locals = searchLocalStopsAndPois("bremerton ferry");
const localWSF = locals.find(l => l.name === "Bremerton" || l.name === "Bremerton Fast Ferry Dock");
assert(localWSF, "searchLocalStopsAndPois must find ferry terminal");
assert.strictEqual(localWSF.desc, "Ferry terminal", "Ferry terminal description must be 'Ferry terminal'");
console.log("PASS 2: searchLocalStopsAndPois correctly labels ferry terminals as 'Ferry terminal'");

// 3. 1-Transfer routing from Seattle Rail (Pioneer Square / U-District) to Bremerton Ferries
const origUDistrict = { lat: 47.6599, lon: -122.3138, name: "U-District Station" };
const destWSF = stopIndex["bremerton-wsf-4"];
const ptMorning = { day: "weekday", prev: "weekday", secs: 7 * 3600 + 2 * 60, date: new Date("2026-11-10T07:02:00-08:00") };
const planFerry = planTransitTrip(origUDistrict, { lat: destWSF.lat, lon: destWSF.lon, name: destWSF.name }, ptMorning);

assert(planFerry.transfer.length > 0, "Must provide 1-transfer connection from 1 Line / 2 Line to Bremerton ferry");
const railToFerry = planFerry.transfer.find(t => (t.r1.short === "1 Line" || t.r1.short === "2 Line") && t.r2.id.includes("bremerton"));
assert(railToFerry, "Must find direct 1 Line -> Ferry transfer at Pioneer Square / Colman Dock");
console.log(`PASS 3: Found 1-transfer connection: ${railToFerry.r1.short} -> ${railToFerry.r2.name} (${railToFerry.totalDuration} min)`);

// 4. Regional multi-leg trips to Kitsap Peninsula (Olympic College Bremerton)
const destCollege = stopIndex["kt-256"];
const planCollege = planTransitTrip(origUDistrict, { lat: destCollege.lat, lon: destCollege.lon, name: destCollege.name }, ptMorning);
assert(planCollege.multi.length > 0, "Must find multi-leg trip from Seattle to Olympic College Bremerton");
const ferryLegTrip = planCollege.multi.find(m => m.legs.some(l => l.route.cat === "ferry"));
assert(ferryLegTrip, "Multi-leg trip to Bremerton must include ferry leg");
console.log(`PASS 4: Found regional multi-leg trip: ${ferryLegTrip.legs.map(l => l.route.short || l.route.name).join(" -> ")} (${ferryLegTrip.totalDuration} min)`);

// 5. Directions view protection check
assert(appJs.includes("if (panelView === \"directions\") return;"), "clearSelection must protect active directions");
assert(appJs.includes("if (panelView === \"directions\") {\n        if (popup) closePopup();\n        return;\n      }"), "map click must protect active directions");
console.log("PASS 5: Active directions panel protected from map click resets");

console.log("\nALL FERRY ROUTING & PROTECTION CHECKS PASSED!");
