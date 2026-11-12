// The full browser check: 51 scripted checks (search, layers, hover, click, tags, themes, phone sheet, zoom sweep, every route opens). Run from the repo root with the site served on :8765. Prints PASS/FAIL per check and 'N/51 passed'.
// (Playwright is preinstalled in the cloud sandbox: NODE_PATH=$(npm root -g) node tools/sweep.js)
const MAPLIBRE_JS = process.env.MAPLIBRE_JS || ''; // a local copy of maplibre-gl.js, when the CDN isn't reachable
const SITE = process.env.SITE || 'http://127.0.0.1:8765'; // the served site: python3 -m http.server -d site 8765
require('fs').mkdirSync('shots', { recursive: true });
// Interaction sweep: drives the app like a user and checks each step. node sweep.js
const { chromium } = require('playwright');
const path = require('path');
const OUT = path.join(__dirname, 'shots');
const results = [];
const check = (name, ok, info = '') => { results.push([ok ? 'PASS' : 'FAIL', name, info]); };

async function open(browser, viewport, hash = '', scheme = 'light') {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: scheme });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_FAILED/.test(m.text())) page.errors.push(m.text()); });
  page.on('pageerror', (e) => page.errors.push('pageerror: ' + e.message));
  if (MAPLIBRE_JS) await page.route('https://cdnjs.cloudflare.com/**/maplibre-gl.js', (r) => r.fulfill({ path: MAPLIBRE_JS, contentType: 'application/javascript' }));
  await page.route('https://tiles.openfreemap.org/**', (r) => r.abort());
  await page.route('https://api.pugetsound.onebusaway.org/**', (r) => r.abort());
  await page.goto(SITE + '/index.html' + hash, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('loading').hidden === true, null, { timeout: 60000 });
  await page.waitForTimeout(800);
  return page;
}
const idle = (page) => page.evaluate(() => new Promise((res) => { const m = window.__map; let d = false; const f = () => { if (!d) { d = true; setTimeout(res, 200); } }; if (m.loaded() && !m.isMoving()) f(); else { m.once('idle', f); setTimeout(f, 5000); } }));

(async () => {
  const browser = await chromium.launch({ ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } } : {}) });

  // ---------- desktop
  let page = await open(browser, { width: 1280, height: 820 });
  check('loads without console errors', page.errors.length === 0, page.errors.join(' | '));
  check('title', (await page.title()) === 'King County Transit Map', await page.title());
  check('home is simple (no switches)', (await page.locator('.layer').count()) === 0 && (await page.locator('#openLayers').count()) === 1);
  check('map key lists visible line types', (await page.locator('.key-grid li').count()) >= 8, String(await page.locator('.key-grid li').count()));
  check('filter bar has 8 chips', (await page.locator('.fchip').count()) === 8, String(await page.locator('.fchip').count()));
  await page.click('.fchip[data-f="Buses"]'); await page.waitForTimeout(400);
  check('Buses chip hides buses', !(await page.evaluate(() => ['rapid', 'frequent', 'local'].some((k) => document.querySelector('.fchip[data-f="Buses"]').classList.contains('on')))));
  await page.click('.fchip[data-f="Buses"]'); await page.waitForTimeout(400);
  check('Buses chip brings them back', await page.locator('.fchip[data-f="Buses"].on').count() === 1);
  await page.click('#openLayers'); await page.waitForTimeout(500);
  check('legend rows', (await page.locator('.layer').count()) === 16, String(await page.locator('.layer').count()));
  check('display settings (4)', (await page.locator('.settings > li').count()) === 4);
  await page.click('.settings li[data-s="tags"] button[data-v="more"]'); await page.waitForTimeout(400);
  check('setting saved', await page.evaluate(() => JSON.parse(localStorage.getItem('kctm:settings') || localStorage.getItem('settings') || '{}').tags === 'more' || Object.keys(localStorage).some((k) => (localStorage.getItem(k) || '').includes('"tags":"more"'))));
  await page.click('#resetLayers'); await page.waitForTimeout(400);
  check('reset restores defaults', (await page.locator('#resetLayers').count()) === 0);

  // search
  await page.fill('#q', '49');
  await page.waitForTimeout(200);
  const firstResult = await page.locator('.result').first().innerText();
  check('search "49" top result is Route 49', /Route 49/.test(firstResult), firstResult.replace(/\n/g, ' '));
  await page.keyboard.press('Enter');
  await idle(page);
  check('Enter opens route card', /Route 49/.test(await page.locator('.hero h2').innerText()));
  check('hash set for route', (await page.evaluate(() => location.hash)) === '#route-metro-49', await page.evaluate(() => location.hash));
  check('selected route drawn', (await page.evaluate(() => window.__map.getSource('sel')._data.features.length)) > 0);
  await page.waitForTimeout(1500);
  check('selected route stops popped out', (await page.evaluate(() => window.__map.getSource('selstops')._data.features.length)) > 5,
    String(await page.evaluate(() => window.__map.getSource('selstops')._data.features.length)));
  {
    const pt = await page.evaluate(() => { const m = window.__map, W = m.getCanvas().clientWidth, H = m.getCanvas().clientHeight; const f = m.getSource('selstops')._data.features.find((x) => { const p = m.project(x.geometry.coordinates); return p.x > 460 && p.x < W - 120 && p.y > 80 && p.y < H - 80; }) || m.getSource('selstops')._data.features[3]; const p = m.project(f.geometry.coordinates); return [p.x, p.y, f.properties.name]; });
    await page.mouse.move(pt[0], pt[1]); await page.waitForTimeout(400);
    const tip = await page.locator('#tip').innerText().catch(() => '');
    check('hovering a stop shows its name', tip.includes(pt[2].slice(0, 8)), `${tip} / ${pt[2]}`);
  }
  check('schedule table rows', (await page.locator('table.sched tbody tr').count()) === 6);
  check('stop list filled', (await page.locator('#stoplist li').count()) > 10, String(await page.locator('#stoplist li').count()));
  await page.locator('.segmented button').nth(1).click();
  await page.waitForTimeout(150);
  check('direction tab switches', (await page.locator('.segmented button').nth(1).getAttribute('aria-selected')) === 'true');
  await page.screenshot({ path: path.join(OUT, 'sweep-route.png') });

  // stop from list (updates active boarding stop, then opens full stop card via All departures)
  await page.locator('#stoplist button').nth(3).click();
  await page.waitForTimeout(300);
  await page.locator('#rdAllDepsBtn').click();
  await idle(page);
  check('stop card from route stop list', /stop here/.test(await page.locator('.view').innerText()));
  await page.locator('#back').click();
  await page.waitForTimeout(300);
  check('back returns from stop card', /Route 49/.test(await page.locator('.hero h2').innerText().catch(() => '')));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check('hash cleared', (await page.evaluate(() => location.hash)) === '');
  if ((await page.locator('.layer').count()) === 0) {
    await page.click('#openLayers');
    await page.waitForTimeout(300);
  }

  // layer toggle
  await page.locator('.layer[data-key="peak"]').click();
  await page.waitForTimeout(300);
  check('toggle rush hour on', await page.locator('#lyr-peak').isChecked());
  const peakFeats = await page.evaluate(() => window.__map.getSource('net')._data.features.filter((f) => f.properties.cat === 'peak').length);
  check('rush-hour lines drawn when on', peakFeats > 0, String(peakFeats));
  await page.locator('.layer[data-key="peak"] .switch').click();
  await page.waitForTimeout(300);
  check('toggle rush hour off', !(await page.locator('#lyr-peak').isChecked()));
  await page.locator('.layer[data-key="frequent"]').click();
  await page.waitForTimeout(300);
  const freqFeats = await page.evaluate(() => window.__map.getSource('net')._data.features.filter((f) => f.properties.cat === 'frequent').length);
  check('frequent lines hidden when off', freqFeats === 0, String(freqFeats));
  await page.locator('.layer[data-key="frequent"]').click();
  await page.waitForTimeout(300);

  // click a busy corridor on the map
  await page.evaluate(() => window.__map.jumpTo({ center: [-122.3175, 47.6612], zoom: 15.5 }));
  await idle(page);
  const pt = await page.evaluate(() => {
    const m = window.__map;
    const fs = m.getSource('net')._data.features.filter((f) => f.properties.cat === 'frequent');
    for (const f of fs) {
      const c = f.geometry.coordinates[Math.floor(f.geometry.coordinates.length / 2)];
      const p = m.project(c);
      if (p.x > 420 && p.x < 1200 && p.y > 80 && p.y < 760) return { x: p.x, y: p.y };
    }
    return null;
  });
  check('found a corridor to click', !!pt);
  if (pt) {
    await page.mouse.move(pt.x, pt.y);
    await page.waitForTimeout(250);
    check('hover shows tooltip', !(await page.locator('#tip').isHidden()));
    check('hover does not dim the map', JSON.stringify(await page.evaluate(() => window.__map.getPaintProperty('line-bus', 'line-opacity'))) === '1');
    {
      await page.mouse.move(3, 3); await page.waitForTimeout(300);
      const tg = await page.evaluate(() => { const m = window.__map, W = m.getCanvas().clientWidth, H = m.getCanvas().clientHeight;
        const f = m.queryRenderedFeatures({ layers: ['badges'] }).find((x) => { const p = m.project(x.geometry.coordinates); return x.properties.k.split(':')[1].split('.').length >= 2 && p.x > 450 && p.x < W - 80 && p.y > 80 && p.y < H - 80; });
        if (!f) return null; const p = m.project(f.geometry.coordinates); return [p.x, p.y]; });
      if (tg) {
        await page.mouse.move(tg[0] - 4, tg[1]); await page.waitForTimeout(700);
        check('pointing at a tag number lifts it and shows that route', !(await page.locator('#lens').isHidden()) && (await page.evaluate(() => window.__map.getSource('hover')._data.features.length + window.__map.getSource('hover2')._data.features.length)) > 0);
        await page.mouse.move(3, 3); await page.waitForTimeout(400);
      } else check('found a tag to point at', false);
    }
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(500);
    const pop = await page.locator('.glass-pop').count();
    const card = await page.locator('.hero h2').count();
    check('click corridor opens route list or route', pop > 0 || card > 0, `popup=${pop} card=${card}`);
    if (pop > 0) {
      await page.screenshot({ path: path.join(OUT, 'sweep-popup.png') });
      await page.locator('.glass-pop [data-route]').first().click();
      await idle(page);
      check('choosing from popup opens route', (await page.locator('.hero h2').count()) > 0);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check('Escape clears selection', (await page.locator('#openLayers').count()) === 1 && (await page.evaluate(() => location.hash)) === '');
  }

  // click a station
  await page.evaluate(() => window.__map.jumpTo({ center: [-122.3378, 47.6114], zoom: 15 }));
  await idle(page);
  const st = await page.evaluate(() => {
    const m = window.__map;
    const f = m.queryRenderedFeatures({ layers: ['stations'] }).find((x) => /Westlake/.test(x.properties.name));
    return f ? m.project(f.geometry.coordinates) : null;
  });
  if (st) {
    await page.mouse.click(st.x, st.y);
    await page.waitForTimeout(500);
    const t = await page.locator('.hero h2').innerText().catch(() => '');
    check('clicking a station opens its card', /Westlake/.test(t), t);
    check('station lists nearby buses', /short walk/.test(await page.locator('.view').innerText()));
  } else check('station visible to click', false);

  // theme cycle
  for (const want of ['dark', 'light', null]) {
    await page.locator('#themeBtn').click();
    await page.waitForTimeout(400);
    const got = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    check(`theme button -> ${want || 'auto'}`, got === want, String(got));
  }
  // zoom buttons
  const z0 = await page.evaluate(() => window.__map.getZoom());
  await page.locator('#zoomIn').click(); await page.waitForTimeout(600);
  const z1 = await page.evaluate(() => window.__map.getZoom());
  check('zoom in button', z1 > z0 + 0.5, `${z0.toFixed(2)} -> ${z1.toFixed(2)}`);
  await page.locator('#zoomOut').click(); await page.waitForTimeout(600);
  check('zoom out button', (await page.evaluate(() => window.__map.getZoom())) < z1 - 0.5);
  // every route opens without errors
  const ids = await page.evaluate(() => [...document.querySelectorAll('.layer')].length && window.__map && Object.keys(window.__routesForTest || {}).length);
  const allIds = await page.evaluate(() => fetch('data/routes.json').then((r) => r.json()).then((d) => d.routes.map((r) => r.id)));
  let bad = [];
  for (const id of allIds) {
    await page.evaluate((id) => { location.hash = 'route-' + id; }, id);
    await page.waitForTimeout(60);
  }
  await idle(page);
  check(`opened all ${allIds.length} routes by link without errors`, page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
  // zoom sweep for render errors
  for (const z of [9.5, 11, 12.5, 14, 16, 18]) { await page.evaluate((z) => window.__map.jumpTo({ center: [-122.33, 47.62], zoom: z }), z); await page.waitForTimeout(250); }
  await idle(page);
  check('zoom sweep without errors', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
  await page.context().close();

  // ---------- phone
  page = await open(browser, { width: 390, height: 844 });
  const cls = () => page.evaluate(() => document.getElementById('panel').className);
  check('phone: sheet starts at peek', /at-peek/.test(await cls()), await cls());
  await page.locator('#grabber').click(); await page.waitForTimeout(700);
  check('phone: grabber -> half', /at-half/.test(await cls()), await cls());
  await page.locator('#grabber').click(); await page.waitForTimeout(700);
  check('phone: grabber -> full', /at-full/.test(await cls()), await cls());
  await page.screenshot({ path: path.join(OUT, 'sweep-phone-full.png') });
  await page.locator('#grabber').click(); await page.waitForTimeout(700);
  check('phone: grabber -> peek', /at-peek/.test(await cls()), await cls());
  await page.evaluate(() => { location.hash = 'route-metro-e-line'; });
  await page.waitForTimeout(1500);
  check('phone: route opens sheet at half', /at-half/.test(await cls()), await cls());
  await page.screenshot({ path: path.join(OUT, 'sweep-phone-route.png') });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('phone: no horizontal overflow', !overflow);
  check('phone: no console errors', page.errors.length === 0, page.errors.join(' | '));
  await page.context().close();

  // ---------- dark, shared link to a station
  page = await open(browser, { width: 1280, height: 820 }, '#station-u-district-st-n07', 'dark');
  await idle(page);
  check('dark: station link opens card', /U District/.test(await page.locator('.hero h2').innerText().catch(() => '')));
  await page.screenshot({ path: path.join(OUT, 'sweep-dark-station.png') });
  check('dark: no console errors', page.errors.length === 0, page.errors.join(' | '));
  await page.context().close();

  await browser.close();
  for (const r of results) console.log(r[0], '-', r[1], r[2] ? `(${r[2]})` : '');
  console.log(`${results.filter((r) => r[0] === 'PASS').length}/${results.length} passed`);
})();
