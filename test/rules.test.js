// Strukturtest der Firebase-Regeln: ohne Emulator. Ein Mini-Auswerter für die Teile der Regelsprache,
// die database.rules.json benutzt, prüft genau die Dokumente, die store.js schreibt (und Müll).
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createStore, localAdapter, userKey } from '../public/store.js';

const rules = JSON.parse(readFileSync(new URL('../database.rules.json', import.meta.url))).rules;
const L = rules.lists.$code;

// Regel-Ausdruck -> JS. newData wird als Wrapper übergeben, $-Variablen als Strings.
function snap(v) {
  return {
    val: () => v, isString: () => typeof v === 'string', isNumber: () => typeof v === 'number',
    isBoolean: () => typeof v === 'boolean',
    hasChildren: ks => v && typeof v === 'object' && ks.every(k => v[k] != null),
  };
}
const test_ = (expr, vars, v) => {
  const js = expr.replace(/\$([a-z]+)/g, (_, n) => `__v.${n}`).replace(/\.matches\((\/.*?\/)\)/g, '.match($1)');
  return !!new Function('newData', '__v', `const s = newData; return (${js.replace(/newData/g, 's')});`)(snap(v), vars);
};

// Prüft Wert v an Knoten mit Regelzweig r; Kinder werden rekursiv geprüft. Gibt Fehlerpfad oder null zurück.
function check(r, v, vars, path = '') {
  if (v == null) return null;
  if (r['.validate'] !== undefined) {
    const ok = typeof r['.validate'] === 'boolean' ? r['.validate'] : test_(r['.validate'], vars, v);
    if (!ok) return path || '/';
  }
  if (v && typeof v === 'object') {
    for (const [k, c] of Object.entries(v)) {
      let sub = r[k], nv = vars;
      if (!sub) { const w = Object.keys(r).find(x => x.startsWith('$')); sub = w && r[w]; nv = { ...vars, [w?.slice(1)]: k }; }
      if (!sub) return `${path}/${k} (nicht erlaubt)`;
      const err = check(sub, c, nv, `${path}/${k}`);
      if (err) return err;
    }
    // Pflichtfeld-Prüfung läuft über hasChildren im .validate des Elternknotens
  } else if (!r['.validate'] && false) return path;
  return null;
}
const list = (data, code = 'ABC234') => check(L, data, { code }, '');

const U = userKey('🦊', 'Mia');
const goodItem = (o = {}) => ({ id: 'a1', title: 'Milch', amount: 1, checked: false, addedBy: U, addedAt: 1700000000000, ...o });
const withItem = it => ({ meta: { created: 1 }, items: { [it.id]: it } });

test('Regeln: Struktur — Lesen offen, Wurzel zu, kein Schreiben auf Listenebene', () => {
  assert.equal(rules['.read'], false); assert.equal(rules['.write'], false);
  assert.equal(L['.read'], true);
  assert.equal(L['.write'], undefined, 'kein Schreibrecht auf lists/$code (sonst Löschen/Überschreiben ganzer Listen)');
  assert.equal(L.meta['.write'], '!data.exists()');
  for (const k of ['items', 'scores', 'deposit']) assert.equal(L[k]['.write'], true);
});

test('Regeln: gültige Dokumente von store.js werden akzeptiert', () => {
  assert.equal(list(withItem(goodItem())), null);
  assert.equal(list(withItem(goodItem({ unit: 'kg', amount: 3, info: 'Bio', vgNum: 4711, ean: '4012345678901', checked: true, checkedBy: U, checkedAt: 5 }))), null);
  assert.equal(list({ meta: { created: 1 }, scores: { [U]: 0 }, deposit: { 12: { [U]: 3 } } }), null);
});

test('Regeln: Müll wird abgelehnt', () => {
  const bad = [
    [{ meta: { created: 1 }, items: { a1: goodItem({ title: 'x'.repeat(121) }) } }, 'langer Titel'],
    [withItem(goodItem({ title: '' })), 'leerer Titel'],
    [withItem(goodItem({ amount: 0 })), 'Menge 0'],
    [withItem(goodItem({ amount: 1000 })), 'Menge 1000'],
    [withItem(goodItem({ amount: 1.5 })), 'Menge gebrochen'],
    [withItem(goodItem({ checked: 'ja' })), 'checked kein boolean'],
    [{ meta: { created: 1 }, items: { a1: goodItem({ id: 'zz' }) } }, 'id ≠ Schlüssel'],
    [withItem(goodItem({ extra: 1 })), 'Zusatzfeld'],
    [withItem(goodItem({ info: 'x'.repeat(201) })), 'lange Info'],
    [withItem(goodItem({ ean: '12ab' })), 'EAN'],
    [withItem(goodItem({ addedBy: '<img src=x onerror=alert(1)>' })), 'XSS im Nutzerschlüssel'],
    [withItem(goodItem({ addedBy: '<svg/onload=alert(1)> Mia' })), 'XSS im Emoji-Teil'],
    [withItem(goodItem({ vgNum: '12' })), 'vgNum als String'],
    [{ meta: { created: 1 }, items: { '"><img onerror=x>': goodItem() } }, 'XSS in Item-ID'],
    [{ meta: { created: 1 }, scores: { [U]: -1 } }, 'negativer Punktestand'],
    [{ meta: { created: 1 }, scores: { [U]: 100001 } }, 'riesiger Punktestand'],
    [{ meta: { created: 1 }, scores: { '<b> x': 1 } }, 'XSS im Score-Schlüssel'],
    [{ meta: { created: 1 }, scores: { [U]: 'viel' } }, 'Score als String'],
    [{ meta: { created: 1 }, deposit: { 12: { [U]: 'x' } } }, 'Leergut als String'],
    [{ meta: { created: 1 }, deposit: { 'a b': { [U]: 1 } } }, 'Leergut-Typ mit Leerzeichen'],
    [{ meta: { created: 1, evil: 'x'.repeat(1e5) } }, 'Fremdfeld in meta'],
    [{ meta: { created: 'heute' } }, 'meta.created kein Zahl'],
    [{ items: { a1: goodItem() } }, 'Liste ohne meta'],
    [{ meta: { created: 1 }, muell: 1 }, 'unbekannter Knoten'],
  ];
  for (const [data, why] of bad) assert.notEqual(list(data), null, why);
  assert.notEqual(list(withItem(goodItem()), 'abc234'), null, 'Code muss groß sein');
  assert.notEqual(list(withItem(goodItem()), 'ABC23'), null, 'Code 5 Zeichen');
});

// store.js schreibt nur, was die Regeln erlauben: den kompletten Ablauf gegen den lokalen Adapter fahren.
const mem = () => { const m = {}; return { getItem: k => m[k] ?? null, setItem: (k, v) => { m[k] = v; } }; };
test('Regeln akzeptieren alles, was store.js im normalen Ablauf schreibt', async () => {
  const db = localAdapter(mem(), false), s = createStore(db);
  const c = await s.create(), B = userKey('🐼', 'Ben');
  await s.join(c, U); await s.join(c, B);
  await s.add(c, { id: 'a', title: 'Milch', amount: 2, unit: 'Liter', info: 'Bio', vgNum: 4711, ean: '4012345678901' }, U);
  await s.add(c, { id: 'b', title: 'VG-Nr. 1234', vgNum: '1234' }, B);
  await s.check(c, 'a', U, true); await s.setNum(c, 'b', B, 1234, true, { title: 'Brot', info: 'x' });
  await s.depositAdd(c, '12', U); await s.depositAdd(c, '12', B); await s.depositRemove(c, '12', U);
  await s.resetScores(c);
  assert.equal(list(await db.get(c, ''), c), null);
});
