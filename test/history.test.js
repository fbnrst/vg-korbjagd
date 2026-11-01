import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHistory, recordHistory, pruneHistory, historyMatches, withoutHistory, HISTORY_MAX, HISTORY_LISTS } from '../public/flows.js';

const NOW = 1_700_000_000_000;
test('record counts uses and remembers the number', () => {
  let h = recordHistory({}, 'LOCAL', ' Milch ', null, NOW);
  h = recordHistory(h, 'LOCAL', 'milch', 1234, NOW + 5);
  assert.equal(h.LOCAL.length, 1);
  assert.deepEqual(h.LOCAL[0], { t: 'Milch', n: 2, ts: NOW + 5, v: 1234 });
  h = recordHistory(h, 'LOCAL', 'Milch', null, NOW + 9);
  assert.equal(h.LOCAL[0].v, 1234); // kept
});
test('record ignores empty titles and bad codes, bounds titles', () => {
  assert.deepEqual(recordHistory({}, 'LOCAL', '  ', null, NOW), {});
  assert.deepEqual(recordHistory({}, 'x!', 'Milch', null, NOW), {});
  assert.equal(recordHistory({}, 'LOCAL', 'a'.repeat(200), null, NOW).LOCAL[0].t.length, 60);
});
test('bounds: names per list and number of lists', () => {
  let h = {};
  for (let i = 0; i < HISTORY_MAX + 20; i++) h = recordHistory(h, 'LOCAL', 'Item ' + i, null, NOW + i);
  assert.equal(h.LOCAL.length, HISTORY_MAX);
  assert.ok(h.LOCAL.some(e => e.t === 'Item ' + (HISTORY_MAX + 19))); // newest kept
  h = {};
  for (let i = 0; i < HISTORY_LISTS + 2; i++) h = recordHistory(h, 'ABCDE' + i + '1', 'Milch', null, NOW + i);
  assert.equal(Object.keys(h).length, HISTORY_LISTS);
  assert.ok(!h['ABCDE01']);
});
test('sanitize drops garbage', () => {
  assert.deepEqual(sanitizeHistory(null), {});
  assert.deepEqual(sanitizeHistory([1]), {});
  const h = sanitizeHistory({
    LOCAL: [{ t: 'Milch', n: 2, ts: NOW, v: 1234 }, { t: 'milch', n: 1, ts: NOW }, { t: '', n: 1, ts: NOW }, { t: 5, n: 1, ts: NOW },
      { t: 'Brot', n: -1, ts: NOW }, { t: 'Käse', n: 1, ts: 'x' }, { t: 'Ei', n: 1, ts: NOW, v: -3 }, null, { t: 'Zukunft', n: 1, ts: NOW * 2 }],
    '<b>': [{ t: 'x', n: 1, ts: NOW }], ABCDEF: 'nope',
  }, NOW);
  assert.deepEqual(Object.keys(h), ['LOCAL']);
  assert.deepEqual(h.LOCAL.map(e => e.t).sort(), ['Ei', 'Milch']);
  assert.equal(h.LOCAL.find(e => e.t === 'Ei').v, undefined);
});
test('prune keeps only live lists', () => {
  const h = recordHistory(recordHistory({}, 'LOCAL', 'a1', null, NOW), 'ABCDEF', 'b1', null, NOW);
  assert.deepEqual(Object.keys(pruneHistory(h, ['ABCDEF'])), ['ABCDEF']);
});
test('matches rank by prefix, count, recency; exact typed text is left out', () => {
  let h = {};
  for (const [t, n] of [['Vollmilch', 1], ['Milch', 3], ['Hafermilch', 5], ['Mehl', 1]]) for (let i = 0; i < n; i++) h = recordHistory(h, 'LOCAL', t, null, NOW + i);
  assert.deepEqual(historyMatches(h.LOCAL, 'mi').map(e => e.t), ['Milch', 'Hafermilch', 'Vollmilch']);
  assert.deepEqual(historyMatches(h.LOCAL, 'milch').map(e => e.t), ['Hafermilch', 'Vollmilch']);
  assert.deepEqual(historyMatches(h.LOCAL, 'm').map(e => e.t), []); // one letter: nothing
  assert.deepEqual(historyMatches(h.LOCAL, 'milch', 1).length, 1);
});
test('withoutHistory removes duplicates in VG names', () => {
  assert.deepEqual(withoutHistory([{ title: 'Milch' }, { title: 'Sahne' }], [{ t: 'milch' }]), [{ title: 'Sahne' }]);
});
