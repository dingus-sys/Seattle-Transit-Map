// Test suite verifying vector icons for Legend, Guide, Book, and Map in poiIconSVG
const fs = require("fs");
const assert = require("assert");

const appCode = fs.readFileSync("web/app.js", "utf8");
const appCss = fs.readFileSync("web/app.css", "utf8");

// Extract poiIconSVG
const fnMatch = appCode.match(/function poiIconSVG\([\s\S]*?\n  \}/);
assert(fnMatch, "poiIconSVG function must exist");

const fn = new Function(fnMatch[0] + "; return poiIconSVG;");
const poiIconSVG = fn();

// Test 1: book icon is rendered as a clean single-cover guidebook
const bookSvg = poiIconSVG("book", 18);
assert(bookSvg.includes("<g fill=\"none\" stroke=\"currentColor\""), "book icon must have fill=none group to prevent solid fill / cutout glitches");
assert(bookSvg.includes("width=\"18\""), "book icon must accept custom size 18");
assert(bookSvg.includes("M4 19.5v-15"), "book icon must render clean single guidebook outline");
assert(!bookSvg.includes("M2 3.5h6a4 4"), "clunky hollow double-border page paths must be completely removed");
console.log("PASS 1: book icon uses modern, clean single guidebook path with fill=none");

// Test 2: legend and guide render authentic crisp folded transit map without yellow line
const legendSvg = poiIconSVG("legend", 20);
assert(legendSvg.includes("<g fill=\"none\" stroke=\"currentColor\""), "legend icon must have fill=none group");
assert(legendSvg.includes("M3 5.5l5.5-2.5 7 2.5L21 3"), "legend icon must render the 3D folded transit map accordion path");
assert(legendSvg.includes("M8.5 3v15.5M15.5 5.5V21"), "legend icon must render map fold creases");
assert(!legendSvg.includes("--guide-route"), "legend icon must not contain yellow route line");
assert(!appCss.includes("--guide-route"), "app.css must not contain yellow route line variable");

const guideSvg = poiIconSVG("guide", 20);
assert(guideSvg.includes("<g fill=\"none\" stroke=\"currentColor\""), "guide icon alias must exist and have fill=none");
assert(guideSvg.includes("M3 5.5l5.5-2.5 7 2.5L21 3"), "guide icon must render the 3D folded transit map accordion path");
console.log("PASS 2: legend and guide aliases resolve to crisp folded transit map without yellow line");

// Test 3: map icon has fill=none
const mapSvg = poiIconSVG("map", 18);
assert(mapSvg.includes("<g fill=\"none\" stroke=\"currentColor\""), "map icon must have fill=none group so internal fold lines are visible");
console.log("PASS 3: map icon fold lines are visible with fill=none");

// Test 4: explore row button uses legend icon with dedicated guide-row-ic class
assert(appCode.includes("id=\"openLegendGuide\""), "openLegendGuide button must be present in app.js");
assert(appCode.includes("guide-row-ic"), "openLegendGuide button must use dedicated guide-row-ic class");
assert(appCode.includes("${poiIconSVG(\"legend\", 20)}"), "openLegendGuide must use legend transit map icon");
assert(!appCode.includes("style=\"background:#2563eb;color:#fff;display:flex;align-items:center;justify-content:center;border-radius:8px\""), "harsh inline style on openLegendGuide must be replaced");
console.log("PASS 4: openLegendGuide button uses dedicated transit badge class and legend icon");

// Test 5: group hairline dividers are symmetrical without awkward half-cutoffs
assert(appCss.includes(".group > li + li::before {\n  content: \"\"; position: absolute; top: 0; left: 12px; right: 12px;"), "group dividers must have symmetrical 12px margins aligning with row padding");
assert(appCss.includes(".guide-row-ic"), "app.css must define .guide-row-ic");
assert(appCss.includes(".guide-hero-ic"), "app.css must define .guide-hero-ic");
console.log("PASS 5: group dividers are symmetrical (left: 12px; right: 12px) and badge classes are defined in CSS");

// Test 6: stay on buses (transfer) uses the classic counter-opposing loop arrows logo
const transferSvg = poiIconSVG("transfer", 19);
assert(transferSvg.includes("M7 3 3 7l4 4M3 7h12a4 4 0 0 1 4 4v1"), "transfer icon must have classic top arrow and loop");
assert(transferSvg.includes("M17 21l4-4-4-4m4 4H9a4 4 0 0 1-4-4v-1"), "transfer icon must have classic bottom arrow and loop");
assert(transferSvg.includes("fill=\"currentColor\""), "transfer icon must have solid filled arrowheads");
console.log("PASS 6: Stay on the Bus uses classic looping transfer arrows logo with filled heads");

console.log("\nALL LEGEND, GUIDE & TRANSFER CHECKS PASSED!");
