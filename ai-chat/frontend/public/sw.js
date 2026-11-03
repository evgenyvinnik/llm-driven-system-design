/*
 * App-shell service worker (production build only).
 *
 * Network first for the page and its static assets, falling back to the last
 * cached copy when the network is down, so the app can still start offline
 * and show the conversations cached in IndexedDB. API calls are never cached
 * here: conversation data lives in the per-user IndexedDB cache, which is
 * deleted on sign-out, while this cache holds only public static files.
 */
const CACHE = 'ai-chat-shell-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone()
          void caches.open(CACHE).then((cache) => cache.put(event.request, copy))
        }
        return response
      })
      .catch(async () => {
        const cached = await caches.match(event.request)
        if (cached) return cached
        // Client-side routes (/c/:id) all serve the same shell.
        if (event.request.mode === 'navigate') return (await caches.match('/')) ?? Response.error()
        return Response.error()
      }),
  )
})
