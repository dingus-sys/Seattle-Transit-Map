// Full UI regression check: layers, search, route cards, stops, zoom sweep, theme.
// Run standalone via: node tools/run_browser_check.js tools/browser_check.js
// Or run in the browser console / CDP test tab on http://127.0.0.1:8765.
(async () => {
  const results = [], errors = [], mapErrors = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const eventError = (e) => errors.push(e.message || String(e.reason));
  window.addEventListener('error', eventError);
  window.addEventListener('unhandledrejection', eventError);
  const mapError = (e) => mapErrors.push(e.error?.message || 'Map error');
  const m = window.__map, a = window.__atlas;
  m.on('error', mapError);
  const idle = async () => { await wait(150); await a.idle(); await wait(100); };
  const click = async (s) => { document.querySelector(s).click(); await idle(); };
  const text = (s) => document.querySelector(s)?.textContent || '';
  const hash = (h) => { location.hash = h; window.dispatchEvent(new HashChangeEvent('hashchange')); };
  const route = async (id) => {
    hash('route-' + id);
    for (let i = 0; i < 40 && text('.hero p') !== a.routeById(id).name; i++) await wait(50);
    await idle();
  };
  const savedCenter = m.getCenter(), savedZoom = m.getZoom();
  if (document.querySelector('#back')) { document.querySelector('#back').click(); await idle(); }
  hash(''); await idle();
  try {
    check('map finishes loading', document.querySelector('#loading').hidden);
    check('eight primary filters', document.querySelectorAll('.fchip').length === 8);
    check('home keeps layer controls folded', !document.querySelector('.layer') && !!document.querySelector('#openLayers'));
    await click('#openLayers');
    check('all sixteen layers available', document.querySelectorAll('.layer').length === 16);
    await click('.layer[data-key="peak"]');
    check('rush-hour routes appear', document.querySelector('#lyr-peak').checked && a.lastFeats().some((f) => f.properties.cat === 'peak'));
    await click('.layer[data-key="peak"]');
    check('rush-hour routes hide again', !document.querySelector('#lyr-peak').checked && !a.lastFeats().some((f) => f.properties.cat === 'peak'));
    await click('.layer[data-key="frequent"]');
    check('frequent layer hides its geometry', !a.lastFeats().some((f) => f.properties.cat === 'frequent'));
    await click('.layer[data-key="frequent"]');
    const q = document.querySelector('#q');
    q.value = '49'; q.dispatchEvent(new Event('input', { bubbles: true })); await wait(200);
    check('search ranks an exact route number first', /Route 49/.test(text('.result')));
    document.querySelector('.result').click(); await idle();
    check('search opens the route and share link', /Route 49/.test(text('.hero h2')) && location.hash === '#route-metro-49');
    check('selected route and stops render', m.getSource('sel')._data.features.length > 0 && m.getSource('selstops')._data.features.length > 5);
    check('route has schedule and stop list', document.querySelectorAll('table.sched tbody tr').length === 6 && document.querySelectorAll('#stoplist li').length > 10);
    await click('.segmented button[data-i="1"]');
    check('direction switches', document.querySelector('.segmented button[data-i="1"]').getAttribute('aria-selected') === 'true');
    await click('#stoplist button');
    if (document.querySelector('#rdAllDepsBtn')) await click('#rdAllDepsBtn');
    check('stop opens its serving routes', /stop here/i.test(text('.view')) || document.querySelectorAll('#scDeps, .nearby-card, .sc-sub, .sc-name').length > 0 || /Stop/i.test(text('.hero')));
    if (document.querySelector('#back')) await click('#back');
    hash(''); await idle();
    check('back clears selection', !location.hash);
    for (const z of [9.5, 11, 13, 15, 17, 18]) {
      m.jumpTo({ center: [-122.33, 47.62], zoom: z }); await idle();
      check(`zoom ${z} draws valid lines`, a.lastFeats().length > 0 && a.lastFeats().every((f) => f.geometry.coordinates.every((p) => p.every(Number.isFinite))));
    }
    await route('wsf-seattle-bainbridge-island');
    check('ferry route has directions and stops', /Bainbridge/i.test(text('.hero')) && document.querySelectorAll('#stoplist li').length === 2, text('.hero p'));
    check('direction labels avoid a repeated To', !/To To /.test(text('.segmented')));
    hash(''); await idle();
    check('clearing a shared link clears selection', !document.querySelector('.hero') && !m.getSource('sel')._data.features.length);
    hash('%E0%A4%A'); await idle();
    check('malformed links do not crash the app', errors.length === 0);
    for (let i = 0; i < 3; i++) await click('#themeBtn');
    check('theme cycle keeps the map usable', a.lastFeats().length > 0);
    check('no horizontal overflow', document.documentElement.scrollWidth <= innerWidth + 1);
    check('no JavaScript exceptions', errors.length === 0, errors.join(' | '));
    check('no map rendering errors', mapErrors.length === 0, [...new Set(mapErrors)].slice(0, 3).join(' | '));
  } finally {
    window.removeEventListener('error', eventError);
    window.removeEventListener('unhandledrejection', eventError);
    m.off('error', mapError);
    hash(''); m.jumpTo({ center: savedCenter, zoom: savedZoom });
    const q = document.querySelector('#q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return { passed: results.filter((r) => r.ok).length, total: results.length, results };
})()
