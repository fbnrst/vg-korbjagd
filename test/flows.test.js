import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isIosLike, isStandalone, shouldShowBrowserHint, shouldShowInstallHint, shouldShowAndroidInstall, isAndroid, sanitizeHintSeen, addHintSeen, tooLongNumber, resetPlan, packTicks, sanitizeTicks, pruneTicks, createVgLoader, uploadLocalList, checkoutSections, rankPlaces, computeBadges, classifyScan, TICK_TTL, TICK_MAX } from '../public/flows.js';
import { createStore, localAdapter, userKey } from '../public/store.js';
import { createSim, createClock } from '../public/sim.js';
import { STRINGS } from '../public/i18n.js';

const mem = () => { const m = {}; return { getItem: k => m[k] ?? null, setItem: (k, v) => { m[k] = v; } }; };

test('input bar: only a run of more than 4 digits is too long for a VG number', () => {
  for (const q of ['', '1', '123', '1234', 'Apfel', '12a345', '12345 ']) assert.equal(tooLongNumber(q), false, q);
  for (const q of ['12345', '00073448', '4006381333931']) assert.equal(tooLongNumber(q), true, q);
});

test('reset plan: the options map to the store calls, the ranking only on a shared list', () => {
  assert.deepEqual(resetPlan({ done: true, empties: true }, false), ['clearChecked', 'clearDeposit']);
  assert.deepEqual(resetPlan({ open: true, done: true }, true), ['clearAll']);
  assert.deepEqual(resetPlan({ open: true }, true), ['clearOpen']);
  assert.deepEqual(resetPlan({ scores: true }, true), ['resetScores']);
  assert.deepEqual(resetPlan({ scores: true, empties: true }, false), ['clearDeposit'], 'no ranking on the local list');
  assert.deepEqual(resetPlan({ done: true, empties: true, scores: true }, true), ['clearChecked', 'clearDeposit', 'resetScores']);
  assert.deepEqual(resetPlan({}, true), []);
});

test('reset plan with the ranking: resetScores zeroes every counter and keeps the players', async () => {
  const db = localAdapter(mem(), false), store = createStore(db);
  const code = await store.create();
  const A = userKey('🦊', 'Mia');
  await store.join(code, A);
  await store.add(code, { id: 'a', title: 'Milch' }, A);
  await store.check(code, 'a', A, true);
  assert.equal((await db.get(code, 'scores'))[A], 1);
  for (const op of resetPlan({ scores: true }, true)) await store[op](code);
  assert.deepEqual(await db.get(code, 'scores'), { [A]: 0 });
  assert.ok((await db.get(code, 'items')).a.checked, 'items stay as they are');
});

test('checkout ticks: sanitised on load, per list, 24 h, bounded', () => {
  const now = 1_000_000_000;
  const ok = packTicks('ABC123', ['a1', 'd7', 'x-y_z'], now);
  assert.deepEqual(sanitizeTicks(ok, 'ABC123', now + 1000), ['a1', 'd7', 'x-y_z']);
  assert.deepEqual(sanitizeTicks(ok, 'OTHER1', now + 1000), [], 'dropped when the list code changes');
  assert.deepEqual(sanitizeTicks(ok, 'ABC123', now + TICK_TTL + 1), [], 'dropped after 24 h');
  assert.deepEqual(sanitizeTicks(ok, 'ABC123', now - 10 * 60000), [], 'a time stamp from the future is not trusted');
  for (const junk of [null, undefined, 5, 'x', [], {}, { code: 'ABC123' }, { code: 'ABC123', ts: 'now', keys: [] }, { code: 'ABC123', ts: now, keys: 'a1' }])
    assert.deepEqual(sanitizeTicks(junk, 'ABC123', now), []);
  const dirty = { code: 'ABC123', ts: now, keys: ['ok1', '<b>', 5, null, 'a'.repeat(60), 'ok1', 'with space', '', 'ok2'] };
  assert.deepEqual(sanitizeTicks(dirty, 'ABC123', now), ['ok1', 'ok2']);
  const many = Array.from({ length: TICK_MAX + 50 }, (_, i) => 'k' + i);
  assert.equal(packTicks('L', many, now).keys.length, TICK_MAX);
  assert.equal(sanitizeTicks({ code: 'L', ts: now, keys: many }, 'L', now).length, TICK_MAX);
});

test('checkout ticks: rows that no longer exist are dropped', () => {
  assert.deepEqual(pruneTicks(new Set(['a', 'b', 'd1']), new Set(['b', 'd1', 'zzz'])), ['b', 'd1']);
  assert.deepEqual(pruneTicks([], new Set(['a'])), []);
});

test('VG loader: loading, ready; a failure or 10 s without data is "unreachable"; retry works', async () => {
  const clock = createClock();
  const timers = { setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock) };
  const log = [];
  let calls = 0, answer = new Promise(() => {}); // the first load never answers
  const loader = createVgLoader({ load: () => { calls++; return answer; }, onChange: (s, d) => log.push(s + (d ? ':data' : '')), ...timers });
  loader.start();
  assert.equal(loader.state, 'loading');
  await clock.advance(9000);
  assert.equal(loader.state, 'loading');
  await clock.advance(1500);
  assert.equal(loader.state, 'unreachable');
  loader.start(); // retry while the first load is still running: no second request, shows loading again
  assert.equal(loader.state, 'loading');
  assert.equal(calls, 1);
  await clock.advance(10500);
  assert.equal(loader.state, 'unreachable');
  assert.deepEqual(log, ['loading', 'unreachable', 'loading', 'unreachable']);
});

test('VG loader: a failed load can be retried and a late success wins', async () => {
  const clock = createClock();
  const timers = { setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock) };
  let n = 0, release;
  const loader = createVgLoader({ load: () => ++n === 1 ? Promise.resolve(null) : n === 2 ? Promise.reject(new Error('offline')) : new Promise(r => { release = r; }), ...timers });
  loader.start(); await clock.advance(0);
  assert.equal(loader.state, 'unreachable', 'null (offline, nothing cached)');
  loader.start(); await clock.advance(0);
  assert.equal(loader.state, 'unreachable', 'a rejected load');
  loader.start(); await clock.advance(10500);
  assert.equal(loader.state, 'unreachable', 'slow');
  release({ deposits: [] }); await clock.advance(0);
  assert.equal(loader.state, 'ready');
  assert.deepEqual(loader.data, { deposits: [] });
  loader.start(); assert.equal(loader.state, 'ready', 'start() is a no-op once the data is there');
  assert.equal(n, 3);
});

test('first share: a failed upload leaves the local list untouched and a retry goes through', async () => {
  const local = localAdapter(mem(), false);
  const A = userKey('🦊', 'Mia');
  const localStore = createStore(local);
  await localStore.add('LOCAL', { id: 'm', title: 'Milch', vgNum: 1234 }, A);
  const data = { items: await local.get('LOCAL', 'items'), deposit: (await local.get('LOCAL', 'deposit')) || {} };
  assert.ok(data.items.m);

  const clock = createClock(1_000_000);
  const sim = createSim(localAdapter(mem(), false), { clock });
  const store = createStore(sim, { setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock), timeoutMs: 8000 });
  sim.setMode('refuse');
  await assert.rejects(uploadLocalList(store, data, A));
  assert.deepEqual(await local.get('LOCAL', 'items'), data.items, 'the local list is as before');

  sim.setMode('ok'); await clock.advance(0);
  const code = await uploadLocalList(store, data, A);
  assert.match(code, /^[A-Z0-9]{8}$/);
  assert.equal(Object.values((await sim.get(code, 'items')) || {})[0].title, 'Milch');
  assert.deepEqual(await local.get('LOCAL', 'items'), data.items, 'removing the local copy is the caller\'s job, after startShared');
});

test('new strings exist in both languages; the wording is aligned', () => {
  for (const k of ['resetScores', 'vgUnreachable', 'tryAgain', 'leaveCode', 'joiningList']) {
    assert.ok(STRINGS.en[k] && STRINGS.de[k], k);
  }
  assert.match(STRINGS.en.leaveCode, /\{code\}/); assert.match(STRINGS.de.leaveCode, /\{code\}/);
  assert.match(STRINGS.en.joiningList, /\{code\}/); assert.match(STRINGS.de.joiningList, /\{code\}/);
  assert.equal(STRINGS.en.resetDone, 'Items in the basket'); assert.equal(STRINGS.de.resetDone, 'Artikel im Korb');
  assert.notEqual(STRINGS.en.secDone, STRINGS.en.resetDone);
  assert.ok(!/HTTPS/.test(STRINGS.en.cameraFail + STRINGS.de.cameraFail), 'no technical camera text');
});

test('index.html: the reset dialog has the ranking box (off by default), the share dialog separates the delete button', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<input type="checkbox" id="resetScores">/);
  assert.match(html, /class="dangerZone"[^>]*><button[^>]*id="deleteBtn"/);
  assert.match(html, /\.dangerZone\{[^}]*border-top/);
});

test('browser hint: only on iOS-like devices, in the browser, once per list code', () => {
  const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 };
  const ipad = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 };
  const mac = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 };
  const android = { userAgent: 'Mozilla/5.0 (Linux; Android 14)', platform: 'Linux armv8l', maxTouchPoints: 5 };
  const browser = () => ({ matches: false });
  const installed = q => ({ matches: q === '(display-mode: standalone)' });
  assert.equal(isIosLike(iphone), true);
  assert.equal(isIosLike(ipad), true);
  assert.equal(isIosLike(mac), false);
  assert.equal(isIosLike(android), false);
  assert.equal(isIosLike(null), false);
  assert.equal(isStandalone({ standalone: true }, browser), true);
  assert.equal(isStandalone(iphone, installed), true);
  assert.equal(isStandalone(iphone, browser), false);
  assert.equal(isStandalone(iphone, () => { throw new Error('no'); }), false);
  assert.equal(shouldShowBrowserHint(iphone, browser, '4ALVUE', []), true);
  assert.equal(shouldShowBrowserHint(ipad, browser, '4ALVUE', []), true);
  assert.equal(shouldShowBrowserHint({ ...iphone, standalone: true }, browser, '4ALVUE', []), false);
  assert.equal(shouldShowBrowserHint(iphone, installed, '4ALVUE', []), false);
  assert.equal(shouldShowBrowserHint(mac, browser, '4ALVUE', []), false);
  assert.equal(shouldShowBrowserHint(android, browser, '4ALVUE', []), false);
  assert.equal(shouldShowBrowserHint(iphone, browser, '4ALVUE', ['4ALVUE']), false);
  assert.equal(shouldShowBrowserHint(iphone, browser, '<b>', []), false);
});

test('browser hint: the stored list of seen codes is validated and bounded', () => {
  assert.deepEqual(sanitizeHintSeen('x'), []);
  assert.deepEqual(sanitizeHintSeen(['4ALVUE', 'bad', 7, '<img>']), ['4ALVUE']);
  let s = [];
  for (let i = 0; i < 30; i++) s = addHintSeen(s, 'AAAA' + String(10 + i));
  assert.equal(s.length, 20);
  assert.deepEqual(addHintSeen(['4ALVUE'], '4ALVUE'), ['4ALVUE']);
});

test('install hint: only in an iPhone/iPad browser tab, never in the installed app, never after it was closed', () => {
  const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X)' };
  const mm = standalone => () => ({ matches: standalone });
  assert.equal(shouldShowInstallHint(iphone, mm(false), false), true);
  assert.equal(shouldShowInstallHint(iphone, mm(false), undefined), true);
  assert.equal(shouldShowInstallHint(iphone, mm(true), false), false);
  assert.equal(shouldShowInstallHint({ ...iphone, standalone: true }, mm(false), false), false);
  assert.equal(shouldShowInstallHint(iphone, mm(false), true), false);
  assert.equal(shouldShowInstallHint({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }, mm(false), false), false);
});

test('android install dialog: Android browser tab only, never in the installed app, never after it was closed', () => {
  const android = { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36' };
  const mm = standalone => () => ({ matches: standalone });
  assert.equal(isAndroid(android), true);
  assert.equal(shouldShowAndroidInstall(android, mm(false), false), true);
  assert.equal(shouldShowAndroidInstall(android, mm(true), false), false);
  assert.equal(shouldShowAndroidInstall(android, mm(false), true), false);
  assert.equal(shouldShowAndroidInstall({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X)' }, mm(false), false), false);
  assert.equal(shouldShowAndroidInstall({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }, mm(false), false), false);
});

test('a retried first share fills the list the first attempt created instead of leaving it half-filled', async () => {
  const A = userKey('🦊', 'Mia');
  const db = localAdapter(mem(), false), store = createStore(db);
  let fail = true, creates = 0;
  const remote = { ...store, create: async () => { creates++; return store.create(); }, importList: async (...a) => { if (fail) throw new Error('offline'); return store.importList(...a); } };
  const made = {}, data = { items: { m: { id: 'm', title: 'Milch' } }, deposit: {} };
  await assert.rejects(uploadLocalList(remote, data, A, made));
  assert.match(made.code, /^[A-Z0-9]{8}$/);
  fail = false;
  assert.equal(await uploadLocalList(remote, data, A, made), made.code);
  assert.equal(creates, 1, 'no second list');
  // a code whose list never came up (the create timed out and was lost) is replaced by a new one
  const lost = { code: 'ZZZZZZZZ' };
  const c = await uploadLocalList(remote, data, A, lost);
  assert.notEqual(c, 'ZZZZZZZZ'); assert.equal(creates, 2);
  // a timed-out create hands over its code
  const late = {}, pending = Object.assign(new Error('pending'), { pending: true, listCode: 'K7M2QXAB' });
  await assert.rejects(uploadLocalList({ ...remote, create: async () => { throw pending; } }, data, A, late));
  assert.equal(late.code, 'K7M2QXAB');
});

test('ranking: same points share a place, ties by name, podium 2-1-3 then players without points', () => {
  const r = rankPlaces({ '🐼 Ben': 3, '🦊 Mia': 5, '🦈 Ada': 3, '🤖 Zoe': 0 });
  assert.deepEqual(r.placed.map(x => [x.k, x.place]), [['🦊 Mia', 1], ['🐼 Ben', 2], ['🦈 Ada', 2], ['🤖 Zoe', 4]]); // ties by key (emoji first)
  assert.deepEqual(r.podium.map(x => x.k), ['🐼 Ben', '🦈 Ada', '🦊 Mia', '🤖 Zoe']);
  assert.equal(r.max, 5);
  assert.deepEqual(rankPlaces({}), { placed: [], podium: [], max: 1 });
});

test('checkout rows: items, bakery and empties by title; typed rows move into one block at the end', () => {
  const items = [
    { id: 'b', title: 'Brot', checked: true, vgNum: 120, amount: 1 },
    { id: 'm', title: 'Milch', checked: true, vgNum: 1234, amount: 2, unit: 'Stück' },
    { id: 'a', title: 'Äpfel', checked: true, vgNum: 2001, amount: 500, unit: 'g' },
    { id: 'o', title: 'Offen', checked: false, vgNum: 1111 },
    { id: 'n', title: 'Ohne Nummer', checked: true },
  ];
  const s = checkoutSections(items, [{ id: 3, name: 'Flasche', vgNum: 9003, n: 2 }], new Set(['m']));
  assert.deepEqual(s.items.map(r => r.key), ['a']);
  assert.deepEqual(s.bakery.map(r => r.key), ['b']);
  assert.deepEqual(s.empties.map(r => [r.key, r.amount, r.no]), [['d3', 2, 9003]]);
  assert.deepEqual(s.done.map(r => r.key), ['m']);
  assert.equal(s.items[0].weight, true, 'grams show beside the unit');
  assert.equal(s.done[0].weight, false, 'counted pieces show as "2 ×"');
});

test('scanned codes: VG labels with or without VG data, barcodes, list codes only while joining', () => {
  assert.deepEqual(classifyScan('02073448'), { kind: 'vg', n: 7344 }, 'a shelf label is a VG number even before the VG data loaded');
  assert.deepEqual(classifyScan('VG 123 Äpfel'), { kind: 'vg', n: 123 });
  assert.deepEqual(classifyScan(' 4006040123458 '), { kind: 'ean', ean: '4006040123458' });
  assert.deepEqual(classifyScan('https://example.com/'), { kind: 'unknown' });
  assert.deepEqual(classifyScan('https://x/?list=K7M2QXAB', { join: true }), { kind: 'list', code: 'K7M2QXAB' });
  assert.deepEqual(classifyScan('4006040123458', { join: true }), { kind: 'unknown' });
});

test('computeBadges: empties, basket and first derived from stored data', () => {
  const A = '🦊 Mia', B = '🐼 Ben', C = '🦈 Ada';
  const scores = { [A]: 4, [B]: 2, [C]: 0 };
  const items = {
    a: { checked: true, checkedBy: A, checkedAt: 300 }, b: { checked: true, checkedBy: A, checkedAt: 200 },
    c: { checked: true, checkedBy: A, checkedAt: 500 }, d: { checked: true, checkedBy: B, checkedAt: 100 }, e: { checked: false },
  };
  const deposit = { 1: { [B]: 2, [C]: 1 }, 2: { [B]: 1 } };
  assert.deepEqual(computeBadges({ scores, items, deposit }), { [A]: ['basket'], [B]: ['empties', 'first'] });
});

test('computeBadges: ties share, thresholds apply, nothing for a single player or odd data', () => {
  const A = '🦊 Mia', B = '🐼 Ben';
  assert.deepEqual(computeBadges({ scores: { [A]: 1 }, deposit: { 1: { [A]: 9 } } }), {});
  assert.deepEqual(computeBadges({ scores: { [A]: 1, [B]: 1 }, deposit: { 1: { [A]: 2, [B]: 2 } } }), {}); // below the minimum
  assert.deepEqual(computeBadges({ scores: { [A]: 1, [B]: 1 }, deposit: { 1: { [A]: 3, [B]: 3 } } }), { [A]: ['empties'], [B]: ['empties'] });
  assert.deepEqual(computeBadges({ scores: { [A]: 1, [B]: 1 }, items: { x: { checked: true, checkedBy: '👻 Gone', checkedAt: 1 } }, deposit: { 1: null } }), {});
  assert.deepEqual(computeBadges(), {});
});
