// Regression test: ensure basemap OSM ferry maritime labels do not pollute street-name layer
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

// 1. Locate the street-name layer definition
const streetNameMatch = appJs.match(/id:\s*["']street-name["'][\s\S]*?filter:\s*(\[[^;]+?\]),\s*layout:/);
assert(streetNameMatch, 'street-name layer definition found in web/app.js');

// Parse the filter using Function / eval in sandboxed environment
const filterExpr = new Function(`return ${streetNameMatch[1]}`)();

function evalExpr(expr, feature, zoom) {
  if (typeof expr !== 'object' || expr === null) return expr;
  const op = expr[0];
  if (op === 'get') return feature[expr[1]];
  if (op === 'zoom') return zoom;
  if (op === 'literal') return expr[1];
  if (op === '!=') return evalExpr(expr[1], feature, zoom) !== evalExpr(expr[2], feature, zoom);
  if (op === '==') return evalExpr(expr[1], feature, zoom) === evalExpr(expr[2], feature, zoom);
  if (op === '>=') return evalExpr(expr[1], feature, zoom) >= evalExpr(expr[2], feature, zoom);
  if (op === '<=') return evalExpr(expr[1], feature, zoom) <= evalExpr(expr[2], feature, zoom);
  if (op === 'in') {
    const val = evalExpr(expr[1], feature, zoom);
    const list = evalExpr(expr[2], feature, zoom);
    return list.includes(val);
  }
  if (op === 'all') return expr.slice(1).every((e) => evalExpr(e, feature, zoom));
  if (op === 'any') return expr.slice(1).some((e) => evalExpr(e, feature, zoom));
  throw new Error('Unknown op: ' + op);
}

// Check 1: Ferries at high zooms (z15, z16, z17) MUST be suppressed
for (const z of [13, 14, 15, 15.5, 16, 17]) {
  const allowed = evalExpr(filterExpr, { class: 'ferry' }, z);
  assert.strictEqual(allowed, false, `ferry class at zoom ${z} must be rejected by street-name filter`);
}
console.log('PASS 1: OSM ferry class features are strictly suppressed at all zoom levels');

// Check 2: Non-street transportation classes (rail, transit, pier) are also rejected
for (const cls of ['rail', 'transit', 'pier']) {
  for (const z of [13, 15, 16]) {
    const allowed = evalExpr(filterExpr, { class: cls }, z);
    assert.strictEqual(allowed, false, `${cls} class at zoom ${z} must be rejected`);
  }
}
console.log('PASS 2: rail, transit, and pier classes are strictly excluded from street names');

// Check 3: Major streets display names at zoom >= 13
for (const cls of ['primary', 'secondary', 'trunk', 'motorway', 'tertiary']) {
  assert.strictEqual(evalExpr(filterExpr, { class: cls }, 13), true, `${cls} at zoom 13`);
  assert.strictEqual(evalExpr(filterExpr, { class: cls }, 15), true, `${cls} at zoom 15`);
}
console.log('PASS 3: Major streets (motorway, trunk, primary, secondary, tertiary) are displayed');

// Check 4: Minor streets display at zoom >= 15 but NOT at zoom < 15
for (const cls of ['minor', 'service']) {
  assert.strictEqual(evalExpr(filterExpr, { class: cls }, 14), false, `${cls} at zoom 14 should not show`);
  assert.strictEqual(evalExpr(filterExpr, { class: cls }, 15), true, `${cls} at zoom 15 should show`);
}
console.log('PASS 4: Minor and service streets display at zoom >= 15 only');

console.log('\nALL STREET-NAME FERRY SUPPRESSION CHECKS PASSED!');
