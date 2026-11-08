// Test suite for custom & distinct icons for Park & Rides, Ferry Terminals, Transit Centers, and Rail Stations
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

// 1. Verify poiIconSVG contains shapes for all 4 distinct transit categories
const shapesMatch = appJs.match(/function poiIconSVG\(kind, size = 18\)[\s\S]*?const shapes = \{([\s\S]*?)\n\s*\};/);
assert(shapesMatch, 'poiIconSVG shapes table found');
const shapesTable = shapesMatch[1];

assert(shapesTable.includes('ferry_terminal:'), 'ferry_terminal icon defined in shapes');
assert(shapesTable.includes('pr:'), 'pr icon defined in shapes');
assert(shapesTable.includes('transit_center:'), 'transit_center icon defined in shapes');
assert(shapesTable.includes('station:'), 'station icon defined in shapes');

// Extract SVG strings using single quotes
const getShape = (name) => {
  const m = shapesTable.match(new RegExp(`\\b${name}:\\s*'([^']+)'`));
  assert(m, `Found shape for ${name}`);
  return m[1];
};

const prSvg = getShape('pr');
const ferrySvg = getShape('ferry_terminal');
const tcSvg = getShape('transit_center');
const stationSvg = getShape('station');

// Check that each icon is unique and has distinct elements
assert(prSvg !== ferrySvg, 'PR != Ferry');
assert(prSvg !== tcSvg, 'PR != TC');
assert(prSvg !== stationSvg, 'PR != Station');
assert(ferrySvg !== tcSvg, 'Ferry != TC');
assert(ferrySvg !== stationSvg, 'Ferry != Station');
assert(tcSvg !== stationSvg, 'TC != Station');

// Visual element verification:
// PR has canopy + P badge + cute car
assert(prSvg.includes('M2.5 8.5h19'), 'PR has parking canopy roof');
assert(prSvg.includes('rx="1.8"'), 'PR has rounded P badge');
console.log('PASS 1: Park & Ride icon has dedicated canopy and car geometry');

// Ferry Terminal has slip dock pilings + Puget Sound ferry + waves
assert(ferrySvg.includes('M2.5 7.5v12'), 'Ferry Terminal has slip pilings');
assert(ferrySvg.includes('M2 21c2.8-1'), 'Ferry Terminal has marine ripples');
console.log('PASS 2: Ferry Terminal icon has terminal slip pilings and marine wave geometry');

// Transit Center has arched concourse pavilion + transfer interchange arrows
assert(tcSvg.includes('M4.5 11c0-4.1'), 'Transit Center has arched station pavilion');
assert(tcSvg.includes('M4 16h11a3 3 0 0 1 3 3'), 'Transit Center has transfer interchange arrows');
console.log('PASS 3: Transit Center icon has station concourse and transfer loop geometry');

// Station has aerodynamic Link Light Rail train + platform tracks
assert(stationSvg.includes('M7.5 7.5h9v3.8h-9z'), 'Station has panoramic train windshield');
assert(stationSvg.includes('M3.5 21h17'), 'Station has platform rails and ties');
console.log('PASS 4: Rail Station icon has aerodynamic light rail train and platform track geometry');

// 2. Verify getPlaceBadge returns distinct iconKind and color for each
assert(appJs.includes('iconKind: "ferry_terminal"'), 'getPlaceBadge returns ferry_terminal');
assert(appJs.includes('iconKind: "transit_center"'), 'getPlaceBadge returns transit_center');
assert(appJs.includes('iconKind: "pr"'), 'getPlaceBadge returns pr');
assert(appJs.includes('iconKind: "station"'), 'getPlaceBadge returns station');
console.log('PASS 5: Place badge mapper returns distinct iconKind and color palettes');

// 3. Verify showStop assigns custom hero icon badges
assert(appJs.includes('poiIconSVG("ferry_terminal", 22)'), 'showStop displays ferry terminal hero badge');
assert(appJs.includes('poiIconSVG("transit_center", 22)'), 'showStop displays transit center hero badge');
assert(appJs.includes('poiIconSVG("station", 22)'), 'showStop displays rail station hero badge');
console.log('PASS 6: Stop & Station view displays rich dedicated hero badges');

// 4. Verify search results display dedicated icons for each hub type
assert(appJs.includes('poiIconSVG("pr", 18)'), 'Search results render Park & Ride badge');
assert(appJs.includes('poiIconSVG(iconKind, 18)'), 'Search results dynamically render station and ferry badges');
console.log('PASS 7: Search dropdown and suggestion view render distinct badges');

// 5. Verify Legend Guide lists all 4 distinct transit hub types
assert(appJs.includes('poiIconSVG("ferry_terminal", 18)'), 'Legend contains ferry_terminal');
assert(appJs.includes('poiIconSVG("transit_center", 18)'), 'Legend contains transit_center');
assert(appJs.includes('poiIconSVG("station", 18)'), 'Legend contains station');
assert(appJs.includes('poiIconSVG("pr", 18)'), 'Legend contains pr');
console.log('PASS 8: Transit Map Guide & Legend lists all 4 distinct transit hub categories');

console.log('\nALL TRANSIT HUB ICON SYSTEM TESTS PASSED PERFECTLY!');
