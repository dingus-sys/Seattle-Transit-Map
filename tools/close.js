// Screenshots of views: node tools/close.js '[["name",[lon,lat],zoom],...]' writes shots/c-name.png (800x700 @2x).
// (Playwright is preinstalled in the cloud sandbox: NODE_PATH=$(npm root -g) node tools/close.js)
const MAPLIBRE_JS = process.env.MAPLIBRE_JS || ''; // a local copy of maplibre-gl.js, when the CDN isn't reachable
const SITE = process.env.SITE || 'http://127.0.0.1:8765'; // the served site: python3 -m http.server -d site 8765
require('fs').mkdirSync('shots', { recursive: true });
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } } : {}) });
  const ctx = await browser.newContext({ viewport: { width: 800, height: 700 }, deviceScaleFactor: 2 });
  // LAYERS=link,rail,...,trails picks the layers shown (default: the transit layers, no bikes)
  const layers = process.env.LAYERS ? process.env.LAYERS.split(',') : ['link','rail','streetcar','monorail','rapid','frequent','local','water','dart','flex','stops'];
  await ctx.addInitScript((layers) => { try { localStorage.clear(); localStorage.setItem('kctm:layers2', JSON.stringify(layers)); } catch (e) {} }, layers);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  if (MAPLIBRE_JS) await page.route(/maplibre-gl\.js$/, (r) => r.fulfill({ path: MAPLIBRE_JS, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.route('https://tiles.openfreemap.org/**', (r) => r.abort());
  await page.goto(SITE + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('loading').hidden === true, null, { timeout: 120000 });
  await page.addStyleTag({ content: '.sheet{display:none!important}' });
  const views = JSON.parse(process.argv[2]);
  for (const [n, c, z, hash] of views) {
    await page.evaluate(([c, z, h]) => { location.hash = h || ''; }, [c, z, hash]);
    await page.waitForTimeout(hash ? 1500 : 300);
    await page.evaluate(([c, z]) => window.__map.jumpTo({ center: c, zoom: z }), [c, z]);
    await page.waitForTimeout(800); await page.evaluate(() => window.__atlas.idle()); await page.waitForTimeout(2200);
    await page.screenshot({ path: `shots/c-${n}.png` });
  }
  await browser.close();
})();
