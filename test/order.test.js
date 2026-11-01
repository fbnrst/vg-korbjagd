import test from 'node:test';
import assert from 'node:assert';
import { planMove, sortOpen, effPos, toPos, MIN_GAP } from '../public/order.js';
import { createStore, localAdapter, userKey } from '../public/store.js';
import { createOutbox, validEntry, overlay } from '../public/outbox.js';

const mem = () => { const m = {}; return { getItem: k => m[k] ?? null, setItem: (k, v) => { m[k] = v; } }; };
const A = userKey('🦊', 'Mia');
const it = (id, addedAt, extra = {}) => ({ id, title: id, addedAt, checked: false, ...extra });
const ids = list => sortOpen(list).map(i => i.id);
const apply = (list, plan) => { const m = new Map(plan.renumber || [[plan.id, plan.pos]]); return list.map(i => (m.has(i.id) ? { ...i, pos: m.get(i.id) } : i)); };

test('never moved items keep the old order (oldest first); a new item lands at the end, also after ranks were written', () => {
  const l = [it('c', 3000), it('a', 1000), it('b', 2000)];
  assert.deepEqual(ids(l), ['a', 'b', 'c']);
  const moved = apply(l, { ...planMove(l, 'c', -1), id: 'c' });
  assert.deepEqual(ids(moved), ['a', 'c', 'b']);
  assert.deepEqual(ids([...moved, it('d', Date.now())]), ['a', 'c', 'b', 'd']);
});

test('planMove: up, down, edges, and the same-position tie is stable', () => {
  const l = [it('a', 1000), it('b', 2000), it('c', 3000)];
  assert.equal(planMove(l, 'a', -1), null);
  assert.equal(planMove(l, 'c', 1), null);
  assert.equal(planMove(l, 'zz', 1), null);
  const up = planMove(l, 'b', -1); assert.deepEqual(ids(apply(l, { ...up, id: 'b' })), ['b', 'a', 'c']);
  const dn = planMove(l, 'a', 1); assert.deepEqual(ids(apply(l, { ...dn, id: 'a' })), ['b', 'a', 'c']);
  const first = [it('a', 1, { pos: 1 }), it('b', 2, { pos: 2 })];
  assert.deepEqual(ids(apply(first, { ...planMove(first, 'b', -1), id: 'b' })), ['b', 'a']);
  assert.deepEqual(ids([it('b', 5, { pos: 1 }), it('a', 5, { pos: 1 })]), ['a', 'b'], 'ties by age then id');
});

test('planMove inside a section keeps the other sections where they are', () => {
  const l = [it('a1', 1), it('b1', 2), it('a2', 3), it('b2', 4), it('a3', 5)];
  const visible = l.filter(i => i.id[0] === 'a');
  const p = planMove(l, 'a3', -1, visible);
  const out = ids(apply(l, { ...p, id: 'a3' }));
  assert.deepEqual(out.filter(x => x[0] === 'a'), ['a1', 'a3', 'a2']);
  assert.deepEqual(out.filter(x => x[0] === 'b'), ['b1', 'b2']);
});

test('many moves never collapse: gaps close, the list is renumbered and the order stays right', () => {
  let l = [it('a', 1000), it('b', 1001), it('c', 1002), it('d', 1003)];
  let expect = ['a', 'b', 'c', 'd'], renumbered = false;
  for (let n = 0; n < 150; n++) { // always slide the last item up to the second place: the gap after the first item keeps halving
    const id = expect[expect.length - 1];
    while (expect.indexOf(id) > 1) {
      const p = planMove(l, id, -1);
      if (p.renumber) renumbered = true;
      const at = expect.indexOf(id); expect.splice(at, 1); expect.splice(at - 1, 0, id);
      l = apply(l, { ...p, id });
      assert.deepEqual(ids(l), expect, `step ${n}`);
    }
  }
  assert.ok(renumbered, 'renumbering happened');
  const gaps = sortOpen(l).map(effPos).map((v, i, a) => (i ? v - a[i - 1] : Infinity));
  assert.ok(gaps.every(g => g > 0), 'all positions distinct');
  assert.ok(MIN_GAP > 0);
});

test('toPos validates', () => {
  assert.equal(toPos('x'), null); assert.equal(toPos(null), null); assert.equal(toPos(NaN), null); assert.equal(toPos(1e20), null);
  assert.equal(toPos(2.5), 2.5); assert.equal(toPos(0), 0); assert.equal(toPos(-3), -3);
});

test('store.move: sets pos on an open item, is idempotent, ignores checked/missing/bad input; restore keeps the place', async () => {
  const db = localAdapter(mem(), false), s = createStore(db), c = await s.create();
  await s.add(c, { id: 'a', title: 'Milch' }, A); await s.add(c, { id: 'b', title: 'Brot' }, A);
  await s.move(c, 'a', 1.5); await s.move(c, 'a', 1.5);
  assert.equal((await db.get(c, 'items/a')).pos, 1.5);
  await s.move(c, 'a', 'x'); await s.move(c, 'nope', 1); await s.move(c, 'bad id', 1);
  assert.equal((await db.get(c, 'items/a')).pos, 1.5);
  await s.check(c, 'b', A, true); await s.move(c, 'b', 7);
  assert.equal((await db.get(c, 'items/b')).pos ?? null, null, 'a checked item is not moved');
  const old = await db.get(c, 'items/a');
  await s.remove(c, 'a'); await s.restore(c, old, A);
  assert.equal((await db.get(c, 'items/a')).pos, 1.5, 'restore brings the old place back');
  await s.check(c, 'a', A, true); await s.check(c, 'a', A, false);
  assert.equal((await db.get(c, 'items/a')).pos, 1.5, 'checking and unchecking keeps the place');
});

test('move is a queueable op: validated, shown ahead, replay is harmless', async () => {
  const CODE = 'ABC234';
  assert.ok(validEntry({ code: CODE, op: 'move', args: ['a', 2.5], ts: 1 }));
  assert.equal(validEntry({ code: CODE, op: 'move', args: ['a', 'x'], ts: 1 }), null);
  assert.equal(validEntry({ code: CODE, op: 'move', args: ['a', null], ts: 1 }), null);
  assert.equal(validEntry({ code: CODE, op: 'move', args: ['bad id', 1], ts: 1 }), null);
  const state = { items: { a: it('a', 1), b: it('b', 2, { checked: true }) }, deposit: {} };
  const mv = (id, pos) => ({ id: 'x', code: CODE, op: 'move', args: [id, pos], ts: 5 });
  assert.equal(overlay(state, [mv('a', 9)]).items.a.pos, 9);
  assert.equal(overlay(state, [mv('b', 9)]).items.b.pos, undefined);
  const db = localAdapter(mem(), false), store = createStore(db), code = await store.create();
  await store.add(code, { id: 'a', title: 'Milch' }, A);
  const ob = createOutbox({ storage: mem() }), w = ob.wrap(store, null);
  await w.move(code, 'a', 3); await w.move(code, 'a', 3);
  assert.equal((await db.get(code, 'items/a')).pos, 3);
  assert.equal(ob.count(code), 0);
});
