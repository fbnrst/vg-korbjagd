const VERSION = 'v102';
// The release (/) and the dev build (/dev/) share one origin and so one cache storage: each keeps to its own cache names
const PREFIX = 'kober-' + (self.registration.scope.includes('/dev/') ? 'dev-' : '') + 'v';
const CACHE = PREFIX + VERSION.slice(1);
const FILES = ['./', './index.html', './app.js', './store.js', './conn.js', './outbox.js', './cache.js', './sim.js', './vg.js', './i18n.js', './env.js', './legal-config.js', './privacy.html', './dev-theme.css', './docs/index.html', './firebase-config.js', './manifest.json', './icon.svg', './logo.svg',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png',
  './vendor/qrcode.js', './vendor/crypto-js.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first, cache on failure. Same origin only (Firebase, VG server etc. are left alone).
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // `no-cache`: always ask the server whether the file changed (cheap 304). GitHub Pages allows browsers to keep files
  // for 10 minutes (max-age=600), which would otherwise delay every new version by up to 10 minutes.
  e.respondWith(fetch(req, { cache: 'no-cache' }).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))));
});
