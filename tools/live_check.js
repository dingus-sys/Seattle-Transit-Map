// Run on a local page that has live_fixture.js installed before app.js.
(async () => {
  const a = window.__atlas, s = window.__liveFixture, results = [];
  const check = (name, ok) => results.push({ name, ok: !!ok });
  const route = () => { location.hash = 'route-wsf-seattle-bainbridge-island'; window.dispatchEvent(new HashChangeEvent('hashchange')); };
  const wait = () => new Promise((r) => setTimeout(r, 200));
  check('WSF vessels work without OneBusAway credentials', !ATLAS_LIVE.key && a.liveState().vehicles.has('95_32'));
  check('other agencies retain timetable estimates', a.liveState().current.some((v) => v.est));
  check('road notices exclude cleared, expired and out-of-region reports', a.alerts().road.length === 1);
  check('road reports do not claim confirmed transit detours', a.alerts().road[0]?.routes.size === 0);
  route(); await wait();
  const text = document.querySelector('#ferryInfo')?.textContent || '';
  check('terminal notes load on demand', /Example terminal note/.test(text));
  check('zero vehicle spaces is distinct from walk-on availability', /Car deck full/.test(text) && /Walk-on availability is separate/.test(text));
  check('canceled sailings are labeled', /Canceled/.test(text));
  const fresh = a.liveState().fresh['95'];
  a.liveState().fresh['95'] = Date.now() - 120000;
  route(); await wait();
  check('stale live positions do not duplicate timetable fallback', !a.liveState().current.some((v) => v.id === '95_32'));
  a.liveState().fresh['95'] = fresh;
  a.wsfState().terminalGot = Date.now() - 120000;
  a.wsfState().terminalAttempt = Date.now();
  route(); await wait();
  check('stale vehicle-space counts are hidden', !/Car deck full/.test(document.querySelector('#ferryInfo')?.textContent || ''));
  s.failRoads = true; a.alerts().got = 0;
  document.dispatchEvent(new Event('visibilitychange')); await wait();
  check('failed road refresh retains recent notices and flags the failure', a.alerts().road.length === 1 && a.alerts().failed > 0);
  return { passed: results.filter((r) => r.ok).length, total: results.length, results };
})()
