/* TrapMap service worker.
   Same-origin files: stale-while-revalidate — serve from cache instantly,
   refresh in the background. Map tiles and Overpass API: network only. */
const CACHE = 'trapmap-v1';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './vendor/leaflet.js',
  './vendor/leaflet.css',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // tiles + APIs: network only
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(e.request);
    const network = fetch(e.request).then(res => {
      if (res && res.ok) c.put(e.request, res.clone());
      return res;
    }).catch(() => null);
    if (hit) {
      e.waitUntil(network);
      return hit;
    }
    const fresh = await network;
    return fresh || new Response('Offline', { status: 503 });
  })());
});
