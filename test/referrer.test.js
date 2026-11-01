import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// The list code travels in the page URL (?list=CODE): no page may send it along as a referrer.
test('all pages carry the no-referrer policy', () => {
  for (const f of ['index.html', 'privacy.html', 'docs/index.html']) {
    const html = fs.readFileSync(path.join(import.meta.dirname, '../public', f), 'utf8');
    assert.match(html, /<meta name="referrer" content="no-referrer">/, f);
  }
});
