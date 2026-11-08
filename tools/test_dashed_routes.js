// Test suite verifying dashed bus route rendering, contrast, casing bed, and shader antialiasing.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ribbonsCode = fs.readFileSync("web/ribbons.js", "utf8");
const appJs = fs.readFileSync("web/app.js", "utf8");

const KCTMRibbons = new Function(ribbonsCode + ";return KCTMRibbons")();

console.log("=== DASHED BUS ROUTE CONTRAST & LEGIBILITY VERIFICATION ===");

// 1. Casing Bed: Dashed bus routes must compile a casing bed ('case' role)
const busFeature = {
  type: "Feature",
  properties: { zu: 2.4 / 2 ** 15, wm: 1.85, cm: 2.6, hm: 0, sh: 0, c: "#1b5bb0", g: "bus", cat: "peak", d: 1 },
  geometry: { type: "LineString", coordinates: [[-122.33, 47.61], [-122.329, 47.61]] }
};

const busMesh = KCTMRibbons.compile([busFeature]);
const busCase = busMesh.find((b) => b.role === "case");
const busDash = busMesh.find((b) => b.role === "dash");

assert(busCase, "Dashed bus routes MUST compile a 'case' role for high contrast background separation");
assert(busDash, "Dashed bus routes MUST compile a 'dash' role");
assert.equal(busDash.pattern, 1, "Dash role must use pattern 1");
console.log("PASS 1: Dashed bus routes compile a dedicated high-contrast casing bed");

// 2. Water routes (ferries) must NOT compile street casing over open water
const waterFeature = {
  type: "Feature",
  properties: { zu: 2.4 / 2 ** 15, wm: 1.9, cm: 2.6, hm: 0, sh: 0, c: "#0d768a", g: "water", cat: "ferry", d: 1 },
  geometry: { type: "LineString", coordinates: [[-122.33, 47.61], [-122.329, 47.61]] }
};

const waterMesh = KCTMRibbons.compile([waterFeature]);
const waterCase = waterMesh.find((b) => b.role === "case");
assert(!waterCase, "Water ferry routes must NOT compile street casing over water");
console.log("PASS 2: Marine water routes keep clean uncased dash pattern over open water");

// 3. Peak bus width must be at least 1.8 (not skinny 1.4)
const catSlice = appJs.slice(appJs.indexOf("const CAT = {"), appJs.indexOf("const VKEY"));
assert(appJs.includes('peak:      { group: "bus",   w: 1.85'), "Peak bus width must be 1.85 for bold dash presence");
assert(appJs.includes('dart:      { group: "bus",   w: 1.7'), "DART bus width must be 1.7 for legible dash presence");
console.log("PASS 3: Dashed bus width increased to 1.85 / 1.7 for strong visual presence");

// 4. Minor zoom scaling must preserve dashed bus visibility (minimum >= 0.70)
assert(appJs.includes("peak: Math.max(0.72"), "Peak bus zoom scaling must preserve at least 0.72x scale");
console.log("PASS 4: Minor zoom scaling maintains dashed route visibility at regional zooms");

// 5. Peak bus must not be washed out with land background
const softMatch = appJs.match(/const SOFT = \{([^}]+)\}/);
assert(softMatch && !softMatch[1].includes("peak:"), "Peak bus must not be washed out by land background color in SOFT");
console.log("PASS 5: Peak bus maintains 100% pure saturated contrast without land wash");

// 6. Shader antialiasing for dash caps
assert(ribbonsCode.includes("smoothstep(0.0, pixDist, endDist)"), "Fragment shader must antialias dash end caps");
console.log("PASS 6: WebGL fragment shader smoothly antialiases dash cap ends");

console.log("\nALL DASHED ROUTE CHECKS PASSED!");
