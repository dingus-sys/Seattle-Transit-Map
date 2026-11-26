// Hover dim in a real browser: pointing at a route fades everything else to HOVER_DIM while the
// route, its stops and its own number tags stay at full strength; leaving restores the map; a
// selected route's stronger dim is not deepened by hovering another line.
// Usage (site served on :8765): node tools/test_hover_dim.js
const path = require('path');

const SITE = process.env.SITE || 'http://127.0.0.1:8765';
const MAPLIBRE_JS = process.env.MAPLIBRE_JS || '';

async function run() {
  const pw = require('./pw').loadPlaywright();
  const browser = await pw.chromium.launch({ ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } } : {}) });
  const results = [];
  const check = (name, ok, info = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${info ? ' (' + info + ')' : ''}`); };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    if (MAPLIBRE_JS) await page.route(/maplibre-gl\.js$/, (r) => r.fulfill({ path: MAPLIBRE_JS, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } }));
    await page.route('https://tiles.openfreemap.org/**', (r) => r.abort());
    await page.route('https://api.pugetsound.onebusaway.org/**', (r) => r.abort());
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(SITE + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('loading') && document.getElementById('loading').hidden === true, null, { timeout: 60000 });
    // vehicles drift under the pointer and (correctly) win the hover; keep them out of the way
    await page.evaluate(() => { for (const id of ['veh-icon', 'veh-dir', 'veh-label']) window.__map.setLayoutProperty(id, 'visibility', 'none'); });
    await page.evaluate(() => window.__map.jumpTo({ center: [-122.318, 47.617], zoom: 14.2 }));
    await page.waitForTimeout(900);
    await page.evaluate(() => window.__atlas.idle());
    await page.waitForTimeout(500);

    const pt = await page.evaluate(() => {
      for (let y = 120; y < 760; y += 5) for (let x = 440; x < 1220; x += 5) {
        const rs = window.__atlas.routesAt({ x, y }, 2);
        if (rs && rs.length === 1) return { x, y, id: rs[0].id };
      }
      return null;
    });
    check('found a single-route line to hover', !!pt, pt ? pt.id : '');
    if (!pt) return false;
    const state = () => page.evaluate(() => ({
      dim: window.__atlas.hoverDim(),
      badges: window.__map.getPaintProperty('badges', 'icon-opacity'),
      stops: window.__map.getPaintProperty('stations', 'circle-opacity'),
      hovTags: ['hovlabels0', 'hovlabels1'].map((s) => (window.__map.getSource(s)._data.features || []).length),
      hovTagOpacity: [0, 1].map((i) => window.__map.getPaintProperty(`hov-badges-${i}`, 'icon-opacity')),
    }));

    await page.mouse.move(pt.x - 30, pt.y - 30);
    await page.mouse.move(pt.x, pt.y, { steps: 5 });
    await page.waitForTimeout(600);
    const on = await state();
    check('hovering a line fades the rest of the network to 0.5', on.dim.to === 0.5 && Math.abs(on.dim.v - 0.5) < 0.01, `v=${on.dim.v.toFixed(3)}`);
    check('the hovered route stays bright', (on.dim.ids || []).length >= 1, (on.dim.ids || []).join(','));
    check('other route tags and stations fade', on.badges === 0.5 && on.stops === 0.5, `tags=${on.badges}, stations=${on.stops}`);
    check("the hovered route's own tags are redrawn at full strength", on.hovTags.some((n) => n > 0) && on.hovTagOpacity.includes(1), JSON.stringify(on.hovTags));

    await page.mouse.move(200, 45, { steps: 4 });
    await page.waitForTimeout(800);
    const off = await state();
    check('leaving the line brings everything back to full strength', off.dim.to === 1 && off.dim.v === 1 && off.badges === 1 && off.stops === 1);
    check('the full-strength tag copies are cleared', off.hovTags.every((n) => n === 0));

    // switching theme while hovering: the fade carries over, and leaving still restores everything
    await page.mouse.move(pt.x - 30, pt.y - 30);
    await page.mouse.move(pt.x, pt.y, { steps: 5 });
    await page.waitForTimeout(600);
    await page.evaluate(() => document.querySelector('#themeBtn').click());
    await page.waitForTimeout(1200);
    const themed = await state();
    await page.mouse.move(200, 45, { steps: 4 });
    await page.waitForTimeout(900);
    const themedOff = await state();
    check('theme switch mid-hover keeps the fade, and leaving restores full strength',
      themed.dim.to === 0.5 && themedOff.dim.to === 1 && themedOff.badges === 1 && themedOff.stops === 1,
      `during=${themed.dim.to}, after: tags=${themedOff.badges}, stations=${themedOff.stops}`);

    // with a route selected, hovering another line must not dim the map further
    await page.evaluate(() => { location.hash = '#route-metro-10'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.__map.jumpTo({ center: [-122.318, 47.617], zoom: 14.2 }));
    await page.waitForTimeout(900);
    await page.mouse.move(pt.x, pt.y, { steps: 5 });
    await page.waitForTimeout(600);
    const sel = await state();
    check('with a route selected, hover adds no extra fade', sel.dim.to === 1, `to=${sel.dim.to}`);
    check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r).length;
  console.log(`\nTOTAL: ${results.length - failed}/${results.length} checks passed.`);
  return failed === 0;
}

if (require.main === module) run().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => { console.error(e); process.exit(1); });
module.exports = { run };
