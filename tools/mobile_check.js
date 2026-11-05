// Run in the local app at a phone-width viewport.
(async () => {
  const results = [], check = (name, ok) => results.push({ name, ok: !!ok });
  const wait = () => new Promise((r) => setTimeout(r, 550));
  const panel = () => document.querySelector('#panel').className;
  check('phone-width layout', innerWidth <= 480);
  check('sheet starts at peek', /at-peek/.test(panel()));
  for (const want of ['half', 'full', 'peek']) {
    document.querySelector('#grabber').click(); await wait();
    check(`grabber opens ${want}`, new RegExp(`at-${want}`).test(panel()));
  }
  location.hash = 'route-metro-49'; window.dispatchEvent(new HashChangeEvent('hashchange')); await wait();
  check('route opens the sheet halfway', /at-half/.test(panel()) && /Route 49/.test(document.querySelector('.hero h2')?.textContent || ''));
  check('route schedule and stops fit the phone', document.querySelectorAll('#stoplist li').length > 10 && document.documentElement.scrollWidth <= innerWidth + 1);
  document.querySelector('#grabber').click(); await wait();
  check('route sheet expands fully', /at-full/.test(panel()));
  return { passed: results.filter((r) => r.ok).length, total: results.length, results };
})()
