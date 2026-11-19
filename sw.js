const CACHE_NAME = 'unhas-da-simone-v6-push';
const CORE = [
  './',
  './index.html',
  './faq/',
  './admin.html',
  './minha.html',
  './recuperar-senha.html',
  './style.css',
  './app.js',
  './minha.js',
  './assets/logo.png',
  './assets/logo-horizontal.png',
  './assets/logo-simone-oficial.png',
  './assets/avatar-simone.webp',
  './assets/esmaltes.webp',
  './assets/app-icon-192.png',
  './assets/app-icon-512.png',
  './assets/manifest.webmanifest'
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(CORE)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch (_) { payload = { body: event.data ? event.data.text() : '' }; }
  const title = payload.title || 'Unhas da Simone';
  const options = {
    body: payload.body || 'Você tem uma atualização na agenda.',
    icon: './assets/app-icon-192.png',
    badge: './assets/favicon-32.png',
    tag: payload.tag || 'unhas-da-simone-agenda',
    renotify: true,
    data: { url: payload.url || './admin.html' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './admin.html', self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const client of list) {
      if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
        client.navigate(target);
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request).then(response => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {});
      return response;
    }).catch(() => caches.match(request).then(cached => cached || caches.match('./index.html')))
  );
});
