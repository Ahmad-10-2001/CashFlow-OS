/* ============================================================
   CashFlow OS — service worker

   Caching strategy
   • Navigations ......... network-first, cached app shell as the offline
                          fallback, so a reload while offline still opens the app.
   • Same-origin assets .. stale-while-revalidate. The cached copy is served
                          immediately (instant, offline-capable) while a fresh
                          copy is fetched in the background and swapped in.
                          This is what lets a redeploy reach installs that are
                          already open, without editing this file.
   • Non-GET and cross-origin requests are left alone.

   When you change the app, bump CACHE_VERSION so the precache and the
   delete-old-caches step pick up the new build in one go.
   ============================================================ */

const CACHE_VERSION = 'v34';
const CACHE_PREFIX = 'cashflow-os-';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
const SHELL_URL = './index.html';

/* Files that must never be served from cache while online: a stale copy of any
   of these mixed with a fresh index.html produces a page that is half-updated. */
const APP_FILES = ['/index.html', '/script.js', '/style.css', '/sync.js', '/config.js', '/manifest.json'];

const PRECACHE = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './sync.js',
  './config.js',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Add entries one at a time. cache.addAll() is all-or-nothing: a single
    // 404 would reject and no service worker would be installed at all.
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
    // Only ever delete caches this app owns.
    await Promise.all(
      names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME).map((n) => caches.delete(n))
    );
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable().catch(() => {});
    }
    await self.clients.claim();
  })());
});

// Let a waiting worker take over immediately when asked (see the update flow).
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

  // ── navigations: fresh when online, cached shell when not ──
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

  // ── the app's own files ──
  // This is the one case where a stale copy is actively harmful: an old
  // script.js served next to a new index.html leaves the markup and the logic
  // disagreeing — a tab that never appears, a dropdown that stays empty. Both
  // files are individually valid, which is what makes it so confusing. So these
  // go network-first, exactly like navigations.
  const isAppFile = APP_FILES.some((f) => url.pathname.endsWith(f));

  if (isAppFile) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request);
        if (response && response.ok && response.type === 'basic') {
          cache.put(request, response.clone());
        }
        return response;
      } catch (err) {
        // Offline: the cached copy is the only one there is.
        const cached = await cache.match(request);
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }

  // ── other same-origin assets: serve from cache now, refresh in background ──
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);

    const refreshed = fetch(request)
      .then((response) => {
        // Only store real, successful, same-origin responses.
        if (response && response.ok && response.type === 'basic') {
          cache.put(request, response.clone());
        }
        return response;
      })
      .catch(() => null);

    if (cached) return cached;                 // stale-while-revalidate
    const fresh = await refreshed;
    return fresh || new Response('', { status: 504, statusText: 'Offline' });
  })());
});
