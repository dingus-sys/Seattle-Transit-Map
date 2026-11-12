// How long a layout takes in the background worker on a 4x slowed CPU, at several zooms.
// (Playwright is preinstalled in the cloud sandbox: NODE_PATH=$(npm root -g) node tools/bench.js)
const MAPLIBRE_JS = process.env.MAPLIBRE_JS || ''; // a local copy of maplibre-gl.js, when the CDN isn't reachable
const SITE = process.env.SITE || 'http://127.0.0.1:8765'; // the served site: python3 -m http.server -d site 8765
require('fs').mkdirSync('shots', { recursive: true });
// Main-thread cost of redrawing the lines: time blocked per redraw, with a 4x CPU slowdown (phone-like).
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } } : {}) });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await ctx.newPage();
  if (MAPLIBRE_JS) await page.route('https://cdnjs.cloudflare.com/**/maplibre-gl.js', (r) => r.fulfill({ path: MAPLIBRE_JS, contentType: 'application/javascript' }));
  await page.route('https://tiles.openfreemap.org/**', (r) => r.abort());
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const t0 = Date.now();
  await page.goto(SITE + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('loading').hidden === true, null, { timeout: 300000 });
  console.log('ready after', ((Date.now() - t0) / 1000).toFixed(1), 's');
  const views = [[[-122.33, 47.61], 13], [[-122.3, 47.62], 11], [[-122.25, 47.55], 10], [[-122.2, 47.6], 14.5], [[-122.33, 47.61], 15.5]];
  const res = await page.evaluate(async (views) => {
    const out = [];
    for (const [c, z] of views) {
      window.__map.jumpTo({ center: c, zoom: z });
      await new Promise((r) => setTimeout(r, 400));
      const ts = [], ws = [];
      for (let i = 0; i < 3; i++) { ts.push(window.__atlas.timeRebuild()); if (window.__atlas.idle) { await window.__atlas.idle(); ws.push(window.__atlas.lastBuildMs()); } }
      ts.sort((a, b) => a - b); ws.sort((a, b) => a - b);
      out.push(`z${z}: page ${ts[1].toFixed(0)} ms` + (ws.length ? ` (worker ${ws[1].toFixed(0)} ms)` : ''));
    }
    return out;
  }, views);
  console.log('in worker:', await page.evaluate(() => window.__atlas.inWorker && window.__atlas.inWorker()));
  console.log('time per redraw:', res.join(', '));
  await browser.close();
})();
