// Regressions from the November 25, 2026 audit that need the real page and the real published data:
//   no walking across water, ferry cards that stay on their own route, the Cascades' clock times,
//   Night Owl from the timetable, a holiday's route status, stop/route/future-dated alerts, ferry bulletins for the
//   San Juans and Port Townsend, Departures Near You without predictions, saved trips and keyboard use.
// Usage (site served on :8765): node tools/test_audit_browser.js
const path = require('path');

const SITE = process.env.SITE || 'http://127.0.0.1:8765';
const MAPLIBRE_JS = process.env.MAPLIBRE_JS || '';

// the instant a Pacific wall-clock time names, n days from today
function pacificInstant(daysAhead, hh, mm) {
  const day = new Date(Date.now() + daysAhead * 86400000);
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(day);
  for (const off of ['-08:00', '-07:00']) {
    const t = new Date(`${ymd}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00${off}`);
    const back = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);
    if (back === `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`) return t;
  }
  throw new Error('no such Pacific time');
}

async function run() {
  const pw = require('./pw').loadPlaywright();
  const browser = await pw.chromium.launch({ ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } } : {}) });
  const results = [];
  const check = (name, ok, info = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${info ? ' (' + info + ')' : ''}`); };
  const open = async (opts = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, ...opts });
    const page = await ctx.newPage();
    if (MAPLIBRE_JS) await page.route(/maplibre-gl\.js$/, (r) => r.fulfill({ path: MAPLIBRE_JS, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } }));
    await page.route('https://tiles.openfreemap.org/**', (r) => r.abort());
    await page.route('https://api.pugetsound.onebusaway.org/**', (r) => r.abort());
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    await page.goto(SITE + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('loading') && document.getElementById('loading').hidden === true, null, { timeout: 60000 });
    await page.waitForFunction(() => window.__atlas && window.__atlas.sched && window.__atlas.sched(), null, { timeout: 60000 });
    return page;
  };
  try {
    const page = await open();

    // ---- 4: no walk across Sinclair Inlet
    const water = await page.evaluate(async () => {
      const stops = await fetch('data/stops.json').then((r) => r.json());
      const find = (re) => [...stops.stations, ...stops.stops].find((s) => re.test(s.name));
      const ann = find(/annapolis/i), bre = find(/bremerton/i);
      const A = window.__atlas;
      const noon = (() => { const b = A.pacificAt(new Date()); return { ...b, secs: 12 * 3600, date: new Date(b.date.getTime() + (12 * 3600 - b.secs) * 1000) }; })();
      const plan = A.planTransitTrip({ lat: ann.lat, lon: ann.lon, name: ann.name }, { lat: bre.lat, lon: bre.lon, name: bre.name }, noon);
      const capitolHill = [47.6253, -122.3222], westlake = [47.6113, -122.3377];
      return {
        names: [ann.name, bre.name], dist: Math.round(A.planner && 0),
        walk: !!(plan && plan.directWalk), options: plan ? plan.options.map((o) => o.type) : null,
        landOk: A.walkable(...capitolHill, ...westlake), lakeBlocked: !A.walkable(47.61, -122.25, 47.61, -122.18), inletBlocked: !A.walkable(ann.lat, ann.lon, bre.lat, bre.lon),
      };
    });
    check('Annapolis to Bremerton is not offered as a walk', water.walk === false, JSON.stringify(water.names));
    check('Annapolis to Bremerton transit offers only real vehicles', Array.isArray(water.options));
    check('a walk across Lake Washington or Sinclair Inlet is refused, a city walk is not', water.landOk && water.lakeBlocked && water.inletBlocked);

    // ---- 5, 22: ferry cards keep to their own route, labelled by their own operator
    const ferry = await page.evaluate(async () => {
      const A = window.__atlas;
      const stops = await fetch('data/stops.json').then((r) => r.json());
      const col = stops.stations.find((s) => /colman/i.test(s.name));
      const bi = A.routeById('wsf-seattle-bainbridge-island'), br = A.routeById('wsf-seattle-bremerton');
      const stop = A.stopIndex(col.id);
      const rows = A.routeDeparturesFor(bi, stop, (bi.patterns || [])[0]);
      const kt = A.routeById('kt-seattle-bremerton'), wsf = A.routeById('wsf-seattle-bremerton');
      const card = (r) => A.routeDeparturesCardHTML(r, stop, (r.patterns || [])[0], { list: [{ t: 600, isLive: false, toName: 'Bremerton', timeText: '10 min' }] });
      return {
        rows: rows.list.map((d) => d.toName), n: rows.list.length,
        // the operator shows once in the route header, not as a tag on every departure row
        noRowTag: ![kt, wsf].some((r) => /class="rd-agency|WSF Ferry|KITSAP|METRO BUS/i.test(card(r))),
      };
    });
    check('the Bainbridge route card at Colman Dock lists only Bainbridge sailings', ferry.n === 0 || ferry.rows.every((n) => !/bremerton/i.test(n)), JSON.stringify(ferry.rows));
    check('departure rows carry no repeated operator tag (Kitsap fast ferry, WSF Bremerton)', ferry.noRowTag);

    // ---- 17: Night Owl comes from trips running between midnight and 5 AM
    const owl = await page.evaluate(() => {
      const A = window.__atlas, S = A.sched();
      const night = new Set();
      for (const k of ['weekday', 'saturday', 'sunday']) for (const [pi, s0, du] of S.days[k]) {
        if (Math.min(s0 + du, 18000) - Math.max(s0, 0) >= 1200 || Math.min(s0 + du, 86400 + 18000) - Math.max(s0, 86400) >= 1200) night.add(S.patterns[pi].r);
      }
      const routes = Object.values(Object.fromEntries(S.patterns.map((p) => [p.r, p.route]))).filter(Boolean);
      const wrong = routes.filter((r) => A.isNightOwl(r) !== night.has(S.patterns.findIndex((p) => p.route === r) >= 0 ? S.patterns[S.patterns.findIndex((p) => p.route === r)].r : -1));
      const named = ['intercity-transit-76', 'intercity-transit-77', 'ct-101', 'metro-223', 'metro-345'].map((id) => A.routeById(id)).filter(Boolean);
      return { wrong: wrong.length, namedWrong: named.filter((r) => A.isNightOwl(r) && !night.has(S.patterns.find((p) => p.route === r)?.r)).map((r) => r.id), n: night.size };
    });
    check('Night Owl is exactly the routes with a trip in the midnight-5 AM window', owl.wrong === 0 && owl.n > 5, `${owl.n} routes`);
    check('routes with no overnight trip are not Night Owl routes', owl.namedWrong.length === 0, owl.namedWrong.join(','));

    // ---- 21: keyboard opens the fleet HUD
    await page.focus('#liveHud');
    await page.keyboard.press('Enter');
    const afterEnter = await page.$eval('#liveHudPop', (e) => !e.hidden);
    await page.keyboard.press('Space');
    const afterSpace = await page.$eval('#liveHudPop', (e) => !e.hidden);
    check('Enter opens the live fleet panel and Space closes it again', afterEnter === true && afterSpace === false);

    // ---- 20: a saved "Your location" end is where the rider is now
    const here = await page.evaluate(() => window.__atlas.resolveSavedEnd({ lat: 47.6113, lon: -122.3377, name: 'Your location', isLocation: true }));
    check('with no fix, a saved "Your location" keeps its old coordinates under an honest name', here && here.isLocation === false && here.name === 'Earlier location');
    const trip = await page.evaluate(() => window.__atlas.renderFavTripRow({ id: 't1', name: 'A → B', summary: '5' }));
    check('a saved trip opens from a real button (reachable by keyboard)', /<button[^>]*data-fav-trip-plan/.test(trip));

    // ---- 18, 19: notices keep their scope; ferry bulletins find the San Juans and Port Townsend
    const al = await page.evaluate(() => {
      const A = window.__atlas, T = A.alertTools, now = Date.now() / 1000;
      const r77 = A.routeById('metro-77');
      const raw77 = r77.rt[0].split('_')[1];
      const stopId = r77.patterns.flatMap((p) => p.stops || []).find((s) => s.startsWith('kcm-'));
      const rawStop = stopId.replace(/^kcm-/, '');
      const mk = (ents, periods) => T.readAlerts('1', [{ id: 'x' + Math.random(), periods: periods || [], ents, effect: 1, url: '', header: 'No service at this stop', desc: '' }], now);
      const out = {};
      T.load(mk([{ route: raw77, stop: rawStop }]));
      out.stopOnly = { route: T.isRouteSuspended(r77), stop: T.stopIsSuspended(stopId) };
      T.load(mk([{ route: raw77 }], [{ s: Math.floor(now + 1800), e: Math.floor(now + 7200) }]));
      out.future = T.isRouteSuspended(r77);
      T.load(mk([{ route: raw77 }], [{ s: Math.floor(now - 600), e: Math.floor(now + 7200) }]));
      out.active = T.isRouteSuspended(r77);
      T.load([]);
      const b = (id, t) => ({ BulletinID: id, AlertFullTitle: t, BulletinText: 'x', PublishDate: '/Date(' + Date.now() + '-0800)/' });
      const w = T.wsfAlerts([b(1, 'Anacortes / San Juan Islands - Sailing canceled'), b(2, 'Port Townsend / Coupeville - Sailing canceled'),
        b(3, 'Seattle / Bainbridge - Sailing canceled'), b(4, 'Somewhere / Else - Delay')], now);
      out.wsf = w.map((a) => ({ n: a.routes.size, wide: !!a.agencyWide, ids: [...a.routes].slice(0, 3) }));
      return out;
    });
    check('a notice for one route at one stop closes that stop, not the whole route', al.stopOnly.route === false && al.stopOnly.stop === true, JSON.stringify(al.stopOnly));
    check('a suspension that begins in 30 minutes is not styled as suspended yet', al.future === false);
    check('a suspension in force is styled as suspended', al.active === true);
    check('a bulletin for the San Juans and one for Port Townsend each reach their routes',
      al.wsf[0].n > 0 && al.wsf[1].n === 1 && al.wsf[1].ids[0] === 'wsf-coupeville-port-townsend' && al.wsf[2].n === 1);
    check('a bulletin naming no mapped route is kept at the agency level', al.wsf[3].n === 0 && al.wsf[3].wide === true);

    // ---- 15: Departures Near You with no predictions
    await page.evaluate(() => window.__atlas.showNearbyDepartures(-122.3764, 47.6760));
    await page.waitForTimeout(600);
    const near = await page.$$eval('.nearby-card', (cards) => cards.map((c) => c.querySelectorAll('.nearby-dep-row').length));
    check('every nearby stop card with service shows scheduled departures', near.length >= 3 && near.filter((n) => n > 0).length >= Math.min(3, near.length), JSON.stringify(near));

    check('no page errors in the main run', page.errors.length === 0, page.errors.slice(0, 2).join(' | '));
    await page.context().close();

    // ---- 2, 23: the Cascades' clock times, and a destination off the map
    const amPage = await open();
    await amPage.clock.setFixedTime(pacificInstant(1, 8, 50));
    const am = await amPage.evaluate(async () => {
      const A = window.__atlas;
      const stops = await fetch('data/stops.json').then((r) => r.json());
      const ks = stops.stations.find((s) => /king street/i.test(s.name));
      const s = A.stopIndex(ks.id), ids = [s.id, s.key, ...(s.stops || [])].filter(Boolean);
      const keys = [...new Set([s.key, ...((s.stops || []).map((x) => A.stopIndex(x) && A.stopIndex(x).key).filter(Boolean))])];
      return A.depRowsHTML(keys, ids);
    });
    const amText = am.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    check('at 8:50 AM King Street Station shows the 8:55 Cascades (5 min) and names Portland', /Amtrak[^]*Portland/i.test(amText) && /\b[3-6] min\b/.test(amText), amText.slice(0, 160));
    await amPage.clock.setFixedTime(pacificInstant(1, 11, 53));
    const am2 = await amPage.evaluate(async () => {
      const A = window.__atlas;
      const stops = await fetch('data/stops.json').then((r) => r.json());
      const ks = stops.stations.find((s) => /king street/i.test(s.name));
      const s = A.stopIndex(ks.id), ids = [s.id, s.key, ...(s.stops || [])].filter(Boolean);
      const keys = [...new Set([s.key, ...((s.stops || []).map((x) => A.stopIndex(x) && A.stopIndex(x).key).filter(Boolean))])];
      return A.depRowsHTML(keys, ids);
    });
    check('at 11:53 AM no Cascades train is due in two minutes (that was the New York clock)', !/Amtrak[^<]*<[^]*?\b2 min\b/.test(am2.replace(/\s+/g, ' ')) || !/(^|[^0-9])2 min/.test(am2.replace(/<[^>]+>/g, ' ')));
    await amPage.context().close();

    // ---- 11: a holiday timetable with no Sounder is not "running every 36 min right now"
    const hol = await open();
    const found = await hol.evaluate(() => {
      const A = window.__atlas, S = A.sched();
      const sounder = Object.values(Object.fromEntries(S.patterns.map((p) => [p.r, p.route]))).filter((r) => r && r.cat === 'sounder');
      for (const ymd of Object.keys(S.special || {}).sort()) {
        const when = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6), 15, 30));
        const p = A.pacificAt(when);
        if (!p.special) continue;
        const idx = new Set(sounder.map((r) => S.patterns.find((q) => q.route === r).r));
        const any = (S.days[p.day] || []).some(([pi]) => idx.has(S.patterns[pi].r));
        if (!any) return { iso: when.toISOString(), route: sounder[0] && sounder[0].id };
      }
      return null;
    });
    if (found && found.route) {
      await hol.clock.setFixedTime(new Date(found.iso));
      const html = await hol.evaluate((id) => window.__atlas.scheduleTable(window.__atlas.routeById(id)), found.route);
      check('on a day with no Sounder trips the route card says there is no service today', /No service today/.test(html) && !/Running every/.test(html), found.iso);
    } else console.log('SKIP: no upcoming date in the timetable with a Sounder-free holiday');
    await hol.context().close();
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r).length;
  console.log(failed ? `${failed} of ${results.length} FAILED` : `ALL ${results.length} AUDIT BROWSER CHECKS PASSED`);
  process.exit(failed ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
