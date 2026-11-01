import test from 'node:test';
import assert from 'node:assert';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { buildJwt, classify, dbUrl, lastActivity, retryOnce, runCleanup, selectExpired } from '../scripts/cleanup-lists.mjs';

const DAY = 86400000, now = Date.UTC(2027, 0, 1);

test('selectExpired picks lists whose last activity is older than the limit', () => {
  const entries = {
    OLD111: { activity: now - 400 * DAY, created: now - 500 * DAY },
    NEW222: { activity: now - 10 * DAY, created: now - 500 * DAY },           // recently used
    NOACT3: { created: now - 366 * DAY },                                      // never stamped: falls back to creation
    FRESH4: { created: now - 30 * DAY },
    BROKEN: {},                                                                // no timestamps: invalid leftover
  };
  assert.deepEqual(selectExpired(entries, now, 365 * DAY).sort(), ['BROKEN', 'NOACT3', 'OLD111']);
  assert.equal(lastActivity({ activity: 5, created: 9 }), 9);
  assert.equal(lastActivity(null), 0);
});

test('the activity stamp keeps a list alive even if it was created long ago', () => {
  assert.deepEqual(selectExpired({ A: { activity: now - 364 * DAY, created: now - 900 * DAY } }, now, 365 * DAY), []);
});

test('buildJwt signs a valid RS256 token for the service account', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = { client_email: 'cleanup@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const [h, b, s] = buildJwt(sa, 1000).split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(b, 'base64url'));
  assert.equal(claims.iss, sa.client_email);
  assert.equal(claims.exp - claims.iat, 3600);
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s, 'base64url')));
});

test('dbUrl puts .json before the query string (the wrong order redirects to an HTML page)', () => {
  const base = 'https://x-default-rtdb.europe-west1.firebasedatabase.app/';
  assert.equal(dbUrl(base, 'lists', 'shallow=true'), 'https://x-default-rtdb.europe-west1.firebasedatabase.app/lists.json?shallow=true');
  assert.equal(dbUrl(base, 'lists/ABC234/meta/created'), 'https://x-default-rtdb.europe-west1.firebasedatabase.app/lists/ABC234/meta/created.json');
});

test('with the 30 day limit a list is kept at 29 days and removed at 31 days of inactivity', () => {
  const entries = { A: { activity: now - 29 * DAY }, B: { activity: now - 31 * DAY } };
  assert.deepEqual(selectExpired(entries, now, 30 * DAY), ['B']);
});

test('a timestamp far in the future does not keep a list alive', () => {
  const entries = {
    EVIL0001: { created: 9e15 },                                               // written under the old unbounded rule
    EVIL02: { activity: now - DAY, created: now + 400 * DAY },
    SKEW03: { activity: now + DAY / 2, created: now - 10 * DAY },              // clock slightly ahead: within the slack
  };
  assert.deepEqual(selectExpired(entries, now, 30 * DAY).sort(), ['EVIL0001', 'EVIL02']);
  assert.equal(classify(entries.EVIL0001, now, 30 * DAY), 'future');
  assert.equal(classify(entries.SKEW03, now, 30 * DAY), 'keep');
  assert.equal(classify({}, now, 30 * DAY), 'invalid');
  assert.equal(classify({ activity: null, created: null }, now, 30 * DAY), 'invalid');
});

// A fake database for runCleanup: data per code, failing paths counted per call
function fakeDb(lists, { fail = {} } = {}) {
  const calls = { del: [] };
  const hit = path => { if (fail[path] > 0) { fail[path]--; throw new Error(`HTTP 503 ${path}`); } };
  return {
    lists, calls,
    get: async (path, query) => {
      hit(path);
      if (path === 'lists') return query === 'shallow=true' ? Object.fromEntries(Object.keys(lists).map(c => [c, true])) : lists;
      const [, code, ...rest] = path.split('/'), e = lists[code];
      return rest.join('/') === 'activity' ? e?.activity ?? null : e?.meta?.created ?? null;
    },
    del: async path => { hit(`DELETE ${path}`); calls.del.push(path); delete lists[path.split('/')[1]]; },
  };
}
const quiet = () => {};

test('runCleanup deletes old, future and invalid lists, 6 and 8 character codes alike', async () => {
  const db = fakeDb({
    OLD111: { activity: now - 40 * DAY, meta: { created: now - 90 * DAY } },
    OLD22222: { meta: { created: now - 40 * DAY } },
    NEW333: { activity: now - DAY, meta: { created: now - 90 * DAY } },
    NEW44444: { meta: { created: now - DAY } },
    FUT555: { meta: { created: 9e15 } },
    NOTS66: { items: {} },
  });
  const r = await runCleanup({ ...db, now, maxAgeMs: 30 * DAY, log: quiet });
  assert.deepEqual(r.deleted.sort(), ['FUT555', 'NOTS66', 'OLD111', 'OLD22222']);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(Object.keys(db.lists).sort(), ['NEW333', 'NEW44444']);
});

test('runCleanup in dry run deletes nothing', async () => {
  const db = fakeDb({ OLD111: { meta: { created: now - 40 * DAY } }, NOTS66: {} });
  const r = await runCleanup({ ...db, now, maxAgeMs: 30 * DAY, dry: true, log: quiet });
  assert.deepEqual(r.deleted.sort(), ['NOTS66', 'OLD111']);
  assert.deepEqual(db.calls.del, []);
});

test('runCleanup retries once, then skips a failing list and goes on', async () => {
  const db = fakeDb({
    FLAKY1: { meta: { created: now - 40 * DAY } },                             // first GET fails, the retry works
    BROKE2: { meta: { created: now - 40 * DAY } },                             // GET fails twice: skipped
    NODEL3: { meta: { created: now - 40 * DAY } },                             // DELETE fails twice: skipped
    OLD444: { meta: { created: now - 40 * DAY } },
  }, { fail: { 'lists/FLAKY1/activity': 1, 'lists/BROKE2/activity': 2, 'DELETE lists/NODEL3': 2 } });
  const lines = [];
  const r = await runCleanup({ ...db, now, maxAgeMs: 30 * DAY, log: l => lines.push(l) });
  assert.deepEqual(r.deleted.sort(), ['FLAKY1', 'OLD444']);
  assert.deepEqual(r.failed.sort(), ['BROKE2', 'NODEL3']);
  assert.ok(lines.some(l => l.startsWith('::error::') && l.includes('BROKE2') && l.includes('NODEL3')));
});

test('runCleanup re-reads a list before deleting it and keeps one that became active', async () => {
  const db = fakeDb({ RACE01: { meta: { created: now - 40 * DAY } } });
  const get = db.get;
  let reads = 0;
  db.get = async (path, q) => {
    if (path === 'lists/RACE01/activity' && ++reads === 2) db.lists.RACE01.activity = now - 1000; // opened meanwhile
    return get(path, q);
  };
  const r = await runCleanup({ get: db.get, del: db.del, now, maxAgeMs: 30 * DAY, log: quiet });
  assert.deepEqual(r.deleted, []);
  assert.deepEqual(db.calls.del, []);
});

test('runCleanup fails as a whole only when the list of codes cannot be read', async () => {
  const db = fakeDb({}, { fail: { lists: 2 } });
  await assert.rejects(runCleanup({ ...db, now, maxAgeMs: 30 * DAY, log: quiet }));
});

test('retryOnce gives up after the second failure', async () => {
  let n = 0;
  assert.equal(await retryOnce(async () => { if (++n < 2) throw new Error('x'); return 7; }), 7);
  n = 0;
  await assert.rejects(retryOnce(async () => { n++; throw new Error('y'); }), /y/);
  assert.equal(n, 2);
});
