// Test verifying route hover bolding without background dimming,
// and ensuring network dimming only triggers on route click/selection.

const assert = require("assert");
const fs = require("fs");

const appCode = fs.readFileSync("web/app.js", "utf8");

console.log("=== HOVER BOLD WITHOUT DIMMING & CLICK DIMMING TEST ===");

// 1. Verify pickLine hover handler bolds route without calling setNetDim
const pickLineSection = appCode.substring(appCode.indexOf("const ln = pickLine(e.point);"), appCode.indexOf("const ln = pickLine(e.point);") + 600);
assert(pickLineSection.includes("focusRoute(strandRoute);"), "Hovering a line must call focusRoute to bold the route");
assert(!pickLineSection.includes("setNetDim("), "Hovering a line must NOT call setNetDim (other lines must not dim on hover)");
console.log("PASS 1: Map line hover bolds route without dimming other lines");

// 2. Verify pickTag hover handler bolds route without calling setNetDim
const pickTagSection = appCode.substring(appCode.indexOf("const tg = tagAt(e.point);"), appCode.indexOf("const tg = tagAt(e.point);") + 1200);
assert(pickTagSection.includes("focusRoute(r);"), "Hovering a tag must call focusRoute to bold the route");
assert(!pickTagSection.includes("setNetDim("), "Hovering a tag must NOT call setNetDim (other lines must not dim on hover)");
console.log("PASS 2: Map route tag hover bolds route without dimming other lines");

// 3. Verify previewOnHover bolds route without calling setNetDim
const previewSection = appCode.substring(appCode.indexOf("function previewOnHover(b)"), appCode.indexOf("function previewOnHover(b)") + 300);
assert(previewSection.includes("focusRoute(r);"), "previewOnHover must call focusRoute to bold the route");
assert(!previewSection.includes("setNetDim(0.20)"), "previewOnHover must NOT call setNetDim(0.20) on hover");
console.log("PASS 3: List route button hover bolds route without dimming other lines");

// 4. Verify route click/selection triggers network dimming (setNetDim(0.38))
const applySelSection = appCode.substring(appCode.indexOf("function applySelectionStyle()"), appCode.indexOf("function applySelectionStyle()") + 800);
assert(applySelSection.includes("setNetDim(dim ? 0.38 : 1)"), "Route selection must dim the surrounding network via setNetDim(0.38)");
assert(appCode.includes("selected = { type: \"route\", id };"), "selectRoute must set route selection state");
console.log("PASS 4: Clicking a route selects it and dims surrounding lines to 0.38");

// 5. Verify clearing selection restores full network opacity (setNetDim(1))
const clearSelSection = appCode.substring(appCode.indexOf("function clearSelection("), appCode.indexOf("function clearSelection(") + 400);
assert(clearSelSection.includes("applySelectionStyle()"), "clearSelection must reapply selection style");
console.log("PASS 5: Clearing selection restores full network visibility (netDim = 1)");

console.log("\nALL HOVER BOLD WITHOUT DIMMING CHECKS PASSED!");
