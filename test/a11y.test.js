import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { shortName, trapTarget, menuIndex } from '../public/a11y.js';
import { measure, contrast, luminance } from '../scripts/contrast.mjs';
import { STRINGS } from '../public/i18n.js';

test('shortName: one line, at most 40 characters, ellipsis only when cut', () => {
  assert.equal(shortName('Milch'), 'Milch');
  assert.equal(shortName('  Bio  \n Milch '), 'Bio Milch');
  assert.equal(shortName('x'.repeat(60)).length, 40);
  assert.ok(shortName('x'.repeat(60)).endsWith('…'));
  assert.equal(shortName(null), '');
});

test('trapTarget keeps Tab inside a dialog and pulls stray focus in', () => {
  const [a, b, c, out] = ['a', 'b', 'c', 'out'];
  const list = [a, b, c];
  assert.equal(trapTarget(list, c, false), a);
  assert.equal(trapTarget(list, a, true), c);
  assert.equal(trapTarget(list, b, false), null);
  assert.equal(trapTarget(list, b, true), null);
  assert.equal(trapTarget(list, out, false), a);
  assert.equal(trapTarget(list, out, true), c);
  assert.equal(trapTarget([], out, false), null);
});

test('menuIndex: arrows wrap, Home and End jump, other keys are ignored', () => {
  assert.equal(menuIndex('ArrowDown', -1, 4), 0);
  assert.equal(menuIndex('ArrowDown', 3, 4), 0);
  assert.equal(menuIndex('ArrowUp', 0, 4), 3);
  assert.equal(menuIndex('ArrowUp', -1, 4), 3);
  assert.equal(menuIndex('Home', 2, 4), 0);
  assert.equal(menuIndex('End', 1, 4), 3);
  assert.equal(menuIndex('a', 1, 4), -1);
  assert.equal(menuIndex('ArrowDown', 0, 0), -1);
});

test('contrast helper matches known WCAG values', () => {
  assert.equal(luminance('#000'), 0);
  assert.ok(Math.abs(contrast('#000', '#fff') - 21) < 1e-9);
  assert.ok(Math.abs(contrast('#777', '#fff') - 4.48) < 0.01);
});

test('theme: text stays at 4.5:1, control borders, check rings and focus rings reach 3:1 in light and dark', () => {
  for (const r of measure()) {
    assert.ok(r.ratio != null, `token missing for ${r.f} on ${r.b} (${r.mode})`);
    assert.ok(r.ratio >= r.min, `${r.mode}: ${r.what} (${r.f} on ${r.b}) is ${r.ratio.toFixed(2)}, needs ${r.min}`);
  }
});

test('item button labels exist in both languages with a {name} placeholder', () => {
  const keys = ['ariaBackItem', 'ariaCheckItem', 'ariaDeleteItem', 'ariaEditNumItem', 'ariaConfirmItem', 'ariaScanItem', 'ariaLessItem', 'ariaMoreItem'];
  for (const lang of ['en', 'de']) for (const k of keys) assert.match(STRINGS[lang][k] || '', /\{name\}/, `${lang}.${k}`);
});

test('every dialog container is covered by the generic dialog helper', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const { DIALOG_SELECTOR } = { DIALOG_SELECTOR: fs.readFileSync(new URL('../public/a11y.js', import.meta.url), 'utf8').match(/DIALOG_SELECTOR = '([^']+)'/)[1] };
  const ids = DIALOG_SELECTOR.split(',').filter(s => s.startsWith('#')).map(s => s.slice(1));
  // top-level overlays of index.html: ids ending in Dlg, plus the scanner
  for (const m of html.matchAll(/<div id="(\w+Dlg|scanner)"/g)) assert.ok(ids.includes(m[1]), `${m[1]} is not covered by DIALOG_SELECTOR`);
  assert.match(html, /id="toast"[^>]*aria-live="polite"/);
});
