const C = 'korbjagd-v2';
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(['./', './app.js', './store.js', './vg.js', './firebase-config.js', './manifest.json', './icon.svg']))); self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('./'))));
});
