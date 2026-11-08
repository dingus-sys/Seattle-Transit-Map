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

// Test 2: legend and guide render authentic transit map with route ribbon & transfer stations
const legendSvg = poiIconSVG("legend", 20);
assert(legendSvg.includes("<g fill=\"none\" stroke=\"currentColor\""), "legend icon must have fill=none group");
assert(legendSvg.includes("M3 5.5l5.5-2.5 7 2.5L21 3"), "legend icon must render the 3D folded transit map accordion path");
assert(legendSvg.includes("M5.5 14c3-4"), "legend icon must render dynamic transit route strand");
assert(legendSvg.includes("circle cx=\"9\" cy=\"11.8\""), "legend icon must render transfer station nodes");

const guideSvg = poiIconSVG("guide", 20);
assert(guideSvg.includes("<g fill=\"none\" stroke=\"currentColor\""), "guide icon alias must exist and have fill=none");
assert(guideSvg.includes("M3 5.5l5.5-2.5 7 2.5L21 3"), "guide icon must render the 3D folded transit map accordion path");
console.log("PASS 2: legend and guide aliases resolve to authentic transit map with route ribbon & station nodes");

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

console.log("\nALL LEGEND & GUIDE CHECKS PASSED!");
