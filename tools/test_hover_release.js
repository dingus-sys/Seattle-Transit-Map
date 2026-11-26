// Hover lets go promptly: moving the pointer off a route, or onto another route, starts fading
// the old highlight within a few frames of the move (headless Chrome draws the map in software,
// so its frames are slower than a real browser's), and it is gone about a quarter second later (it used to linger about half a second: a 200 ms grace, then the wait for the
// next route's path from the layout worker). Pointing back at a route shown a moment ago is
// answered from the hover cache.
// Usage (site served on :8765): node tools/test_hover_release.js
const SITE = process.env.SITE || 'http://127.0.0.1:8765';
const MAPLIBRE_JS = process.env.MAPLIBRE_JS || '';
// Limits are counted in this browser's own frames: headless Chrome draws the map in software, and
// a busy CI runner can take 50+ ms a frame, so fixed milliseconds made this test fail on slow
// machines while the page behaved the same. "Starts within a few frames" = 4 frames (+40 ms for
// the pointer event to land); "gone" = the 150 ms fade plus 6 frames. On a 60 Hz laptop that is
// about 105 ms and 290 ms, still well under the old behaviour (~250 ms / ~430 ms).
const FADE_MS = 150; // hoverFade(slot, 0, 140-150) in web/app.js
const limits = (frame) => ({ start: 40 + 4 * frame, gone: 40 + FADE_MS + 6 * frame });

(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } } : {}) });
  const results = [];
  const check = (name, ok, info = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${info ? ' (' + info + ')' : ''}`); };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    if (MAPLIBRE_JS) await page.route(/maplibre-gl\.js$/, (r) => r.fulfill({ path: MAPLIBRE_JS, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } }));
    await page.route('https://tiles.openfreemap.org/**', (r) => r.abort());
    await page.route('https://api.pugetsound.onebusaway.org/**', (r) => r.abort());
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(SITE + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('loading') && document.getElementById('loading').hidden === true, null, { timeout: 60000 });
    await page.evaluate(() => { for (const id of ['veh-icon', 'veh-dir', 'veh-label']) window.__map.setLayoutProperty(id, 'visibility', 'none'); });
    await page.evaluate(() => window.__map.jumpTo({ center: [-122.318, 47.617], zoom: 14.2 }));
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.__atlas.idle());
    await page.waitForTimeout(500);
    const hs = () => page.evaluate(() => window.__atlas.hoverState());

    // two single-route lines that really take the hover, and a spot well away from every line
    const cands = await page.evaluate(() => {
      const out = [];
      for (let y = 260; y < 700; y += 7) for (let x = 560; x < 1150; x += 7) {
        const rs = window.__atlas.routesAt({ x, y }, 2);
        if (rs && rs.length === 1 && !out.some((p) => p.id === rs[0].id || Math.hypot(p.x - x, p.y - y) < 90)) out.push({ x, y, id: rs[0].id });
      }
      return out;
    });
    const pts = [];
    for (const c of cands) {
      await page.mouse.move(c.x - 25, c.y - 25); await page.mouse.move(c.x, c.y, { steps: 4 });
      await page.waitForTimeout(600);
      if ((await hs()).key.includes(c.id)) pts.push(c);
      await page.mouse.move(1270, 810); await page.waitForTimeout(400);
      if (pts.length >= 2) break;
    }
    const empty = await page.evaluate(() => {
      for (let y = 300; y < 700; y += 10) for (let x = 600; x < 1150; x += 10) {
        const rs = window.__atlas.routesAt({ x, y }, 40);
        if (!rs || !rs.length) return { x, y };
      }
      return null;
    });
    check('found two hoverable routes and an empty spot', pts.length === 2 && !!empty, pts.map((p) => p.id).join(', '));
    if (pts.length < 2 || !empty) throw new Error('no targets');

    // Records every animation frame's hover state while the pointer moves, timed from the last
    // pointer event (the one that lands on the new spot).
    const watch = (ms) => page.evaluate((ms) => new Promise((res) => {
      const t0 = performance.now(), rows = [], ev = [];
      const on = () => ev.push(performance.now());
      document.addEventListener('mousemove', on, true);
      const f = () => {
        const s = window.__atlas.hoverState();
        rows.push({ t: performance.now(), key: s.key, v: s.v, to: s.to });
        if (performance.now() - t0 < ms) requestAnimationFrame(f);
        else { document.removeEventListener('mousemove', on, true); res({ rows, last: ev[ev.length - 1] || t0 }); }
      };
      requestAnimationFrame(f);
    }), ms);
    const timing = (res, before) => {
      const old = before.v.indexOf(Math.max(...before.v));
      let start = null, gone = null;
      for (const r of res.rows) {
        if (r.t < res.last) continue;
        if (start === null && r.to[old] === 0) start = r.t - res.last;
        if (gone === null && r.v[old] < 0.1) gone = r.t - res.last;
      }
      const dts = res.rows.slice(1).map((r, i) => r.t - res.rows[i].t).sort((a, b) => a - b);
      const frame = dts.length ? dts[Math.floor(dts.length / 2)] : 16.7;
      return { start, gone, frame };
    };

    const offs = [], swaps = [];
    for (let round = 0; round < 3; round++) {
      await page.mouse.move(pts[0].x, pts[0].y, { steps: 3 }); await page.waitForTimeout(700);
      let before = await hs();
      let w = watch(700); await page.mouse.move(empty.x, empty.y); offs.push(timing(await w, before));
      await page.waitForTimeout(400);
      await page.mouse.move(pts[0].x, pts[0].y, { steps: 3 }); await page.waitForTimeout(700);
      before = await hs();
      w = watch(700); await page.mouse.move(pts[1].x, pts[1].y); swaps.push({ ...timing(await w, before), key: (await hs()).key });
      await page.waitForTimeout(400);
      await page.mouse.move(empty.x, empty.y); await page.waitForTimeout(500);
    }
    const fmt = (xs) => xs.map((x) => `${x.start == null ? '-' : Math.round(x.start)}/${x.gone == null ? '-' : Math.round(x.gone)} (frame ${Math.round(x.frame)} ms)`).join(' ');
    const startOk = (x) => x.start != null && x.start <= limits(x.frame).start;
    const goneOk = (x) => x.gone != null && x.gone <= limits(x.frame).gone;
    check('off a route: the highlight starts fading within a few frames (was ~250 ms)', offs.every(startOk), 'start/gone ms ' + fmt(offs));
    check('off a route: the highlight is gone within the fade plus a few frames (was ~430 ms)', offs.every(goneOk), fmt(offs));
    check('onto another route: the old highlight starts fading within a few frames', swaps.every(startOk), fmt(swaps));
    check('onto another route: the old highlight is gone within the fade plus a few frames', swaps.every(goneOk), fmt(swaps));
    check('onto another route: that route takes the hover', swaps.every((x) => x.key.includes(pts[1].id)), swaps.map((x) => x.key).join(' '));
    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (e) {
    check('test ran', false, e.message);
  } finally {
    await browser.close();
  }
  const ok = results.every(Boolean);
  console.log(`${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(ok ? 0 : 1);
})();
