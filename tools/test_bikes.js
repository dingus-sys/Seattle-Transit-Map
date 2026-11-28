// Bike routes on the map, in the browser (the data itself: tools/check_bikes.py).
//  1. Flush and parallel: where a bike line runs along a transit band it touches the band's
//     edge all along (no gap, no overlap, not slanting toward or away from it), at every zoom.
//  2. Hover: pointing at a bike line lights that whole bike route (every piece of it in view,
//     solid and wide) and fades everything else; leaving the line lets go.
//  3. Tap: chooses the route (the rest of the map fades to 0.38), and it stays chosen and faded
//     when the pointer then leaves the map for its card or a map button (Nov 28: that let go of
//     the fade); Escape lets it go.
// Usage (site served on :8765): node tools/test_bikes.js   (ONLY=Fremont runs one area; DBG=1 lists where
// bike lines run over a band, and what a tap opened)
const { loadPlaywright } = require('./pw.js');
const SITE = process.env.SITE || 'http://127.0.0.1:8765';
const MAPLIBRE_JS = process.env.MAPLIBRE_JS || '';
const VIEWS = [
  ['NE 55th St (route 79)', [-122.3010, 47.6683], 16], ['Ravenna', [-122.305, 47.676], 14.6], ['Downtown', [-122.3355, 47.6075], 15.5],
  ['Capitol Hill', [-122.3208, 47.6200], 15.2], ['Fremont', [-122.3500, 47.6510], 14.8], ['U District', [-122.3130, 47.6600], 15.4],
  ['Rainier Valley', [-122.2900, 47.5600], 14.2], ['Bellevue', [-122.2000, 47.6150], 14.6],
].filter(([n]) => !process.env.ONLY || n.includes(process.env.ONLY)); // ONLY=Fremont runs one area
// route:segment pairs where the bike line keeps its own distance from the street (its 5th step value)
const FAR = (() => {
  try {
    const B = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'site', 'data', 'bikes.json')));
    return [...new Set(B.pieces.flatMap((pc) => pc.s.filter((st) => st[0] >= 0 && st.length > 4).map((st) => `${pc.b}:${st[0]}`)))];
  } catch (e) { return []; }
})();
const FLUSH_SHARE = 0.9;   // of the length that runs beside a band, at least this much touches it
const OVERLAP_SHARE = 0.03; // ...and at most this much runs over it

(async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } } : {});
  const results = [];
  const check = (name, ok, info = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${info ? ' (' + info + ')' : ''}`); };
  try {
    const page = await (await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1200, height: 800 } })).newPage();
    page.on('pageerror', (e) => console.log('pageerror', e.message));
    // everything off the network but MapLibre itself (CI loads it from the CDN; MAPLIBRE_JS overrides)
    await page.route(/^https:\/\//, (r) => (/maplibre-gl/.test(r.request().url()) ? r.continue() : r.abort()));
    if (MAPLIBRE_JS) await page.route(/maplibre-gl\.js$/, (r) => r.fulfill({ path: MAPLIBRE_JS, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } }));
    await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('kctm:layers2', JSON.stringify(['link', 'rail', 'streetcar', 'monorail', 'rapid', 'frequent', 'local', 'peak', 'water', 'stops', 'trails'])); } catch (e) {} });
    await page.goto(SITE + '/index.html');
    await page.waitForFunction(() => document.getElementById('loading')?.hidden === true, null, { timeout: 90000 });
    await page.evaluate(() => { for (const id of ['veh-icon', 'veh-dir', 'veh-label']) try { window.__map.setLayoutProperty(id, 'visibility', 'none'); } catch (e) {} });
    await page.addStyleTag({ content: '#panel,.sheet{pointer-events:none!important;opacity:0!important}' });
    let hovered = 0;
    for (const [name, c, z] of VIEWS) {
      await page.mouse.move(1195, 795);
      await page.evaluate(([c, z]) => window.__map.jumpTo({ center: c, zoom: z }), [c, z]);
      await page.waitForTimeout(700); await page.evaluate(() => window.__atlas.idle()); await page.waitForTimeout(400);

      // 1. every bike line, every 2 m, against the nearest transit band running the same way
      const fl = await page.evaluate((farList) => {
        const far = new Set(farList);
        const A = window.__atlas, bands = A.lastFeats().filter((f) => f.properties.g !== 'rail' && f.properties.g !== 'water' && f.geometry.type === 'LineString');
        const bikes = A.lastBikes();
        if (!bikes.length) return { n: 0 };
        const lat0 = window.__map.getCenter().lat, lon0 = window.__map.getCenter().lng, KX = 111320 * Math.cos(lat0 * Math.PI / 180), KY = 110574;
        const m = ([lon, lat]) => [(lon - lon0) * KX, (lat - lat0) * KY];
        const unit = 78271.5 * Math.cos(lat0 * Math.PI / 180) * bikes[0].properties.zu; // metres per line unit
        // touching: within 0.35 m or 0.6 of a screen pixel, whichever is more (antialiasing blends finer gaps)
        const tol = Math.max(0.35, 0.6 * 78271.5 * Math.cos(lat0 * Math.PI / 180) / 2 ** window.__map.getZoom());
        const segs = [];
        for (const f of bands) {
          const P = f.geometry.coordinates.map(m), hw = f.properties.wm * unit / 2;
          for (let i = 1; i < P.length; i++) segs.push([P[i - 1], P[i], hw, f.properties.e]);
        }
        const G = new Map(), cell = 40, key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
        for (const s of segs) {
          const x0 = Math.min(s[0][0], s[1][0]), x1 = Math.max(s[0][0], s[1][0]), y0 = Math.min(s[0][1], s[1][1]), y1 = Math.max(s[0][1], s[1][1]);
          for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) {
            const k = `${gx},${gy}`; if (!G.has(k)) G.set(k, []); G.get(k).push(s);
          }
        }
        let beside = 0, flush = 0, over = 0;
        const bad = [], overBy = {};
        for (const f of bikes) {
          const P = f.geometry.coordinates.map(m), bw = f.properties.wm * unit / 2;
          for (let i = 1; i < P.length; i++) {
            const dx = P[i][0] - P[i - 1][0], dy = P[i][1] - P[i - 1][1], L = Math.hypot(dx, dy);
            if (L < 1e-6) continue;
            for (let t = 0; t < L; t += 2) {
              const x = P[i - 1][0] + dx * t / L, y = P[i - 1][1] + dy * t / L;
              let best = null;
              for (let gx = -1; gx <= 1; gx++) for (let gy = -1; gy <= 1; gy++) for (const s of G.get(key(x + gx * cell, y + gy * cell)) || []) {
                const ex = s[1][0] - s[0][0], ey = s[1][1] - s[0][1], E = ex * ex + ey * ey || 1;
                const u = Math.max(0, Math.min(1, ((x - s[0][0]) * ex + (y - s[0][1]) * ey) / E));
                const d = Math.hypot(s[0][0] + ex * u - x, s[0][1] + ey * u - y);
                if (!best || d - s[2] - bw < best.gap) best = { gap: d - s[2] - bw, par: Math.abs(ex * dx + ey * dy) / Math.sqrt(E) / L, u, e: s[3] };
              }
              // beside a band: running the same way (within 10 degrees), along it (not past its end), close to it
              if (!best || best.par < Math.cos(10 * Math.PI / 180) || best.u <= 0 || best.u >= 1 || best.gap > 6) continue;
              // a path that really runs a little way off this street may keep some of that distance
              // when zoomed in (pipeline/build_bikes.py records it): it only must not run over the band
              if (best.gap > 0 && far.has(`${f.properties.b}:${best.e}`)) continue;
              beside += 2;
              if (Math.abs(best.gap) <= tol) flush += 2;
              else if (best.gap < 0) {
                over += 2; if (bad.length < 3) bad.push(`${f.properties.nl} ${best.gap.toFixed(1)} m`);
                const at = `${f.properties.nl} (${f.properties.k}) by edge ${best.e}`;
                const ll = [+(x / KX + lon0).toFixed(5), +(y / KY + lat0).toFixed(5)];
                if (!overBy[at]) overBy[at] = [0, ll, ll]; overBy[at][0] += 2; overBy[at][2] = ll;
              }
              else if (bad.length < 3) bad.push(`${f.properties.nl} +${best.gap.toFixed(1)} m`);
            }
          }
        }
        return { n: bikes.length, beside, flush, over, bad, overBy: Object.entries(overBy).sort((a, b) => b[1][0] - a[1][0]).slice(0, 8) };
      }, FAR);
      if (!fl.n) { check(`${name}: bike lines drawn`, false, 'none in view'); continue; }
      if (process.env.DBG) console.log('  over a band:', JSON.stringify(fl.overBy));
      check(`${name}: bike lines beside bus bands touch them, parallel`, fl.beside === 0 || (fl.flush / fl.beside >= FLUSH_SHARE && fl.over / fl.beside <= OVERLAP_SHARE),
        `${fl.beside} m beside bands: ${Math.round(100 * fl.flush / Math.max(1, fl.beside))}% flush, ${Math.round(100 * fl.over / Math.max(1, fl.beside))}% over a band; e.g. ${fl.bad.join(', ')}`);

      // 2. a bike route with pieces on several streets in view: point at it where no transit line is
      const target = await page.evaluate(() => {
        const A = window.__atlas, map = window.__map, W = map.getCanvas().clientWidth, H = map.getCanvas().clientHeight;
        const by = new Map();
        for (const f of A.lastBikes()) { if (!by.has(f.properties.b)) by.set(f.properties.b, []); by.get(f.properties.b).push(f); }
        const cands = [...by.entries()].filter(([, fs]) => new Set(fs.map((f) => f.properties.p)).size >= 2).sort((a, b) => b[1].length - a[1].length);
        for (const [b, fs] of cands) {
          for (const f of fs) {
            const C = f.geometry.coordinates;
            for (let i = 1; i < C.length - 1; i++) {
              const p = map.project(C[i]);
              if (p.x < 60 || p.y < 60 || p.x > W - 60 || p.y > H - 60) continue;
              const bk = A.bikeAt(p);
              // squarely on the bike line, and no stop, place name or transit line there to take the pointer instead
              if (!bk || bk.b !== b || bk.out > 0 || window.__atlasStopAt(p) || window.__atlasPick(p)) continue;
              // (a place's tap area takes a tap within 10 px before any line does)
              if (map.queryRenderedFeatures([[p.x - 14, p.y - 14], [p.x + 14, p.y + 14]]).some((f) => (f.layer.type === 'symbol' && f.layer.source !== 'trails') || /^(destinations|poi)/.test(f.layer.id))) continue;
              return { b, x: p.x, y: p.y, pieces: new Set(fs.map((f) => f.properties.p)).size, name: f.properties.n };
            }
          }
        }
        return null;
      });
      if (!target) { console.log(`  (${name}: no bike route with several pieces clear of transit lines to point at)`); continue; }
      // a spot with nothing on it, to come from and go back to
      const clear = await page.evaluate(() => {
        const map = window.__map, W = map.getCanvas().clientWidth, H = map.getCanvas().clientHeight;
        for (let y = 40; y < H - 40; y += 23) for (let x = 40; x < W - 40; x += 31) {
          const p = { x, y };
          if (!map.queryRenderedFeatures([[x - 14, y - 14], [x + 14, y + 14]]).some((f) => ['trails', 'net', 'sel', 'netlabels', 'stops'].includes(f.layer.source) || f.layer.type === 'symbol')
              && !window.__atlasPick(p) && !window.__atlas.bikeAt(p)) return p;
        }
        return { x: W - 5, y: H - 5 };
      });
      hovered++;
      await page.mouse.move(clear.x, clear.y);
      await page.mouse.move(target.x, target.y, { steps: 6 });
      // (a route card the pointer crossed on the way, heading for it, waits TIP_REST 200 ms before it
      // lets go: tools/test_hover_reach.js)
      await page.waitForTimeout(750);
      const hv = await page.evaluate((b) => {
        const A = window.__atlas, map = window.__map, lit = map.queryRenderedFeatures(undefined, { layers: ['bike-hl'] });
        const W = map.getCanvas().clientWidth, H = map.getCanvas().clientHeight;
        const onScreen = (f) => f.geometry.coordinates.some((c) => { const q = map.project(c); return q.x > 2 && q.y > 2 && q.x < W - 2 && q.y < H - 2; });
        const inView = new Set(A.lastBikes().filter((f) => f.properties.b === b && onScreen(f)).map((f) => f.properties.p));
        const litP = new Set(lit.filter((f) => f.properties.b === b).map((f) => f.properties.p));
        return { cur: window.__atlasCur(), st: A.bikeState(), dim: A.hoverDim(), other: lit.filter((f) => f.properties.b !== b).length, inView: [...inView], lit: [...litP],
          dash: map.getPaintProperty('bike-hl', 'line-dasharray') || null };
      }, target.b);
      const whole = hv.inView.every((p) => hv.lit.includes(p));
      check(`${name}: pointing at ${target.name} lights the whole route, solid, and fades the rest`,
        hv.st.hover === target.b && whole && hv.other === 0 && !hv.dash && hv.dim.ids && hv.dim.ids.includes('__bike') && hv.dim.v <= 0.36,
        `${hv.lit.length}/${hv.inView.length} of its lines in view lit, ${hv.other} other lines lit, map at ${hv.dim.v.toFixed(2)}; pointer on ${JSON.stringify(hv.cur)}`);
      await page.mouse.move(clear.x, clear.y, { steps: 3 });
      await page.waitForTimeout(700);
      const off = await page.evaluate(() => ({ st: window.__atlas.bikeState(), dim: window.__atlas.hoverDim() }));
      check(`${name}: leaving the bike line lets go`, off.st.hover == null && off.dim.v > 0.95, `map at ${off.dim.v.toFixed(2)}`);
      // 3. tap and Escape
      await page.mouse.click(target.x, target.y);
      await page.waitForTimeout(450);
      const sel = await page.evaluate(() => window.__atlas.bikeState());
      if (process.env.DBG) console.log('  after tap:', JSON.stringify(await page.evaluate(() => ({ sel: window.__atlas.bikeState(), cur: window.__atlasCur(), panel: document.querySelector('.sheet-body h2, .sheet-body .name')?.textContent, popup: document.querySelector('.maplibregl-popup')?.textContent?.slice(0, 80) }))), JSON.stringify(target));
      // off the map, onto the zoom buttons: the choice and its fade stay
      const btn = await page.evaluate(() => { const r = document.getElementById('zoomIn')?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; });
      if (btn) await page.mouse.move(btn.x, btn.y, { steps: 4 });
      await page.waitForTimeout(500);
      const kept = await page.evaluate(() => ({ st: window.__atlas.bikeState(), o: window.__map.getPaintProperty('trail-sharrow', 'line-opacity') }));
      check(`${name}: the chosen route stays chosen, the rest faded, with the pointer off the map`, !!btn && kept.st.sel === target.b && Math.abs(kept.st.netDim - 0.38) < 0.01 && kept.o < 0.5,
        `${btn ? '' : 'no map button; '}chosen ${kept.st.sel}, map ${kept.st.netDim}, other bike lines at ${kept.o}`);
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => window.__atlas.bikeState());
      check(`${name}: tapping it chooses the route; Escape lets it go`, sel.sel === target.b && Math.abs(sel.netDim - 0.38) < 0.01 && after.sel == null && after.netDim === 1,
        `chosen ${sel.sel} (want ${target.b}), map ${sel.netDim}; after Escape ${after.sel}, ${after.netDim}`);
    }
    check('pointed at bike routes in at least 4 views', hovered >= 4, `${hovered}`);
  } catch (e) {
    console.log('ERROR', e && e.stack || e);
    results.push(false);
  } finally {
    await browser.close();
  }
  const ok = results.filter(Boolean).length;
  console.log(`${ok}/${results.length} passed`);
  process.exit(ok === results.length ? 0 : 1);
})();
