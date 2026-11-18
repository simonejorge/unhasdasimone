const CACHE_NAME = 'unhas-da-simone-v2';
const CORE = [
  './',
  './index.html',
  './admin.html',
  './minha.html',
  './recuperar-senha.html',
  './style.css',
  './app.js',
  './minha.js',
  './assets/logo.png',
  './assets/logo-horizontal.png',
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
