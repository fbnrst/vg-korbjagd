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
// The app always listens to its list; a transaction first runs against the local cache, which stays empty without a listener.
raw.subscribe(c, () => {});
await s.join(c, U); await s.join(c, B);
await s.add(c, { id: 'a', title: 'Milch', amount: 2, unit: 'Liter', info: 'Bio', vgNum: 4711, ean: '4012345678901' }, U);
await s.add(c, { id: 'b', title: 'VG no. 1234', vgNum: '1234' }, B);
await s.check(c, 'a', U, true);
await s.setNum(c, 'b', B, 1234, true, { title: 'Brot', info: 'x' });
await s.depositAdd(c, '12', U); await s.depositAdd(c, '12', B); await s.depositRemove(c, '12', U);
await s.resetScores(c);
// renameUser rewrites scores and deposit as whole objects
const C = userKey('🐱', 'Cleo');
await s.join(c, C); await s.depositAdd(c, '14', C); await s.renameUser(c, C, userKey('🐯', 'Cleo'));
assert.equal(await raw.get(c, `deposit/14/${userKey('🐯', 'Cleo')}`), 1);
pass('normal store.js flow is accepted');

// What a manipulated client could try
await rejects('overwrite the whole list', () => raw.set(c, '', { meta: { created: 1 }, items: {} }));
await rejects('XSS user key', () => raw.set(c, 'scores/<svg onload=x> y', 1));
await rejects('XSS item id', () => raw.set(c, 'items/"><img onerror=x>', { title: 'x' }));
await rejects('score is not a number', () => raw.set(c, `scores/${U}`, 'a'));
await rejects('unknown field on the list', () => raw.set(c, 'evil', 1));
await rejects('title too long', () => raw.set(c, 'items/z', { title: 'x'.repeat(5000), amount: 1, checked: false }));
// A primitive on a container node would skip the wildcard checks below it (and could be megabytes)
await rejects('items as a string', () => raw.set(c, 'items', 'x'.repeat(1000)));
await rejects('scores as a number', () => raw.set(c, 'scores', 5));
await rejects('deposit as a string', () => raw.set(c, 'deposit', 'x'));
await rejects('deposit type as a number', () => raw.set(c, 'deposit/12', 3));
await rejects('deposit type key too long', () => raw.set(c, `deposit/${'x'.repeat(21)}/${U}`, 1));
await rejects('deposit type key with a bad character', () => raw.set(c, `deposit/a+b/${U}`, 1));
// meta.created far ahead would make a list immune to the cleanup
await rejects('created far in the future', () => raw.set('FUTUR234', 'meta', { created: 9e15 }));
await rejects('created 3 days ahead', () => raw.set('FUTUR235', 'meta', { created: Date.now() + 3 * 86400000 }));
// Codes: 6 characters (old lists) and 8 (new lists) are both valid, 5 and 9 are not
await raw.set('ABCD2345', 'meta', { created: Date.now() });
await raw.set('ABC2345', 'meta', { created: Date.now() });
pass('8 and 7 character codes are accepted');
await rejects('9 character code', () => raw.set('ABCD23456', 'meta', { created: Date.now() }));
await rejects('5 character code', () => raw.set('ABC23', 'meta', { created: Date.now() }));
await raw.remove('ABCD2345', ''); await raw.remove('ABC2345', '');

// Two phones at once: transactions must not lose or double a point. Real transactions retry on conflict, the local adapter
// used by the other tests cannot show that.
const score = async u => (await raw.get(c, `scores/${u}`)) || 0;
await s.resetScores(c);
for (const id of ['r1', 'r2', 'r3']) await s.add(c, { id, title: id }, U);
await Promise.all([s.check(c, 'r1', U, true), s.check(c, 'r1', B, true)]);
assert.equal(await score(U) + await score(B), 1, 'the same item checked twice at once gives exactly one point');
const first = (await raw.get(c, 'items/r1')).checkedBy;
pass('the same item checked on two phones at once: one point');
await Promise.all([s.check(c, 'r2', U, true), s.check(c, 'r3', B, true)]);
assert.equal(await score(first) + await score(first === U ? B : U), 3, 'two different items at once give two points');
assert.equal(await score(U) + await score(B), 3);
pass('two different items checked at once: both points arrive');
await s.check(c, 'r1', first === U ? B : U, false); // the other person unchecks: the point goes back to who got it
assert.equal(await score(U) + await score(B), 2);
for (const u of [U, B]) assert.ok(await score(u) >= 0, 'never below zero');
pass('unchecking by someone else takes the point from the one who checked');
await s.resetScores(c);
await Promise.all(Array.from({ length: 20 }, (_, i) => s.depositAdd(c, '13', i % 2 ? U : B)));
assert.equal(await raw.get(c, `deposit/13/${U}`), 10);
assert.equal(await raw.get(c, `deposit/13/${B}`), 10);
assert.equal(await score(U), 10);
assert.equal(await score(B), 10);
pass('20 empties added at once from two phones: counts and points add up');
await Promise.all(Array.from({ length: 30 }, () => s.depositRemove(c, '13', U)));
// depositRemove reads who holds pieces before its transaction, so a removal can find nothing left and do nothing. What must
// hold is that the points always match the pieces that are left, and that nothing goes below zero.
const left = Object.values((await raw.get(c, 'deposit/13')) || {}).reduce((a, n) => a + n, 0);
assert.equal(await score(U) + await score(B), left, 'points match the pieces that are left');
assert.ok(await score(U) >= 0 && await score(B) >= 0);
for (let i = 0; i < left; i++) await s.depositRemove(c, '13', U);
assert.equal(await raw.get(c, 'deposit/13'), null);
assert.equal(await score(U) + await score(B), 0);
pass('30 removals at once from 20 pieces: points match the rest, none lost, all pieces removable afterwards');

// Emptying the container nodes is a delete and stays allowed (clear the list, last item, last empties, new round)
await s.add(c, { id: 'last', title: 'x' }, U);
await s.clearAll(c);
assert.equal(await raw.get(c, 'items'), null);
await raw.remove(c, 'deposit');
await raw.set(c, 'scores', {});
assert.equal(await raw.get(c, 'scores'), null);
await s.join(c, U); await s.resetScores(c);
pass('emptying items, deposit and scores is allowed');

// Deleting a whole list is the one write allowed at list level
await raw.remove(c, '');
assert.equal(await raw.get(c, ''), null);
pass('delete the whole list is allowed');

console.log(`${ok} checks passed`);
process.exit(0); // the SDK keeps its connection open
