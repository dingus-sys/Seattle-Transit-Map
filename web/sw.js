/* Seattle Transit Map Service Worker - Offline Tunnel Mode & App Caching (v9.8) */
const CACHE_NAME = "seattle-transit-v9-8";
const STATIC_ASSETS = [
  "./",
  "index.html",
  "app.css",
  "app.js",
  "geom.js",
  "ribbons.js",
  "logo-mark.svg",
  "manifest.json",
  "data/network.json",
  "data/routes.json",
  "data/stops.json",
  "data/areas.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn("SW: pre-caching partial failure", err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    }).then(() => self.clients.claim())
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

  // Transit and map data: Network-first with cache fallback so fresh routes, areas & schedules load immediately
  if (url.pathname.includes("/data/")) {
    event.respondWith(
      fetch(req).then((response) => {
        if (response && response.status === 200) {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, cloned));
        }
        return response;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // App core assets, vector tiles: Cache-first with network fallback
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((response) => {
        if (!response || response.status !== 200 || response.type !== "basic") {
          return response;
        }
        const cloned = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          // Cache vector tiles, fonts, and static assets dynamically
          if (url.pathname.includes("/tiles/") || url.pathname.includes("/fonts/") || url.pathname.endsWith(".js") || url.pathname.endsWith(".css") || url.pathname.endsWith(".svg")) {
            cache.put(req, cloned);
          }
        });
        return response;
      }).catch((err) => {
        // If offline and request is for page, return root
        if (req.mode === "navigate") {
          return caches.match("./");
        }
        throw err;
      });
    })
  );
});
