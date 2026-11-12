// Verification test suite for clicking hovered route line vs corridor picker
const fs = require('fs');
const assert = require('assert');

const appJs = fs.readFileSync('web/app.js', 'utf8');

// 1. Verify click handler priority: hovered/strand route is selected directly
assert(appJs.includes('const hoveredRoute = (cur && cur.kind === "line" && cur.id >= 0) ? LINES[cur.id] : null;'),
  'Click handler must inspect currently hovered route');
assert(appJs.includes('const strandRoute = (hoveredRoute && rs.some((r) => r.id === hoveredRoute.id))'),
  'Click handler must prioritize the hovered route if it is on the clicked corridor');
assert(appJs.includes('if (strandRoute) {\n        selectRoute(strandRoute.id, { fit: true });\n        return;\n      }'),
  'Click handler must select the strand/hovered route directly');

console.log('PASS 1: Clicking a route while it is hovered directly selects that route');

// 2. Verify corridor picker keeps full network visible (setNetDim(1))
const showCorridorMatch = appJs.match(/function showCorridor\([\s\S]*?\{([\s\S]*?)\n  \}/);
assert(showCorridorMatch, 'showCorridor function found');
const corridorBody = showCorridorMatch[1];
assert(corridorBody.includes('setNetDim(1);'), 'showCorridor must maintain full network visibility (setNetDim(1))');
assert(!corridorBody.includes('setNetDim(0.38);'), 'showCorridor must not dim the background network to 0.38');

console.log('PASS 2: Corridor picker keeps all transit lines on map visible (setNetDim(1))');

// 3. Verify previewOnHover revert in corridor view preserves full network visibility
assert(appJs.includes('if (panelView === "corridor" && corridorRoutes.length) {\n        setNetDim(1);\n        focusRoutes(corridorRoutes'),
  'previewOnHover revert in corridor view must restore setNetDim(1)');

console.log('PASS 3: PreviewOnHover revert restores full network visibility');

console.log('\nALL CLICK HOVERED ROUTE & CORRIDOR CHECKS PASSED!');
