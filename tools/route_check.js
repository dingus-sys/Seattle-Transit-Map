// Batch verification of route cards against data/routes.json.
// Run standalone via: node tools/run_browser_check.js tools/route_check.js
// Or set window.__qaRouteStart to 0, 75, 150, ... in console to check in bounded batches.
(async () => {
  const routes = (await fetch('data/routes.json').then((r) => r.json())).routes;
  const start = window.__qaRouteStart || 0, batch = routes.slice(start, start + 75), bad = [];
  for (const r of batch) {
    location.hash = 'route-' + r.id;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (document.querySelector('.hero p')?.textContent !== r.name) bad.push(r.id);
  }
  location.hash = ''; window.dispatchEvent(new HashChangeEvent('hashchange'));
  await window.__atlas.idle();
  return { start, checked: batch.length, total: routes.length, bad };
})()
