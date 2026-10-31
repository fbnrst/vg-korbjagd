import test from 'node:test';
import assert from 'node:assert';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { buildJwt, dbUrl, lastActivity, selectExpired } from '../scripts/cleanup-lists.mjs';

const DAY = 86400000, now = Date.UTC(2027, 0, 1);

test('selectExpired picks lists whose last activity is older than the limit', () => {
  const entries = {
    OLD111: { activity: now - 400 * DAY, created: now - 500 * DAY },
    NEW222: { activity: now - 10 * DAY, created: now - 500 * DAY },           // recently used
    NOACT3: { created: now - 366 * DAY },                                      // never stamped: falls back to creation
    FRESH4: { created: now - 30 * DAY },
    BROKEN: {},                                                                // no timestamps: unknown, never deleted
  };
  assert.deepEqual(selectExpired(entries, now, 365 * DAY).sort(), ['NOACT3', 'OLD111']);
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
