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

test('static text selectors are exact: no generic .muted selectors, root ids exist exactly once', async () => {
  const { STATIC } = await import('../public/i18n.js');
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const [sel] of STATIC) {
    assert.ok(!/\.muted/.test(sel), `selector ${sel} is too generic: it also matches other muted paragraphs (give the element an id)`);
    const root = sel.match(/^#([\w-]+)/);
    if (root) assert.equal(html.split(`id="${root[1]}"`).length - 1, 1, `id ${root[1]} must exist exactly once`);
  }
});

test('dev share buttons are created from JS behind IS_DEV only, never in the static HTML', async () => {
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const dev = fs.readFileSync(new URL('../public/dev.js', import.meta.url), 'utf8');
  assert.ok(!/devShare/i.test(html));
  assert.ok(!/devShare/.test(src), 'app.js leaves the dev buttons to dev.js');
  assert.match(src, /if \(IS_DEV\) import\('\.\/dev\.js'\)/, 'dev.js is loaded only on the dev site');
  assert.match(dev, /devShareCreate[\s\S]*?devShareBack/);
});

// Keys that are never written out in full in the code because it builds them (t(`prefix${x}`)): list each with the place
// that builds it. Empty today.
const DYNAMIC_KEYS = [];
// Keys kept on purpose although nothing uses them (say why). Empty today.
const UNUSED_OK = [];

test('every key in STRINGS.en is used somewhere in public/ (no dead translations)', async () => {
  const { STRINGS } = await import('../public/i18n.js');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const pub = path.resolve(import.meta.dirname, '../public');
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); } else if (/\.(js|html)$/.test(e.name)) files.push(p);
  } };
  walk(pub);
  // i18n.js itself only counts from the static text map on (the tables above it define the keys, they do not use them)
  const src = files.map(f => {
    const s = fs.readFileSync(f, 'utf8');
    return path.basename(f) === 'i18n.js' && path.dirname(f) === pub ? s.slice(s.indexOf('export const STATIC')) : s;
  }).join('\n');
  // A key built at runtime must be declared above, otherwise this test could not see it
  for (const m of src.matchAll(/\bt\(\s*`([^`]*)\$\{/g)) assert.ok(DYNAMIC_KEYS.some(k => k.startsWith(m[1])), `t(\`${m[1]}\${…}\`) builds a key: list the keys in DYNAMIC_KEYS`);
  // Keys are passed around as string literals (t('x'), helpers like devBtn(box, 'x'), the STATIC map): a key counts as used
  // when it appears quoted somewhere
  const quoted = new Set([...src.matchAll(/['"`]([A-Za-z][A-Za-z0-9]*)['"`]/g)].map(m => m[1]));
  const unused = Object.keys(STRINGS.en).filter(k => !quoted.has(k) && !DYNAMIC_KEYS.includes(k) && !UNUSED_OK.includes(k));
  assert.deepEqual(unused, [], `translation keys nobody uses (remove them from both tables, or list them in UNUSED_OK): ${unused.join(', ')}`);
  for (const k of [...DYNAMIC_KEYS, ...UNUSED_OK]) assert.ok(k in STRINGS.en, `listed key ${k} does not exist any more`);
});
