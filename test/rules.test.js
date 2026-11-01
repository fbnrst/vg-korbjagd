// Structural test of the Firebase rules: no emulator. A mini evaluator for the parts of the rules language
// that database.rules.json uses; checks exactly the documents store.js writes (and garbage).
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createStore, localAdapter, userKey } from '../public/store.js';

const rules = JSON.parse(readFileSync(new URL('../database.rules.json', import.meta.url))).rules;
const L = rules.lists.$code;

// Rule expression -> JS. newData is passed as a wrapper, $-variables as strings.
function snap(v) {
  return {
    val: () => v, isString: () => typeof v === 'string', isNumber: () => typeof v === 'number',
    isBoolean: () => typeof v === 'boolean',
    // hasChildren() without keys: any child at all (a primitive has none)
    hasChildren: ks => !!v && typeof v === 'object' && (ks ? ks.every(k => v[k] != null) : Object.keys(v).length > 0),
  };
}
const test_ = (expr, vars, v) => {
  const js = expr.replace(/\$([a-z]+)/g, (_, n) => `__v.${n}`).replace(/\.matches\((\/.*?\/)\)/g, '.match($1)');
  return !!new Function('newData', '__v', 'now', `const s = newData; return (${js.replace(/newData/g, 's')});`)(snap(v), vars, Date.now());
};

// Checks value v at a node with rule branch r; children are checked recursively. Returns the error path or null.
function check(r, v, vars, path = '') {
  // Deleting is not validated; RTDB stores an empty object as nothing (a delete)
  if (v == null || (typeof v === 'object' && !Object.keys(v).length)) return null;
  if (r['.validate'] !== undefined) {
    const ok = typeof r['.validate'] === 'boolean' ? r['.validate'] : test_(r['.validate'], vars, v);
    if (!ok) return path || '/';
  }
  if (v && typeof v === 'object') {
    for (const [k, c] of Object.entries(v)) {
      let sub = r[k], nv = vars;
      if (!sub) { const w = Object.keys(r).find(x => x.startsWith('$')); sub = w && r[w]; nv = { ...vars, [w?.slice(1)]: k }; }
      if (!sub) return `${path}/${k} (not allowed)`;
      const err = check(sub, c, nv, `${path}/${k}`);
      if (err) return err;
    }
    // Required-field check goes through hasChildren in the parent node's .validate
  } else if (!r['.validate'] && false) return path;
  return null;
}
const list = (data, code = 'ABC234') => check(L, data, { code }, '');

const U = userKey('🦊', 'Mia');
const goodItem = (o = {}) => ({ id: 'a1', title: 'Milch', amount: 1, checked: false, addedBy: U, addedAt: 1700000000000, ...o });
const withItem = it => ({ meta: { created: 1 }, items: { [it.id]: it } });

test('Rules: structure - read open, root closed, no writes at list level', () => {
  assert.equal(rules['.read'], false); assert.equal(rules['.write'], false);
  assert.equal(L['.read'], true);
  assert.equal(L['.write'], '!newData.exists()', 'lists/$code may only be written to delete the whole list (never to create or overwrite it)');
  assert.equal(L.meta['.write'], '!data.exists()');
  for (const k of ['items', 'scores', 'deposit', 'activity']) assert.equal(L[k]['.write'], true);
});

test('Rules: container nodes only take objects (a primitive would bypass the wildcard checks)', () => {
  for (const k of ['items', 'scores', 'deposit']) assert.match(L[k]['.validate'], /newData\.hasChildren\(\)/, k);
  assert.match(L.deposit.$typ['.validate'], /^\$typ\.matches\(.*\) && newData\.hasChildren\(\)$/, 'deposit/$typ checks its key and takes objects only');
  assert.match(L.meta.created['.validate'], /newData\.val\(\) <= now \+ \d+/, 'meta.created is bounded (a far future value would dodge the cleanup)');
});

test('Rules: valid documents from store.js are accepted', () => {
  assert.equal(list(withItem(goodItem())), null);
  assert.equal(list(withItem(goodItem({ unit: 'kg', amount: 3, info: 'Bio', vgNum: 4711, ean: '4012345678901', checked: true, checkedBy: U, checkedAt: 5 }))), null);
  assert.equal(list(withItem(goodItem({ claimedBy: U }))), null, 'a claimed open item');
  assert.equal(list({ meta: { created: 1 }, scores: { [U]: 0 }, deposit: { 12: { [U]: 3 } } }), null);
  assert.equal(list({ meta: { created: 1 }, activity: Date.now() }), null);
  assert.equal(list({ meta: { created: Date.now() } }), null);
  assert.equal(list({ meta: { created: 1 }, scores: {}, items: {}, deposit: {} }), null, 'emptied nodes are deletions');
});

test('Rules: garbage is rejected', () => {
  const bad = [
    [{ meta: { created: 1 }, items: { a1: goodItem({ title: 'x'.repeat(121) }) } }, 'long title'],
    [withItem(goodItem({ title: '' })), 'empty title'],
    [withItem(goodItem({ claimedBy: '<b>x</b>' })), 'claimedBy is not a user key'],
    [withItem(goodItem({ claimedBy: 5 })), 'claimedBy is not a string'],
    [withItem(goodItem({ amount: 0 })), 'amount 0'],
    [withItem(goodItem({ amount: 1000 })), 'amount 1000'],
    [withItem(goodItem({ amount: 1.5 })), 'fractional amount'],
    [withItem(goodItem({ checked: 'ja' })), 'checked not a boolean'],
    [{ meta: { created: 1 }, items: { a1: goodItem({ id: 'zz' }) } }, 'id != key'],
    [withItem(goodItem({ extra: 1 })), 'extra field'],
    [withItem(goodItem({ info: 'x'.repeat(201) })), 'long info'],
    [withItem(goodItem({ ean: '12ab' })), 'EAN'],
    [withItem(goodItem({ addedBy: '<img src=x onerror=alert(1)>' })), 'XSS in user key'],
    [withItem(goodItem({ addedBy: '<svg/onload=alert(1)> Mia' })), 'XSS in emoji part'],
    [withItem(goodItem({ vgNum: '12' })), 'vgNum as string'],
    [{ meta: { created: 1 }, items: { '"><img onerror=x>': goodItem() } }, 'XSS in item ID'],
    [{ meta: { created: 1 }, scores: { [U]: -1 } }, 'negative score'],
    [{ meta: { created: 1 }, scores: { [U]: 100001 } }, 'huge score'],
    [{ meta: { created: 1 }, scores: { '<b> x': 1 } }, 'XSS in score key'],
    [{ meta: { created: 1 }, scores: { [U]: 'viel' } }, 'score as string'],
    [{ meta: { created: 1 }, deposit: { 12: { [U]: 'x' } } }, 'deposit as string'],
    [{ meta: { created: 1 }, deposit: { 'a b': { [U]: 1 } } }, 'deposit type with space'],
    [{ meta: { created: 1, evil: 'x'.repeat(1e5) } }, 'foreign field in meta'],
    [{ meta: { created: 'heute' } }, 'meta.created not a number'],
    [{ items: { a1: goodItem() } }, 'list without meta'],
    [{ meta: { created: 1 }, muell: 1 }, 'unknown node'],
    [{ meta: { created: 1 }, activity: 'gestern' }, 'activity as string'],
    [{ meta: { created: 1 }, activity: -5 }, 'negative activity'],
    [{ meta: { created: 1 }, activity: Date.now() + 3 * 86400000 }, 'activity far in the future (would keep a list alive forever)'],
    [{ meta: { created: 9e15 } }, 'created far in the future (would keep a list alive forever)'],
    [{ meta: { created: Date.now() + 3 * 86400000 } }, 'created 3 days ahead'],
    [{ meta: { created: 1 }, items: 'x'.repeat(1000) }, 'items as a string'],
    [{ meta: { created: 1 }, items: 5 }, 'items as a number'],
    [{ meta: { created: 1 }, scores: 'x' }, 'scores as a string'],
    [{ meta: { created: 1 }, deposit: true }, 'deposit as a boolean'],
    [{ meta: { created: 1 }, deposit: { 12: 'x' } }, 'deposit type as a string'],
    [{ meta: { created: 1 }, deposit: { 12: 3 } }, 'deposit type as a number'],
    [{ meta: { created: 1 }, deposit: { ['x'.repeat(21)]: { [U]: 1 } } }, 'deposit type too long'],
  ];
  for (const [data, why] of bad) assert.notEqual(list(data), null, why);
  assert.notEqual(list(withItem(goodItem()), 'abc234'), null, 'code must be uppercase');
  assert.notEqual(list(withItem(goodItem()), 'ABC23'), null, 'code with 5 characters');
  assert.notEqual(list(withItem(goodItem()), 'ABCD23456'), null, 'code with 9 characters');
  for (const code of ['ABC234', 'ABC2345', 'ABCD2345']) assert.equal(list(withItem(goodItem()), code), null, `code ${code}: old 6 and new 8 characters`);
});

// store.js only writes what the rules allow: run the complete flow against the local adapter.
const mem = () => { const m = {}; return { getItem: k => m[k] ?? null, setItem: (k, v) => { m[k] = v; } }; };
test('Rules accept everything store.js writes in the normal flow', async () => {
  const db = localAdapter(mem(), false), s = createStore(db);
  const c = await s.create(), B = userKey('🐼', 'Ben');
  await s.join(c, U); await s.join(c, B);
  await s.add(c, { id: 'a', title: 'Milch', amount: 2, unit: 'Liter', info: 'Bio', vgNum: 4711, ean: '4012345678901' }, U);
  await s.add(c, { id: 'b', title: 'VG no. 1234', vgNum: '1234' }, B);
  await s.check(c, 'a', U, true); await s.setNum(c, 'b', B, 1234, true, { title: 'Brot', info: 'x' });
  await s.depositAdd(c, '12', U); await s.depositAdd(c, '12', B); await s.depositRemove(c, '12', U);
  await s.resetScores(c);
  assert.equal(list(await db.get(c, ''), c), null);
});
