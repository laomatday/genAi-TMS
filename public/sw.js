const CACHE_NAME = 'genai-tms-v10';
const CACHE_PREFIX = 'genai-tms-';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/genai-app-icon-180.png',
  '/genai-app-icon-192.png',
  '/genai-app-icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const staleAppCaches = keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME);

      await Promise.all(staleAppCaches.map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) {
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  const requestUrl = new URL(event.request.url);
  const shouldAlwaysRevalidate = ['/', '/index.html', '/manifest.json', '/sw.js'].includes(requestUrl.pathname);

  if (shouldAlwaysRevalidate) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    })),
  );
});
