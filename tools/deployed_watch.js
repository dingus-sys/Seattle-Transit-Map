// Opens the DEPLOYED site (URL as argument) and prints live vehicle counts per agency every 10 s: the way to check live data on the real website.
// (Playwright is preinstalled in the cloud sandbox: NODE_PATH=$(npm root -g) node tools/deployed_watch.js)
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY } });
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('console', m.type(), m.text().slice(0, 200)); });
  await page.goto(process.argv[2] + '?v=' + Date.now(), { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => document.getElementById('loading').hidden === true, null, { timeout: 180000 });
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(10000);
    const r = await page.evaluate(() => { const L = window.__atlas.liveState(), c = {}; for (const v of L.vehicles.values()) c[v.agency] = (c[v.agency] || 0) + 1;
      return { c, last: L.last ? Math.round((Date.now() - L.last) / 1000) : null, pause: L.pauseUntil > Date.now(), polling: L.polling, st95: [...L.status.keys()].filter((x) => x.startsWith('95_')).length }; });
    console.log(JSON.stringify(r));
  }
  await browser.close();
})();
