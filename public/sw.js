// Only public application assets belong in this cache; API responses are never cached.
const BASE = new URL(self.registration.scope).pathname;
const CACHE_PREFIX = `idea-shell-${BASE}-`;
const CACHE = "idea-shell-v1";
const PRECACHE = [
  "/",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.webmanifest",
];
self.addEventListener("install", (event) =>
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE))),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("message", (event) => {
  if (event.data === "ACTIVATE_UPDATE") self.skipWaiting();
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    !url.pathname.startsWith(BASE) ||
    url.pathname.startsWith(`${BASE}api/`)
  )
    return;
  if (event.request.mode === "navigate" && url.pathname === BASE) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((c) => c.put(BASE, copy));
          }
          return response;
        })
        .catch(() => caches.match(BASE)),
    );
  } else if (
    url.pathname.startsWith(`${BASE}assets/`) ||
    ["/icon.svg", "/icon-192.png", "/icon-512.png", "/manifest.webmanifest"]
      .map((path) => BASE + path.slice(1))
      .includes(url.pathname)
  ) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ||
          fetch(event.request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((c) => c.put(event.request, copy));
            }
            return response;
          }),
      ),
    );
  }
});
