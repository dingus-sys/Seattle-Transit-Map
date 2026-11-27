// Cloudflare Worker that keeps the live-data keys off the public page.
//
// The page asks this Worker instead of OneBusAway and WSDOT directly, with "proxy" where a key
// would go. The Worker swaps in the real key (stored as a Worker secret), forwards the request,
// and returns the answer. It only forwards the API paths the map uses, and only for pages on the
// allowed sites, so the Worker can't be used as an open proxy for the keys.
//
// Secrets (Worker > Settings > Variables and Secrets, type "Secret"):
//   OBA_API_KEY   OneBusAway Puget Sound key
//   WSDOT_KEY     WSDOT access code (ferries and highway alerts use the same kind of code)
//   WSF_KEY       optional: a separate code for the ferry API; WSDOT_KEY is used when absent
// Optional plain variable ALLOWED_ORIGINS: comma-separated sites allowed to use the Worker
// (default below).
//
// Routes:  /oba/<path>    -> https://api.pugetsound.onebusaway.org/<path>   (key=)
//          /wsdot/<path>  -> https://www.wsdot.wa.gov/<path>                (apiaccesscode= / AccessCode=)
//          /skagit/<path> -> https://strweb.skagittransit.org/<path>        (open feed, no key)

const DEFAULT_ORIGINS = "https://dingus-sys.github.io,http://localhost:8765,http://127.0.0.1:8765";

const UPSTREAMS = {
  oba: {
    host: "https://api.pugetsound.onebusaway.org",
    paths: [/^\/api\/gtfs_realtime\/(vehicle-positions|alerts)-for-agency\/[\w-]+\.pb$/,
            /^\/api\/where\/(vehicles-for-agency|trip-for-vehicle|arrivals-and-departures-for-stop)\/[\w.%-]+\.json$/],
    // short edge cache so many visitors share one upstream call (helps the OneBusAway rate limit)
    cacheTtl: 10,
  },
  wsdot: {
    host: "https://www.wsdot.wa.gov",
    paths: [/^\/ferries\/api\/(vessels|terminals|schedule)\/rest\/[\w/]+$/,
            /^\/traffic\/api\/HighwayAlerts\/HighwayAlertsREST\.svc\/GetAlertsAsJson$/],
    cacheTtl: 30,
  },
  // Skagit Transit's open feed (no key); its server doesn't allow browser requests directly
  skagit: {
    host: "https://strweb.skagittransit.org",
    paths: [/^\/GTFS\/GTFS_(VehiclePositions|ServiceAlerts)\.pb$/],
    cacheTtl: 10,
    open: true,
  },
};

function allowedOrigin(request, env) {
  const list = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(",").map((s) => s.trim()).filter(Boolean);
  // fetch() sends Origin; a <script> tag (the WSDOT JSONP calls) sends only Referer
  let from = request.headers.get("Origin");
  if (!from) {
    try { from = new URL(request.headers.get("Referer") || "").origin; } catch { from = ""; }
  }
  return list.includes(from) ? from : null;
}

function reply(body, status, origin, extra = {}) {
  const headers = { "Content-Type": "text/plain; charset=utf-8", ...extra };
  if (origin) { headers["Access-Control-Allow-Origin"] = origin; headers["Vary"] = "Origin"; }
  return new Response(body, { status, headers });
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    if (request.method === "OPTIONS") {
      return origin ? new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET",
        "Access-Control-Max-Age": "86400", "Vary": "Origin" } }) : reply("forbidden", 403, null);
    }
    if (request.method !== "GET") return reply("method not allowed", 405, origin);
    if (!origin) return reply("forbidden", 403, null);

    const url = new URL(request.url);
    const [, name, ...rest] = url.pathname.split("/");
    const up = UPSTREAMS[name];
    const path = "/" + rest.join("/");
    if (!up || !up.paths.some((re) => re.test(path))) return reply("not found", 404, origin);

    const q = new URLSearchParams(url.search);
    if (name === "oba") {
      if (!env.OBA_API_KEY) return reply("OBA_API_KEY is not set", 503, origin);
      q.set("key", env.OBA_API_KEY);
    } else if (up.open) {
      // no key to add
    } else {
      const isFerry = path.startsWith("/ferries/");
      const code = isFerry ? (env.WSF_KEY || env.WSDOT_KEY) : (env.WSDOT_KEY || env.WSF_KEY);
      if (!code) return reply("WSDOT_KEY is not set", 503, origin);
      q.delete("apiaccesscode"); q.delete("AccessCode");
      q.set(isFerry ? "apiaccesscode" : "AccessCode", code);
    }

    let res;
    try {
      res = await fetch(`${up.host}${path}?${q}`, {
        headers: { "Accept": request.headers.get("Accept") || "*/*" },
        cf: q.has("callback") ? {} : { cacheTtl: up.cacheTtl, cacheEverything: true },
      });
    } catch {
      return reply("upstream unreachable", 502, origin);
    }
    const headers = new Headers();
    for (const h of ["Content-Type", "Retry-After"]) {
      const v = res.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set("Cache-Control", "no-store");
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
    // the key is never echoed back: upstream bodies don't include it, and no upstream URL is returned
    return new Response(res.body, { status: res.status, headers });
  },
};
