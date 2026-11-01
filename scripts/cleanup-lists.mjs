// Deletes shared lists after a period of inactivity (default: 30 days), and lists whose timestamps are in the far future
// or missing (garbage the current rules cannot produce). List codes of any length (6 old, 8 new) are handled alike.
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

// The rules cap both stamps at now + 24 h when written; anything later came from old rules or a bypass and must not
// keep a list alive forever.
export const FUTURE_SLACK_MS = 86400000;

// 'keep' | 'expired' | 'future' (a stamp beyond now + slack: garbage) | 'invalid' (no stamp at all: the rules require
// meta.created, so such a list is a leftover that cannot have been created by a client).
export function classify(e, now, maxAgeMs) {
  const last = lastActivity(e);
  if (last <= 0) return 'invalid';
  if (last > now + FUTURE_SLACK_MS) return 'future';
  return now - last > maxAgeMs ? 'expired' : 'keep';
}

// entries: { CODE: { activity, created } } -> codes to delete (expired, future stamp or no stamp)
export function selectExpired(entries, now, maxAgeMs) {
  return Object.entries(entries).filter(([, e]) => classify(e, now, maxAgeMs) !== 'keep').map(([code]) => code);
}

// One retry, then the error goes to the caller (which skips that list)
export async function retryOnce(f) {
  try { return await f(); } catch { return f(); }
}

// Date() only goes up to 8.64e15 ms: a garbage stamp beyond it is printed as the raw number
const day = ms => { const d = new Date(ms); return Number.isNaN(d.getTime()) ? String(ms) : d.toISOString().slice(0, 10); };
const describe = (kind, e) => kind === 'invalid' ? 'no activity and no meta.created: invalid leftover'
  : kind === 'future' ? `timestamp in the future: ${day(lastActivity(e))}` : `last activity ${day(lastActivity(e))}`;

// get(path) -> value (null if missing), del(path); both throw on HTTP errors. A failed list is skipped, the run goes on;
// the failures are returned so the caller can exit non-zero. Each list is read again right before it is deleted, so one
// that was opened meanwhile survives.
export async function runCleanup({ get, del, now, maxAgeMs, dry = false, log = console.log }) {
  const codes = Object.keys((await retryOnce(() => get('lists', 'shallow=true'))) || {});
  const read = async code => ({ activity: await get(`lists/${code}/activity`), created: await get(`lists/${code}/meta/created`) });
  const failed = [], deleted = [], entries = {};
  for (const code of codes) {
    try { entries[code] = await retryOnce(() => read(code)); } catch (e) { failed.push(code); log(`::warning::skipping ${code}: ${e.message}`); }
  }
  const doomed = selectExpired(entries, now, maxAgeMs);
  log(`${codes.length} lists, ${doomed.length} to delete (inactive for more than ${Math.round(maxAgeMs / 86400000)} days, future timestamp or invalid)${dry ? ' (dry run, nothing is deleted)' : ''}`);
  for (const code of doomed) {
    try {
      const fresh = await retryOnce(() => read(code));
      const kind = classify(fresh, now, maxAgeMs);
      if (kind === 'keep') { log(`keeping ${code}: became active meanwhile`); continue; }
      log(`${kind === 'invalid' ? '::warning::' : ''}${dry ? 'would delete' : 'deleting'} ${code} (${describe(kind, fresh)})`);
      if (!dry) await retryOnce(() => del(`lists/${code}`));
      deleted.push(code);
    } catch (e) { failed.push(code); log(`::warning::skipping ${code}: ${e.message}`); }
  }
  if (failed.length) log(`::error::${failed.length} list(s) failed and were skipped: ${failed.join(', ')}`);
  return { deleted, failed };
}

async function main() {
  const { FIREBASE_SERVICE_ACCOUNT, DATABASE_URL, MAX_AGE_DAYS = '30', DRY_RUN = 'false' } = process.env;
  if (!FIREBASE_SERVICE_ACCOUNT || !DATABASE_URL) throw new Error('FIREBASE_SERVICE_ACCOUNT and DATABASE_URL are required');
  let sa;
  try { sa = JSON.parse(FIREBASE_SERVICE_ACCOUNT); } catch { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON: paste the complete contents of the downloaded key file'); }
  if (!sa.client_email || !sa.private_key) throw new Error('FIREBASE_SERVICE_ACCOUNT is missing client_email or private_key: use a service account key file');
  const days = Number(MAX_AGE_DAYS);
  if (!(days >= 14)) throw new Error('MAX_AGE_DAYS must be at least 14');
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
  const del = async path => { const r = await fetch(db(path), { method: 'DELETE', headers: auth }); if (!r.ok) throw new Error(`DELETE ${path}: HTTP ${r.status}`); };

  const { failed } = await runCleanup({ get, del, now, maxAgeMs: days * 86400000, dry });
  if (failed.length) process.exit(1);
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) main().catch(e => { console.error(`::error::${e.message}`); process.exit(1); });
