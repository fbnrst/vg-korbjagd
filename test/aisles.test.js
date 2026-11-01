import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { guessAisle, aisleOf, aisleKey, groupByAisle, sanitizeOverrides, withChoice, AISLES, OTHER, MAX_OVERRIDES } from '../public/aisles.js';

test('everyday items land in the aisle a shopper expects', () => {
  const expect = {
    produce: ['Äpfel', 'Rote Bete', 'Chicorée', 'Weißkohl', 'Zuckerschoten', 'Gurke', 'Mais'],
    dairy: ['Milch', 'Eier', 'Eier Freiland', 'Ei', 'Rührei', 'Hafer Barista', 'Frischkäse', 'Haferdrink'],
    bakery: ['Brötchen', 'Vollkornbrot', 'Käsekuchen', 'Laugenbrezel'],
    meat: ['Hackfleisch', 'Räucherlachs', 'Tofu', 'Bratwurst', 'Hühnerbrust'],
    frozen: ['Tiefkühlpizza', 'Pommes', 'Eis'],
    dry: ['Nudeln', 'Tomaten Dose', 'Gurken Glas', 'Gemüsebrühe', 'Paprikapulver', 'Apfelmus', 'Gemüsesuppe', 'Sonnenblumenöl', 'Kaffeebohnen', 'Kräutertee', 'Puddingpulver'],
    drinks: ['Apfelsaft', 'Mineralwasser', 'Bier', 'Eistee', 'Wein'],
    household: ['Spülmittel', 'Toilettenpapier', 'Kaffeefilter', 'Blumen', 'Zahnpasta'],
  };
  for (const [aisle, names] of Object.entries(expect)) for (const n of names) assert.equal(guessAisle(n), aisle, `${n} should be ${aisle}`);
});

test('compounds follow their last word, so a modifier does not decide', () => {
  assert.equal(guessAisle('Apfelsaft'), 'drinks');
  assert.equal(guessAisle('Apfel'), 'produce');
  assert.equal(guessAisle('Sonnenblumenöl'), 'dry'); // not "Blumen"
  assert.equal(guessAisle('Reis'), 'dry'); // "ei" inside a word means nothing
  assert.equal(guessAisle('Seife'), 'household');
});

test('unknown items are "other", never a guess', () => {
  for (const n of ['Frühstück', 'das Zeug für Sonntag', 'xyz', '']) assert.equal(aisleOf(n), OTHER);
});

test('a learned choice wins over the dictionary, and "automatic" removes it', () => {
  let o = withChoice({}, 'Milch', 'household');
  assert.equal(aisleOf('milch ', o), 'household');
  assert.equal(aisleOf('Milch', withChoice(o, 'MILCH', null)), 'dairy');
  assert.equal(aisleKey('Möhren!'), 'moehren');
});

test('groups come in walking order, only non-empty ones, other last, order inside kept', () => {
  const items = ['Seife', 'unbekannt', 'Milch', 'Apfel', 'Birne'].map((title, n) => ({ id: 'i' + n, title }));
  const g = groupByAisle(items);
  assert.deepEqual(g.map(x => x.aisle), ['produce', 'dairy', 'household', 'other']);
  assert.deepEqual(g[0].items.map(i => i.title), ['Apfel', 'Birne']);
  assert.deepEqual(g.map(x => x.aisle).filter(a => a !== OTHER), AISLES.filter(a => g.some(x => x.aisle === a)));
});

test('stored choices are validated and bounded', () => {
  assert.deepEqual(sanitizeOverrides(null), {});
  assert.deepEqual(sanitizeOverrides([1]), {});
  assert.deepEqual(sanitizeOverrides({ milch: 'dairy', Bad: 'dairy', x: 'nope', 'a b': 'other' }), { milch: 'dairy', 'a b': 'other' });
  let o = {};
  for (let n = 0; n < MAX_OVERRIDES + 20; n++) o = withChoice(o, 'item ' + 'abcdefghij'[n % 10] + n, 'dry');
  assert.equal(Object.keys(o).length, MAX_OVERRIDES);
  assert.ok(!('item a0' in o), 'the oldest choice made room');
});

test('the fixture list of everyday items is mostly resolved and almost never "other"', () => {
  const words = fs.readFileSync(new URL('./../scripts/fixtures/typical-items.txt', import.meta.url), 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.includes(' => ') && !l.includes(' != '));
  const other = words.filter(w => aisleOf(w) === OTHER);
  assert.ok(other.length <= 4, `too many unresolved: ${other.join(', ')}`);
});
