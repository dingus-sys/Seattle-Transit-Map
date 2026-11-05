// Run in the local test tab (CDP/console). Works against the previous release too,
// returning the same measurements for a matched before/after comparison.
(async () => {
  const m = window.__map, a = window.__atlas, results = [], errors = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const idle = async () => { await a.idle(); await wait(250); };
  const saved = { center: m.getCenter(), zoom: m.getZoom() };
  const nativePost = Worker.prototype.postMessage, source = m.getSource('net'), nativeData = source.setData;
  let requests = 0, updates = 0;
  Worker.prototype.postMessage = function (msg, ...rest) { if (msg.type === 'build') requests++; return nativePost.call(this, msg, ...rest); };
  source.setData = function (...args) { updates++; return nativeData.apply(this, args); };
  const error = (e) => errors.push(e.error?.message || e.message || 'Map error');
  m.on('error', error);
  const measure = async (to, duration) => {
    const begin = performance.now(), req0 = requests, update0 = updates, gaps = [];
    let done = false, previous = begin, movingRequests = 0, movingUpdates = 0;
    const frame = (now) => { gaps.push(now - previous); previous = now; if (!done) requestAnimationFrame(frame); };
    const moving = () => { movingRequests = Math.max(movingRequests, requests - req0); movingUpdates = Math.max(movingUpdates, updates - update0); };
    m.on('move', moving); requestAnimationFrame(frame);
    await new Promise((resolve) => { m.once('moveend', resolve); m.easeTo({ ...to, duration }); });
    const gestureMs = performance.now() - begin; done = true; m.off('move', moving);
    await idle();
    const sorted = gaps.filter((n) => n >= 0).sort((x, y) => x - y);
    return { gestureMs, settledMs: performance.now() - begin, frames: gaps.length,
      maxFrameMs: sorted.at(-1), p95FrameMs: sorted[Math.floor(sorted.length * 0.95)],
      requests: requests - req0, updates: updates - update0, movingRequests, movingUpdates };
  };
  try {
    m.jumpTo({ center: [-122.334, 47.6085], zoom: 14 }); await idle();
    const zoom = await measure({ zoom: 18.2 }, 650);
    check('fast zoom reaches its destination', Math.abs(m.getZoom() - 18.2) < 0.01);
    check('no geometry work is requested during the zoom', zoom.movingRequests === 0, String(zoom.movingRequests));
    check('no source replacements interrupt the zoom', zoom.movingUpdates === 0, String(zoom.movingUpdates));
    check('one final layout follows a zoom', zoom.requests <= 1, String(zoom.requests));
    check('route mesh stays active after rapid zoom', a.drawStats?.().renderer === 'mesh' && a.drawStats().vertices > 0);
    m.jumpTo({ center: [-122.334, 47.6085], zoom: 15.5 }); await idle();
    const pan = await measure({ center: [-122.323, 47.616] }, 650);
    check('panning does not rebuild routes during the gesture', pan.movingRequests === 0 && pan.movingUpdates === 0);
    check('panning retains route coverage', a.lastFeats().length > 0);
    const hit = a.lastFeats().find((f) => f.properties.r >= 0 && f.geometry.coordinates.some((c) => {
      const p = m.project(c); return p.x > 440 && p.x < m.getCanvas().clientWidth - 80 && p.y > 70 && p.y < m.getCanvas().clientHeight - 70;
    }));
    if (hit && a.routesAt) {
      const c = hit.geometry.coordinates.find((c) => { const p = m.project(c); return p.x > 440 && p.x < m.getCanvas().clientWidth - 80 && p.y > 70 && p.y < m.getCanvas().clientHeight - 70; });
      const point = m.project(c), rs = a.routesAt(point);
      check('route hit testing follows the visible ribbon', rs.some((r) => r.id === a.lineId(hit.properties.r)));
    }
    check('no map rendering errors', errors.length === 0, errors.join(' | '));
    return { passed: results.filter((r) => r.ok).length, total: results.length, zoom, pan, results };
  } finally {
    Worker.prototype.postMessage = nativePost; source.setData = nativeData; m.off('error', error);
    m.jumpTo({ center: saved.center, zoom: saved.zoom });
  }
})()
