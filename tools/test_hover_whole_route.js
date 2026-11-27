// Hovering any piece of any route lights that whole route, never just the block under the pointer
// and never the other routes beside it. In a band (one line per service type on a street, its
// routes side by side inside it) the strand under the pointer is the route. Three checks per view:
//  1. every strand of every band that is wide enough to point at picks its own route;
//  2. each route's hover path covers its whole network in view (no block-long pieces);
//  3. real pointer moves onto a sample of strands light exactly that route's whole hover path.
// Usage (site served on :8765): node tools/test_hover_whole_route.js
const fs = require('fs');
const { loadPlaywright } = require('./pw.js');
const SITE = process.env.SITE || 'http://127.0.0.1:8765';
const MAPLIBRE_JS = process.env.MAPLIBRE_JS || '';
const net = JSON.parse(fs.readFileSync('site/data/network.json'));
// busy and quiet places, at overview and street zooms; every service type shown (rush hour too)
const VIEWS = [
  ['Ravenna (route 72)', [-122.305, 47.678], 15], ['U District', [-122.31, 47.665], 13.3], ['Burien (route 128)', [-122.33, 47.50], 13.4],
  ['Downtown', [-122.335, 47.607], 14], ['Capitol Hill', [-122.318, 47.617], 14.6], ['Rainier Valley', [-122.29, 47.55], 13],
  ['Bellevue', [-122.195, 47.615], 13.6], ['Everett', [-122.2, 47.98], 13], ['Northgate', [-122.325, 47.705], 12.6],
];
const SAMPLE = +process.env.SAMPLE || 12; // real pointer moves per view

(async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } } : {});
  const results = [];
  const check = (name, ok, info = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${info ? ' (' + info + ')' : ''}`); };
  try {
    const page = await (await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 820 } })).newPage();
    // everything off the network but MapLibre itself (CI loads it from the CDN; MAPLIBRE_JS overrides)
    await page.route(/^https:\/\//, (r) => (/maplibre-gl/.test(r.request().url()) ? r.continue() : r.abort()));
    if (MAPLIBRE_JS) await page.route(/maplibre-gl\.js$/, (r) => r.fulfill({ path: MAPLIBRE_JS, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } }));
    await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('kctm:layers2', JSON.stringify(['link', 'rail', 'streetcar', 'monorail', 'rapid', 'frequent', 'local', 'peak', 'water', 'dart', 'flex', 'stops'])); } catch (e) {} });
    await page.goto(SITE + '/index.html');
    await page.waitForFunction(() => document.getElementById('loading')?.hidden === true, null, { timeout: 90000 });
    await page.evaluate(() => { for (const id of ['veh-icon', 'veh-dir', 'veh-label']) try { window.__map.setLayoutProperty(id, 'visibility', 'none'); } catch (e) {} });
    await page.addStyleTag({ content: '#panel,.sheet{pointer-events:none!important;opacity:0!important}' });
    for (const [name, c, z] of VIEWS) {
      await page.mouse.move(1275, 815);
      await page.evaluate(([c, z]) => window.__map.jumpTo({ center: c, zoom: z }), [c, z]);
      await page.waitForTimeout(700); await page.evaluate(() => window.__atlas.idle()); await page.waitForTimeout(400);
      // 1. the middle of every strand of every band, and what the pointer there would pick
      const strands = await page.evaluate(() => {
        const m = window.__map, A = window.__atlas, out = [], R = 6378137;
        for (const f of A.lastFeats()) {
          const p = f.properties;
          if (p.r >= 0 || !p.so || p.g === 'water' || f.geometry.coordinates.length < 2) continue;
          const so = p.so.split(',').map((x) => x.split(':').map(Number));
          const cs = f.geometry.coordinates, k = Math.floor((cs.length - 1) / 2), a = cs[k], b = cs[k + 1];
          const kx = Math.cos(a[1] * Math.PI / 180) * Math.PI * R / 180, ky = Math.PI * R / 180;
          const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky, L = Math.hypot(dx, dy);
          if (L < 1) continue;
          const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], mpp = 78271.517 * Math.cos(mid[1] * Math.PI / 180) / 2 ** m.getZoom();
          const strandPx = p.ws / so.length / mpp;
          for (const [i, o] of so) {
            // o metres to the right of the band's line as drawn
            const q = [mid[0] + (dy / L) * o / kx, mid[1] - (dx / L) * o / ky], s = m.project(q);
            if (s.x < 30 || s.y < 30 || s.x > 1250 || s.y > 790) continue;
            // only where this band is the only line under the point (a crossing street or a train
            // drawn over it rightly wins there), and no stop, tag or place sits on it
            const others = (A.routesAt({ x: s.x, y: s.y }, 0.5) || []).filter((r) => !so.some(([j]) => A.lineId(j) === r.id));
            const marks = m.queryRenderedFeatures([[s.x - 9, s.y - 9], [s.x + 9, s.y + 9]], { layers: m.getStyle().layers.map((l) => l.id).filter((id) => /stop|badge|station|poi|place|dest/.test(id)) });
            const pk = window.__atlasPick({ x: s.x, y: s.y }) || {};
            // (the top-right corner holds the live-vehicle note and the zoom buttons, over the map)
            const bare = !marks.length && !pk.stop && !(s.x > 1080 && s.y < 120);
            out.push({ id: A.lineId(i), x: s.x, y: s.y, px: strandPx, n: so.length, clear: !others.length, bare, pick: pk.r });
          }
        }
        return out;
      });
      const aimable = strands.filter((s) => s.px >= 1.5 && s.clear);
      const wrong = aimable.filter((s) => s.pick !== s.id);
      // a stop, tag or vehicle can sit on a strand: those points are judged by what they are, so only the line pick counts here
      check(`${name}: each strand picks its own route`, aimable.length > 0 && wrong.length <= Math.max(1, aimable.length * 0.02),
        `${aimable.length - wrong.length}/${aimable.length} strands${wrong.length ? '; e.g. ' + wrong.slice(0, 4).map((w) => `${w.id} picked ${w.pick}`).join(', ') : ''}`);

      // 2. each route's hover path runs over every street piece the map draws it on (in and around the view)
      const ids = [...new Set(strands.map((s) => s.id))];
      const short = [];
      let pieces = 0;
      for (const id of ids) {
        const r = await page.evaluate(async (id) => {
          const A = window.__atlas, idx = A.lineIdx(id);
          const drawn = new Set(A.lastFeats().filter((f) => A.streetRoutes(f).includes(idx) && (f.properties.r === idx || f.properties.r < 0)).map((f) => f.properties.e));
          const lit = new Set((await A.routePathsFor([id])).map((f) => f.properties.e));
          return { drawn: drawn.size, missing: [...drawn].filter((e) => !lit.has(e)).length };
        }, id);
        pieces += r.drawn;
        if (r.missing) short.push(`${id} misses ${r.missing} of ${r.drawn}`);
      }
      check(`${name}: every route's hover path is the whole route`, !short.length, `${ids.length} routes, ${pieces} street pieces${short.length ? '; ' + short.slice(0, 6).join(', ') : ''}`);

      // 3. real pointer moves onto strands
      const pool = aimable.filter((s) => s.pick === s.id && s.px >= 3 && s.bare);
      const sample = pool.filter((_, k) => k % Math.max(1, Math.floor(pool.length / SAMPLE)) === 0).slice(0, SAMPLE);
      const bad = [];
      let onStop = 0;
      for (const s of sample) {
        await page.mouse.move(1275, 815); await page.waitForTimeout(450); // the last route's stops are gone
        await page.mouse.move(s.x, s.y); await page.waitForTimeout(650);
        const h = await page.evaluate(() => {
          const m = window.__map, st = window.__atlas.hoverState(), src = m.getSource(['hover', 'hover2'][st.slot]);
          const fs = (src && src._data && src._data.features) || [];
          const tip = document.getElementById('tip');
          return { key: st.key, lit: fs.map((f) => window.__atlas.lineId(f.properties.r)), n: fs.length, tip: tip && !tip.hidden ? tip.innerText.split('\n')[0].slice(0, 40) : '',
            stopCard: !!(tip && !tip.hidden && tip.classList.contains('tip-card')) };
        });
        // landed on a stop marker (a stop under the pointer shows its departures): not a line test
        if (h.stopCard && !h.key) { onStop++; continue; }
        const onlyIt = h.lit.length > 0 && h.lit.every((x) => x === s.id);
        const full = await page.evaluate((id) => window.__atlas.routePathsFor([id]).then((f) => f.length), s.id);
        // the pointer may land on a stop or tag of the route: the route must still be the one lit
        if (h.key !== `r:${s.id}:g` || !onlyIt || h.n < full) bad.push(`${s.id}: ${h.key || 'nothing'} (${h.n}/${full} pieces${h.tip ? ', card: ' + h.tip : ''}${process.env.DBG ? ' at ' + Math.round(s.x) + ',' + Math.round(s.y) : ''})`);
      }
      const tried = sample.length - onStop;
      check(`${name}: pointing at a strand lights that whole route`, tried >= Math.min(5, sample.length) && !bad.length,
        `${tried - bad.length}/${tried}${onStop ? ` (+${onStop} on a stop marker)` : ''}${bad.length ? '; ' + bad.slice(0, 3).join('; ') : ''}`);
    }
  } catch (e) {
    console.log('ERROR', e.message); results.push(false);
  } finally { await browser.close(); }
  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} checks passed`);
  process.exit(ok === results.length ? 0 : 1);
})();
