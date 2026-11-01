import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STRINGS } from '../public/i18n.js';

const read = f => fs.readFileSync(new URL('../public/' + f, import.meta.url), 'utf8');

test('the VG list import is gone', () => {
  for (const f of ['index.html', 'app.js', 'a11y.js', 'vg.js', 'sw.js']) assert.ok(!/menuImport|importDlg|openImport|parseShareLink|decryptShared|CryptoJS|crypto-js/.test(read(f)), f);
  assert.ok(!fs.existsSync(new URL('../public/vendor/crypto-js.js', import.meta.url)));
  for (const lang of ['en', 'de']) for (const k of Object.keys(STRINGS[lang])) assert.ok(!/^(import|resetImport|toastImported|clipNoLink|paste$)/.test(k), `${lang}.${k} belonged to the import`);
});

test('the empty-list hint offers joining a list through the same dialog as the menu', () => {
  const app = read('app.js');
  const hint = app.slice(app.indexOf('function emptyHint'), app.indexOf('function render()'));
  assert.match(hint, /id="emptyJoin"[^>]*>\$\{esc\(t\('emptyJoin'\)\)\}/);
  assert.match(app, /#emptyJoin[^\n]*openJoin/); // the hint's button opens the join dialog
  assert.ok(STRINGS.en.emptyJoin && STRINGS.de.emptyJoin);
});
