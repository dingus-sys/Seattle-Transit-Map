// Simulates a pinch zoom (15 to 17) and screenshots right after it stops, to check lines stay together while zooming. Usage: node tools/zoomgap2.js <tag>.
// (Playwright is preinstalled in the cloud sandbox: NODE_PATH=$(npm root -g) node tools/zoomgap2.js)
const MAPLIBRE_JS = process.env.MAPLIBRE_JS || ''; // a local copy of maplibre-gl.js, when the CDN isn't reachable
const SITE = process.env.SITE || 'http://127.0.0.1:8765'; // the served site: python3 -m http.server -d site 8765
require('fs').mkdirSync('shots', { recursive: true });
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } } : {}) });
  const ctx = await browser.newContext({ viewport: { width: 640, height: 640 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  if (MAPLIBRE_JS) await page.route('https://cdnjs.cloudflare.com/**/maplibre-gl.js', (r) => r.fulfill({ path: MAPLIBRE_JS, contentType: 'application/javascript' }));
  await page.route('https://tiles.openfreemap.org/**', (r) => r.abort());
  await page.goto(SITE + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('loading').hidden === true, null, { timeout: 120000 });
  await page.addStyleTag({ content: '.sheet{display:none!important}' });
  const tag = process.argv[2] || 'a';
  // step the zoom up like a pinch: 0.12 zoom every 50 ms, from 15 to 17
  await page.evaluate(() => window.__map.jumpTo({ center: [-122.3128, 47.6612], zoom: 15 }));
  await page.waitForTimeout(1200); await page.evaluate(() => window.__atlas.idle()); await page.waitForTimeout(800);
  const res = await page.evaluate(async () => {
    const m = window.__map, frames = [];
    for (let z = 15; z <= 17.001; z += 0.12) {
      m.jumpTo({ zoom: z });
      m.fire('zoom'); // what a pinch sends each frame
      await new Promise((r) => setTimeout(r, 50));
    }
    return m.getZoom();
  });
  await page.screenshot({ path: `shots/zg2-${tag}-mid.png` });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `shots/zg2-${tag}-end.png` });
  console.log('zoom', res);
  await browser.close();
})();
