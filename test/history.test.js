import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHistory, recordHistory, historyMatches, HISTORY_MAX } from '../public/flows.js';

const NOW = 1_700_000_000_000;
test('record counts uses and remembers the number', () => {
  let h = recordHistory({}, 'ALL', ' Milch ', null, NOW);
  h = recordHistory(h, 'ALL', 'milch', 1234, NOW + 5);
  assert.equal(h.ALL.length, 1);
  assert.deepEqual(h.ALL[0], { t: 'Milch', n: 2, ts: NOW + 5, v: 1234 });
  h = recordHistory(h, 'ALL', 'Milch', null, NOW + 9);
  assert.equal(h.ALL[0].v, 1234); // kept
});
test('record ignores empty titles and bad codes, bounds titles', () => {
  assert.deepEqual(recordHistory({}, 'ALL', '  ', null, NOW), {});
  assert.deepEqual(recordHistory({}, 'x!', 'Milch', null, NOW), {});
  assert.equal(recordHistory({}, 'ALL', 'a'.repeat(200), null, NOW).ALL[0].t.length, 60);
});
test('bounds: number of names', () => {
  let h = {};
  for (let i = 0; i < HISTORY_MAX + 20; i++) h = recordHistory(h, 'ALL', 'Item ' + i, null, NOW + i);
  assert.equal(h.ALL.length, HISTORY_MAX);
  assert.ok(h.ALL.some(e => e.t === 'Item ' + (HISTORY_MAX + 19))); // newest kept
});
test('sanitize drops garbage', () => {
  assert.deepEqual(sanitizeHistory(null), {});
  assert.deepEqual(sanitizeHistory([1]), {});
  const h = sanitizeHistory({
    ALL: [{ t: 'Milch', n: 2, ts: NOW, v: 1234 }, { t: 'milch', n: 1, ts: NOW }, { t: '', n: 1, ts: NOW }, { t: 5, n: 1, ts: NOW },
      { t: 'Brot', n: -1, ts: NOW }, { t: 'Käse', n: 1, ts: 'x' }, { t: 'Ei', n: 1, ts: NOW, v: -3 }, null, { t: 'Zukunft', n: 1, ts: NOW * 2 }],
    '<b>': [{ t: 'x', n: 1, ts: NOW }], ABCDEF: 'nope',
  }, NOW);
  assert.deepEqual(Object.keys(h), ['ALL']);
  assert.deepEqual(h.ALL.map(e => e.t).sort(), ['Ei', 'Milch']);
  assert.equal(h.ALL.find(e => e.t === 'Ei').v, undefined);
});
test('matches rank by prefix, count, recency; exact typed text is left out', () => {
  let h = {};
  for (const [t, n] of [['Vollmilch', 1], ['Milch', 3], ['Hafermilch', 5], ['Mehl', 1]]) for (let i = 0; i < n; i++) h = recordHistory(h, 'ALL', t, null, NOW + i);
  assert.deepEqual(historyMatches(h.ALL, 'mi').map(e => e.t), ['Milch', 'Hafermilch', 'Vollmilch']);
  assert.deepEqual(historyMatches(h.ALL, 'milch').map(e => e.t), ['Hafermilch', 'Vollmilch']);
  assert.deepEqual(historyMatches(h.ALL, 'm').map(e => e.t), []); // one letter: nothing
  assert.deepEqual(historyMatches(h.ALL, 'milch', 1).length, 1);
});
