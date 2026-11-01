// Runs the real store.js and the real database.rules.json against the Firebase Realtime Database emulator.
// Start it with `npm run test:emulator` (needs Java 21+; firebase-tools is fetched by npx). test/rules.test.js checks the
// rules with a small home-made evaluator without any emulator; this is the check with the real rules language.
// Not part of `npm test` on purpose: it downloads the emulator.
import assert from 'node:assert';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) throw new Error('Run through `npm run test:emulator` (emulators:exec sets the emulator host).');
const project = process.env.GCLOUD_PROJECT || 'demo-kober';
const pub = new URL('../public/', import.meta.url);

// store.js loads the Firebase SDK from gstatic in the browser; use the npm package with the same version here.
// The copy goes into a temp dir next to a copy of env.js, so the repository stays untouched; the SDK is given by URL because
// the temp dir has no node_modules.
const dir = mkdtempSync(join(tmpdir(), 'kober-emu-'));
copyFileSync(new URL('env.js', pub), join(dir, 'env.js'));
const src = readFileSync(new URL('store.js', pub), 'utf8')
  .replace(/import\(`https:\/\/www\.gstatic\.com\/firebasejs\/\$\{V\}\/firebase-app\.js`\)/, `import('${import.meta.resolve('firebase/app')}')`)
  .replace(/import\(`https:\/\/www\.gstatic\.com\/firebasejs\/\$\{V\}\/firebase-database\.js`\)/, `import('${import.meta.resolve('firebase/database')}')`);
assert.ok(!src.includes('gstatic.com'), 'store.js: the SDK import changed, adapt the replacement in this script');
writeFileSync(join(dir, 'store.mjs'), src);
const { firebaseAdapter, createStore, userKey } = await import(pathToFileURL(join(dir, 'store.mjs')));

// The emulator applies the rules to the namespace <project>-default-rtdb only (any other namespace is wide open).
const raw = await firebaseAdapter({ projectId: project, databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}/?ns=${project}-default-rtdb` });
const s = createStore(raw);
const U = userKey('🦊', 'Anna'), B = userKey('🐼', 'Ben');
let ok = 0;
const pass = name => { ok++; console.log('ok  ', name); };
const rejects = async (name, f) => {
  try { await f(); } catch (e) { return pass(`${name} (${e.code || e.message})`); }
  assert.fail(`${name} was accepted`);
};

// The normal flow, the same as in test/rules.test.js
const c = await s.create();
await s.join(c, U); await s.join(c, B);
await s.add(c, { id: 'a', title: 'Milch', amount: 2, unit: 'Liter', info: 'Bio', vgNum: 4711, ean: '4012345678901' }, U);
await s.add(c, { id: 'b', title: 'VG no. 1234', vgNum: '1234' }, B);
await s.check(c, 'a', U, true);
await s.setNum(c, 'b', B, 1234, true, { title: 'Brot', info: 'x' });
await s.depositAdd(c, '12', U); await s.depositAdd(c, '12', B); await s.depositRemove(c, '12', U);
await s.resetScores(c);
pass('normal store.js flow is accepted');

// What a manipulated client could try
await rejects('overwrite the whole list', () => raw.set(c, '', { meta: { created: 1 }, items: {} }));
await rejects('XSS user key', () => raw.set(c, 'scores/<svg onload=x> y', 1));
await rejects('XSS item id', () => raw.set(c, 'items/"><img onerror=x>', { title: 'x' }));
await rejects('score is not a number', () => raw.set(c, `scores/${U}`, 'a'));
await rejects('unknown field on the list', () => raw.set(c, 'evil', 1));
await rejects('title too long', () => raw.set(c, 'items/z', { title: 'x'.repeat(5000), amount: 1, checked: false }));

// Deleting a whole list is the one write allowed at list level
await raw.remove(c, '');
assert.equal(await raw.get(c, ''), null);
pass('delete the whole list is allowed');

console.log(`${ok} checks passed`);
process.exit(0); // the SDK keeps its connection open
