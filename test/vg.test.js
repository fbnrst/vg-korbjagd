import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildIndex, cleanTitle, infoText, parseShareLink, decryptShared } from '../public/vg.js';

// Load the vendor UMD file in its own context (provides CryptoJS)
const sandbox = { crypto: globalThis.crypto };
vm.runInNewContext(fs.readFileSync(new URL('../public/vendor/crypto-js.js', import.meta.url), 'utf8'), sandbox);
const CryptoJS = sandbox.CryptoJS;

const raw = {
  products: [[7900, 'Fruchtwürfel- mischung', 2, 158, 31, 0], [1181, 'Schafmilch- Joghurt Natur', 3, 748, 5, 1], [1076, 'Vollmilchpulver 1kg', 2, 1, 1, 0]],
  man: { 158: 'Beispiel GmbH - 01234 Dresden', 748: 'Hof Muster', 1: 'Hersteller unbekannt' },
  countries: { 31: 'Deutschland', 5: 'Österreich', 1: 'siehe Etikett' }, units: { 2: 'kg', 3: 'Stück' },
};

test('titles are cleaned of hyphenation breaks in the VG data', () => {
  assert.equal(cleanTitle('Fruchtwürfel- mischung'), 'Fruchtwürfelmischung');
  assert.equal(cleanTitle('Schafmilch- Joghurt Natur'), 'Schafmilch-Joghurt Natur');
});

test('index: number, title, search and info text', () => {
  const ix = buildIndex(raw);
  assert.equal(ix.lookup(7900).title, 'Fruchtwürfelmischung');
  assert.equal(ix.lookup('1181').unit, 'Stück');
  assert.equal(ix.lookup(999), null);
  assert.equal(ix.byTitle('schafmilch-joghurt natur').vgNum, 1181);
  assert.deepEqual(ix.search('joghurt natur').map(p => p.vgNum), [1181]);
  assert.equal(infoText(ix.lookup(1181)), 'Stück · Hof Muster · Österreich · regional');
  assert.equal(infoText(ix.lookup(1076)), 'kg');
});

test('share link of the original app is recognised', () => {
  assert.deepEqual(parseShareLink('Schau: https://app.vg-dresden.de/list?shareId=123#AbCdEf'), { id: '123', key: 'AbCdEf' });
  assert.equal(parseShareLink('https://example.org'), null);
});

test('shared list of the original app is decrypted', () => {
  const list = [{ title: 'Hafermilch', id: 1, amount: 2, unit: 'Stück', vgNum: 4711, checked: true, date: 0, hasVgNum: true, order: 0 }, { title: 'Brot', amount: 1, checked: false }];
  const cipher = CryptoJS.AES.encrypt(JSON.stringify(list), 'geheimerSchluessel').toString();
  const items = decryptShared(CryptoJS, cipher, 'geheimerSchluessel');
  assert.deepEqual(items[0], { title: 'Hafermilch', vgNum: 4711, amount: 2, unit: 'Stück', checked: true });
  assert.equal(items[1].vgNum, null);
  assert.throws(() => decryptShared(CryptoJS, cipher, 'falsch'));
});

test('deposit types are in the index', () => {
  const ix = buildIndex({ ...raw, deposits: [{ id: 1, name: 'Flasche Schraubver.', vgNum: 2009 }] });
  assert.deepEqual(ix.deposits, [{ id: 1, name: 'Flasche Schraubver.', vgNum: 2009 }]);
  assert.deepEqual(buildIndex(raw).deposits, []);
});
