// Default for local runs: scripts/build-site.mjs stamps each deployed site with a hash of its files, so every deploy that
// changes a file gets a new cache name (no manual bump)
const VERSION = 'v136';
// The release (/) and the dev build (/dev/) share one origin and so one cache storage: each keeps to its own cache names
const PREFIX = 'kober-' + (self.registration.scope.includes('/dev/') ? 'dev-' : '') + 'v';
const CACHE = PREFIX + VERSION.slice(1);
// Everything the app needs offline. test/sw.test.js checks that the module graph of app.js and the files index.html links are
// all here; build-site.mjs swaps the icons for the dev ones in /dev/.
const FILES = ['./', './index.html', './app.js', './store.js', './conn.js', './outbox.js', './cache.js', './flows.js', './aisles.js', './order.js', './a11y.js', './sim.js', './vg.js', './i18n.js', './env.js', './version.js', './legal-config.js', './privacy.html', './privacy.js', './theme.css', './docs/index.html', './docs/help.js', './firebase-config.js', './manifest.json', './icon.svg', './logo.svg',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png',
  './vendor/qrcode.js', './vendor/zxing.min.js'];
// A shop with weak signal: after this long without an answer the cached copy is used (the network may still update the cache)
const TIMEOUT_MS = 3000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first with a timeout, cache when the network is slow or fails. Same origin only (Firebase, VG server etc. are left alone).
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const nav = req.mode === 'navigate';
  // Pages are stored without their query: `?list=CODE` (a list's only secret) must not pile up in the cache storage
  const key = nav ? url.origin + url.pathname : req;
  // `no-cache`: always ask the server whether the file changed (cheap 304). GitHub Pages allows browsers to keep files
  // for 10 minutes (max-age=600), which would otherwise delay every new version by up to 10 minutes.
  const net = fetch(req, { cache: 'no-cache' });
  // The cache write is part of the event's lifetime, also when it lands after the timeout already answered from the cache
  e.waitUntil(net.then(res => {
    if (!res.ok) return;
    const copy = res.clone();
    return caches.open(CACHE).then(c => c.put(key, copy));
  }).catch(() => {}));
  const cached = () => caches.match(key, { ignoreSearch: true }).then(r => r || (nav ? caches.match('./index.html') : undefined));
  e.respondWith(new Promise(resolve => {
    let done = false;
    const answer = r => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    // Timeout: answer from the cache if it has the file, otherwise keep waiting for the network
    const timer = setTimeout(() => cached().then(r => { if (r) answer(r); }), TIMEOUT_MS);
    net.then(answer, () => cached().then(r => answer(r || Response.error())));
  }));
});
