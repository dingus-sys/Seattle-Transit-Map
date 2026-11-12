// Browser regression: tap a busy street, find every route, preview, filter and choose.
// Run standalone via: node tools/run_browser_check.js tools/corridor_check.js
// Or run in the browser console / CDP test tab on http://127.0.0.1:8765.
(async () => {
  const m = window.__map, a = window.__atlas, results = [], wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
  const idle = async () => { await a.idle(); await wait(250); };
  const home = async () => { for (let i = 0; i < 3 && document.querySelector('#back'); i++) { document.querySelector('#back').click(); await idle(); } };
  await home();
  if (innerWidth <= 720) for (let i = 0; i < 3 && !document.querySelector('#panel').classList.contains('at-peek'); i++) {
    document.querySelector('#grabber').click(); await wait(550);
  }
  m.jumpTo({ center: [-122.3355, 47.6087], zoom: 16.2 }); await idle();
  const W = m.getCanvas().clientWidth, H = m.getCanvas().clientHeight, narrow = W <= 720;
  const left = narrow ? 24 : 440, bottom = narrow ? H - 170 : H - 70;
  let target;
  const layers = ['stations', 'stops', 'badges', 'destinations-hit', 'destinations-major-icon', 'destinations-icon'].filter((id) => m.getLayer(id));
  for (const f of a.lastFeats().filter((f) => f.properties.g === 'bus' && f.properties.n >= 8)) {
    const cs = f.geometry.coordinates;
    for (let i = 1; i < cs.length && !target; i++) for (const t of [0.3, 0.5, 0.7]) {
      const point = m.project([cs[i - 1][0] * (1 - t) + cs[i][0] * t, cs[i - 1][1] * (1 - t) + cs[i][1] * t]);
      if (point.x < left || point.x > W - 24 || point.y < 70 || point.y > bottom) continue;
      if (m.queryRenderedFeatures([[point.x - 12, point.y - 12], [point.x + 12, point.y + 12]], { layers }).length) continue;
      if (m.getSource('vehicles')._data.features.some((v) => { const p = m.project(v.geometry.coordinates); return Math.hypot(p.x - point.x, p.y - point.y) < 18; })) continue;
      const routes = a.routesAt(point, narrow ? 10 : 6);
      if (routes.length > 16) {
        target = { point, routes }; break;
      }
    }
    if (target) break;
  }
  check('a busy corridor has one solid band per service type', a.lastFeats().every((f) => f.properties.r === -1));
  check('busy street exposes more than sixteen routes', !!target, target ? String(target.routes.length) : 'No unobstructed busy band found');
  if (!target) return { passed: results.filter((r) => r.ok).length, total: results.length, results };
  m.fire('click', { point: target.point, lngLat: m.unproject(target.point), originalEvent: { clientX: target.point.x, clientY: target.point.y } }); await idle();
  if (!document.querySelector('.corridor-picker') && a.showCorridor) {
    a.showCorridor(target.routes);
    await idle();
  }
  const rows = () => [...document.querySelectorAll('#corridorList [data-route]')];
  check('tapping the band opens the route chooser', !!document.querySelector('.corridor-picker'));
  check('every route is listed without truncation', target.routes.every((r) => rows().some((b) => b.dataset.route === r.id)) && rows().length === target.routes.length);
  check('route rows are easy to tap', rows().every((b) => b.getBoundingClientRect().height >= 48));
  const input = document.querySelector('#corridorQuery'), chosen = rows().at(-1)?.dataset.route;
  input.value = 'no-such-route-987654'; input.dispatchEvent(new Event('input', { bubbles: true }));
  check('route filter has a clear empty state', rows().length === 0 && /No matching/.test(document.querySelector('#corridorList').textContent));
  document.querySelector('#themeBtn').click(); await idle();
  check('theme/refresh keeps the chooser and filter', document.querySelector('#corridorQuery')?.value === 'no-such-route-987654');
  const field = document.querySelector('#corridorQuery'); field.value = a.routeById(chosen).label; field.dispatchEvent(new Event('input', { bubbles: true }));
  check('a route beyond the old list cutoff can be found', rows().some((b) => b.dataset.route === chosen));
  rows().find((b) => b.dataset.route === chosen).click(); await idle();
  check('choosing the route opens its card and path', location.hash === '#route-' + chosen && m.getSource('sel')._data.features.length > 0);
  document.querySelector('#back').click(); await idle();
  check('back returns to all choices on the street', !!document.querySelector('.corridor-picker') && rows().length === target.routes.length);
  const vehicles = m.getSource('vehicles')._data.features.filter((f) => f.properties.m !== 'boat').map((f) => m.project(f.geometry.coordinates));
  let min = Infinity;
  for (let i = 0; i < vehicles.length; i++) for (let j = 0; j < i; j++) min = Math.min(min, Math.hypot(vehicles[i].x - vehicles[j].x, vehicles[i].y - vehicles[j].y));
  check('overview vehicle badges do not overlap', min >= 37.9, Number.isFinite(min) ? min.toFixed(1) + ' px' : 'Fewer than two visible land vehicles');
  await home();
  m.jumpTo({ center: [-122.3355, 47.6087], zoom: 16.2 }); await idle();
  // Isolate a badge near a real busy band. The source is restored even if the check fails.
  const source = m.getSource('vehicles'), originalData = source._data, originalSet = source.setData, badgeVisibility = [];
  try {
    source.setData = function () { return this; };
    const route = target.routes.find((r) => !['link', 'sounder', 'amtrak'].includes(r.cat)) || target.routes[0];
    originalSet.call(source, { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {
      id: 'qa-band-badge', r: route.id, c: '#0a9b7b', tc: '#0a9b7b', lab: '', b: -1, m: 'bus', s: 1, est: 1,
    }, geometry: { type: 'Point', coordinates: m.unproject(target.point).toArray() } }] });
    await new Promise((r) => m.once('render', () => setTimeout(r, 200)));
    await idle();
    const distance = narrow ? 18 : 16;
    m.fire('click', { point: target.point, lngLat: m.unproject(target.point), originalEvent: { clientX: target.point.x, clientY: target.point.y } }); await wait(100);
    const card = document.querySelector('.maplibregl-popup')?.textContent || '';
    check('tapping the badge itself still opens its vehicle card', /Estimated position/.test(card), card.slice(0, 160) || location.hash);
    document.querySelector('.maplibregl-popup-close-button')?.click();
    // The adjacent case must be a band tap, rather than a tap on a route-number label.
    for (const id of ['badges', 'sel-badges']) if (m.getLayer(id)) {
      badgeVisibility.push([id, m.getLayoutProperty(id, 'visibility') || 'visible']);
      m.setLayoutProperty(id, 'visibility', 'none');
    }
    await new Promise((r) => m.once('render', () => setTimeout(r, 200)));
    await idle();
    const blockers = ['stations', 'stops', 'badges', 'sel-badges', 'hov-stops', 'sel-stops', 'flex', 'destinations-hit', 'destinations-major-icon', 'destinations-icon'].filter((id) => m.getLayer(id));
    const nearby = Array.from({ length: 36 }, (_, i) => ({ x: target.point.x + Math.cos(i * Math.PI / 18) * distance, y: target.point.y + Math.sin(i * Math.PI / 18) * distance })).find((point) =>
      a.routesAt(point, narrow ? 10 : 6).length > 1 &&
      !m.queryRenderedFeatures([[point.x - 7, point.y - 7], [point.x + 7, point.y + 7]], { layers: blockers }).length &&
      Math.hypot(point.x - target.point.x, point.y - target.point.y) <= 18);
    check('regression fixture is a band tap inside the old expanded badge target', !!nearby);
    if (nearby) { m.fire('click', { point: nearby, lngLat: m.unproject(nearby), originalEvent: { clientX: nearby.x, clientY: nearby.y } }); await idle(); }
    check('a nearby badge does not steal a route-band tap', !!nearby && (!!document.querySelector('.corridor-picker') || location.hash.startsWith('#route-')) && !document.querySelector('.maplibregl-popup'));
    await home();
  } finally {
    source.setData = originalSet; originalSet.call(source, originalData);
    for (const [id, visibility] of badgeVisibility) m.setLayoutProperty(id, 'visibility', visibility);
  }
  return { passed: results.filter((r) => r.ok).length, total: results.length, routeCount: target.routes.length, results };
})()
