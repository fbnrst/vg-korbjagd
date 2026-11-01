import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { createConn } from '../public/conn.js';
import { createStore, localAdapter, userKey } from '../public/store.js';
import { createSim, createClock, applyScenario } from '../public/sim.js';
import { createOutbox, validEntry, overlay, MAX_ENTRIES, MAX_AGE } from '../public/outbox.js';
import { saveSnapshot, loadSnapshot, sanitize, KEEP, MAX_BYTES } from '../public/cache.js';
import { STRINGS } from '../public/i18n.js';

const SEC = 1000, CODE = 'ABCDEF';
const A = userKey('🦊', 'Mia'), B = userKey('🐼', 'Tom');
// A storage like localStorage (enumerable, removable)
const mem = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); }, key: i => [...m.keys()][i] ?? null, get length() { return m.size; } };
};

// One "page load": clock, conn, simulated server over `base`, store with outbox over `storage`. Several boots on the same
// storage and base are reloads of the page.
const boot = ({ clock = createClock(1_000_000), storage, base, onFull } = {}) => {
  const conn = createConn({ now: clock.now, setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock), random: () => 0.5 });
  const sim = createSim(base, { clock });
  const outbox = createOutbox({ storage, now: clock.now, onFull });
  const timers = { setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock) };
  const store = outbox.wrap(createStore(sim, { ...timers, timeoutMs: 8 * SEC, onResult: conn.opResult, conn, journal: outbox.journal }), conn);
  conn.attach(sim);
  conn.subscribe(s => { if (s === 'ok') store.flush(CODE); }); // like app.js
  sim.subscribe(CODE, () => {}, conn.onStatus);
  return { clock, conn, sim, outbox, store };
};
const stored = (storage, key = 'kober-outbox') => JSON.parse(storage.getItem(key) || '[]');
const finalState = async base => ({ items: await base.get(CODE, 'items'), scores: await base.get(CODE, 'scores'), deposit: await base.get(CODE, 'deposit') });
const strip = s => JSON.parse(JSON.stringify(s, (k, v) => (k === 'addedAt' || k === 'checkedAt' ? undefined : v)));

// The scenario of the test: five changes
const actions = async store => {
  await store.add(CODE, { id: 'a', title: 'Milch' }, A);
  await store.add(CODE, { id: 'b', title: 'Brot' }, A);
  await store.check(CODE, 'a', A, true);
  await store.depositAdd(CODE, '1', B);
  await store.setNum(CODE, 'b', A, 1234, true);
};

test('outbox: write while busy, reload, recover: items and scores equal the run without trouble', async () => {
  const ref = localAdapter(mem(), false); // reference run
  const r = boot({ storage: mem(), base: ref });
  await r.clock.advance(1);
  await actions(r.store);
  await r.clock.advance(1);
  const expected = strip(await finalState(ref));
  assert.equal(expected.scores[A], 2); assert.equal(expected.scores[B], 1);

  const storage = mem(), base = localAdapter(mem(), false);
  const one = boot({ storage, base });
  await one.clock.advance(1);
  one.sim.maxConnections(100); // the server is full
  await one.clock.advance(20 * SEC);
  assert.equal(one.conn.state(), 'busy');
  const calls = one.sim.callCount();
  await actions(one.store);
  assert.equal(one.sim.callCount(), calls, 'nothing is sent while busy');
  assert.equal(stored(storage).length, 5, 'the intents are on disk');
  assert.equal(one.outbox.count(CODE), 5);
  assert.equal(await base.get(CODE, 'items'), null);
  // reload: a new page over the same storage, and the server is fine now
  const two = boot({ storage, base, clock: createClock(2_000_000) });
  assert.equal(two.outbox.count(CODE), 5, 'the intents survive the reload');
  await two.clock.advance(10 * SEC);
  assert.equal(two.conn.state(), 'ok');
  assert.equal(two.outbox.entries().length, 0, 'everything was sent and struck out');
  assert.deepEqual(strip(await finalState(base)), expected);
});

test('outbox: a replayed entry list is idempotent, also twice in a row', async () => {
  const storage = mem(), base = localAdapter(mem(), false);
  const one = boot({ storage, base });
  await one.clock.advance(1);
  one.sim.maxConnections(100); await one.clock.advance(20 * SEC);
  await actions(one.store);
  const saved = storage.getItem('kober-outbox');
  const two = boot({ storage, base, clock: createClock(2_000_000) });
  await two.clock.advance(10 * SEC);
  const first = strip(await finalState(base));
  storage.setItem('kober-outbox', saved); // the very same intents again (a crash right before they were struck out)
  const three = boot({ storage, base, clock: createClock(3_000_000) });
  await three.clock.advance(10 * SEC);
  const second = strip(await finalState(base));
  assert.equal(second.scores[A], 2, 'no point twice');
  assert.deepEqual(second.items, first.items, 'items unchanged');
  assert.equal(second.deposit['1'][B], 2, 'documented: a replayed depositAdd counts again (only if the page died before the entry was struck out)');
});

test('outbox: reload between the item transaction and its point: the point is neither lost nor doubled', async () => {
  const storage = mem(), base = localAdapter(mem(), false);
  const one = boot({ storage, base });
  await one.clock.advance(1);
  await one.store.add(CODE, { id: 'a', title: 'Milch' }, A);
  one.sim.dropAfter('update'); // the connection dies right after the item transaction
  const out = one.store.check(CODE, 'a', A, true);
  await one.clock.advance(8100);
  await out;
  assert.equal((await base.get(CODE, 'items/a')).checked, true, 'the item changed');
  assert.equal(await base.get(CODE, 'scores'), null, 'the point did not');
  assert.deepEqual(stored(storage).map(e => e.op).sort(), ['bump', 'check'], 'the point was journaled when the item committed');
  // reload: the old page (and its queued bump) is gone
  const two = boot({ storage, base, clock: createClock(2_000_000) });
  await two.clock.advance(10 * SEC);
  assert.equal((await base.get(CODE, 'scores'))[A], 1, 'exactly one point');
  assert.equal(two.outbox.entries().length, 0);
  // an item transaction that timed out and is lost with the page: replay does item and point
  const s2 = mem(), b2 = localAdapter(mem(), false);
  const x = boot({ storage: s2, base: b2 });
  await x.clock.advance(1);
  await x.store.add(CODE, { id: 'a', title: 'Milch' }, A);
  x.sim.setMode('blackhole');
  const p = x.store.check(CODE, 'a', A, true);
  await x.clock.advance(8100); await p;
  assert.equal(x.outbox.count(CODE), 1);
  const y = boot({ storage: s2, base: b2, clock: createClock(2_000_000) });
  await y.clock.advance(10 * SEC);
  assert.equal((await b2.get(CODE, 'scores'))[A], 1);
  assert.equal((await b2.get(CODE, 'items/a')).checked, true);
});

test('outbox: a late commit in the same page strikes the entry out and the point follows once', async () => {
  const storage = mem(), base = localAdapter(mem(), false);
  const { clock, sim, store, outbox } = boot({ storage, base });
  await clock.advance(1);
  await store.add(CODE, { id: 'a', title: 'Milch' }, A);
  sim.setMode('blackhole');
  const p = store.check(CODE, 'a', A, true);
  await clock.advance(8100); await p;
  sim.setMode('ok');
  await clock.advance(20 * SEC);
  assert.equal((await base.get(CODE, 'scores'))[A], 1);
  assert.equal(outbox.entries().length, 0);
});

test('outbox: optimistic view while waiting, a live snapshot is authoritative', async () => {
  const storage = mem(), base = localAdapter(mem(), false);
  const { clock, sim, store, outbox } = boot({ storage, base });
  await clock.advance(1);
  await store.add(CODE, { id: 'a', title: 'Milch' }, A);
  sim.maxConnections(100); await clock.advance(20 * SEC);
  const live = { items: await base.get(CODE, 'items'), scores: {}, deposit: {} };
  await store.check(CODE, 'a', A, true);
  await store.depositAdd(CODE, '1', A);
  await store.add(CODE, { id: 'n', title: 'Brot' }, A);
  const view = outbox.overlayFor(live, CODE);
  assert.equal(view.items.a.checked, true, 'the check mark flips at once');
  assert.equal(view.items.a.checkedBy, A);
  assert.equal(view.items.n.title, 'Brot');
  assert.equal(view.deposit['1'][A], 1);
  assert.deepEqual(view.scores, {}, 'points are not shown ahead');
  assert.equal(live.items.a.checked, false, 'the snapshot itself is not touched');
  // recovery: the snapshot now says what really happened
  sim.releaseOthers(); await clock.advance(20 * SEC);
  assert.equal(outbox.entries().length, 0);
  const after = await finalState(base);
  assert.deepEqual(strip(outbox.overlayFor(after, CODE)), strip(after), 'nothing left to apply');
  assert.equal(after.scores[A], 2, 'one point for the check, one for the empty');
  // pure function: removing and un-checking
  const o = overlay({ items: { a: { id: 'a', title: 'x', checked: true, checkedBy: A }, b: { id: 'b', title: 'y' } }, scores: {}, deposit: { 1: { [A]: 1 } } },
    [{ op: 'check', args: ['a', A, false], ts: 5 }, { op: 'remove', args: ['b'], ts: 6 }, { op: 'depositRemove', args: ['1', A], ts: 7 }]);
  assert.equal(o.items.a.checked, false); assert.ok(!o.items.b); assert.ok(!o.deposit['1']);
});

test('outbox: capped at 200 entries, the oldest are dropped, the warning comes once', () => {
  const storage = mem(); let full = 0;
  const clock = createClock(1_000_000);
  const ob = createOutbox({ storage, now: clock.now, onFull: () => full++ });
  const stub = { mode: 'x', subscribe() {}, add: () => new Promise(() => {}), check: () => new Promise(() => {}) };
  const s = ob.wrap(stub, { state: () => 'busy' });
  for (let i = 0; i < MAX_ENTRIES + 25; i++) s.check(CODE, 'i' + i, A, true);
  assert.equal(ob.entries().length, MAX_ENTRIES);
  assert.equal(stored(storage).length, MAX_ENTRIES);
  assert.equal(ob.entries()[0].args[0], 'i25', 'the oldest were dropped');
  assert.equal(full, 1, 'once');
});

test('outbox: entries older than 24 h are dropped on replay and on load', async () => {
  const storage = mem(), base = localAdapter(mem(), false);
  const one = boot({ storage, base });
  await one.clock.advance(1);
  one.sim.maxConnections(100); await one.clock.advance(20 * SEC);
  await one.store.add(CODE, { id: 'a', title: 'Milch' }, A);
  const old = storage.getItem('kober-outbox');
  // a page that stays open for more than a day: the entry expires at replay
  const two = boot({ storage, base });
  assert.equal(two.outbox.entries().length, 1);
  two.sim.setMode('drop'); await two.clock.advance(MAX_AGE + 60 * SEC);
  two.sim.setMode('ok'); two.conn.wake(); await two.clock.advance(200 * SEC);
  assert.equal(await base.get(CODE, 'items'), null, 'too old: not sent');
  assert.equal(two.outbox.entries().length, 0);
  // on load: the timestamp is old already
  storage.setItem('kober-outbox', JSON.stringify(JSON.parse(old).map(e => ({ ...e, ts: 1 }))));
  assert.equal(createOutbox({ storage, now: () => 1 + MAX_AGE + 1 }).entries().length, 0);
});

test('outbox: invalid or tampered entries are dropped, valid ones are cleaned', () => {
  const storage = mem();
  const ts = 1_000_000;
  storage.setItem('kober-outbox', JSON.stringify([
    { code: CODE, op: 'check', args: ['a', A, true], ts },
    { code: 'bad', op: 'check', args: ['a', A, true], ts },
    { code: CODE, op: 'deleteList', args: [], ts },
    { code: CODE, op: 'check', args: ['a/../x', A, true], ts },
    { code: CODE, op: 'check', args: ['a', 'nospace', true], ts },
    { code: CODE, op: 'check', args: ['a', A, 'yes'], ts },
    { code: CODE, op: 'add', args: [{ id: 'z', title: '   ' }, A], ts },
    { code: CODE, op: 'add', args: [{ id: 'z', title: '<b>Käse</b>'.repeat(30), vgNum: 'x', ean: 'abc', amount: 5000 }, A], ts },
    { code: CODE, op: 'bump', args: [A, 7], ts },
    { code: CODE, op: 'setEan', args: ['a', A, '12', false], ts },
    { code: CODE, op: 'check', args: ['a', A, true], ts: 'yesterday' },
    { code: CODE, op: 'check', args: 'a', ts },
    null, 5, 'x',
  ]));
  const clock = createClock(2_000_000);
  const ob = createOutbox({ storage, now: clock.now });
  assert.deepEqual(ob.entries().map(e => e.op), ['check', 'add']);
  const add = ob.entries()[1].args[0];
  assert.equal(add.title.length, 120); assert.ok(!('vgNum' in add) && !('ean' in add) && !('amount' in add));
  storage.setItem('kober-outbox', '{not json');
  assert.equal(createOutbox({ storage, now: clock.now }).entries().length, 0);
  storage.setItem('kober-outbox', '{"a":1}');
  assert.equal(createOutbox({ storage, now: clock.now }).entries().length, 0);
  // the queueable set is exactly the item and empties operations
  for (const op of ['create', 'exists', 'deleteList', 'importList', 'join', 'renameUser', 'resetScores']) assert.equal(validEntry({ code: CODE, op, args: [], ts: 1 }), null, op);
});

test('outbox: a failing entry is kept for later attempts, the ones behind it still go', async () => {
  const storage = mem(), base = localAdapter(mem(), false);
  const ts = 1_000_000;
  storage.setItem('kober-outbox', JSON.stringify([
    { code: CODE, op: 'add', args: [{ id: 'a', title: 'Milch' }, A], ts },
    { code: CODE, op: 'add', args: [{ id: 'b', title: 'Brot' }, A], ts },
  ]));
  const b = boot({ storage, base });
  b.sim.failNext('update', new Error('permission denied'));
  await b.clock.advance(10 * SEC);
  assert.equal((await base.get(CODE, 'items/b')).title, 'Brot');
  assert.equal(b.outbox.entries().length, 1, 'the failed one is kept for now');
  b.store.flush(CODE); await b.clock.advance(1);
  assert.equal((await base.get(CODE, 'items/a')).title, 'Milch', 'a later attempt works');
  assert.equal(b.outbox.entries().length, 0);
});

test('cache: last live snapshot per list, sanitised, shown on first load while nothing arrived', async () => {
  const storage = mem();
  const snap = { meta: { created: 1 }, items: { a: { id: 'a', title: 'Milch', checked: true, checkedBy: A, checkedAt: 5, addedBy: A, addedAt: 1, vgNum: 12 } }, scores: { [A]: 3 }, deposit: { 1: { [A]: 2 } } };
  assert.ok(saveSnapshot(storage, CODE, snap, 1000));
  assert.ok(storage.getItem('kober-cache:' + CODE));
  const c = loadSnapshot(storage, CODE, 2000);
  assert.equal(c.items.a.title, 'Milch'); assert.equal(c.scores[A], 3); assert.equal(c.deposit['1'][A], 2);
  // the first load with a dead server: nothing arrives, the cache is what there is
  const { clock, sim, conn } = boot({ storage: mem(), base: localAdapter(mem(), false) });
  sim.setMode('drop'); conn.reset();
  const seen = []; sim.subscribe(CODE, v => seen.push(v), conn.onStatus);
  await clock.advance(30 * SEC);
  assert.deepEqual(seen, []); assert.notEqual(conn.state(), 'ok');
  assert.equal(loadSnapshot(storage, CODE, 2000).items.a.title, 'Milch', 'still there for the screen');
  // untrusted: hostile content is cleaned (rendering escapes the rest with esc())
  storage.setItem('kober-cache:ZZZZZZ', JSON.stringify({ ts: 1500, data: { items: { 'x"y': { id: 'x"y', title: 'bad' }, ok: { title: 5 }, fine: { title: '<img src=x onerror=1>', checked: 'yes', amount: 'many' } }, scores: { 'nokey': 1, [A]: -4 }, deposit: { '../x': { [A]: 1 }, 1: { [A]: 'x' } } } }));
  const h = loadSnapshot(storage, 'ZZZZZZ', 2000);
  assert.deepEqual(Object.keys(h.items), ['fine']); assert.equal(h.items.fine.checked, false); assert.equal(h.items.fine.amount, 1);
  assert.deepEqual(h.scores, {}); assert.deepEqual(h.deposit, {});
  storage.setItem('kober-cache:YYYYYY', '{broken'); assert.equal(loadSnapshot(storage, 'YYYYYY'), null);
  assert.equal(loadSnapshot(storage, 'bad code'), null);
  assert.equal(loadSnapshot(storage, CODE, 1000 + 31 * 24 * 3600e3), null, 'old caches are ignored');
  assert.deepEqual(sanitize(null), { items: {}, scores: {}, deposit: {} });
});

test('cache: only the last-used lists are kept, and a huge list is not cached', () => {
  const storage = mem();
  const codes = ['AAAAAA', 'BBBBBB', 'CCCCCC', 'DDDDDD', 'EEEEEE'];
  codes.forEach((c, i) => saveSnapshot(storage, c, { items: {}, scores: {}, deposit: {} }, 1000 + i));
  const have = codes.filter(c => storage.getItem('kober-cache:' + c));
  assert.equal(have.length, KEEP);
  assert.deepEqual(have, codes.slice(-KEEP), 'the most recently written stay');
  const big = { items: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`i${i}`, { id: `i${i}`, title: 'Ein langer Artikelname mit Zusatz ' + i, info: 'x'.repeat(100) }])) };
  assert.ok(JSON.stringify(sanitize(big)).length > MAX_BYTES);
  assert.equal(saveSnapshot(storage, 'EEEEEE', big, 5000), false);
  assert.equal(storage.getItem('kober-cache:EEEEEE'), null, 'an outgrown cache is removed, not kept stale');
  // storage that throws: no cache, no exception
  assert.equal(saveSnapshot({ setItem() { throw new Error('quota'); }, removeItem() {}, length: 0, key: () => null }, CODE, {}, 1), false);
});

test('NS prefix on both new storage keys, and the sim scenario `cut`', () => {
  const o = fs.readFileSync(new URL('../public/outbox.js', import.meta.url), 'utf8');
  const c = fs.readFileSync(new URL('../public/cache.js', import.meta.url), 'utf8');
  assert.ok(/NS \+ 'kober-outbox'/.test(o));
  assert.ok(/NS \+ 'kober-cache:'/.test(c));
  assert.ok(!/localStorage\.|sessionStorage|indexedDB/.test(o + c), 'storage is injected, never reached for globally');
  const sim = createSim(localAdapter(mem(), false));
  assert.equal(applyScenario(sim, 'cut:5:10'), true);
  assert.equal(applyScenario(sim, 'nonsense'), false);
});

test('i18n: the outbox texts exist in both languages with the same placeholders', () => {
  for (const k of ['connPending', 'connScoreLater', 'connCached', 'outboxFull']) assert.ok(STRINGS.en[k] && STRINGS.de[k], k);
  assert.match(STRINGS.en.connPending, /\{n\}/); assert.match(STRINGS.de.connPending, /\{n\}/);
  assert.equal(STRINGS.en.connScoreLater, 'Points are counted when the connection is back.');
  assert.equal(STRINGS.de.outboxFull, 'Zu viele wartende Änderungen; die ältesten wurden verworfen.');
});

test('a restore entry is validated and shows at once in the optimistic view', async () => {
  const { validEntry, overlay } = await import('../public/outbox.js');
  const e = validEntry({ code: 'ABCDEF', op: 'restore', args: [{ id: 'a', title: 'Milch', vgNum: 4711, checked: true, checkedBy: A, addedBy: A, addedAt: 5, checkedAt: 6 }, A], ts: 10 });
  assert.ok(e);
  assert.equal(e.args[0].vgNum, 4711);
  assert.equal(validEntry({ code: 'ABCDEF', op: 'restore', args: [{ id: 'bad id', title: 'x' }, A], ts: 10 }), null);
  const view = overlay({ items: {}, scores: {}, deposit: {} }, [e]);
  assert.equal(view.items.a.checked, true);
  assert.equal(view.items.a.title, 'Milch');
});
