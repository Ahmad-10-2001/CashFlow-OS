const CACHE_VERSION = 'v7';
const CACHE_PREFIX = 'salary-manager-';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
const SHELL_URL = './index.html';

const PRECACHE = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const results = await Promise.allSettled(
      PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' })))
    );
    const failed = PRECACHE.filter((_, i) => results[i].status === 'rejected');
    if (failed.length) console.warn('[sw] could not precache:', failed.join(', '));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME).map((n) => caches.delete(n))
    );
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable().catch(() => {});
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const preloaded = await event.preloadResponse;
        if (preloaded) return preloaded;
        return await fetch(request);
      } catch (err) {
        const cache = await caches.open(CACHE_NAME);
        const shell = await cache.match(SHELL_URL);
        if (shell) return shell;
        const root = await cache.match('./');
        if (root) return root;
        return new Response('Offline and no cached copy is available.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' }
        });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);

    const refreshed = fetch(request)
      .then((response) => {
        if (response && response.ok && response.type === 'basic') {
          cache.put(request, response.clone());
        }
        return response;
      })
      .catch(() => null);

    if (cached) return cached;
    const fresh = await refreshed;
    return fresh || new Response('', { status: 504, statusText: 'Offline' });
  })());
});
