/**
 * Service Worker for typeahead offline support.
 * Uses stale-while-revalidate strategy for API requests and network-first for pages,
 * so a redeploy is picked up on the next load (the cached shell is only an offline fallback).
 */

/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

// Bump CACHE_VERSION whenever the caching scheme changes; activate deletes every other cache.
const CACHE_VERSION = 'v2';
const CACHE_NAME = `typeahead-${CACHE_VERSION}`;
const API_CACHE_NAME = `typeahead-api-${CACHE_VERSION}`;

// URLs to cache on install
const STATIC_ASSETS = [
  '/',
  '/index.html',
];

// API routes to apply stale-while-revalidate
const SWR_API_PATTERNS = [
  '/api/v1/suggestions',
  '/api/v1/analytics/trending',
  '/api/v1/analytics/summary',
];

// Cache TTLs (in milliseconds)
const API_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
// Oldest response still served as an offline fallback; older entries are deleted, so a phrase
// filtered by an admin cannot stay servable from here indefinitely
const API_CACHE_MAX_STALE = 24 * 60 * 60 * 1000; // 24 hours
// Every keystroke prefix is a distinct URL; cap the entry count so the cache cannot grow forever
const API_CACHE_MAX_ENTRIES = 200;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME && name !== API_CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

/**
 * Check if a URL matches our stale-while-revalidate patterns.
 */
function shouldApplySWR(url: URL): boolean {
  return SWR_API_PATTERNS.some((pattern) => url.pathname.startsWith(pattern));
}

/**
 * Age of a cached API response in milliseconds (Infinity if it carries no timestamp).
 */
function cacheAge(response: Response): number {
  const cachedAt = response.headers.get('sw-cached-at');
  if (!cachedAt) return Infinity;
  return Date.now() - parseInt(cachedAt, 10);
}

/**
 * Check if cached response is still fresh.
 */
function isCacheValid(response: Response): boolean {
  return cacheAge(response) < API_CACHE_TTL;
}

/**
 * Evict the oldest entries beyond API_CACHE_MAX_ENTRIES. cache.put() appends (a re-put moves
 * the entry to the end), so keys() is ordered oldest write first.
 */
async function trimApiCache(cache: Cache): Promise<void> {
  const keys = await cache.keys();
  const excess = keys.length - API_CACHE_MAX_ENTRIES;
  if (excess <= 0) return;
  await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)));
}

/**
 * Clone response and add cache timestamp header.
 */
async function cacheWithTimestamp(
  cache: Cache,
  request: Request,
  response: Response
): Promise<void> {
  const headers = new Headers(response.headers);
  headers.set('sw-cached-at', Date.now().toString());

  const cachedResponse = new Response(await response.clone().blob(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });

  await cache.put(request, cachedResponse);
  await trimApiCache(cache);
}

/**
 * Stale-while-revalidate fetch handler.
 * Returns cached response immediately while fetching fresh data in background.
 */
async function staleWhileRevalidate(request: Request): Promise<Response> {
  const cache = await caches.open(API_CACHE_NAME);
  let cachedResponse = await cache.match(request);

  // Too old even for an offline fallback: delete instead of serving
  if (cachedResponse && cacheAge(cachedResponse) > API_CACHE_MAX_STALE) {
    await cache.delete(request);
    cachedResponse = undefined;
  }

  // Start network request. Revalidate past the browser HTTP cache (no-cache sends the ETag,
  // so an unchanged body costs a 304), otherwise a still-fresh HTTP-cached body would be
  // re-stamped here as newly fetched.
  const fetchPromise = fetch(new Request(request, { cache: 'no-cache' }))
    .then(async (networkResponse) => {
      if (networkResponse.ok) {
        await cacheWithTimestamp(cache, request, networkResponse);
      }
      return networkResponse.clone();
    })
    .catch((error) => {
      console.warn('[SW] Network request failed:', error);
      return null;
    });

  // The page asked to bypass caches (api.ts fetches personalized suggestions with no-cache,
  // since they change as soon as the user logs a search): only answer from here when offline
  const bypassCache =
    request.cache === 'no-cache' || request.cache === 'no-store' || request.cache === 'reload';

  // If we have a valid cached response, return it immediately
  if (!bypassCache && cachedResponse && isCacheValid(cachedResponse)) {
    // Revalidate in background
    fetchPromise.catch(() => {});
    return cachedResponse;
  }

  // If cache is stale or missing, wait for network
  const networkResponse = await fetchPromise;

  if (networkResponse) {
    return networkResponse;
  }

  // Fallback to stale cache if network failed
  if (cachedResponse) {
    return cachedResponse;
  }

  // No cache and no network - return error
  return new Response(JSON.stringify({ error: 'Offline and no cached data' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Network-first fetch for non-SWR requests.
 */
async function networkFirst(request: Request): Promise<Response> {
  try {
    const response = await fetch(request);
    return response;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    const cachedResponse = await cache.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }
    throw new Error('Network error and no cache available');
  }
}

/**
 * Network-first for page navigations. Serving the precached index.html cache-first would pin
 * returning users to the build they first saw: after a redeploy its hashed bundle no longer
 * exists and the page stays blank. The shell is refreshed on every successful load and is
 * only served when the network is unreachable (any route, since this is an SPA).
 */
async function navigationNetworkFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    // Only the app shell may replace the cached shell (not, say, a JSON API URL opened in a tab)
    if (response.ok && response.headers.get('Content-Type')?.includes('text/html')) {
      await cache.put('/index.html', response.clone());
    }
    return response;
  } catch {
    const cachedResponse = (await cache.match('/index.html')) ?? (await cache.match('/'));
    if (cachedResponse) {
      return cachedResponse;
    }
    throw new Error('Network error and no cached shell available');
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) {
    return;
  }

  // Skip non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  // Apply stale-while-revalidate for API endpoints
  if (shouldApplySWR(url)) {
    event.respondWith(staleWhileRevalidate(event.request));
    return;
  }

  // Network-first for pages, so a new deploy's index.html is used as soon as it exists
  if (event.request.mode === 'navigate') {
    event.respondWith(navigationNetworkFirst(event.request));
    return;
  }

  // Network-first for other requests (cached copies are only an offline fallback)
  event.respondWith(networkFirst(event.request));
});

// Handle messages from the main thread
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  // Sent by the admin client after rebuild / cache clear / add / filter
  if (event.data?.type === 'CLEAR_API_CACHE') {
    event.waitUntil(caches.delete(API_CACHE_NAME));
  }
});

export {};
