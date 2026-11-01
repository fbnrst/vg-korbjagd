import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The help page is edited by hand: a lost closing tag nests the next section (or the whole other language) inside
// the previous one and the page renders empty
test('help page: sections and divs are balanced, both languages have the same sections', () => {
  const html = fs.readFileSync(new URL('../public/docs/index.html', import.meta.url), 'utf8');
  const count = re => (html.match(re) || []).length;
  assert.equal(count(/<section\b/g), count(/<\/section>/g));
  assert.equal(count(/<div\b/g), count(/<\/div>/g));
  const ids = lang => [...html.matchAll(new RegExp(`<section[^>]* id="${lang}-([a-z]+)"`, 'g'))].map(m => m[1]);
  assert.deepEqual(ids('de'), ids('en'));
  // every section ends with its screenshot column before the next one starts
  for (const part of html.split('<section').slice(1)) assert.match(part, /<\/div><div class="figs[^"]*">[\s\S]*<\/section>/);
});
