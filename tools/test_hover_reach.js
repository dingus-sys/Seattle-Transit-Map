// Hover cards can be reached and clicked (Nov 28): pointing at a route, a tag number or a bike
// route shows its card beside the pointer; moving the pointer off it toward the card keeps the
// card where it is (it used to fade 60 ms after the pointer left the line), and clicking the card
// does what clicking the thing does (a route opens in the side panel, a bike route's card opens).
//  1. route lines in several areas: the card stays the whole way to it, then opens the route;
//  2. while the pointer is still on the line the card keeps following it;
//  3. leaving the line away from the card lets the card and the highlight go at once;
//  4. a route tag number's card, and 5. a bike route's card, the same way.
// Run from the repo root with the site served on :8765. Prints PASS/FAIL per check and 'N/M passed'.
const MAPLIBRE_JS = process.env.MAPLIBRE_JS || '';
const SITE = process.env.SITE || 'http://127.0.0.1:8765';
const { chromium } = require('playwright');

const AREAS = [
  ['10th Ave E', [-122.3195, 47.632], 15],
  ['Ravenna', [-122.305, 47.672], 15],
  ['Beacon Hill', [-122.305, 47.556], 15],
  ['Fremont', [-122.349, 47.651], 15],
];
const results = [];
const check = (name, ok, info = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${info ? ` (${info})` : ''}`); };

(async () => {
  const browser = await chromium.launch({ ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)/, (r) => r.abort());
  if (MAPLIBRE_JS) await page.route(/maplibre-gl\.js$/, (r) => r.fulfill({ path: MAPLIBRE_JS, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.goto(SITE + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('loading').hidden === true, null, { timeout: 60000 });
  await page.waitForTimeout(800);
  // timetable buses glide under the pointer and (rightly) take its card: keep them out of the way
  const hideBuses = () => page.evaluate(() => { for (const id of ['veh-icon', 'veh-dir', 'veh-label']) if (window.__map.getLayer(id)) window.__map.setLayoutProperty(id, 'visibility', 'none'); });
  await hideBuses();

  const tipState = () => page.evaluate(() => {
    const t = document.getElementById('tip'), r = t.getBoundingClientRect();
    return { shown: !t.hidden && !t.classList.contains('tip-leaving'), reach: t.classList.contains('tip-reach'), x: r.left, y: r.top, w: r.width, h: r.height,
      text: (t.innerText || '').split('\n').filter(Boolean).slice(0, 2).join(' / ') };
  });
  const reset = async () => {
    await page.mouse.move(1270, 810);
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    if (await page.evaluate(() => !!location.hash)) { await page.evaluate(() => { history.replaceState(null, '', location.pathname); window.dispatchEvent(new HashChangeEvent('hashchange')); }); }
    await page.evaluate(() => document.querySelectorAll('.maplibregl-popup').forEach((p) => p.remove()));
    await page.waitForTimeout(300);
  };
  const goTo = async (c, z) => { await page.evaluate(([c, z]) => window.__map.jumpTo({ center: c, zoom: z }), [c, z]); await page.evaluate(() => window.__atlas.idle && window.__atlas.idle()); await page.waitForTimeout(1200); await hideBuses(); };
  // walk the pointer from (x, y) to the card like a hand would: 12 moves over about a quarter second;
  // returns whether the card stayed up (and the same card) at every step
  const walkToCard = async (x, y) => {
    const t0 = await tipState();
    const tx = t0.x + Math.min(60, t0.w / 2), ty = t0.y + Math.min(22, t0.h / 2);
    let stayed = true, lost = '';
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(x + (tx - x) * i / 12, y + (ty - y) * i / 12);
      await page.waitForTimeout(22);
      const s = await tipState();
      if (!s.shown || s.text !== t0.text) { stayed = false; lost = lost || `step ${i}: ${s.shown ? s.text : 'gone'}`; }
    }
    await page.waitForTimeout(250);
    const s = await tipState();
    if (!s.shown) { stayed = false; lost = lost || 'gone after arriving'; }
    return { stayed, lost, reach: s.reach, tx, ty, text: t0.text };
  };
  const placeNear = (p) => page.evaluate((p) => { const m = window.__map, rc = m.getCanvas().getBoundingClientRect(); const q = { x: p.x - rc.left, y: p.y - rc.top };
    return m.queryRenderedFeatures([[q.x - 14, q.y - 14], [q.x + 14, q.y + 14]]).some((h) => /^(destinations|poi)/.test(h.layer.id)); }, p);

  // ---------- 1-3. route lines
  let lineAreas = 0;
  for (const [name, c, z] of AREAS) {
    await reset(); await goTo(c, z);
    const pt = await page.evaluate(() => {
      const m = window.__map, rc = m.getCanvas().getBoundingClientRect(), W = m.getCanvas().clientWidth, H = m.getCanvas().clientHeight;
      const empty = (x, y) => !window.__atlasPick({ x, y }) && !window.__atlas.bikeAt({ x, y }) && !m.queryRenderedFeatures([[x - 12, y - 12], [x + 12, y + 12]]).some((h) => h.layer.type === 'symbol' || /^(destinations|poi)/.test(h.layer.id));
      for (let y = 180; y < H - 260; y += 5) for (let x = 520; x < W - 340; x += 5) {
        const p = window.__atlasPick({ x, y });
        if (!p || !p.r || p.stop || window.__atlasStopAt({ x, y })) continue;
        if (m.queryRenderedFeatures([[x - 14, y - 14], [x + 14, y + 14]]).some((h) => /^(destinations|poi)/.test(h.layer.id) || h.layer.id === 'badges')) continue;
        // the way to the card (toward 76, 38 px right and below: its text) and the way back (up and left) are clear
        let clear = true;
        for (let t = 0.12; t <= 1 && clear; t += 0.08) { const q = { x: x + 76 * t, y: y + 38 * t }; if (window.__atlasPick(q) || window.__atlas.bikeAt(q)) clear = false; }
        if (!clear || !empty(x - 30, y - 30)) continue;
        // another point of the same route 30-70 px along it, for the "card follows" check
        let along = null;
        for (let a = 0; a < 360 && !along; a += 10) for (const d of [40, 55, 70]) {
          const q = { x: x + d * Math.cos(a * Math.PI / 180), y: y + d * Math.sin(a * Math.PI / 180) };
          const pq = window.__atlasPick(q);
          if (pq && pq.r === p.r && !window.__atlasStopAt(q)) { along = { x: q.x + rc.left, y: q.y + rc.top }; break; }
        }
        return { x: x + rc.left, y: y + rc.top, r: p.r, along };
      }
      return null;
    });
    if (!pt) { console.log(`  (${name}: no single-route line with a clear way to its card)`); continue; }
    lineAreas++;
    // 2. on the line, the card follows the pointer
    if (pt.along) {
      await page.mouse.move(pt.along.x - 20, pt.along.y - 20); await page.mouse.move(pt.along.x, pt.along.y, { steps: 4 }); await page.waitForTimeout(450);
      const a = await tipState();
      await page.mouse.move(pt.x, pt.y, { steps: 8 }); await page.waitForTimeout(450);
      const b = await tipState();
      check(`${name}: on route ${pt.r} the card follows the pointer along the line`, a.shown && b.shown && !b.reach && Math.hypot(b.x - a.x, b.y - a.y) > 20,
        `moved ${Math.round(Math.hypot(b.x - a.x, b.y - a.y))} px for a ${Math.round(Math.hypot(pt.x - pt.along.x, pt.y - pt.along.y))} px move`);
    } else {
      await page.mouse.move(pt.x - 25, pt.y - 25); await page.mouse.move(pt.x, pt.y, { steps: 5 }); await page.waitForTimeout(450);
    }
    // 3. off the line the other way: the card and the highlight let go
    await page.mouse.move(pt.x - 30, pt.y - 30, { steps: 3 }); await page.waitForTimeout(350);
    const gone = await tipState(), lit = await page.evaluate(() => (window.__atlas.hoverState ? window.__atlas.hoverState().key : '') || '');
    check(`${name}: leaving route ${pt.r} away from its card lets the card and highlight go`, !gone.shown && !lit, `card ${gone.shown ? 'still up' : 'gone'}, lit "${lit}"`);
    // 1. back on, then to the card: it stays, waits, and opens the route
    await page.mouse.move(pt.x, pt.y, { steps: 4 }); await page.waitForTimeout(450);
    const w = await walkToCard(pt.x, pt.y);
    check(`${name}: route ${pt.r}'s card stays while the pointer moves to it`, w.stayed && w.reach, w.lost || (w.reach ? '' : 'card not clickable'));
    await page.mouse.click(w.tx, w.ty); await page.waitForTimeout(900);
    const hash = await page.evaluate(() => location.hash);
    check(`${name}: clicking route ${pt.r}'s card opens the route`, hash === '#route-' + pt.r, hash || 'no route opened');
  }
  check('route line checks ran in at least 3 areas', lineAreas >= 3, `${lineAreas}`);

  // ---------- 4. a route tag number
  let tag = null;
  for (const [c, z] of [[[-122.3195, 47.62], 14.5], [[-122.305, 47.672], 15], [[-122.349, 47.651], 15], [[-122.383, 47.668], 14.5], [[-122.30, 47.60], 14.5], [[-122.29, 47.55], 14.5]]) {
  await reset(); await goTo(c, z);
  tag = await page.evaluate(() => {
    const m = window.__map, rc = m.getCanvas().getBoundingClientRect();
    const cells = window.__atlas.tagCells();
    // (the other numbers of a tag are targets of their own: pointing at the next one shows its route)
    const onCell = (x, y, t) => cells.some((c) => c !== t && Math.abs(y - c.y) < 10 && x > c.x0 - 3 && x < c.x1 + 3);
    for (const t of cells) {
      if (!t.r || t.x < rc.left + 480 || t.x > innerWidth - 340 || t.y < 120 || t.y > innerHeight - 220) continue;
      // (a tag's card sits 16 px right of and 30 px below the pointer)
      let clear = true;
      for (let k = 0.15; k <= 1 && clear; k += 0.05) { const q = { x: t.x - rc.left + 76 * k, y: t.y - rc.top + 52 * k }; if (window.__atlasPick(q) || window.__atlas.bikeAt(q) || window.__atlasStopAt(q) || onCell(t.x + 76 * k, t.y + 52 * k, t)) clear = false; }
      if (clear) return t;
    }
    return null;
  });
  if (tag) break;
  }
  if (!tag) check('a route tag with a clear way to its card', false, 'none found');
  else {
    await page.mouse.move(tag.x - 20, tag.y - 20); await page.mouse.move(tag.x, tag.y, { steps: 4 }); await page.waitForTimeout(450);
    const w = await walkToCard(tag.x, tag.y);
    check(`tag ${tag.r}: its card stays while the pointer moves to it`, w.stayed && w.reach, w.lost);
    await page.mouse.click(w.tx, w.ty); await page.waitForTimeout(900);
    const hash = await page.evaluate(() => location.hash);
    check(`tag ${tag.r}: clicking its card opens the route`, hash === '#route-' + tag.r, hash || 'no route opened');
  }

  // ---------- 5. a bike route
  let bike = null;
  for (const [c, z] of [[[-122.3138, 47.6658], 15], [[-122.2985, 47.6655], 15.5], [[-122.296, 47.5535], 15], [[-122.3705, 47.6295], 15], [[-122.335, 47.6795], 15]]) {
  await reset(); await goTo(c, z);
  bike = await page.evaluate(() => {
    const A = window.__atlas, m = window.__map, rc = m.getCanvas().getBoundingClientRect(), W = m.getCanvas().clientWidth, H = m.getCanvas().clientHeight;
    for (const f of A.lastBikes()) {
      const C = f.geometry.coordinates;
      for (let i = 1; i < C.length - 1; i++) {
        const p = m.project(C[i]);
        if (p.x < 500 || p.y < 150 || p.x > W - 340 || p.y > H - 240) continue;
        const bk = A.bikeAt(p);
        if (!bk || bk.out > 0 || window.__atlasPick(p) || window.__atlasStopAt(p)) continue;
        if (m.queryRenderedFeatures([[p.x - 14, p.y - 14], [p.x + 14, p.y + 14]]).some((h) => /^(destinations|poi)/.test(h.layer.id) || h.layer.id === 'badges')) continue;
        let clear = true;
        for (let t = 0.12; t <= 1 && clear; t += 0.08) { const q = { x: p.x + 76 * t, y: p.y + 38 * t }; if (window.__atlasPick(q) || A.bikeAt(q)) clear = false; }
        if (clear) return { x: p.x + rc.left, y: p.y + rc.top, b: bk.b, n: f.properties.n };
      }
    }
    return null;
  });
  if (bike) break;
  }
  if (!bike) check('a bike route with a clear way to its card', false, 'none found');
  else {
    await page.mouse.move(bike.x - 20, bike.y - 20); await page.mouse.move(bike.x, bike.y, { steps: 4 }); await page.waitForTimeout(450);
    const w = await walkToCard(bike.x, bike.y);
    check(`bike route ${bike.n}: its card stays while the pointer moves to it`, w.stayed && w.reach, w.lost);
    await page.mouse.click(w.tx, w.ty); await page.waitForTimeout(700);
    const opened = await page.evaluate(() => ({ pop: document.querySelectorAll('.maplibregl-popup').length, sel: window.__atlas.bikeState().sel }));
    check(`bike route ${bike.n}: clicking its card opens the bike route`, opened.pop > 0 && opened.sel === bike.b, JSON.stringify(opened));
  }

  await browser.close();
  const ok = results.filter(Boolean).length;
  console.log(`${ok}/${results.length} passed`);
  process.exit(ok === results.length ? 0 : 1);
})();
