// Offline support. Build output has hashed names, so a cached copy of a file
// can never go stale; a new build ships a new sw.js with a new cache.
const BUILD = __BUILD__;
const PRECACHE = __PRECACHE__;
const CACHE = `sarala-app-${BUILD}`;
const RUNTIME = "sarala-runtime";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // In batches: hundreds of grammar chunks at once trips some hosts' limits.
    for (let i = 0; i < PRECACHE.length; i += 24) {
      await cache.addAll(PRECACHE.slice(i, i + 24));
    }
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith("sarala-app-") && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope).pathname;
  const path = url.pathname.slice(scope.length);
  // Pandoc has its own cache, filled by an explicit download.
  if (path.startsWith("pandoc/")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return (await cache.match("./")) ?? fetch(request);
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    // Too large to fetch up front, and not everyone needs them: keep them once used.
    if (response.ok && (path.startsWith("ort/") || path.startsWith("assets/"))) {
      const runtime = await caches.open(RUNTIME);
      await runtime.put(request, response.clone());
    }
    return response;
  })());
});
