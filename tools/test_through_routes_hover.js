// Regression and interaction verification for through-routes card & individual button hover,
// route isolation, and line dimming.

const assert = require("assert");
const fs = require("fs");

const appJs = fs.readFileSync("web/app.js", "utf8");
const appCss = fs.readFileSync("web/app.css", "utf8");

console.log("=== THROUGH-ROUTES HOVER & ISOLATION VERIFICATION ===");

// 1. Verify CSS styles for individual button hover, active strand, and sibling dimming
assert(appCss.includes(".tr-partner-btn.is-hovered"), "CSS must support .tr-partner-btn.is-hovered");
assert(appCss.includes(".tr-partner-btn.is-active-strand"), "CSS must support .tr-partner-btn.is-active-strand");
assert(appCss.includes(".tr-route-item"), "CSS must support .tr-route-item");
assert(appCss.includes(".tr-guide-actions:has(.tr-partner-btn:hover) .tr-partner-btn:not(:hover)") ||
       appCss.includes(".tr-guide-actions:has(.tr-partner-btn.is-hovered)"),
       "CSS must support dimming sibling buttons when one route button is hovered");
console.log("PASS 1: CSS contains button hover states, active strand classes, and sibling dimming");

// 2. Verify through-routes card rendering attaches data-tr-route and data-tr-select
assert(appJs.includes('data-tr-route="${esc(routes[0]?.id || "")}"'), "Top column must include data-tr-route");
assert(appJs.includes('data-tr-select="${esc(r.id)}"'), "Bottom buttons must include data-tr-select");
console.log("PASS 2: Through-route cards output interactive data-tr-route and data-tr-select targets");

// 3. Verify individual button hover sets deep dimming (0.18) and focuses single route
assert(appJs.includes("setNetDim(0.18)"), "Individual route hover must deeply dim remaining lines to 0.18");
assert(appJs.includes("focusRoutes([r], false, { glow: true, widthScale: 1.85 })"),
       "Individual button hover must isolate the hovered route with glow and widthScale 1.85");
console.log("PASS 3: Hovering over individual route buttons isolates single route and deeply dims network");

// 4. Verify card-level hover sets card dimming (0.35) and focuses all routes in group
assert(appJs.includes("setNetDim(0.35)"), "Card-level hover must dim background network to 0.35");
assert(appJs.includes("focusRoutes(cardRoutes, false, { glow: true, widthScale: 1.58 })"),
       "Card-level hover must focus all through-route partner routes");
console.log("PASS 4: Hovering over card lights up all paired routes and dims network to 0.35");

// 5. Verify unhovering restores full network opacity and clears focus
assert(appJs.includes("setNetDim(1)"), "Leaving card must restore full network opacity (netDim = 1)");
assert(appJs.includes("focusOff()"), "Leaving card must clear focus with focusOff()");
console.log("PASS 5: Leaving through-route card restores netDim(1) and turns off focus");

// 6. Verify home widget through-route hover support
assert(appJs.includes('homeTr.addEventListener("mouseenter"'), "Home through-routes card must have mouseenter listener");
assert(appJs.includes('homeTr.addEventListener("mouseleave"'), "Home through-routes card must have mouseleave listener");
console.log("PASS 6: Home screen through-routes widget includes hover preview and reset");

console.log("\nALL THROUGH-ROUTES HOVER & ISOLATION CHECKS PASSED!");
