import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const PUB = path.join(import.meta.dirname, '../public');
const read = f => fs.readFileSync(path.join(PUB, f), 'utf8');

// The app serves a vendored copy of the Firebase SDK (public/vendor/firebase/); package.json pins the same version for the
// tests and the emulator check, and the comment in store.js names it. All of them move together (re-vendor to update).
test('Firebase version: vendored SDK, store.js comment, LICENSE.txt and package.json agree', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const app = read('vendor/firebase/firebase-app.js');
  const v = app.match(/\bconst SDK_VERSION = (version\$\d+);/);
  assert.ok(v, 'vendor/firebase/firebase-app.js: SDK_VERSION not found');
  const vendored = app.match(new RegExp(`\\bconst ${v[1].replace('$', '\\$')} = "([^"]+)";`));
  assert.ok(vendored, 'vendor/firebase/firebase-app.js: SDK version string not found');
  assert.equal(pkg.devDependencies.firebase, vendored[1], 'package.json and the vendored SDK differ');
  const store = read('store.js').match(/Firebase JS SDK (\d+\.\d+\.\d+)/);
  assert.ok(store, 'store.js: the comment "Firebase JS SDK x.y.z" was not found');
  assert.equal(store[1], vendored[1], 'store.js names another SDK version than the vendored one');
  assert.ok(read('vendor/firebase/LICENSE.txt').includes(`/firebasejs/${vendored[1]}/`), 'vendor/firebase/LICENSE.txt names another version');
});

test('the vendored SDK imports itself relatively, and nothing in public/ loads from gstatic', () => {
  assert.match(read('vendor/firebase/firebase-database.js'), /from"\.\/firebase-app\.js"/, 'firebase-database.js must import ./firebase-app.js');
  // firebase-app.js keeps its upstream URL as a plain string (component and logger name); it is never imported or fetched
  for (const f of ['vendor/firebase/firebase-app.js', 'vendor/firebase/firebase-database.js']) {
    assert.doesNotMatch(read(f), /(?:\bfrom\s*|\bimport\s*\(\s*)["'`]https?:\/\//, `${f}: imports from an absolute URL`);
  }
  const files = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); } else if (/\.(js|html|json|css)$/.test(e.name)) files.push(p);
    }
  };
  walk(PUB);
  assert.ok(files.length > 10, 'the walk found the app');
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /gstatic\.com/, `${path.relative(PUB, f)} mentions gstatic.com`);
});
