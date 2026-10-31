import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import { SYNONYM_GROUPS, vgNumFromCode, similarNames, nameSimilarity, buildIndex, isPlaceholder, cleanTitle, infoText, parseShareLink, decryptShared } from '../public/vg.js';

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

test('VG numbers are read from shelf label codes like in the original app', () => {
  assert.equal(vgNumFromCode('00073448'), 7344);                    // EAN-8: digits 4-7 are the number, the last one is the check digit
  assert.equal(vgNumFromCode('000000007344'.concat('1')), 7344);    // EAN-13: first 12 digits, zero padded
  assert.equal(vgNumFromCode('VG 7344 kg Äpfel Deutschland'), 7344); // QR label
  assert.equal(vgNumFromCode('vg 12 Stück Brot'), 12);
  assert.equal(vgNumFromCode('4006381333931'), null);               // ordinary EAN-13: number would be far too large
  assert.equal(vgNumFromCode('12345'), null);
  assert.equal(vgNumFromCode('VG abc'), null);
  assert.equal(vgNumFromCode(''), null);
});

test('similarNames lets alike names pass and asks for different products', () => {
  const same = [['Äpfel', 'Apfel Elstar'], ['Weißkohl', 'Weisskohl Frankreich'], ['Tomate', 'Tomaten'], ['Zwiebel', 'Zwiebel rot'],
    ['Kartoffeln', 'Kartoffel festkochend'], ['Datteln', 'Dattel Deglet Nour'], ['Vollmilchpulver 1kg', 'Milchpulver'], ['Bio Apfel', 'Apfel Elstar'],
    ['', 'Brot'], ['VG no. 123', 'Brot'], ['Ei', 'Eier'],
    ['Porree', 'Lauch'], ['Lauch', 'Porree Bio'], ['Möhren', 'Karotte'], ['Zucchini', 'Courgette'], ['Tomate', 'Paradeiser'],
    ['Aprikosen', 'Marille'], ['Rucola', 'Rauke'], ['Blumenkohl', 'Karfiol'], ['Brokkoli', 'Broccoli'], ['Feldsalat', 'Rapunzel'],
    ['Weintrauben', 'Traube weiß Sugraone kernlos'],
    ['Tomate', 'Cherrytomaten'], ['Salat', 'Bataviasalat'], ['Walnüsse', 'Walnusskerne'], ['Rosinen', 'Sultaninen'], ['Marmelade', 'Fruchtaufstrich'],
    ['Zwiebeln', 'Gemüsezwiebel'], ['Rote Beete', 'Rande'], ['Kürbis', 'Hokkaidokürbis'], ['Bohnen', 'Buschbohnen'], ['Melone', 'Wassermelone'],
    ['Müsli', 'Muesli'], ['Kartoffeln', 'Frühkartoffeln'], ['Gurke', 'Minigurke'], ['Champignons', 'Egerlinge'], ['Äpfel', 'Tafelapfel'],
    ['Brot', 'Vollkornbrot'], ['Brot', 'Roggenbrot Natur'], ['Landbrot', 'Brot']];
  for (const [x, y] of same) assert.ok(similarNames(x, y), `${x} ~ ${y} should pass without a question (${nameSimilarity(x, y).toFixed(2)})`);
  const different = [['Apfel', 'Orange'], ['Apfel', 'Orangensaft'], ['Apfel', 'Apfelsaft'], ['Milch', 'Vollmilchschokolade'],
    ['Bio Apfel', 'Bio Orange'], ['Datteln', 'Reformationsbrot'], ['Milch', 'Zucchini'],
    ['Porree', 'Karotte'], ['Lauch', 'Zucchini']];
  for (const [x, y] of different) assert.ok(!similarNames(x, y), `${x} vs ${y} should be questioned (${nameSimilarity(x, y).toFixed(2)})`);
  assert.equal(nameSimilarity('Apfel', 'Apfel'), 1);
});

test('synonym groups do not overlap and keep different products apart', () => {
  const norm = x => x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss');
  const seen = new Map();
  SYNONYM_GROUPS.forEach((g, i) => g.forEach(w => {
    const k = norm(w);
    assert.ok(!seen.has(k) || seen.get(k) === i, `"${w}" is in two synonym groups`);   // the later group would silently win
    seen.set(k, i);
  }));
  for (const [x, y] of [['Apfel', 'Apfelsaft'], ['Orange', 'Orangensaft'], ['Tomate', 'Tomatenmark'], ['Gurke', 'Tomate'], ['Salat', 'Feldsalat'],
    ['Zwiebel', 'Frühlingszwiebel'], ['Walnüsse', 'Haselnüsse'], ['Traube', 'Johannisbeere'], ['Roggenbrot', 'Dinkelbrot'], ['Brot', 'Linsen rot'], ['Apfel rot', 'Paprika rot'], ['Traube rot', 'Tomate rot'], ['Brot', 'Brötchen'], ['Brot', 'Brotaufstrich'], ['Kürbis', 'Kartoffel'], ['Bohnen', 'Erbsen']])
    assert.ok(!similarNames(x, y), `${x} vs ${y} must still be questioned (${nameSimilarity(x, y).toFixed(2)})`);
});
