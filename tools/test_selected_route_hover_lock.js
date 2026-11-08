// Automated test for route selection hover lock and span icon logic
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const appJs = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");

// Test 1: Verify isLateNightSpan function exists and handles various times correctly
console.log("Test 1: Testing isLateNightSpan logic...");
const isLateNightSpanMatch = appJs.match(/function isLateNightSpan\(w\) \{([\s\S]*?)\n  \}/);
assert(isLateNightSpanMatch, "isLateNightSpan function must exist in web/app.js");

const isLateNightSpan = new Function("w", isLateNightSpanMatch[1]);

// Route 988: ends 3:34 PM -> Daytime (not late night)
assert.strictEqual(isLateNightSpan({ last: "3:34 PM", span_h: 8.3 }), false, "3:34 PM should not be late night");
// Route ending at 5:45 PM -> Daytime
assert.strictEqual(isLateNightSpan({ last: "5:45 PM", span_h: 11.5 }), false, "5:45 PM should not be late night");
// Route ending at 8:30 PM -> Evening / Daytime
assert.strictEqual(isLateNightSpan({ last: "8:30 PM", span_h: 14.5 }), false, "8:30 PM should not be late night");

// Late night routes:
// 1 Line: ends 12:02 AM
assert.strictEqual(isLateNightSpan({ last: "12:02 AM", span_h: 19.9 }), true, "12:02 AM should be late night");
// Swift Blue: ends 11:55 PM
assert.strictEqual(isLateNightSpan({ last: "11:55 PM", span_h: 19.9 }), true, "11:55 PM should be late night");
// Route ending at 2:30 AM
assert.strictEqual(isLateNightSpan({ last: "2:30 AM", span_h: 21 }), true, "2:30 AM should be late night");
// 24-hour Night Owl route (span_h >= 22)
assert.strictEqual(isLateNightSpan({ last: "3:52 AM", span_h: 23.4 }), true, "span_h >= 22 should be late night");

console.log("✓ isLateNightSpan logic passed all cases");

// Test 2: Verify routeBadgesHTML uses the Last Call Bell icon for Route 988
console.log("Test 2: Testing routeBadgesHTML output for Route 988 and Night Owl routes...");

// Mock environment for routeBadgesHTML
const mockEnv = {
  esc: (s) => String(s),
  isEveryday: () => false,
  poiIconSVG: () => "<svg></svg>",
  isLateNightSpan,
};

const routeBadgesMatch = appJs.match(/function routeBadgesHTML\(r\) \{([\s\S]*?)\n  \}/);
assert(routeBadgesMatch, "routeBadgesHTML function must exist in web/app.js");

const routeBadgesHTML = new Function("r", "esc", "isEveryday", "poiIconSVG", "isLateNightSpan", routeBadgesMatch[1]);

const r988 = {
  id: "metro-988",
  short: "988",
  sched: {
    weekday: {
      am: 180,
      am_n: 1,
      mid: null,
      mid_n: 0,
      pm: 180,
      pm_n: 1,
      first: "7:14 AM",
      last: "3:34 PM",
      span_h: 8.3,
      trips: 2,
    },
  },
};

const html988 = routeBadgesHTML(r988, mockEnv.esc, mockEnv.isEveryday, mockEnv.poiIconSVG, mockEnv.isLateNightSpan);

// Must contain "Until 3:34 PM" (with narrow space or normal space)
assert(/Until 3:34[ \s]PM/.test(html988), "Route 988 pill must contain 'Until 3:34 PM'");
// Must NOT say "last scheduled" (per user explicit request: "i dont wnat it to say liek last shededueld")
assert(!/last scheduled/i.test(html988), "Must not say 'last scheduled'");
// Must contain the Last Call Bell SVG (M8 1.5a2 2 0 0 0-2 2...)
assert(html988.includes("M8 1.5a2 2 0 0 0-2 2"), "Route 988 must contain the Last Call Bell icon");
// Must NOT contain the Crescent Moon SVG (M6 .278a.768...)
assert(!html988.includes("M6 .278a.768"), "Route 988 must NOT contain the moon icon");

console.log("✓ Route 988 correctly displays Last Call Bell icon and 'Until 3:34 PM'");

// Now test 24-hour / Night Owl route
const rOwl = {
  id: "metro-e-line",
  short: "E Line",
  sched: {
    weekday: {
      mid: 7,
      mid_n: 50,
      first: "4:30 AM",
      last: "3:52 AM",
      span_h: 23.4,
      trips: 272,
    },
  },
};

const htmlOwl = routeBadgesHTML(rOwl, mockEnv.esc, mockEnv.isEveryday, mockEnv.poiIconSVG, mockEnv.isLateNightSpan);
assert(htmlOwl.includes("24 Hours · Night Owl"), "Night Owl route must contain '24 Hours · Night Owl'");
assert(htmlOwl.includes("M6 .278a.768"), "Night Owl route must contain the moon icon");

console.log("✓ Night Owl route correctly displays crescent moon icon");

// Test 3: Verify mousemove suppresses other route hovering when a route is selected
console.log("Test 3: Testing mousemove hover suppression when selected.type === 'route'...");

assert(appJs.includes("if (selected && selected.type === \"route\") {"), "web/app.js must check if selected.type === 'route'");
assert(appJs.includes("if (!strandRoute || strandRoute.id !== selected.id) {"), "web/app.js must check if strandRoute is not selected.id");

console.log("✓ All unit tests passed successfully!");
