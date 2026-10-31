import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { similarNames, nameSimilarity } from '../public/vg.js';

// The checked pairs in scripts/fixtures/typical-items.txt: "Item => VG name" must be accepted by the name check,
// "Item != VG name" must keep being questioned (different products).
const lines = fs.readFileSync(new URL('../scripts/fixtures/typical-items.txt', import.meta.url), 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
const same = lines.filter(l => l.includes(' => ')).map(l => l.split(' => '));
const different = lines.filter(l => l.includes(' != ')).map(l => l.split(' != '));

test('typical items: every checked pair of the same product is accepted', () => {
  assert.ok(same.length >= 40, 'the list should keep its checked pairs');
  for (const [item, name] of same) assert.ok(similarNames(item, name), `${item} => ${name} should be accepted (${nameSimilarity(item, name).toFixed(2)})`);
});

test('typical items: every checked pair of different products is still questioned', () => {
  assert.ok(different.length >= 10);
  for (const [item, name] of different) assert.ok(!similarNames(item, name), `${item} != ${name} should be questioned (${nameSimilarity(item, name).toFixed(2)})`);
});
