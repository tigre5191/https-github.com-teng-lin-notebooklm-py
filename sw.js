/* NutriLog service worker.
   Same-origin files: stale-while-revalidate — serve from cache instantly,
   refresh the cache in the background so the next launch gets updates.
   API calls (Open Food Facts, AI providers) always go to the network. */
const CACHE = 'nutrilog-v3';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './vendor/zxing.min.js',
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
  if (url.origin !== location.origin) return; // API calls: network only
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(e.request);
    const network = fetch(e.request).then(res => {
      if (res && res.ok) c.put(e.request, res.clone());
      return res;
    }).catch(() => null);
    if (hit) {
      e.waitUntil(network); // refresh in background
      return hit;
    }
    const fresh = await network;
    return fresh || new Response('Offline', { status: 503 });
  })());
});
