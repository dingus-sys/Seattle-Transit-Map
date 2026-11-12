// Opens the Service alerts page and a route with an alert, counts live vehicle kinds, prints page errors. Needs live keys (see CLAUDE.md).
// (Playwright is preinstalled in the cloud sandbox: NODE_PATH=$(npm root -g) node tools/alertcheck.js)
const MAPLIBRE_JS = process.env.MAPLIBRE_JS || ''; // a local copy of maplibre-gl.js, when the CDN isn't reachable
const SITE = process.env.SITE || 'http://127.0.0.1:8765'; // the served site: python3 -m http.server -d site 8765
require('fs').mkdirSync('shots', { recursive: true });
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } } : {}) });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  if (MAPLIBRE_JS) await page.route('https://cdnjs.cloudflare.com/**/maplibre-gl.js', (r) => r.fulfill({ path: MAPLIBRE_JS, contentType: 'application/javascript' }));
  await page.route('https://tiles.openfreemap.org/**', (r) => r.abort());
  await page.goto(SITE + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('loading').hidden === true, null, { timeout: 120000 });
  // wait for alerts to arrive
  await page.waitForFunction(() => /Service alerts/.test(document.body.innerText) && !/Checking…/.test(document.querySelector('#openAlerts')?.innerText || 'Checking…'), null, { timeout: 90000 }).catch(() => {});
  console.log('home row:', await page.evaluate(() => document.querySelector('#openAlerts')?.innerText.replace(/\s+/g, ' ')));
  await page.screenshot({ path: 'shots/al-home.png' });
  await page.click('#openAlerts');
  await page.waitForTimeout(700);
  await page.locator('.alerts-view details').first().click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'shots/al-view.png' });
  console.log('alerts:', await page.evaluate(() => document.querySelectorAll('.alerts-view li.alert').length));
  // a route with an alert
  const rid = await page.evaluate(() => document.querySelector('.alerts-view .al-r')?.dataset.route);
  console.log('route', rid);
  if (rid) { await page.evaluate((id) => { location.hash = 'route-' + id; }, rid); await page.waitForTimeout(2500); await page.screenshot({ path: 'shots/al-route.png' }); }
  // ferries and trains, live
  await page.evaluate(() => { location.hash = ''; });
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__map.jumpTo({ center: [-122.42, 47.62], zoom: 11.3 }));
  await page.waitForTimeout(25000);
  await page.screenshot({ path: 'shots/al-ferries.png' });
  const vk = await page.evaluate(() => { const f = window.__map.getSource('vehicles')._data.features; const c = {}; for (const x of f) c[x.properties.m] = (c[x.properties.m] || 0) + 1; return { c, boats: f.filter((x) => x.properties.m === 'boat').map((x) => x.properties.r + ' ' + x.properties.lab).slice(0, 12) }; });
  console.log(JSON.stringify(vk));
  console.log('errors', errs.slice(0, 5));
  await browser.close();
})();
