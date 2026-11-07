/* Seattle Transit Map Service Worker - Reliable Offline & Dynamic Cache (v10.1) */
const CACHE_NAME = "seattle-transit-v10-1";
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
  "data/areas.json",
  "data/schedule.json",
  "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.js",
  "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.css"
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
    }).then(() => self.clients.claim()).then(() => {
      // Notify active clients that an updated service worker is running
      return self.clients.matchAll().then((clients) => {
        clients.forEach((client) => client.postMessage({ type: "SW_UPDATED", version: CACHE_NAME }));
      });
    })
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
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, cloned));
        }
        return response;
      }).catch(() => {
        return caches.match(req).then((cached) => cached || caches.match("./") || caches.match("index.html"));
      })
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

  // App core assets, vector tiles, CDN resources: Cache-first with network fallback
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((response) => {
        if (!response || (response.status !== 200 && response.status !== 0)) {
          return response;
        }
        // Allow basic, cors, and opaque so third-party CDN libraries (like MapLibre) can be cached for offline mode
        if (response.type !== "basic" && response.type !== "cors" && response.type !== "opaque") {
          return response;
        }
        const cloned = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          // Cache vector tiles, fonts, and static assets dynamically
          if (url.pathname.includes("/tiles/") || url.pathname.includes("/fonts/") || url.pathname.endsWith(".js") || url.pathname.endsWith(".css") || url.pathname.endsWith(".svg") || url.hostname.includes("cdnjs.cloudflare.com")) {
            cache.put(req, cloned);
          }
        });
        return response;
      }).catch((err) => {
        if (req.mode === "navigate") {
          return caches.match("./");
        }
        throw err;
      });
    })
  );
});
