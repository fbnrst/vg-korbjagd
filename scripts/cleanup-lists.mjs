// Deletes shared lists after a period of inactivity (default: 365 days).
// Runs in GitHub Actions (.github/workflows/cleanup.yml) with a Firebase service account, which bypasses the
// database rules. Environment: FIREBASE_SERVICE_ACCOUNT (JSON), DATABASE_URL, MAX_AGE_DAYS, DRY_RUN=true|false.
import { createSign } from 'node:crypto';

const b64url = x => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');

// Signed JWT for the Google OAuth token endpoint (service account flow), no dependencies
export function buildJwt(sa, nowSec, scope = 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email') {
  const head = b64url({ alg: 'RS256', typ: 'JWT' });
  const body = b64url({ iss: sa.client_email, scope, aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: nowSec, exp: nowSec + 3600 });
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(sa.private_key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

// REST URL of the Realtime Database: `.json` belongs right after the path, before the query string
export const dbUrl = (base, path, query = '') => `${base.replace(/\/$/, '')}/${path}.json${query ? `?${query}` : ''}`;

// A list counts as active at the latest of its activity stamp and its creation time (both in ms).
export const lastActivity = e => Math.max(Number(e?.activity) || 0, Number(e?.created) || 0);

// entries: { CODE: { activity, created } }. Lists without any timestamp are never selected (unknown, not old).
export function selectExpired(entries, now, maxAgeMs) {
  return Object.entries(entries).filter(([, e]) => { const last = lastActivity(e); return last > 0 && now - last > maxAgeMs; }).map(([code]) => code);
}

async function main() {
  const { FIREBASE_SERVICE_ACCOUNT, DATABASE_URL, MAX_AGE_DAYS = '365', DRY_RUN = 'false' } = process.env;
  if (!FIREBASE_SERVICE_ACCOUNT || !DATABASE_URL) throw new Error('FIREBASE_SERVICE_ACCOUNT and DATABASE_URL are required');
  let sa;
  try { sa = JSON.parse(FIREBASE_SERVICE_ACCOUNT); } catch { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON: paste the complete contents of the downloaded key file'); }
  if (!sa.client_email || !sa.private_key) throw new Error('FIREBASE_SERVICE_ACCOUNT is missing client_email or private_key: use a service account key file');
  const days = Number(MAX_AGE_DAYS);
  if (!(days >= 30)) throw new Error('MAX_AGE_DAYS must be at least 30');
  const now = Date.now(), dry = DRY_RUN === 'true';

  const tokenRes = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: buildJwt(sa, Math.floor(now / 1000)) }),
  });
  if (!tokenRes.ok) throw new Error(`token request failed: ${tokenRes.status}`);
  const auth = { Authorization: `Bearer ${(await tokenRes.json()).access_token}` };
  const db = (path, query) => dbUrl(DATABASE_URL, path, query);
  const json = async (r, what) => {
    const text = await r.text();
    if (!r.ok) throw new Error(`${what}: HTTP ${r.status} ${text.slice(0, 120)}`);
    try { return JSON.parse(text); } catch { throw new Error(`${what}: response is not JSON (${text.slice(0, 40).replace(/\s+/g, ' ')}…)`); }
  };
  const get = async (path, query) => json(await fetch(db(path, query), { headers: auth }), `GET ${path}`);

  const codes = Object.keys((await get('lists', 'shallow=true')) || {});
  const entries = {};
  for (const code of codes) entries[code] = { activity: await get(`lists/${code}/activity`), created: await get(`lists/${code}/meta/created`) };
  const expired = selectExpired(entries, now, days * 86400000);
  console.log(`${codes.length} lists, ${expired.length} inactive for more than ${days} days${dry ? ' (dry run, nothing is deleted)' : ''}`);
  for (const code of expired) {
    console.log(`${dry ? 'would delete' : 'deleting'} ${code} (last activity ${new Date(lastActivity(entries[code])).toISOString().slice(0, 10)})`);
    if (!dry) { const r = await fetch(db(`lists/${code}`), { method: 'DELETE', headers: auth }); if (!r.ok) throw new Error(`DELETE ${code}: ${r.status}`); }
  }
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) main().catch(e => { console.error(`::error::${e.message}`); process.exit(1); });
