import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

// The app loads the Firebase SDK from gstatic by version (V in store.js); package.json pins the same version for the tests
// and the emulator check. Both must move together.
test('Firebase version in package.json equals the SDK version store.js loads', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const store = fs.readFileSync(new URL('../public/store.js', import.meta.url), 'utf8');
  const v = store.match(/\bconst V = '([^']+)'/);
  assert.ok(v, 'store.js: const V = \'...\' not found');
  assert.equal(pkg.devDependencies.firebase, v[1]);
});
