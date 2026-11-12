// Verification test suite for corridor tag overflow (+N) click and highlighting behavior
const fs = require('fs');
const assert = require('assert');

const appJs = fs.readFileSync('web/app.js', 'utf8');

console.log('=== TEST SUITE: Corridor Tag Overflow (+N) & Route Highlighting ===');

// 1. Verify drawBadge populates all routes in `more` and tracks `overflow` and `extra`
assert(appJs.includes('const groups = [], all = [...new Set(list.split(".").map(Number))];'),
  'drawBadge must construct deduplicated all route indices');
assert(appJs.includes('groups[groups.length - 1].refs.push({ more: all, overflow: all.slice(MAX - 1), extra });'),
  'drawBadge must store all routes in `more` and overflow in `overflow` with extra count');
console.log('PASS 1: drawBadge stores all corridor routes in ref.more and tracks overflow + extra');

// 2. Verify showLens displays `+${it.extra || it.more.length}`
assert(appJs.includes('lens.innerHTML = it.r != null ? `<span class="lens-in">${badgeHTML(LINES[it.r])}</span>`\n      : `<span class="lens-in"><span class="badge lens-more">+${it.extra || it.more.length}</span></span>`;'),
  'showLens must prioritize it.extra to display +2 rather than total route count');
console.log('PASS 2: Lens correctly displays +N badge count using it.extra');

// 3. Verify hovering +N on tag focuses all routes on corridor with glow
const tagHoverSection = appJs.substring(appJs.indexOf('cur = { kind: "tag", id: "more" };'), appJs.indexOf('cur = { kind: "tag", id: "more" };') + 1200);
assert(tagHoverSection.includes('focusRoutes(groupList, false, { glow: true, widthScale: 1.65 });'),
  'Hovering +N must focus all corridor routes with glow and widthScale 1.65');
assert(tagHoverSection.includes('${' + 'allRoutes.length} routes share this street · Click to view all'),
  'Tooltip on +N hover must indicate total routes and offer to view all');
console.log('PASS 3: Hovering +N lights up all corridor routes with glow and displays total corridor count');

// 4. Verify clicking +N opens corridor picker with ALL routes and lights them up
const tagClickSection = appJs.substring(appJs.lastIndexOf('const tg = tagAt(e.point);'), appJs.lastIndexOf('const tg = tagAt(e.point);') + 600);
assert(tagClickSection.includes('const corridorList = (tg.item.more || []).map((i) => LINES[i]).filter(Boolean).sort(tagOrder);'),
  'Clicking +N must extract all routes from tg.item.more');
assert(tagClickSection.includes('showCorridor(corridorList);'),
  'Clicking +N must pass all routes to showCorridor so main routes do not disappear');
assert(tagClickSection.includes('focusRoutes(corridorList, false, { glow: true, widthScale: 1.65 });'),
  'Clicking +N must light up corridor routes on the map with glow: true');
console.log('PASS 4: Clicking +N shows all corridor routes (main routes preserved) and lights up corridor path');

// 5. Verify showCorridor activates corridor view with glow
const corridorSection = appJs.substring(appJs.indexOf('function showCorridor('), appJs.indexOf('function showCorridor(') + 600);
assert(corridorSection.includes('focusRoutes(corridorRoutes.map((id) => RBY[id]), false, { glow: true, widthScale: 1.65 });'),
  'showCorridor must activate focusRoutes with glow: true, widthScale: 1.65');
console.log('PASS 5: showCorridor illuminates corridor routes on map with glowing line');

// 6. Verify previewOnHover revert restores corridor routes with glow
const previewSection = appJs.substring(appJs.indexOf('function previewOnHover('), appJs.indexOf('function previewOnHover(') + 600);
assert(previewSection.includes('if (panelView === "corridor" && corridorRoutes.length) {\n        setNetDim(1);\n        focusRoutes(corridorRoutes.map((id) => RBY[id]), false, { glow: true, widthScale: 1.65 });'),
  'previewOnHover revert must restore glowing corridor routes');
console.log('PASS 6: previewOnHover revert maintains glowing corridor routes');

// 7. Verify blank map click clears corridor view
assert(appJs.includes('if (panelView === "corridor") {\n        panelView = "home";\n        corridorRoutes = [];\n        focusOff();\n        setNetDim(1);\n        showHome();\n        openSheet("peek");\n        return;\n      }'),
  'Clicking blank map area in corridor view must reset to home');
console.log('PASS 7: Clicking blank map space dismisses corridor view cleanly');

// 8. Strict check for emoji
const emojiRegex = /[\u{1F000}-\u{1FAFF}]/u;
assert(!emojiRegex.test(appJs.slice(appJs.indexOf('cur = { kind: "tag", id: "more" };'), appJs.indexOf('cur = { kind: "tag", id: "more" };') + 1000)),
  'No emoji allowed in tag hover/tooltip code');
console.log('PASS 8: No platform emoji in corridor tag code');

console.log('\nALL 8 CORRIDOR TAG OVERFLOW CHECKS PASSED PERFECTLY!');
