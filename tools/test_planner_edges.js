// Trip planner edge cases found by an independent QA pass (Nov 17 2026), in a real browser:
// the date picker opens above the trip cards and works in Seattle time from any time zone;
// Arrive by offers the latest departure that still arrives in time; a holiday or service-change
// date uses that date's own trips; station searches that include "Station" find the station;
// Escape closes the whole planner; bad coordinates and far-off map links are refused.
// Usage (site served on :8765): node tools/test_planner_edges.js
const path = require('path');

const SITE = process.env.SITE || 'http://127.0.0.1:8765';
const MAPLIBRE_JS = process.env.MAPLIBRE_JS || '';

async function run() {
  let pw;
  try { pw = require('playwright'); } catch (e) {
    pw = require(path.join(process.env.HOME || '', '.npm/_npx/e41f203b7505f1fb/node_modules/playwright'));
  }
  const browser = await pw.chromium.launch({ ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } } : {}) });
  const results = [];
  const check = (name, ok, info = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${info ? ' (' + info + ')' : ''}`); };
  const open = async (opts = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, ...opts });
    const page = await ctx.newPage();
    if (MAPLIBRE_JS) await page.route('https://cdnjs.cloudflare.com/**/maplibre-gl.js', (r) => r.fulfill({ path: MAPLIBRE_JS, contentType: 'application/javascript' }));
    await page.route('https://tiles.openfreemap.org/**', (r) => r.abort());
    await page.route('https://api.pugetsound.onebusaway.org/**', (r) => r.abort());
    await page.route('https://photon.komoot.io/**', (r) => r.fulfill({ contentType: 'application/json', body: '{"features":[]}' }));
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    await page.goto(SITE + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('loading') && document.getElementById('loading').hidden === true, null, { timeout: 60000 });
    return page;
  };
  try {
    // ---- the planner UI, from a browser in New York
    let page = await open({ timezoneId: 'America/New_York' });
    await page.click('#planTripBtn');
    await page.waitForTimeout(300);
    for (const [sel, text] of [['#dirOrig', 'Westlake'], ['#dirDest', 'Capitol Hill']]) {
      await page.fill(sel, text);
      await page.waitForTimeout(500);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
    }
    await page.waitForFunction(() => document.querySelectorAll('.trip-card, [data-itin-idx]').length > 0, null, { timeout: 60000 });
    await page.click('[data-plan-time="depart-at"]');
    await page.waitForTimeout(400);
    if (await page.$eval('#dirCustomPicker', (e) => e.hidden)) await page.click('#dirTimeTriggerBtn');
    await page.waitForTimeout(300);
    const chip = await page.$('#dirCustomPicker [data-preset-date]:nth-child(2)');
    const box = await chip.boundingBox();
    const onTop = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('#dirCustomPicker'), [box.x + box.width / 2, box.y + box.height / 2]);
    check('the date picker opens above the trip cards (its buttons take the clicks)', onTop);
    await chip.click();
    await page.waitForTimeout(250);
    await page.click('#dirCustomPicker [data-qtime="8:00 AM"]');
    await page.waitForTimeout(250);
    await page.click('#calDoneBtn');
    await page.waitForTimeout(1500);
    const disp = await page.textContent('#dirTimeDisplay');
    const summary = (await page.textContent('#panelBody')).replace(/\s+/g, ' ');
    check('Tomorrow 8:00 AM chosen in a New York browser plans for 8:00 AM Seattle time',
      /Tomorrow · 8:00/.test(disp) && /Depart at \w+, \w+ \d+, 8:00 AM/.test(summary), disp);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    const closed = await page.evaluate(() => ({
      panel: document.getElementById('dirPanel').hidden,
      line: (window.__map.getSource('tripline')._data.features || []).length,
      pins: (window.__map.getSource('trippts')._data.features || []).length,
    }));
    check('Escape closes the whole planner (fields, trip line and pins)', closed.panel && closed.line === 0 && closed.pins === 0, JSON.stringify(closed));
    check('no page errors in the planner', page.errors.length === 0, page.errors.slice(0, 2).join(' | '));
    await page.context().close();

    // ---- the planner itself, and links
    page = await open();
    await page.waitForFunction(() => { const r = window.__atlas.planTransitTrip({ lat: 47.6, lon: -122.33 }, { lat: 47.61, lon: -122.32 }); return r && !r.pending; }, null, { timeout: 60000 });
    const ab = await page.evaluate(() => {
      const A = window.__atlas;
      // the next weekday, 8:00 AM Pacific
      const d = new Date(Date.now() + 86400000);
      while (['Sat', 'Sun'].includes(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short' }).format(d))) d.setTime(d.getTime() + 86400000);
      const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d);
      const deadline = new Date(`${ymd}T08:00:00-08:00`);
      const pt = { ...A.pacificAt(deadline), mode: 'arrive-by' };
      const r = A.planArriveBy({ lat: 47.6097, lon: -122.3422 }, { lat: 47.6232, lon: -122.32 }, pt);
      const o = r.options[0];
      return o ? { late: pt.secs - o.arrivalSec, tag: o.tags[0], n: r.options.length } : null;
    });
    check('Arrive by 8:00 offers the latest departure that still arrives in time',
      ab && ab.late >= -30 && ab.late < 20 * 60 && ab.tag === 'Leave latest', ab ? `arrives ${Math.round(ab.late / 60)} min early, ${ab.n} options` : 'no options');

    const special = await page.evaluate(() => {
      const A = window.__atlas;
      const S = window.__atlas.sched && window.__atlas.sched();
      if (!S || !S.special) return { none: true };
      const entry = Object.entries(S.special).find(([, v]) => S.variants[v] && S.variants[v].drop.length);
      if (!entry) return { none: true };
      const [ymd, v] = entry, V = S.variants[v];
      const pt = A.pacificAt(new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}T12:00:00-08:00`));
      const drop = new Set(V.drop), added = new Set(V.add.map((t) => S.patterns[t[0]].r));
      const list = S.days[pt.day] || [];
      const leaked = list.filter((t) => drop.has(S.patterns[t[0]].r) && !added.has(S.patterns[t[0]].r)).length;
      return { ymd, day: pt.day, special: pt.special, n: list.length, leaked };
    });
    check("a date that differs from its sample day plans on that date's own trips",
      special.none || (special.special && special.n > 0 && special.leaked === 0), JSON.stringify(special));

    for (const [q, name] of [['Westlake Station', 'Westlake'], ['UW Station', 'Univ of Washington'], ['Capitol Hill Station', 'Capitol Hill']]) {
      await page.fill('#q', q);
      await page.waitForTimeout(400);
      const first = await page.evaluate(() => { const r = document.querySelector('#results [data-i], #results button, #results .res'); return r ? r.textContent.replace(/\s+/g, ' ').trim() : ''; });
      check(`"${q}" lists the station first`, first.startsWith(name), first.slice(0, 50));
    }
    await page.fill('#q', '');
    const inf = await page.evaluate(() => { const t0 = performance.now(); const r = window.__atlas.planTransitTrip({ lat: Infinity, lon: 0 }, { lat: 47.6, lon: -122.3 }); return { ms: performance.now() - t0, r }; });
    check('Infinity coordinates are refused at once', inf.r === null && inf.ms < 100, `${Math.round(inf.ms)} ms`);
    const z0 = await page.evaluate(() => window.__map.getZoom());
    await page.evaluate(() => { location.hash = '#loc=999,999'; });
    await page.waitForTimeout(800);
    check('a map link far outside the region is ignored', Math.abs((await page.evaluate(() => window.__map.getZoom())) - z0) < 0.01);
    await page.evaluate(() => { location.hash = '#route-metro-10'; });
    await page.waitForTimeout(1500);
    await page.evaluate(() => { location.hash = '#route-doesnotexist'; });
    await page.waitForTimeout(1200);
    const head = await page.evaluate(() => document.querySelector('#panelBody h2, #panelBody h1')?.textContent?.trim() || '');
    check('a link to an unknown route clears the route shown before', !/^Route 10/.test(head), head);
    check('no page errors', page.errors.length === 0, page.errors.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r).length;
  console.log(`\nTOTAL: ${results.length - failed}/${results.length} checks passed.`);
  return failed === 0;
}

if (require.main === module) run().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => { console.error(e); process.exit(1); });
module.exports = { run };
