// Checks worker/live-proxy.js with a stand-in fetch: keys swapped in, other sites and paths refused.
// Usage: node tools/test_live_proxy.mjs
const mod = await import(new URL("../worker/live-proxy.js", import.meta.url));
let seen;
globalThis.fetch = async (u) => { seen = u; return new Response("ok", { headers: { "Content-Type": "application/json" } }); };
const env = { OBA_API_KEY: "OBAX", WSDOT_KEY: "WSDX" };
const go = async (path, hdr) => { seen = null; const r = await mod.default.fetch(new Request("https://w.example" + path, { headers: hdr }), env); return [r.status, r.headers.get("Access-Control-Allow-Origin"), seen]; };
const O = { Origin: "https://dingus-sys.github.io" }, R = { Referer: "https://dingus-sys.github.io/Seattle-Transit-Map/" };
const cases = [
  ["oba status", await go("/oba/api/where/vehicles-for-agency/1.json?key=proxy&includeReferences=true", O), (x) => x[0] === 200 && x[2].includes("key=OBAX") && !x[2].includes("proxy")],
  ["oba pb", await go("/oba/api/gtfs_realtime/vehicle-positions-for-agency/40.pb?key=proxy", O), (x) => x[0] === 200],
  ["trip id", await go("/oba/api/where/trip-for-vehicle/1_7012.json?key=proxy", O), (x) => x[0] === 200],
  ["ferry jsonp via referer", await go("/wsdot/ferries/api/vessels/rest/vessellocations?apiaccesscode=proxy&callback=cb1", R), (x) => x[0] === 200 && x[2].includes("apiaccesscode=WSDX") && x[2].includes("callback=cb1")],
  ["highway", await go("/wsdot/traffic/api/HighwayAlerts/HighwayAlertsREST.svc/GetAlertsAsJson?AccessCode=proxy&callback=c", R), (x) => x[0] === 200 && x[2].includes("AccessCode=WSDX")],
  ["other site refused", await go("/oba/api/where/vehicles-for-agency/1.json", { Origin: "https://evil.example" }), (x) => x[0] === 403 && !x[2]],
  ["no origin refused", await go("/oba/api/where/vehicles-for-agency/1.json", {}), (x) => x[0] === 403],
  ["other path refused", await go("/oba/api/where/stops-for-location.json", O), (x) => x[0] === 404 && !x[2]],
  ["traversal refused", await go("/wsdot/../etc", O), (x) => x[0] === 404],
];
let ok = 0; for (const [n, x, f] of cases) { const p = f(x); ok += p; console.log(p ? "PASS" : "FAIL", n, x[0], x[1]); }
console.log(`${ok}/${cases.length} passed`); process.exit(ok === cases.length ? 0 : 1);
