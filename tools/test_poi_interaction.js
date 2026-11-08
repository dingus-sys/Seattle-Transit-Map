// POI interaction regression checks. Run: node tools/test_poi_interaction.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

// App UI should ship vector glyphs, not platform-dependent emoji glyphs.
const appWithoutComments = app.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
assert.equal(/[\u{1F000}-\u{1FAFF}]/u.test(appWithoutComments), false, 'app UI must not include platform emoji');
assert.match(app, /function poiIconSVG\(kind, size = 18\)/, 'shared SVG glyph family exists');
assert.match(app, /iconKind: "ferry"/, 'place badges select named custom glyphs');

// Both curated wayfinding POIs and ordinary base-map POIs must produce a map-anchored callout.
assert.match(app, /const BASE_POI_LAYER_IDS = \["poi13", "poi14", "poi15"\]/, 'base POI layers are interactive');
assert.match(app, /function showDestinationPopup\(d\)/, 'curated destination popup exists');
assert.match(app, /function showMapPoiPopup\(place\)/, 'ordinary POI popup exists');
assert.match(app, /showDestinationPopup\(dObj\)/, 'destination map taps stay on the map');
assert.match(app, /showMapPoiPopup\(basePoi\)/, 'base POI map taps stay on the map');
assert.match(app, /<span>Navigate<\/span>/, 'callout includes navigation');
assert.match(app, /data-dest-details/, 'curated destination callout includes details');
assert.match(app, /data-place-details/, 'ordinary POI callout includes details');

console.log('PASS custom vector glyphs and anchored POI navigation callouts');
