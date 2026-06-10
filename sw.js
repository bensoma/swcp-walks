/**
 * Service Worker — South West Coast Path Walk Journal (v8, modular build)
 * ──────────────────────────────────────────────────────────────────────
 * Caching strategy:
 *
 *   • PRECACHE — the app shell (the built single-file index.html, the
 *     manifest, and the icons) is cached on install so the app boots with
 *     no network. The shell essentials are required; icons are best-effort
 *     so a missing icon never aborts the whole install.
 *
 *   • RUNTIME CACHE — third-party assets loaded on demand (Leaflet, jsPDF,
 *     JSZip and Chart.js from cdnjs; Google Fonts; OpenStreetMap tiles) are
 *     cached cache-first on first online use, so the lazy loaders in
 *     loaders.js work offline after a single online visit.
 *
 *   • NAVIGATION — top-level navigations are network-first with a fallback
 *     to the cached index.html, giving the latest build when online and a
 *     working offline boot when not.
 *
 *   • IndexedDB IS NOT TOUCHED — the worker caches HTTP responses only.
 *     Walks, photos and GPX live in IndexedDB, independent of this worker.
 *
 * Update flow is driven by pwa.js: on an update it posts {type:'SKIP_WAITING'}
 * after showing the "update available" toast, then reloads on controllerchange.
 * This worker therefore does NOT call skipWaiting() on install — it waits for
 * that message so the page controls when the new version takes over.
 *
 * Bump VERSION on each release to invalidate the old caches cleanly.
 */

const VERSION       = 'v8.0.2';
const PRECACHE      = `swcp-precache-${VERSION}`;
const RUNTIME_CACHE = `swcp-runtime-${VERSION}`;

/**
 * Shell essentials — install fails if any of these cannot be cached. Paths are
 * relative to the worker's scope so the same list works on localhost and on a
 * GitHub Pages project site.
 */
const PRECACHE_SHELL = [
  './',
  './index.html',
  './manifest.json',
];

/**
 * Icons — cached best-effort. They may not exist yet; a 404 here must not abort
 * the install, so each is fetched individually and failures are swallowed.
 */
const PRECACHE_ICONS = [
  './icons/favicon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
];

/** Hostnames whose responses are cached cache-first at runtime. */
const RUNTIME_CACHE_HOSTS = [
  'cdnjs.cloudflare.com',        // Leaflet, jsPDF, JSZip, Chart.js
  'fonts.googleapis.com',        // Google Fonts CSS
  'fonts.gstatic.com',           // Google Fonts woff2 files
  'a.tile.openstreetmap.org',    // Leaflet map tiles
  'b.tile.openstreetmap.org',
  'c.tile.openstreetmap.org',
];

// ─── Install: precache the shell (required) + icons (best-effort) ────────────
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(PRECACHE);
    // Shell must succeed, or the worker is useless — let a failure reject install.
    await cache.addAll(PRECACHE_SHELL);
    // Icons are optional; cache whatever resolves, ignore the rest.
    await Promise.all(PRECACHE_ICONS.map(async url => {
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (res.ok) await cache.put(url, res);
      } catch (_) { /* icon missing — ignore */ }
    }));
    // NB: no skipWaiting() here — pwa.js drives activation via SKIP_WAITING.
  })());
});

// ─── Activate: drop old caches, take control of open clients ─────────────────
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k !== PRECACHE && k !== RUNTIME_CACHE)
          .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// ─── Fetch: route each request through the right strategy ────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;              // never cache non-GET (writes)
  const url = new URL(req.url);

  // Connectivity probes bypass the cache so they reflect the real network.
  if (url.searchParams.has('_probe')) return;

  // Never cache GitHub API traffic — sync must always hit the network.
  if (url.hostname === 'api.github.com') return;

  // Top-level navigation: network-first, fall back to cached shell offline.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(req));
    return;
  }

  // Same-origin assets: cache-first, lazily populating the precache.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req, PRECACHE));
    return;
  }

  // Known CDN / tile hosts: cache-first into the runtime cache.
  if (RUNTIME_CACHE_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(req, RUNTIME_CACHE));
    return;
  }

  // Anything else: leave to the network untouched.
});

/**
 * Cache-first: serve the cached response if present, otherwise fetch, cache a
 * successful copy, and return it. On network failure with no cache, propagate
 * the error. Opaque (cross-origin no-cors) responses are returned but not
 * cached, to avoid filling the cache with unreadable zero-length entries.
 */
async function cacheFirst(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.status === 200 && response.type !== 'opaque') {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (e) {
    return cached || Response.error();
  }
}

/**
 * Network-first for navigations. Refreshes the cached shell on every success so
 * the next offline boot serves the latest build; falls back to the cached
 * index.html when the network is unavailable.
 */
async function networkFirstNavigation(request) {
  const cache = await caches.open(PRECACHE);
  try {
    const fresh = await fetch(request);
    cache.put('./index.html', fresh.clone()).catch(() => {});
    return fresh;
  } catch (e) {
    return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
  }
}

// ─── Update channel ──────────────────────────────────────────────────────────
// pwa.js posts {type:'SKIP_WAITING'} after the user is told an update is ready;
// activating here triggers controllerchange, which pwa.js uses to reload.
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
