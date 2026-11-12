// Harness for running in-page check scripts (zoom_check, corridor_check, mobile_check, etc.)
// via Node and Playwright against the local site.
// Usage: node tools/run_browser_check.js tools/zoom_check.js
// Or import { runInPage } and run directly.

const fs = require('fs');
const path = require('path');

const SITE = process.env.SITE || 'http://127.0.0.1:8765';
const MAPLIBRE_JS = process.env.MAPLIBRE_JS || '';

async function runInPage(scriptPath, options = {}) {
  let pw;
  try {
    pw = require('playwright');
  } catch (e) {
    // Attempt standard cached paths if NODE_PATH wasn't set
    const candidates = [
      path.join(process.env.HOME || '', '.npm/_npx/e41f203b7505f1fb/node_modules/playwright'),
      path.join(process.env.HOME || '', 'Library/Caches/ms-playwright'),
    ];
    for (const c of candidates) {
      try {
        pw = require(c);
        break;
      } catch (_) {}
    }
    if (!pw) throw new Error('Playwright not found. Run with NODE_PATH set (see CLAUDE.md).');
  }

  const { chromium } = pw;
  const viewport = options.viewport || (options.mobile ? { width: 390, height: 844 } : { width: 1280, height: 820 });
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } } : {})
  });

  try {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    if (MAPLIBRE_JS) await page.route('https://cdnjs.cloudflare.com/**/maplibre-gl.js', (r) => r.fulfill({ path: MAPLIBRE_JS, contentType: 'application/javascript' }));
    await page.route('https://tiles.openfreemap.org/**', (r) => r.abort());
    await page.route('https://api.pugetsound.onebusaway.org/**', (r) => r.abort());

    const url = SITE + '/index.html' + (options.hash || '');
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('loading') && document.getElementById('loading').hidden === true, null, { timeout: 60000 });
    await page.waitForTimeout(800);

    const scriptCode = fs.readFileSync(scriptPath, 'utf8');
    const result = await page.evaluate(scriptCode);

    console.log(`\n=== Results for ${path.basename(scriptPath)} ===`);
    if (result && Array.isArray(result.results)) {
      for (const r of result.results) {
        console.log(`${r.ok ? 'PASS' : 'FAIL'}: ${r.name} ${r.detail ? '(' + r.detail + ')' : ''}`);
      }
      console.log(`\n${result.passed}/${result.total} checks passed.`);
      return result.passed === result.total;
    } else {
      console.log('Script returned:', result);
      return true;
    }
  } finally {
    await browser.close();
  }
}

module.exports = { runInPage };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node tools/run_browser_check.js <path-to-check-script.js>');
    process.exit(1);
  }
  const isMobile = /mobile/.test(file);
  runInPage(path.resolve(file), { mobile: isMobile })
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
