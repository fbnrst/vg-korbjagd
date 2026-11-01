import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const PUB = path.resolve(import.meta.dirname, '../public');
const read = f => fs.readFileSync(path.join(PUB, f), 'utf8');
const sw = read('sw.js');
const FILES = new Function(`return ${sw.match(/const FILES = (\[[\s\S]*?\]);/)[1]}`)().map(f => path.posix.normalize(f));

// Same-origin files a module loads: static imports/re-exports, literal dynamic imports and `new URL('...', import.meta.url)`.
// Absolute URLs are cross-origin and left out. vendor/ is not followed, except the ES modules of the Firebase SDK
// (firebase-database.js imports ./firebase-app.js).
const deps = (file, src) => {
  const out = [];
  const add = spec => { if (!/^[a-z]+:|^\/\//i.test(spec)) out.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec))); };
  for (const m of src.matchAll(/^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/gm)) add(m[1]);
  for (const m of src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) add(m[1]);
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1]);
  for (const m of src.matchAll(/new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) add(m[1]);
  return out;
};
const graph = entries => {
  const seen = new Set(), todo = [...entries];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (f.endsWith('.js') && (!f.startsWith('vendor/') || f.startsWith('vendor/firebase/'))) todo.push(...deps(f, read(f)));
  }
  return seen;
};
// Local files a page links: <script src>, <link href> (manifest, icons, styles)
const links = page => [...read(page).matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g)].map(m => m[1])
  .filter(u => !/^[a-z]+:|^\/\//i.test(u)).map(u => path.posix.normalize(path.posix.join(path.posix.dirname(page), u)));

test('sw.js precaches every module app.js loads and every file the pages link', () => {
  const pages = ['index.html', 'privacy.html', 'docs/index.html'];
  const need = graph(pages.flatMap(links));
  assert.ok(need.has('app.js') && need.has('store.js') && need.has('vendor/zxing.min.js') && need.has('vendor/firebase/firebase-database.js') && need.has('vendor/firebase/firebase-app.js') && need.has('theme.css'), 'the graph was found');
  for (const p of pages) assert.ok(FILES.includes(p), `${p} is precached`);
  for (const f of need) {
    assert.ok(fs.existsSync(path.join(PUB, f)), `${f} exists`);
    assert.ok(FILES.includes(f), `sw.js FILES misses ./${f}`);
  }
  for (const f of FILES) if (f !== '.') assert.ok(fs.existsSync(path.join(PUB, f)), `precached ${f} exists`);
});

// Runs sw.js in a sandbox with a fake cache storage, fetch and timers
const runSw = () => {
  const store = new Map(), timers = [], handlers = {};
  const keyOf = (k, ignoreSearch) => { const u = new URL(typeof k === 'string' ? k : k.url, 'https://kober.test/'); if (ignoreSearch) u.search = ''; return u.href; };
  const cache = {
    put: async (k, res) => { store.set(keyOf(k), res); },
    match: async (k, o = {}) => { for (const [u, r] of store) if (keyOf(u, o.ignoreSearch) === keyOf(k, o.ignoreSearch)) return r; },
    addAll: async () => {},
  };
  let net;
  const ctx = {
    self: { registration: { scope: 'https://kober.test/' }, addEventListener: (n, f) => { handlers[n] = f; }, skipWaiting() {}, clients: { claim: async () => {} } },
    location: { origin: 'https://kober.test' },
    caches: { open: async () => cache, match: (k, o) => cache.match(k, o), keys: async () => [], delete: async () => true },
    fetch: (...a) => net(...a),
    setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout() {},
    URL, Request, Response, Promise,
  };
  vm.runInNewContext(sw, ctx);
  const fire = (url, mode = 'no-cors') => {
    const e = { waits: [], request: { url, method: 'GET', mode }, respondWith(p) { e.response = p; }, waitUntil(p) { e.waits.push(p); } };
    handlers.fetch(e);
    return e;
  };
  return { store, timers, fire, setNet: f => { net = f; } };
};
const tick = () => new Promise(r => setImmediate(r));

test('sw.js: a slow network falls back to the cache after the timeout and still updates the cache later', async () => {
  const s = runSw();
  s.store.set('https://kober.test/app.js', new Response('old'));
  let arrive;
  s.setNet(() => new Promise(r => { arrive = r; }));
  const e = s.fire('https://kober.test/app.js');
  assert.equal(s.timers.length, 1);
  assert.ok(s.timers[0].ms > 0 && s.timers[0].ms <= 5000, 'a timeout of a few seconds');
  s.timers[0].fn();
  assert.equal(await (await e.response).text(), 'old', 'the cached copy answers');
  arrive(new Response('new'));
  await Promise.all(e.waits);
  assert.equal(await s.store.get('https://kober.test/app.js').text(), 'new', 'the late response lands in the cache');
});

test('sw.js: a fast network answers and is cached; a failed one falls back at once', async () => {
  const s = runSw();
  s.setNet(async () => new Response('fresh'));
  const e = s.fire('https://kober.test/vg.js');
  assert.equal(await (await e.response).text(), 'fresh');
  await Promise.all(e.waits);
  assert.ok(s.store.has('https://kober.test/vg.js'));
  s.setNet(async () => { throw new TypeError('offline'); });
  const f = s.fire('https://kober.test/vg.js');
  await tick();
  assert.equal(await (await f.response).text(), 'fresh');
  // timeout without a cached copy keeps waiting for the network
  let arrive;
  s.setNet(() => new Promise(r => { arrive = r; }));
  const g = s.fire('https://kober.test/nothere.js');
  s.timers.at(-1).fn(); await tick();
  arrive(new Response('late'));
  assert.equal(await (await g.response).text(), 'late');
});

test('sw.js: pages are cached without their query, so list codes never land in the cache storage', async () => {
  const s = runSw();
  s.setNet(async () => new Response('page'));
  const e = s.fire('https://kober.test/dev/?list=ABCDEF', 'navigate');
  await e.response; await Promise.all(e.waits);
  assert.deepEqual([...s.store.keys()], ['https://kober.test/dev/']);
  assert.ok(![...s.store.keys()].some(k => k.includes('ABCDEF')));
  s.setNet(async () => { throw new TypeError('offline'); });
  const f = s.fire('https://kober.test/dev/?list=XYZXYZ', 'navigate');
  assert.equal(await (await f.response).text(), 'page', 'offline: the page is found again whatever the query');
});
