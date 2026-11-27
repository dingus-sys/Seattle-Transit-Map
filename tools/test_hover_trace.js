// Tracing a route with the pointer, along its line and over its stops and the places beside it,
// keeps that route lit the whole way: the highlight never lets go part-way (it used to at every
// stop and place label, so the route flashed on and off) and never shrinks to just the street
// (a street a route shares used to light only that street). Stop cards may come and go.
// Usage (site served on :8765): node tools/test_hover_trace.js
const SITE = process.env.SITE || 'http://127.0.0.1:8765';
const { loadPlaywright } = require('./pw.js');
const { chromium } = loadPlaywright();
const views = JSON.parse(process.argv[2] || '[["metro-128",[-122.33,47.50],13.4],["metro-8",[-122.31,47.62],14],["metro-106",[-122.27,47.51],12.5],["metro-5",[-122.345,47.66],13.5]]');
(async () => {
  const browser = await chromium.launch(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  if (process.env.MAPLIBRE_JS) await page.route(/maplibre-gl\.js$/, (r) => r.fulfill({ path: process.env.MAPLIBRE_JS, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.route('https://tiles.openfreemap.org/**', (r) => r.abort());
  await page.route('https://api.pugetsound.onebusaway.org/**', (r) => r.abort());
  await page.goto(SITE + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('loading').hidden === true, null, { timeout: 90000 });
  await page.evaluate(() => { for (const id of ['veh-icon', 'veh-dir', 'veh-label']) try { window.__map.setLayoutProperty(id, 'visibility', 'none'); } catch (e) {} });
  let total = 0, fails = 0, walked = 0;
  for (const [rid, c, z] of views) {
    await page.mouse.move(1275, 815);
    await page.evaluate(([c, z]) => window.__map.jumpTo({ center: c, zoom: z }), [c, z]);
    await page.waitForTimeout(700); await page.evaluate(() => window.__atlas.idle()); await page.waitForTimeout(700);
    // the route's drawn path on screen: its strand features, or a band that carries it
    const path = await page.evaluate((rid) => {
      const A = window.__atlas, m = window.__map, fs = A.lastFeats();
      let idx = -1; for (let i = 0; i < 5000; i++) { if (A.lineId(i) === rid) { idx = i; break; } }
      let best = null;
      for (const f of fs) {
        if (f.geometry.type !== 'LineString') continue;
        const p = f.properties;
        const has = A.streetRoutes(f).includes(idx);
        if (!has) continue;
        const pts = f.geometry.coordinates.map((q) => m.project(q)).filter((q) => q.x > 380 && q.x < 1240 && q.y > 40 && q.y < 780);
        let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        if (!best || len > best.len) best = { len, pts: pts.map((q) => [q.x, q.y]), r: p.r };
      }
      return best && { idx, ...best };
    }, rid);
    if (!path || path.pts.length < 2) { console.log('SKIP:', rid, 'not on screen'); continue; }
    // trace the route's own lane: hover it once, then read the path the hover drew
    {
      const mid = path.pts[Math.floor(path.pts.length / 2)];
      await page.mouse.move(mid[0], mid[1]); await page.waitForTimeout(900);
      const lane = await page.evaluate((idx) => {
        const m = window.__map, h = window.__atlas.hoverState();
        for (const id of ['hover', 'hover2', 'hover-a', 'hover-b']) {
          const src = m.getSource(id); if (!src || !src._data) continue;
          const fs = (src._data.features || []).filter((f) => f.properties.r === idx && f.geometry.type === 'LineString');
          let best = null;
          for (const f of fs) { const pts = f.geometry.coordinates.map((q) => m.project(q)).filter((q) => q.x > 380 && q.x < 1240 && q.y > 40 && q.y < 780);
            if (!best || pts.length > best.length) best = pts; }
          if (best && best.length > 1) return best.map((q) => [q.x, q.y]);
        }
        return null;
      }, path.idx);
      if (lane) path.pts = lane; else console.log('  (no lane path; walking the street centre)');
    }
    const steps = [];
    for (let i = 1; i < path.pts.length; i++) {
      const [x0, y0] = path.pts[i - 1], [x1, y1] = path.pts[i], n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 4);
      for (let k = 0; k < n; k++) steps.push([x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n]);
    }
    const walk = steps.slice(0, 160);
    await page.mouse.move(walk[0][0], walk[0][1]); await page.waitForTimeout(500);
    const log = [];
    for (const [x, y] of walk) {
      await page.mouse.move(x, y);
      await page.waitForTimeout(40);
      log.push(await page.evaluate(() => { const h = window.__atlas.hoverState(), d = window.__atlas.hoverDim(); const t = document.getElementById('tip'); const tt = t && !t.hidden && !t.classList.contains('tip-leaving') ? (t.innerText || '').split('\n')[0].slice(0, 22) : 'none'; return (h.key || '-') + '|' + (d.to < 1 ? 'dim' : 'lit') + '|' + tt; }));
    }
    const changes = []; for (let i = 1; i < log.length; i++) if (log[i] !== log[i - 1]) changes.push(i + ':' + log[i]);
    total += changes.length;
    const lost = log.filter((x) => x.startsWith('-|')).length, street = log.filter((x) => x.startsWith('c:')).length;
    const lit = log.filter((x) => x.includes(rid)).length;
    const ok = !lost && !street && lit > log.length * 0.8;
    walked++; if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'}: tracing ${rid} keeps it lit (${lit}/${log.length} moments lit, ${lost} let go, ${street} street only)`);
    if (process.env.DBG) console.log(`${rid}: ${walk.length} steps, ${changes.length} changes; start ${log[0]}; ${changes.slice(0, 12).join('  ')}`);
  }
  await browser.close();
  console.log(`\n${walked - fails}/${walked} routes traced without letting go`);
  process.exit(fails || walked < 3 ? 1 : 0);
})();
