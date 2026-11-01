import test from 'node:test';
import assert from 'node:assert';
import { createStore, localAdapter, userKey, isUserKey, parseListCode } from '../public/store.js';

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

test('new round sets all counters to zero (basket and empties count for nobody), clearing deposit leaves the counters alone', async () => {
  const { s, db } = setup(); const c = await s.create();
  await s.add(c, item('z', 'Tee'), A); await s.check(c, 'z', A, true);
  await s.depositAdd(c, '3', A); await s.depositAdd(c, '3', B);
  assert.deepEqual(await db.get(c, 'scores'), { [A]: 2, [B]: 1 });
  await s.resetScores(c);                                            // new round: zero for everyone, nothing counted from the basket
  assert.deepEqual(await db.get(c, 'scores'), { [A]: 0, [B]: 0 });
  await s.clearDeposit(c);
  assert.equal(await db.get(c, 'deposit'), null);
  assert.deepEqual(await db.get(c, 'scores'), { [A]: 0, [B]: 0 });   // clearing the empties does not touch the counters
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

test('activity stamp: set on creation, refreshed by changes at most once per hour', async () => {
  const { s, db } = setup();
  const realNow = Date.now;
  try {
    const c = await s.create();
    const created = await db.get(c, 'activity');
    assert.ok(created > 0);
    await s.add(c, item('t1', 'Tea'), A);                           // within the hour: no new write
    assert.equal(await db.get(c, 'activity'), created);
    Date.now = () => created + 2 * 3600e3;
    await s.add(c, item('t2', 'Coffee'), A);                        // two hours later: stamp is refreshed
    assert.equal(await db.get(c, 'activity'), created + 2 * 3600e3);
  } finally { Date.now = realNow; }
});

test('deleteList removes the whole list', async () => {
  const { s, db } = setup(); const c = await s.create();
  await s.add(c, item('d1', 'Milk'), A); await s.depositAdd(c, '1', A);
  assert.equal(await s.exists(c), true);
  await s.deleteList(c);
  assert.equal(await s.exists(c), false);
  assert.equal(await db.get(c, 'items'), null);
  assert.equal(await db.get(c, 'scores'), null);
});

test('clearAll removes all items but keeps points and empties; clearChecked keeps open items', async () => {
  const { s, db } = setup(); const c = await s.create();
  await s.add(c, item('c1', 'Milk'), A); await s.add(c, item('c2', 'Bread'), A);
  await s.check(c, 'c1', A, true); await s.depositAdd(c, '1', A);
  await s.clearChecked(c);
  assert.deepEqual(Object.keys(await db.get(c, 'items')), ['c2']);
  await s.clearAll(c);
  assert.equal(await db.get(c, 'items'), null);
  assert.equal((await db.get(c, 'scores'))[A], 2);                  // item point + empties point stay
  assert.equal((await db.get(c, 'deposit'))['1'][A], 1);            // empties are cleared separately
  await s.clearDeposit(c);
  assert.equal(await db.get(c, 'deposit'), null);
});

test('the VG number of an item can be added, changed and removed without touching the basket state', async () => {
  const { s, db } = setup(); const c = await s.create();
  await s.add(c, item('n1', 'Cabbage'), A);
  await s.setNum(c, 'n1', A, 4711, false);                         // add: not checked, no point
  let it = await db.get(c, 'items/n1');
  assert.equal(it.vgNum, 4711); assert.equal(it.checked, false);
  assert.equal((await db.get(c, 'scores'))?.[A] ?? 0, 0);
  await s.check(c, 'n1', A, true);
  await s.setNum(c, 'n1', A, 4712, false);                         // change on a checked item: stays checked, no extra point
  it = await db.get(c, 'items/n1');
  assert.equal(it.vgNum, 4712); assert.equal(it.checked, true);
  assert.equal((await db.get(c, 'scores'))[A], 1);
  await s.setNum(c, 'n1', A, null, false);                         // empty field: number removed
  assert.equal((await db.get(c, 'items/n1')).vgNum ?? null, null);
  await s.setNum(c, 'n1', A, 'abc', false);                        // garbage is ignored, no number
  assert.equal((await db.get(c, 'items/n1')).vgNum ?? null, null);
});

test('setEan remembers a scanned barcode on an item and can check it off', async () => {
  const { s, db } = setup(); const c = await s.create();
  await s.add(c, item('e1', 'Oat drink'), A);
  await s.setEan(c, 'e1', A, '4056489123456', false);
  let it = await db.get(c, 'items/e1');
  assert.equal(it.ean, '4056489123456'); assert.equal(it.checked, false);
  await s.setEan(c, 'e1', A, '4056489123456', true);
  it = await db.get(c, 'items/e1');
  assert.equal(it.checked, true); assert.equal((await db.get(c, 'scores'))[A], 1);
  await s.setEan(c, 'e1', A, 'abc', false);                          // invalid codes are ignored
  assert.equal((await db.get(c, 'items/e1')).ean, '4056489123456');
});

test('after a new round old items score nothing and never push a counter below zero', async () => {
  const { s, db } = setup(); const c = await s.create();
  await s.add(c, item('o1', 'Milk'), A); await s.add(c, item('o2', 'Bread'), B);
  await s.check(c, 'o1', A, true); await s.check(c, 'o2', B, true);
  await s.resetScores(c);
  assert.deepEqual(await db.get(c, 'scores'), { [A]: 0, [B]: 0 });  // the two items in the basket are not counted
  await s.check(c, 'o1', B, false);                                  // taking an old item out: A stays at 0, not -1
  await s.remove(c, 'o2');                                           // deleting an old checked item: same
  assert.deepEqual(await db.get(c, 'scores'), { [A]: 0, [B]: 0 });
  await s.check(c, 'o1', B, true);                                   // new points only for new actions
  assert.deepEqual(await db.get(c, 'scores'), { [A]: 0, [B]: 1 });
});

test('parseListCode takes a typed code or the link of a shared list and nothing else', () => {
  assert.equal(parseListCode('k7m2qx'), 'K7M2QX');
  assert.equal(parseListCode('  K7M2QX '), 'K7M2QX');
  assert.equal(parseListCode('https://fbnrst.github.io/kober/?list=ab12cd'), 'AB12CD');
  for (const bad of ['', 'K7M2Q', 'K7M2QXX', 'K7 M2Q', 'https://example.com/', 'VG 4455', '4455', null, undefined]) assert.equal(parseListCode(bad), null, String(bad));
});

test('renameUser moves points, empties and marks to the new name and leaves others alone', async () => {
  const { db, s } = setup();
  const code = await s.create();
  await s.join(code, A); await s.join(code, B);
  await s.add(code, item('x1', 'Milch'), A); await s.check(code, 'x1', A, true);
  await s.add(code, item('x2', 'Brot'), B); await s.check(code, 'x2', B, true);
  await s.depositAdd(code, '1', A); await s.depositAdd(code, '1', A); await s.depositAdd(code, '3', B);
  const C = userKey('🐯', 'Mia Neu');
  await s.renameUser(code, A, C);
  const list = await db.get(code, '');
  assert.equal(list.scores[A], undefined);
  assert.equal(list.scores[C], 3);            // 1 item + 2 pieces
  assert.equal(list.scores[B], 2);            // unchanged
  assert.equal(list.deposit['1'][C], 2); assert.equal(list.deposit['1'][A], undefined); assert.equal(list.deposit['3'][B], 1);
  assert.equal(list.items.x1.checkedBy, C); assert.equal(list.items.x1.addedBy, C);
  assert.equal(list.items.x2.checkedBy, B);
  await s.renameUser(code, C, C); await s.renameUser(code, 'bad key <', C);   // same or invalid key: nothing happens
  assert.equal((await db.get(code, 'scores'))[C], 3);
  const D = userKey('🦊', 'Neu'), E = userKey('🦊', 'Neuer');
  await s.renameUser(code, D, E);                                             // no points yet: the new name joins with 0
  assert.equal((await db.get(code, 'scores'))[E], 0);
});
