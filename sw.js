const CACHE = 'qeets-v2';
const STATIC = [
  '/',
  '/manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Outfit:wght@300;400;500;600;700&display=swap',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Don't intercept socket.io, POST, or upload URLs
  if (
    e.request.url.includes('/socket.io') ||
    e.request.url.includes('/upload') ||
    e.request.url.includes('/uploads/') ||
    e.request.method !== 'GET'
  ) return;

  e.respondWith(
    fetch(e.request)
      .then(r => {
        // Only cache successful same-origin or CORS responses
        if (r.ok || r.type === 'opaque') {
          const clone = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});