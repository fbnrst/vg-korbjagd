import test from 'node:test';
import assert from 'node:assert';
import { detectLang, t } from '../public/i18n.js';

test('language follows the first supported system language, English is the fallback', () => {
  assert.equal(detectLang('', ['de-DE', 'en']), 'de');
  assert.equal(detectLang('', ['fr-FR', 'de']), 'de');
  assert.equal(detectLang('', ['en-US', 'de']), 'en');
  assert.equal(detectLang('', ['fr', 'es']), 'en');
  assert.equal(detectLang('', []), 'en');
});

test('?lang overrides the system language, unknown values are ignored', () => {
  assert.equal(detectLang('?lang=de', ['en']), 'de');
  assert.equal(detectLang('?lang=en', ['de']), 'en');
  assert.equal(detectLang('?lang=xx', ['de']), 'de');
});

test('t() fills parameters and falls back to English, then to the key', () => {
  assert.equal(t('inBasketHead', { n: 3 }, 'en'), 'In the basket · 3');
  assert.equal(t('inBasketHead', { n: 3 }, 'de'), 'Im Korb · 3');
  assert.equal(t('noSuchKey', {}, 'de'), 'noSuchKey');
  assert.equal(t('pcs', {}, 'en'), '{n} pcs');
});

test('German and English tables have exactly the same keys and placeholders', async () => {
  const { STRINGS } = await import('../public/i18n.js');
  assert.deepEqual(Object.keys(STRINGS.de).sort(), Object.keys(STRINGS.en).sort());
  const params = s => (s.match(/\{\w+\}/g) || []).sort().join();
  for (const k of Object.keys(STRINGS.en)) assert.equal(params(STRINGS.de[k]), params(STRINGS.en[k]), `placeholders differ for ${k}`);
});

test('every key used in app.js and in the static text map exists', async () => {
  const { STRINGS, STATIC } = await import('../public/i18n.js');
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const used = new Set();
  for (const call of src.matchAll(/\bt\(([^()]*)/g)) for (const q of call[1].matchAll(/'([A-Za-z]+)'/g)) used.add(q[1]);
  for (const [, key] of STATIC) used.add(key);
  assert.ok(used.size > 40, 'expected to find the keys that are used');
  for (const k of used) assert.ok(k in STRINGS.en, `missing translation key: ${k}`);
});
