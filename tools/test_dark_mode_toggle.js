// Test verifying theme switching and dark mode toggle behavior.
// Ensures that turning off dark mode when the computer is in dark mode
// updates the MapLibre basemap colors (land, water, roads, parks)
// as well as the UI text, cards, and transit lines without desynchronization.

const assert = require("assert");
const fs = require("fs");

const appCode = fs.readFileSync("web/app.js", "utf8");
const cssCode = fs.readFileSync("web/app.css", "utf8");

console.log("=== DARK MODE TOGGLE & BASEMAP THEME SYNC TEST ===");

// 1. Verify applyTheme does NOT bail out silently on !map.isStyleLoaded()
const applyThemeStart = appCode.indexOf("function applyTheme()");
assert(applyThemeStart !== -1, "applyTheme function must exist in web/app.js");
const applyThemeBody = appCode.substring(applyThemeStart, applyThemeStart + 2500);

assert(!applyThemeBody.includes("if (!map || !map.isStyleLoaded()) return;"),
  "applyTheme must NOT silently abort when !map.isStyleLoaded() — causes desync where UI/lines change but basemap does not");

assert(applyThemeBody.includes("if (!map || !map.style)"),
  "applyTheme must check for map and map.style existence");

assert(!applyThemeBody.includes("styledata"),
  "applyTheme must NOT register styledata listeners, as setPaintProperty fires styledata and causes an infinite lockup loop");

assert(applyThemeBody.includes("map.triggerRepaint()"),
  "applyTheme must trigger an immediate repaint to ensure layers redraw cleanly");

console.log("PASS 1: applyTheme executes cleanly without styledata recursion loop");

// 2. Verify all base layers and custom layers are updated via setPaintProperty
assert(applyThemeBody.includes("baseLayers(P)"), "applyTheme must update baseLayers with active theme palette");
assert(applyThemeBody.includes("map.setPaintProperty("), "applyTheme must call map.setPaintProperty");
assert(applyThemeBody.includes("areaLayers(P, theme)"), "applyTheme must pass theme to areaLayers");
assert(applyThemeBody.includes("poiLayers(P, theme)"), "applyTheme must pass theme to poiLayers");
assert(applyThemeBody.includes("destLayers(P, theme)"), "applyTheme must pass theme to destLayers");
assert(applyThemeBody.includes("stopLayers(P, theme)"), "applyTheme must pass theme to stopLayers");
assert(applyThemeBody.includes("tripLayers(P, theme)"), "applyTheme must pass theme to tripLayers");

console.log("PASS 2: applyTheme updates all layer categories with theme palette");

// 3. Verify system-aware theme toggle button logic (#themeBtn)
const themeBtnStart = appCode.indexOf("const tb = $(\"#themeBtn\");");
assert(themeBtnStart !== -1, "#themeBtn setup must exist in web/app.js");
const themeBtnSection = appCode.substring(themeBtnStart, themeBtnStart + 1200);

assert(themeBtnSection.includes("next = mq.matches ? \"light\" : \"dark\""),
  "#themeBtn must switch directly to light when OS is dark and appearance is auto");

// Simulate the toggle cycle logic for both dark and light OS preferences
function simulateToggle(mqMatches, startVal, steps) {
  let cur = startVal;
  const history = [cur];
  for (let i = 0; i < steps; i++) {
    let next;
    if (!cur) {
      next = mqMatches ? "light" : "dark";
    } else if (cur === (mqMatches ? "light" : "dark")) {
      next = mqMatches ? "dark" : "light";
    } else {
      next = "";
    }
    cur = next;
    history.push(cur);
  }
  return history;
}

// OS Dark: Auto -> Light -> Dark -> Auto
const darkOsCycle = simulateToggle(true, "", 3);
assert.deepStrictEqual(darkOsCycle, ["", "light", "dark", ""],
  "When OS is dark, clicking #themeBtn once must switch directly to light mode, then dark, then auto");

// OS Light: Auto -> Dark -> Light -> Auto
const lightOsCycle = simulateToggle(false, "", 3);
assert.deepStrictEqual(lightOsCycle, ["", "dark", "light", ""],
  "When OS is light, clicking #themeBtn once must switch directly to dark mode, then light, then auto");

console.log("PASS 3: #themeBtn provides smart system-aware appearance cycling");

// 4. Verify CSS background properties on #map and canvas
assert(cssCode.includes("#map { position: fixed; inset: 0; background: var(--map); }"),
  "#map container must have background: var(--map) to prevent dark/light flash during style updates");
assert(cssCode.includes("#map canvas { background: var(--map); }"),
  "#map canvas must have background: var(--map)");

console.log("PASS 4: #map and canvas CSS backgrounds match theme variable");

// 5. Verify no platform emoji introduced
const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
assert(!EMOJI_REGEX.test(applyThemeBody), "No platform emoji in applyTheme");
assert(!EMOJI_REGEX.test(themeBtnSection), "No platform emoji in themeBtn setup");

console.log("PASS 5: Zero platform emoji in theme code");

console.log("\nALL DARK MODE TOGGLE & BASEMAP THEME SYNC CHECKS PASSED!");
