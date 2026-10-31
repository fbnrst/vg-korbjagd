import test from 'node:test';
import assert from 'node:assert';
import { createStore, localAdapter, userKey, isUserKey } from '../public/store.js';

const mem = () => { const m = {}; return { getItem: k => m[k] ?? null, setItem: (k, v) => { m[k] = v; } }; };
const setup = () => { const db = localAdapter(mem(), false); return { db, s: createStore(db) }; };
const A = userKey('🦊', 'Mia'), B = userKey('🐼', 'Ben');
const item = (id, title, extra = {}) => ({ id, title, ...extra });

test('create list, existence check', async () => {
  const { s } = setup();
  const code = await s.create();
  assert.match(code, /^[A-Z0-9]{6}$/);
  assert.equal(await s.exists(code), true);
  assert.equal(await s.exists('ZZZZZZ'), false);
});

test('checking off scores points, undoing deducts from the original checker', async () => {
  const { s, db } = setup(); const c = await s.create();
  await s.add(c, item('a', 'Milch'), A); await s.add(c, item('b', 'Brot'), B);
  await s.check(c, 'a', A, true);
  await s.setNum(c, 'b', B, 4711, true);
  const st = await db.get(c, '');
  assert.equal(st.items.a.checkedBy, A);
  assert.equal(st.items.b.vgNum, 4711);
  assert.deepEqual(st.scores, { [A]: 1, [B]: 1 });
  await s.check(c, 'a', B, false);
  assert.equal((await db.get(c, 'scores'))[A], 0);
});

test('add and check are idempotent', async () => {
  const { s, db } = setup(); const c = await s.create();
  await s.add(c, item('x', 'Apfel'), A); await s.add(c, item('x', 'Birne'), B);
  await s.check(c, 'x', A, true); await s.check(c, 'x', B, true);
  const st = await db.get(c, '');
  assert.equal(Object.keys(st.items).length, 1);
  assert.equal(st.items.x.title, 'Apfel');
  assert.equal(st.items.x.checkedBy, A);
  assert.equal(st.scores[A], 1);
  assert.equal(st.scores[B] ?? 0, 0);
});

test('deleting a checked item takes the point back', async () => {
  const { s, db } = setup(); const c = await s.create();
  await s.add(c, item('y', 'Käse'), A); await s.check(c, 'y', A, true);
  await s.remove(c, 'y');
  assert.equal((await db.get(c, 'scores'))[A], 0);
  assert.equal(await db.get(c, 'items/y'), null);
});

test('clearing checked items keeps points, new round resets them', async () => {
  const { s, db } = setup(); const c = await s.create();
  await s.add(c, item('p', 'Tee'), A); await s.add(c, item('q', 'Kaffee'), B);
  await s.check(c, 'p', A, true); await s.check(c, 'q', B, true);
  await s.clearChecked(c);
  assert.equal(await db.get(c, 'items'), null);
  assert.equal((await db.get(c, 'scores'))[A], 1);
  await s.resetScores(c);
  assert.deepEqual(await db.get(c, 'scores'), { [A]: 0, [B]: 0 });
});

test('EAN valid/invalid, user key without Firebase special characters', async () => {
  const { s, db } = setup(); const c = await s.create();
  await s.add(c, item('e1', 'Hafermilch', { ean: '4056489123456' }), A);
  await s.add(c, item('e2', 'Brot', { ean: 'abc' }), A);
  assert.equal((await db.get(c, 'items/e1')).ean, '4056489123456');
  assert.equal((await db.get(c, 'items/e2')).ean, null);
  assert.equal(userKey('🦊', 'a.b/c#d'), '🦊 a_b_c_d');
});

test('adding gives no points, only checking off (or entering a number) counts', async () => {
  const { s, db } = setup(); const c = await s.create();
  await s.join(c, A);
  await s.add(c, item('n1', 'Milch'), A);
  await s.add(c, item('n2', 'Brot', { vgNum: 4711 }), A);
  assert.equal((await db.get(c, 'scores'))[A], 0);
  await s.check(c, 'n1', A, true);
  assert.equal((await db.get(c, 'scores'))[A], 1);
  await s.setNum(c, 'n2', A, 4711, true);
  assert.equal((await db.get(c, 'scores'))[A], 2);
});

test('deposit: each piece gives a point, removing deducts from the contributor', async () => {
  const { s, db } = setup(); const c = await s.create();
  await s.depositAdd(c, '1', A); await s.depositAdd(c, '1', A); await s.depositAdd(c, '2', B);
  assert.deepEqual(await db.get(c, 'scores'), { [A]: 2, [B]: 1 });
  await s.depositRemove(c, '1', A);                        // own piece
  assert.equal((await db.get(c, 'scores'))[A], 1);
  await s.depositRemove(c, '2', A);                        // A has nothing there: B's piece goes away
  assert.deepEqual(await db.get(c, 'scores'), { [A]: 1, [B]: 0 });
  assert.equal(await db.get(c, 'deposit/2'), null);
  await s.depositRemove(c, '2', A);                        // empty: nothing happens
  assert.equal((await db.get(c, 'scores'))[A], 1);
});

test('new round counts deposit too, clearing deposit keeps points', async () => {
  const { s, db } = setup(); const c = await s.create();
  await s.add(c, item('z', 'Tee'), A); await s.check(c, 'z', A, true);
  await s.depositAdd(c, '3', A); await s.depositAdd(c, '3', B);
  await s.resetScores(c);
  assert.deepEqual(await db.get(c, 'scores'), { [A]: 2, [B]: 1 });
  await s.clearDeposit(c);
  assert.equal(await db.get(c, 'deposit'), null);
  assert.equal((await db.get(c, 'scores'))[A], 2);
});

test('validation: garbage input is discarded or neutralised', async () => {
  const { s, db } = setup(); const c = await s.create();
  assert.equal(await s.add(c, item('', 'x'), A), null);
  assert.equal(await s.add(c, item('"><img onerror=x>', 'x'), A), null);
  assert.equal(await s.add(c, item('ok', 'x'), '<svg/onload=alert(1)> x'), null);
  await s.add(c, item('t', 'T'.repeat(500), { amount: 1e9, unit: 'u'.repeat(99), info: 'i'.repeat(999), ean: 'abc', vgNum: 'NaN' }), A);
  const it = (await db.get(c, 'items/t'));
  assert.equal(it.title.length, 120); assert.equal(it.amount, 999); assert.equal(it.unit.length, 20);
  assert.equal(it.info.length, 200); assert.equal(it.ean, null); assert.equal(it.vgNum, null);
  await s.setNum(c, 't', A, '12.4abc', false);
  assert.equal((await db.get(c, 'items/t')).vgNum, null);
  await s.depositAdd(c, '<x>', A);
  assert.equal(await db.get(c, 'deposit'), null);
});

test('userKey: HTML and Firebase special characters replaced, length limited, valid key', () => {
  const k = userKey('<b>', 'A&B"C\'.$#[]/ ' + 'x'.repeat(99));
  assert.ok(isUserKey(k), k);
  assert.ok(!/[<>&"'`.$#\[\]\/]/.test(k));
  assert.ok(isUserKey(userKey('', '')));
  assert.ok(!isUserKey('<img onerror=1> x') && !isUserKey('nospace'));
});

test('moving a local list to a shared one keeps items but awards no points', async () => {
  const { s, db } = setup();
  const local = await s.create();                                   // stands in for the local list
  await s.add(local, item('l1', 'Milk', { vgNum: 1076 }), A);
  await s.add(local, item('l2', 'Bread'), A);
  await s.check(local, 'l1', A, true);
  await s.depositAdd(local, '1', A); await s.depositAdd(local, '1', A);
  const data = { items: await db.get(local, 'items'), deposit: await db.get(local, 'deposit') };

  const shared = await s.create();
  await s.importList(shared, data, B);
  const st = await db.get(shared, '');
  assert.equal(st.items.l1.checked, true);
  assert.equal(st.items.l1.checkedBy, B);                           // now belongs to the sharing user
  assert.equal(st.items.l1.vgNum, 1076);
  assert.equal(st.items.l2.checked, false);
  assert.equal(st.items.l2.addedBy, B);
  assert.equal(st.deposit['1'][B], 2);
  assert.deepEqual(st.scores, { [B]: 0 });                          // the game starts at zero
});

test('importList ignores broken items and invalid users', async () => {
  const { s, db } = setup(); const c = await s.create();
  await s.importList(c, { items: { x: { id: 'bad id!', title: 'X' }, y: { id: 'y', title: '  ' }, z: null } }, B);
  assert.equal(await db.get(c, 'items'), null);
  await s.importList(c, { items: { ok: { id: 'ok', title: 'Fine' } } }, 'nokey');
  assert.equal(await db.get(c, 'items'), null);
});
