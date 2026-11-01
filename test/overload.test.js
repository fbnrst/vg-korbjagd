import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { createConn, createBackoff, backoffDelay, backoffCeiling, shouldForgetList } from '../public/conn.js';
import { createStore, localAdapter, userKey, isPending, PendingError } from '../public/store.js';
import { createSim, createClock } from '../public/sim.js';
import { STRINGS, STATIC } from '../public/i18n.js';

const mem = () => { const m = {}; return { getItem: k => m[k] ?? null, setItem: (k, v) => { m[k] = v; } }; };
const A = userKey('🦊', 'Mia');
const SEC = 1000;

// A conn on a manual clock, with a fixed random number so the backoff is predictable
const setupConn = (random = () => 0.5) => {
  const clock = createClock(1_000_000);
  const conn = createConn({ now: clock.now, setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock), random });
  const log = []; conn.subscribe((s, prev) => log.push(`${prev}>${s}`));
  return { clock, conn, log };
};
// Store + sim + conn wired like the app does it
const setupStack = (opts = {}) => {
  const { clock, conn, log } = setupConn(opts.random);
  const base = localAdapter(mem(), false);
  const sim = createSim(base, { clock });
  const timers = { setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock) };
  const store = createStore(sim, { ...timers, timeoutMs: 8 * SEC, onResult: conn.opResult, conn });
  conn.attach(sim);
  return { clock, conn, log, base, sim, store };
};

test('conn: connecting, ok, and a disconnect only counts after 3 s (hysteresis)', async () => {
  const { clock, conn } = setupConn();
  assert.equal(conn.state(), 'connecting');
  conn.onStatus(true);
  assert.equal(conn.state(), 'ok');
  conn.onStatus(false);
  await clock.advance(2900);
  assert.equal(conn.state(), 'ok');
  await clock.advance(100);
  assert.equal(conn.state(), 'degraded');
  conn.onStatus(true);
  await clock.advance(4900);
  assert.equal(conn.state(), 'degraded', 'back to ok only after 5 s of stable connection');
  await clock.advance(100);
  assert.equal(conn.state(), 'ok');
});

test('conn: a short disconnect inside the grace period never shows', async () => {
  const { clock, conn, log } = setupConn();
  conn.onStatus(true);
  conn.onStatus(false); await clock.advance(1500); conn.onStatus(true);
  await clock.advance(20 * SEC);
  assert.equal(conn.state(), 'ok');
  assert.deepEqual(log, ['connecting>ok']);
});

test('conn: never connected: connecting, then degraded after 3 s, busy after 15 s', async () => {
  const { clock, conn } = setupConn();
  conn.onStatus(false);
  await clock.advance(2900); assert.equal(conn.state(), 'connecting');
  await clock.advance(200); assert.equal(conn.state(), 'degraded');
  await clock.advance(11 * SEC); assert.equal(conn.state(), 'degraded');
  await clock.advance(1 * SEC); assert.equal(conn.state(), 'busy');
});

test('conn: flapping (3 drops in 60 s) is degraded even though each outage is short, and it decays', async () => {
  const { clock, conn } = setupConn();
  conn.onStatus(true);
  for (let i = 0; i < 3; i++) { await clock.advance(10 * SEC); conn.onStatus(false); await clock.advance(1 * SEC); conn.onStatus(true); }
  assert.equal(conn.state(), 'degraded');
  await clock.advance(70 * SEC);
  assert.equal(conn.state(), 'ok');
});

test('conn: writes timing out make it degraded, a finished write clears it', async () => {
  const { clock, conn } = setupConn();
  conn.onStatus(true);
  await clock.advance(6 * SEC);
  conn.opResult(false);
  assert.equal(conn.state(), 'degraded');
  conn.opResult(true);
  assert.equal(conn.state(), 'ok');
  conn.opResult(false);
  await clock.advance(31 * SEC); // nothing more happened: the failure ages out
  assert.equal(conn.state(), 'ok');
});

test('conn: connect-then-drop within 2 s, twice, is the connection-limit signature (busy), stable connection recovers', async () => {
  const { clock, conn } = setupConn();
  conn.onStatus(true); await clock.advance(800); conn.onStatus(false); // accepted, dropped
  assert.notEqual(conn.state(), 'busy');
  await clock.advance(1000); conn.onStatus(true); await clock.advance(800); conn.onStatus(false);
  assert.equal(conn.state(), 'busy');
  await clock.advance(1000); conn.onStatus(true);
  await clock.advance(4900); assert.equal(conn.state(), 'busy');
  await clock.advance(100); assert.equal(conn.state(), 'ok');
});

test('backoff: exponential ceiling 5/10/20/40 s capped at 120 s, full jitter, never zero, reset after success', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(backoffCeiling), [5000, 10000, 20000, 40000, 80000, 120000, 120000]);
  for (let n = 0; n < 12; n++) {
    for (const r of [0, 0.0001, 0.5, 0.999999]) {
      const d = backoffDelay(n, () => r);
      assert.ok(d >= 1000, `delay ${d} must never be zero`);
      assert.ok(d <= backoffCeiling(n) && d <= 120000);
    }
    assert.ok(backoffDelay(n, () => 0.999999) >= backoffDelay(n, () => 0.5));
  }
  assert.ok(backoffDelay(5, () => 0.999999) > 100000, 'near the 120 s cap');
  const b = createBackoff(() => 0.999999);
  const seq = [b.next(), b.next(), b.next(), b.next()];
  assert.ok(seq[0] < seq[1] && seq[1] < seq[2] && seq[2] < seq[3]);
  b.reset();
  assert.equal(b.next(), seq[0]);
  let jitter = 0; const c = createBackoff(() => (jitter += 0.37) % 1);
  assert.notEqual(c.next(), c.next());
});

test('busy detection from the connection limit; deliberate reconnects follow the backoff, no extra network calls', async () => {
  const { clock, conn, sim } = setupStack({ random: () => 0.5 });
  const connects = []; const realConnect = sim.connect.bind(sim);
  sim.connect = () => { connects.push(clock.now()); realConnect(); };
  conn.attach(sim);
  sim.maxConnections(100); // all slots taken by other clients
  const seen = [];
  sim.subscribe('ABCDEF', v => seen.push(v), conn.onStatus);
  await clock.advance(10 * SEC);
  assert.equal(conn.state(), 'busy');
  assert.equal(sim.online(), false, 'while busy the client has switched itself off');
  const t0 = clock.now();
  await clock.advance(600 * SEC);
  assert.equal(conn.state(), 'busy');
  assert.ok(connects.length >= 2 && connects.length <= 14, `reconnect attempts: ${connects.length}`);
  const gaps = connects.slice(1).map((t, i) => t - connects[i]);
  assert.ok(gaps.every(g => g >= 15 * SEC + 1000), 'every attempt gets its window plus a pause');
  assert.ok(gaps[gaps.length - 1] > gaps[0], 'the pauses grow');
  assert.equal(sim.callCount(), 0, 'no per-retry get/exists calls');
  assert.equal(seen.length, 0, 'no snapshot arrived');
  // the server frees a slot: the next attempt gets through, and after 5 s of stability everything is ok again
  sim.releaseOthers(1);
  await clock.advance(400 * SEC);
  assert.equal(conn.state(), 'ok');
  assert.ok(sim.online() && seen.length >= 1);
  assert.ok(t0 > 0);
});

test('retries pause while the tab is hidden and one immediate attempt follows when it is visible again', async () => {
  const { clock, conn, sim } = setupStack({ random: () => 0.5 });
  let connects = 0; const realConnect = sim.connect.bind(sim); sim.connect = () => { connects++; realConnect(); };
  conn.attach(sim);
  sim.maxConnections(100);
  sim.subscribe('ABCDEF', () => {}, conn.onStatus);
  await clock.advance(3 * SEC);
  assert.equal(conn.state(), 'busy');
  conn.setHidden(true);
  connects = 0;
  await clock.advance(900 * SEC);
  assert.equal(connects, 0, 'no attempt while hidden');
  sim.releaseOthers(1);
  conn.setHidden(false); // visible again: immediately, no waiting for the backoff
  assert.equal(connects, 1);
  await clock.advance(6 * SEC);
  assert.equal(conn.state(), 'ok');
});

test('write timeout: the operation stays pending, the state turns degraded, nothing throws, and the write finishes later', async () => {
  const { clock, conn, sim, store, base } = setupStack();
  sim.subscribe('ABCDEF', () => {}, conn.onStatus);
  await clock.advance(1);
  assert.equal(conn.state(), 'ok');
  sim.setMode('blackhole'); // looks connected, nothing gets through
  const p = store.add('ABCDEF', { id: 'a', title: 'Milch' }, A);
  const outcome = p.then(() => 'done', e => e);
  await clock.advance(7900);
  assert.equal(conn.state(), 'ok');
  await clock.advance(200);
  const err = await outcome;
  assert.ok(err instanceof PendingError && isPending(err), 'typed pending error');
  assert.equal(conn.state(), 'degraded', 'reported as degraded, not as a failure');
  assert.equal(await base.get('ABCDEF', 'items'), null, 'not applied yet');
  sim.setMode('ok'); // connection works again: the queued write goes through
  await clock.advance(6 * SEC);
  assert.equal((await base.get('ABCDEF', 'items/a')).title, 'Milch');
  assert.equal(conn.state(), 'ok');
});

test('check and its point: the connection dies between the item transaction and the bump, no point is lost', async () => {
  const { clock, conn, sim, store, base } = setupStack();
  sim.subscribe('ABCDEF', () => {}, conn.onStatus);
  await store.add('ABCDEF', { id: 'a', title: 'Milch' }, A);
  sim.dropAfter('update');
  const outcome = store.check('ABCDEF', 'a', A, true).then(() => 'done', e => e);
  await clock.advance(8100);
  assert.ok(isPending(await outcome), 'the bump hangs: typed pending error');
  assert.equal((await base.get('ABCDEF', 'items/a')).checked, true);
  assert.equal(await base.get('ABCDEF', 'scores'), null, 'the point waits in the queue');
  sim.setMode('ok');
  await clock.advance(6 * SEC);
  assert.equal((await base.get('ABCDEF', 'scores'))[A], 1, 'the queued bump arrives with the connection');
});

test('check and its point: the item transaction times out and commits late, the point follows exactly once', async () => {
  const { clock, conn, sim, store, base } = setupStack();
  sim.subscribe('ABCDEF', () => {}, conn.onStatus);
  await store.add('ABCDEF', { id: 'a', title: 'Milch' }, A);
  sim.setMode('blackhole');
  const outcome = store.check('ABCDEF', 'a', A, true).then(() => 'done', e => e);
  await clock.advance(8100);
  assert.ok(isPending(await outcome));
  sim.setMode('ok');
  await clock.advance(6 * SEC);
  assert.equal((await base.get('ABCDEF', 'items/a')).checked, true);
  assert.equal((await base.get('ABCDEF', 'scores'))[A], 1);
  // un-checking later takes it back once
  await store.check('ABCDEF', 'a', A, false);
  assert.equal((await base.get('ABCDEF', 'scores'))[A], 0);
});

test('check and its point: a single failed bump is retried', async () => {
  const { sim, store, base } = setupStack();
  await store.add('ABCDEF', { id: 'a', title: 'Milch' }, A);
  // calls so far: add = update; check = update (item), update (bump)
  await store.check('ABCDEF', 'a', A, true);
  assert.equal((await base.get('ABCDEF', 'scores'))[A], 1);
  await store.add('ABCDEF', { id: 'b', title: 'Brot' }, A);
  // let the item transaction pass, then fail the bump once
  const real = sim.update; let n = 0;
  sim.update = (...a) => (++n === 2 ? Promise.reject(new Error('transient')) : real(...a));
  const guarded = createStore(sim, { onResult() {} });
  await guarded.check('ABCDEF', 'b', A, true);
  assert.equal((await base.get('ABCDEF', 'scores'))[A], 2);
});

test('first load: no snapshot arrives, the shared list is never forgotten, and an empty snapshot only counts on a healthy connection', async () => {
  const { clock, conn, sim, base } = setupStack();
  await base.set('ABCDEF', 'meta', { created: 1 });
  sim.setMode('drop');
  const seen = [];
  conn.reset();
  sim.subscribe('ABCDEF', v => seen.push(v), conn.onStatus);
  await clock.advance(60 * SEC);
  assert.deepEqual(seen, [], 'nothing arrived');
  assert.notEqual(conn.state(), 'ok');
  assert.equal(shouldForgetList(null, conn.state()), false);
  assert.equal(shouldForgetList(null, 'connecting'), false);
  assert.equal(shouldForgetList(null, 'busy'), false);
  assert.equal(shouldForgetList(null, 'degraded'), false);
  assert.equal(shouldForgetList({ items: {} }, 'ok'), true, 'a live snapshot without meta: the list is gone');
  assert.equal(shouldForgetList({ meta: { created: 1 } }, 'ok'), false);
  assert.equal(shouldForgetList(null, 'ok'), true);
  assert.equal(conn.state(), 'busy');
  sim.setMode('ok'); // the data arrives later (the next attempt, here: the tab becomes visible)
  conn.wake();
  await clock.advance(6 * SEC);
  assert.ok(seen.length >= 1 && seen[0].meta);
  assert.equal(conn.state(), 'ok');
});

test('the local adapter reports "connected" before the first snapshot', async () => {
  const db = localAdapter(mem(), false); const order = [];
  db.subscribe('LOCAL', () => order.push('data'), () => order.push('status'));
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(order, ['status', 'data']);
});

test('the hourly activity stamp is skipped while the connection is not ok', async () => {
  const base = localAdapter(mem(), false), sim = createSim(base);
  let state = 'degraded';
  const store = createStore(sim, { conn: { state: () => state } });
  await store.add('ABCDEF', { id: 'a', title: 'Milch' }, A);
  assert.equal(sim.calls.filter(c => c.op === 'set' && c.path === 'activity').length, 0);
  state = 'ok';
  await store.add('ABCDEF', { id: 'b', title: 'Brot' }, A);
  assert.equal(sim.calls.filter(c => c.op === 'set' && c.path === 'activity').length, 1);
});

test('sim knobs: failNext, delay, flap, call log', async () => {
  const clock = createClock();
  const sim = createSim(localAdapter(mem(), false), { clock });
  sim.failNext('get', new Error('boom'));
  await assert.rejects(sim.get('X', ''), /boom/);
  assert.equal(await sim.get('X', ''), null);
  sim.delay('get', 500);
  let done = false; sim.get('X', '').then(() => { done = true; });
  await clock.advance(499); assert.equal(done, false);
  await clock.advance(2); assert.equal(done, true);
  sim.delay('get', 0);
  const seen = []; sim.subscribe('X', () => {}, on => seen.push(on));
  sim.flap(1000);
  await clock.advance(3500);
  assert.deepEqual(seen.slice(0, 1), [true]);
  assert.ok(seen.includes(false) && seen.filter(Boolean).length >= 2, 'the connection comes and goes');
  sim.flap(0);
  assert.equal(sim.online(), true);
  assert.deepEqual(sim.calls.map(c => c.op), ['get', 'get', 'get']);
});

test('i18n: the new connection texts exist in both languages, the offline chip texts are gone', () => {
  for (const k of ['connBusy', 'connDegraded', 'connRestored', 'connLoadingList', 'connUseLocal', 'noDbBusy']) {
    assert.ok(STRINGS.en[k] && STRINGS.de[k], `missing ${k}`);
  }
  assert.ok(!('offline' in STRINGS.en) && !('offlineHint' in STRINGS.de));
  assert.ok(!STATIC.some(([sel]) => sel === '#offline'));
});

test('every browser storage key and cache uses the NS prefix', () => {
  for (const f of fs.readdirSync(new URL('../public/', import.meta.url)).filter(n => n.endsWith('.js'))) {
    const src = fs.readFileSync(new URL('../public/' + f, import.meta.url), 'utf8');
    for (const m of src.matchAll(/(?:get|set|remove)Item\(\s*([^,)]*)/g)) {
      const arg = m[1].trim();
      assert.ok(!/^['"`]/.test(arg), `${f}: storage key must not be a bare literal: ${arg}`);
    }
    if (['conn.js', 'sim.js'].includes(f)) assert.ok(!/localStorage|sessionStorage|indexedDB|caches\./.test(src), `${f} must not touch browser storage`);
  }
});
