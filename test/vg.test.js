import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildIndex, isPlaceholder, cleanTitle, infoText, parseShareLink, decryptShared } from '../public/vg.js';

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

test('name suggestions collapse duplicate names and carry no numbers', () => {
  const ix = buildIndex({
    products: [[1100, 'Äpfel', 2, 1, 1, 0], [1101, 'Äpfel', 2, 1, 1, 0], [1102, 'Apfelsaft', 3, 1, 1, 0], [1102, 'Apfelsaft', 3, 1, 1, 0], [1200, 'Birnen', 2, 1, 1, 0]],
    man: { 1: 'Hof' }, countries: { 1: 'Deutschland' }, units: { 2: 'kg', 3: 'Stück' },
  });
  assert.deepEqual(ix.searchNames('äpfel'), [{ title: 'Äpfel' }]);                  // two products, shown once
  assert.deepEqual(ix.searchNames('apfelsaft'), [{ title: 'Apfelsaft' }]);          // same number twice, shown once
  assert.deepEqual(ix.searchNames('ä', 1), [{ title: 'Äpfel' }]);                   // limit respected
  assert.equal(ix.searchNames('zzz').length, 0);
  assert.equal(ix.searchNames('', 6).length, 0);
});

test('placeholder entries (unused number slots) are never suggested but their exact number still resolves', () => {
  assert.ok(isPlaceholder('unbesetzt Backwaren') && isPlaceholder('RESERVIERT -NICHT VERWENDEN') && isPlaceholder('  Reservierung Bistro'.replace('Reservierung', 'Reserviert')));
  assert.ok(isPlaceholder('Trocken 19% Unbesetzt') && isPlaceholder('Hanfsemmel (unbesetzt?)'));   // the word anywhere in the title
  assert.ok(!isPlaceholder('Reformationsbrot') && !isPlaceholder('Reservierungsgebühr Tee'));
  const ix = buildIndex({ products: [[1300, 'unbesetzt Backwaren', 2, 1, 1, 0], [1301, 'RESERVIERT -NICHT VERWENDEN', 2, 1, 1, 0], [1302, 'Reformationsbrot', 2, 1, 1, 0],
      [1400, 'unbesetzt', 2, 1, 1, 0], [1400, 'Echtes Brot', 2, 1, 1, 0]],
    man: { 1: 'Hof' }, countries: { 1: 'Deutschland' }, units: { 2: 'kg' } });
  assert.equal(ix.lookup(1300).title, 'unbesetzt Backwaren');                       // typed number is still accepted
  assert.equal(ix.lookup('1301').title, 'RESERVIERT -NICHT VERWENDEN');
  assert.equal(ix.lookup(1400).title, 'Echtes Brot');                               // a real product wins over a placeholder
  assert.deepEqual(ix.searchByNumber('130').map(p => p.vgNum), [1302]);              // not suggested by number ...
  assert.deepEqual(ix.searchNames('unbesetzt'), []);                                // ... nor by name
  assert.equal(ix.size, 2);
});
