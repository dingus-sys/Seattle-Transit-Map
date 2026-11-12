// Automated verification test suite for hover cards (+N overflow tags and stops)
// Exercises safe bridge traversal with real mouse movements, route chip interactions,
// corridor view activation, dismissals, wheel forwarding, and boundary clipping checks.
// Usage: node tools/test_hover_cards.js

const path = require('path');
const fs = require('fs');

const SITE = process.env.SITE || 'http://127.0.0.1:8765';
const MAPLIBRE_JS = process.env.MAPLIBRE_JS || '';

async function run() {
  let pw;
  try {
    pw = require('playwright');
  } catch (e) {
    const candidates = [
      path.join(process.env.HOME || '', '.npm/_npx/e41f203b7505f1fb/node_modules/playwright'),
      path.join(process.env.HOME || '', 'Library/Caches/ms-playwright'),
    ];
    for (const c of candidates) {
      try { pw = require(c); break; } catch (_) {}
    }
    if (!pw) throw new Error('Playwright not found');
  }

  const { chromium } = pw;
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } } : {})
  });

  const results = [];
  const check = (name, ok, info = '') => {
    results.push([ok ? 'PASS' : 'FAIL', name, info]);
    console.log(`${ok ? 'PASS' : 'FAIL'}: ${name} ${info ? '(' + info + ')' : ''}`);
  };

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    if (MAPLIBRE_JS) await page.route('https://cdnjs.cloudflare.com/**/maplibre-gl.js', (r) => r.fulfill({ path: MAPLIBRE_JS, contentType: 'application/javascript' }));
    await page.route('https://tiles.openfreemap.org/**', (r) => r.abort());
    await page.route('https://api.pugetsound.onebusaway.org/**', (r) => r.abort());

    await page.goto(SITE + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('loading') && document.getElementById('loading').hidden === true, null, { timeout: 60000 });
    await page.waitForTimeout(600);

    console.log('\n=== SUITE 1: +N TAG HOVER CARD & SAFE BRIDGE ===');
    // Position map to bring 8-route corridor tag into clear canvas
    await page.evaluate(() => window.__map.jumpTo({ center: [-122.330, 47.600], zoom: 15.0 }));
    await page.waitForTimeout(1000);

    const startX = 1026, startY = 441;
    await page.mouse.move(startX, startY);
    await page.waitForTimeout(250);

    const opened = await page.evaluate(() => {
      const tip = document.querySelector('#tip');
      return tip && !tip.hidden && tip.className.includes('tip-live');
    });
    check('+N tag opens interactive live card on hover', opened);

    // Micro-step mouse traversal across the safe bridge onto the first route chip
    const destX = 1040, destY = 470;
    const steps = 15;
    let stayedOpen = true;
    for (let i = 1; i <= steps; i++) {
      const curX = startX + (destX - startX) * (i / steps);
      const curY = startY + (destY - startY) * (i / steps);
      await page.mouse.move(curX, curY);
      await page.waitForTimeout(20);
      const openAtStep = await page.evaluate(() => {
        const tip = document.querySelector('#tip');
        return tip && !tip.hidden;
      });
      if (!openAtStep) { stayedOpen = false; break; }
    }
    check('Safe bridge keeps +N card alive during micro-step pointer traversal', stayedOpen);

    // Check boundary clipping (card must be within viewport and right of left panel)
    const bounds = await page.evaluate(() => {
      const tip = document.querySelector('#tip');
      const r = tip.getBoundingClientRect();
      const panel = document.querySelector('#panel').getBoundingClientRect();
      return {
        left: r.left, right: r.right, top: r.top, bottom: r.bottom,
        panelRight: panel.right,
        unclipped: r.left >= panel.right && r.right <= 1280 && r.top >= 0 && r.bottom <= 820
      };
    });
    check('+N card is fully visible without clipping by panel or screen edge', bounds.unclipped,
      `left=${bounds.left.toFixed(0)}, panelRight=${bounds.panelRight.toFixed(0)}, right=${bounds.right.toFixed(0)}`);

    fs.mkdirSync('shots', { recursive: true });
    await page.screenshot({ path: 'shots/hover-tag-card.png' });

    // Hovering route chip lights up that route
    const hoveredRoute = await page.evaluate(() => {
      const hover = window.__map.getSource('hover');
      return hover && hover._data && hover._data.features.length > 0;
    });
    check('Hovering route chip illuminates route path on map', hoveredRoute);

    // Wheel forwarding: mouse wheel over card scrolls/zooms the map
    const z0 = await page.evaluate(() => window.__map.getZoom());
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(350);
    const z1 = await page.evaluate(() => window.__map.getZoom());
    check('Mouse wheel over card zooms the underlying map', z1 !== z0, `z0=${z0.toFixed(2)}, z1=${z1.toFixed(2)}`);

    // Escape key closes the hover card
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    const escaped = await page.evaluate(() => {
      const tip = document.querySelector('#tip');
      return tip.hidden || tip.classList.contains('tip-leaving');
    });
    check('Escape key dismisses the hover card', escaped);

    // Re-open and click chip directly selects route
    await page.mouse.move(startX, startY);
    await page.waitForTimeout(250);
    await page.mouse.move(destX, destY);
    await page.waitForTimeout(200);
    await page.mouse.click(destX, destY);
    await page.waitForTimeout(400);
    const selRoute = await page.evaluate(() => location.hash);
    check('Clicking route chip selects the route directly', selRoute.startsWith('#route-'), selRoute);

    // Click back to return
    await page.evaluate(() => {
      location.hash = '';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await page.waitForTimeout(400);

    // Re-open and click card body opens corridor view
    await page.evaluate(() => window.__map.jumpTo({ center: [-122.330, 47.600], zoom: 15.0 }));
    await page.waitForTimeout(800);
    await page.mouse.move(startX, startY);
    await page.waitForTimeout(250);
    await page.mouse.move(1120, 490); // card footer / body area
    await page.waitForTimeout(200);
    await page.mouse.click(1120, 490);
    await page.waitForTimeout(400);
    const corridorOpen = await page.evaluate(() => !!document.querySelector('.corridor-picker'));
    check('Clicking +N card footer/body opens corridor route chooser', corridorOpen);

    // Reset back to home
    await page.evaluate(() => {
      document.querySelector('#back')?.click();
      location.hash = '';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await page.waitForTimeout(400);

    console.log('\n=== SUITE 2: STOP HOVER CARD & SAFE BRIDGE ===');
    // Zoom in to downtown stop (e.g. 3rd & Pike / Pine area)
    await page.evaluate(() => window.__map.jumpTo({ center: [-122.3365, 47.6105], zoom: 16.5 }));
    await page.waitForTimeout(800);

    const stopPoint = await page.evaluate(() => {
      const m = window.__map;
      const fs = m.queryRenderedFeatures({ layers: ['stops'] });
      for (const f of fs) {
        const p = m.project(f.geometry.coordinates);
        if (p.x > 450 && p.x < 1100 && p.y > 150 && p.y < 650) {
          return { x: p.x, y: p.y, name: f.properties.name, id: f.properties.id };
        }
      }
      return null;
    });
    check('Found rendered stop pin in clear canvas area', !!stopPoint, stopPoint ? stopPoint.name : '');

    if (stopPoint) {
      await page.mouse.move(stopPoint.x, stopPoint.y);
      await page.waitForTimeout(250);

      const stopCardOpen = await page.evaluate(() => {
        const tip = document.querySelector('#tip');
        return tip && !tip.hidden && tip.querySelector('.sc-name') !== null;
      });
      check('Hovering stop pin opens stop hover card with name and departures', stopCardOpen);

      // Traversal from stop pin into stop card
      const tipBox = await page.evaluate(() => {
        const r = document.querySelector('#tip').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + 20, rect: r };
      });

      let stopStayedOpen = true;
      for (let i = 1; i <= 10; i++) {
        const cx = stopPoint.x + (tipBox.x - stopPoint.x) * (i / 10);
        const cy = stopPoint.y + (tipBox.y - stopPoint.y) * (i / 10);
        await page.mouse.move(cx, cy);
        await page.waitForTimeout(20);
        if (await page.evaluate(() => document.querySelector('#tip').hidden)) {
          stopStayedOpen = false;
          break;
        }
      }
      check('Safe bridge keeps stop card alive when moving pointer from pin into card', stopStayedOpen);

      await page.screenshot({ path: 'shots/hover-stop-card.png' });
      const stopBounds = await page.evaluate(() => {
        const r = document.querySelector('#tip').getBoundingClientRect();
        return r.left >= 0 && r.right <= 1280 && r.top >= 0 && r.bottom <= 820;
      });
      check('Stop card is fully visible on screen without clipping', stopBounds);

      // Clicking stop card selects the stop
      await page.mouse.click(tipBox.x, tipBox.y);
      await page.waitForTimeout(400);
      const selectedStop = await page.evaluate(() => document.querySelector('.hero h2')?.innerText);
      check('Clicking stop card body opens the full stop details panel', !!selectedStop, selectedStop);
    }

    const failed = results.filter((r) => r[0] === 'FAIL').length;
    console.log(`\n================================`);
    console.log(`TOTAL: ${results.length - failed}/${results.length} checks passed.`);
    return failed === 0;
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  run()
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { run };
