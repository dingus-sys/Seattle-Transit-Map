// Moves the pointer slowly across the map while recording video (vid2/) and logging every tooltip change with timestamps, to look for flicker.
// (Playwright is preinstalled in the cloud sandbox: NODE_PATH=$(npm root -g) node tools/hovervid.js)
const MAPLIBRE_JS = process.env.MAPLIBRE_JS || ''; // a local copy of maplibre-gl.js, when the CDN isn't reachable
const SITE = process.env.SITE || 'http://127.0.0.1:8765'; // the served site: python3 -m http.server -d site 8765
require('fs').mkdirSync('shots', { recursive: true });
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } });
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1, recordVideo: { dir: 'vid2', size: { width: 800, height: 600 } } });
  await ctx.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  if (MAPLIBRE_JS) await page.route('https://cdnjs.cloudflare.com/**/maplibre-gl.js', (r) => r.fulfill({ path: MAPLIBRE_JS, contentType: 'application/javascript' }));
  await page.route('https://tiles.openfreemap.org/**', (r) => r.abort());
  await page.goto(SITE + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('loading').hidden === true, null, { timeout: 120000 });
  await page.addStyleTag({ content: '.sheet{display:none!important}' });
  await page.evaluate(() => window.__map.jumpTo({ center: [-122.3425, 47.6535], zoom: 16 }));
  await page.waitForTimeout(800); await page.evaluate(() => window.__atlas.idle()); await page.waitForTimeout(1500);
  await page.evaluate(() => {
    window.__tipLog = [];
    const t = document.getElementById('tip');
    new MutationObserver(() => window.__tipLog.push([Math.round(performance.now()), t.hidden ? '-' : t.innerText.replace(/\s+/g, ' ').slice(0, 40)])).observe(t, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  });
  const path = [];
  for (let i = 0; i <= 120; i++) { const a = i / 120; path.push([200 + 420 * a, 300 + 60 * Math.sin(a * 6.28)]); }
  for (const [x, y] of path) { await page.mouse.move(x, y); await page.waitForTimeout(30); }
  await page.waitForTimeout(500);
  const log = await page.evaluate(() => window.__tipLog);
  const out = []; for (const e of log) if (!out.length || out[out.length - 1][1] !== e[1]) out.push(e);
  console.log(out.map((e) => e.join(' ')).join('\n'));
  await ctx.close(); await browser.close();
})();
