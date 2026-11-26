/* Seattle Transit Map Service Worker - Reliable Offline & Dynamic Cache (v11) */
const CACHE_PREFIX = "seattle-transit-";
const CACHE_NAME = "seattle-transit-v11";
// The page shell only. The data files (about 4 MB compressed) are cached as the page itself
// fetches them (network-first, below), so a first visit doesn't download them twice.
const STATIC_ASSETS = [
  "manifest.json",
  "logo-mark.svg",
  "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.js",
  "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.css"
];

// Cache a response without ever letting a storage failure escape as an unhandled rejection.
function safePut(req, response) {
  return caches.open(CACHE_NAME).then((cache) => cache.put(req, response)).catch(() => {});
}

// The built page links its scripts, styles, logos and preloaded data with ?v=hash URLs, so read
// them from the page itself instead of guessing; each asset is cached on its own, so one
// unavailable file can't stop the rest.
async function precache() {
  const cache = await caches.open(CACHE_NAME);
  const urls = new Set(STATIC_ASSETS);
  try {
    const res = await fetch("./", { cache: "reload" });
    if (res && res.ok) {
      const html = await res.clone().text();
      await cache.put("./", res);
      for (const m of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
        const u = m[1];
        if (/^(https?:)?\/\//.test(u) && !/cdnjs\.cloudflare\.com/.test(u)) continue;
        if (/^(data:|blob:|mailto:|javascript:)/.test(u)) continue;
        if (/(^|\/)data\//.test(u)) continue; // preloaded data: cached when the page fetches it
        if (/\.(js|css|json|svg|png|webp|ico)(\?|$)/.test(u)) urls.add(u);
      }
    }
  } catch (e) { /* offline during install: the static list below still gets tried */ }
  await Promise.allSettled([...urls].map((u) =>
    // CDN scripts are loaded with crossorigin + integrity, so cache a CORS response (an opaque
    // one can't answer a CORS request)
    fetch(u, /^https?:/.test(u) ? { mode: "cors", credentials: "omit" } : undefined).then((r) => { if (r && r.ok) return cache.put(u, r); })
  ));
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      // only this app's own old caches: other projects on the same origin keep theirs
      keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k))
    )).then(() => self.clients.claim()).then(() =>
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => client.postMessage({ type: "SW_UPDATED", version: CACHE_NAME }));
      })
    )
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Skip non-GET requests
  if (req.method !== "GET") return;

  // Real-time dynamic APIs: Network-first
  if (url.searchParams.has("key") || url.pathname.includes("/api/") || url.pathname.endsWith(".pb") || url.hostname.includes("obaweb.org") || url.hostname.includes("wsdot.wa.gov")) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req))
    );
    return;
  }

  // Navigation requests: Network-first with cache fallback
  // This guarantees returning visitors immediately receive the updated page and scripts when online,
  // without mixing older cached HTML with newer data schemas.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).then((response) => {
        if (response && response.status === 200) {
          event.waitUntil(safePut(req, response.clone()));
        }
        return response;
      }).catch(() =>
        caches.match(req).then((cached) => cached || caches.match("./")).then((cached) => cached || caches.match("index.html"))
      )
    );
    return;
  }

  // Transit and map data: Network-first with cache fallback so fresh routes, areas & schedules load immediately
  if (url.pathname.includes("/data/")) {
    event.respondWith(
      fetch(req).then((response) => {
        if (response && response.status === 200) {
          event.waitUntil(safePut(req, response.clone()));
        }
        return response;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // App core assets, vector tiles, CDN resources: Cache-first with network fallback
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((response) => {
        if (!response || response.status !== 200) {
          return response;
        }
        // Basic and CORS responses only: the CDN scripts are requested with CORS, so MapLibre still caches for offline use
        if (response.type !== "basic" && response.type !== "cors") {
          return response;
        }
        // Cache vector tiles, fonts, and static assets dynamically
        if (url.pathname.includes("/tiles/") || url.pathname.includes("/fonts/") || url.pathname.endsWith(".js") || url.pathname.endsWith(".css") || url.pathname.endsWith(".svg") || url.hostname.includes("cdnjs.cloudflare.com")) {
          event.waitUntil(safePut(req, response.clone()));
        }
        return response;
      });
    })
  );
});
