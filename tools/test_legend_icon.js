// Test suite verifying vector icons for Legend, Guide, Book, and Map in poiIconSVG
const fs = require("fs");
const assert = require("assert");

const appCode = fs.readFileSync("web/app.js", "utf8");

// Extract poiIconSVG
const fnMatch = appCode.match(/function poiIconSVG\([\s\S]*?\n  \}/);
assert(fnMatch, "poiIconSVG function must exist");

const fn = new Function(fnMatch[0] + "; return poiIconSVG;");
const poiIconSVG = fn();

// Test 1: book icon is rendered with fill="none" and stroke="currentColor"
const bookSvg = poiIconSVG("book", 18);
assert(bookSvg.includes("<g fill=\"none\" stroke=\"currentColor\""), "book icon must have fill=none group to prevent solid fill / cutout glitches");
assert(bookSvg.includes("width=\"18\""), "book icon must accept custom size 18");
assert(bookSvg.includes("M2 3.5h6a4 4"), "book icon must render the smooth left page path");
assert(bookSvg.includes("M22 3.5h-6a4 4"), "book icon must render the smooth right page path");
assert(bookSvg.includes("M12 7.5v13.5"), "book icon must render center spine line");
console.log("PASS 1: book icon uses modern, balanced open guidebook path with fill=none");

// Test 2: legend and guide aliases
const legendSvg = poiIconSVG("legend", 20);
assert(legendSvg.includes("<g fill=\"none\" stroke=\"currentColor\""), "legend icon alias must exist and have fill=none");
const guideSvg = poiIconSVG("guide", 20);
assert(guideSvg.includes("<g fill=\"none\" stroke=\"currentColor\""), "guide icon alias must exist and have fill=none");
console.log("PASS 2: legend and guide aliases resolve to clean vector paths");

// Test 3: map icon has fill=none
const mapSvg = poiIconSVG("map", 18);
assert(mapSvg.includes("<g fill=\"none\" stroke=\"currentColor\""), "map icon must have fill=none group so internal fold lines are visible");
console.log("PASS 3: map icon fold lines are visible with fill=none");

// Test 4: explore row button uses book/legend icon cleanly
assert(appCode.includes("id=\"openLegendGuide\""), "openLegendGuide button must be present in app.js");
assert(!appCode.includes("M4 4h7a3 3 0 0 1 3 3v13a3 3 0 0 0-3-3H4V4Zm16 0h-7a3 3 0 0 0-3 3v13a3 3 0 0 1 3-3h7V4Z"), "broken overlapping cutout path must be completely removed");
console.log("PASS 4: old distorted path is completely eradicated from codebase");

console.log("\nALL LEGEND & GUIDE ICON CHECKS PASSED!");
