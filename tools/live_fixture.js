// Local browser test fixture. Install before navigation using CDP's new-document hook.
// No real credentials or external live requests are used. Remove the hook after testing.
(() => {
  let config;
  const state = window.__liveFixture = { calls: [], failRoads: false, failTerminals: false };
  Object.defineProperty(window, 'ATLAS_MODE', { configurable: true, get: () => 'bundled', set() {} });
  Object.defineProperty(window, 'ATLAS_LIVE', { configurable: true, get: () => config, set(value) {
    config = { ...value, key: '', feeds: [], wsf: { ...value.wsf, code: 'fixture-wsf' }, wsdot: { ...value.wsdot, code: 'fixture-wsdot' } };
  } });
  const date = (offset = 0) => `/Date(${Date.now() + offset})/`;
  const append = Node.prototype.appendChild;
  Node.prototype.appendChild = function (el) {
    if (!(el instanceof HTMLScriptElement) || !/wsdot\.wa\.gov\/(ferries|traffic)\/api\//i.test(el.src)) return append.call(this, el);
    const u = new URL(el.src), cb = u.searchParams.get('callback'), kind = u.pathname.split('/').pop().toLowerCase();
    state.calls.push(kind);
    const road = (id, lon = -122.33, status = 'Open', end = 3600000) => ({ AlertID: id, HeadlineDescription: 'Example road closure near Seattle', ExtendedDescription: 'Fixture: highway conditions, no transit detour confirmed.',
      EventStatus: status, Priority: 'High', StartTime: date(-600000), EndTime: date(end), StartRoadwayLocation: { Latitude: 47.61, Longitude: lon } });
    const responses = {
      vessellocations: [{ VesselID: 32, VesselName: 'Tacoma', InService: true, DepartingTerminalID: 7, ArrivingTerminalID: 3,
        DepartingTerminalName: 'Seattle', ArrivingTerminalName: 'Bainbridge Island', Latitude: 47.62, Longitude: -122.45, Heading: 270, AtDock: false,
        TimeStamp: date(), LeftDock: date(-600000), Eta: date(1200000) }],
      alerts: [],
      terminalwaittimes: [{ TerminalID: 7, TerminalName: 'Seattle', WaitTimes: [
        { RouteName: 'Seattle / Bainbridge Island', WaitTimeNotes: 'Example terminal note for the browser test.', WaitTimeLastUpdated: date(-300000) },
        { RouteName: 'Seattle / Bremerton', WaitTimeNotes: 'Unrelated crossing note that must stay off the Bainbridge route.', WaitTimeLastUpdated: date(-300000) },
      ] }],
      terminalsailingspace: [{ TerminalID: 7, TerminalName: 'Seattle', DepartingSpaces: [
        { Departure: date(600000), IsCancelled: false, SpaceForArrivalTerminals: [{ TerminalID: 3, TerminalName: 'Bainbridge Island', DisplayDriveUpSpace: true, DriveUpSpaceCount: 0 }] },
        { Departure: date(2400000), IsCancelled: true, SpaceForArrivalTerminals: [{ TerminalID: 3, TerminalName: 'Bainbridge Island', DisplayDriveUpSpace: false, DriveUpSpaceCount: null }] },
      ] }],
      getalertsasjson: [road(900001), road(900002, -117.4), road(900003, -122.33, 'Closed'), road(900004, -122.33, 'Open', -60000)],
    };
    queueMicrotask(() => {
      if (state.failRoads && kind === 'getalertsasjson' || state.failTerminals && kind.startsWith('terminal')) el.onerror?.(new Event('error'));
      else window[cb]?.(responses[kind] || []);
    });
    return el;
  };
})();
