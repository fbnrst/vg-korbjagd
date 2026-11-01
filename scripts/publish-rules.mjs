// Publishes database.rules.json to a Realtime Database through the REST API (PUT /.settings/rules.json), then reads the rules
// back and compares them. Runs in GitHub Actions (.github/workflows/rules.yml) with a Firebase service account.
// Environment: FIREBASE_SERVICE_ACCOUNT (JSON), DATABASE_URL, DRY_RUN=true|false (only check the file and the access).
import { readFileSync } from 'node:fs';
import { buildJwt, dbUrl } from './cleanup-lists.mjs';

// The file as it will be sent: it must be JSON with a top-level "rules" object. Returns { text, rules }.
export function rulesPayload(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('database.rules.json is not valid JSON'); }
  if (!doc || typeof doc !== 'object' || !doc.rules || typeof doc.rules !== 'object' || Array.isArray(doc.rules)) throw new Error('database.rules.json has no "rules" object');
  return { text, rules: doc };
}

// Same rules regardless of key order and whitespace. `live` is what the server returned (text; may be unparsable: then false).
export function sameRules(a, live) {
  const norm = v => (Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, norm(v[k])])) : v);
  try { return JSON.stringify(norm(a)) === JSON.stringify(norm(typeof live === 'string' ? JSON.parse(live) : live)); } catch { return false; }
}

async function main() {
  const { FIREBASE_SERVICE_ACCOUNT, DATABASE_URL, DRY_RUN = 'false', RULES_FILE = 'database.rules.json' } = process.env;
  if (!FIREBASE_SERVICE_ACCOUNT || !DATABASE_URL) throw new Error('FIREBASE_SERVICE_ACCOUNT and DATABASE_URL are required');
  let sa;
  try { sa = JSON.parse(FIREBASE_SERVICE_ACCOUNT); } catch { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON: paste the complete contents of the downloaded key file'); }
  if (!sa.client_email || !sa.private_key) throw new Error('FIREBASE_SERVICE_ACCOUNT is missing client_email or private_key: use a service account key file');
  const { text, rules } = rulesPayload(readFileSync(RULES_FILE, 'utf8'));
  const dry = DRY_RUN === 'true';

  const tokenRes = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: buildJwt(sa, Math.floor(Date.now() / 1000)) }),
  });
  if (!tokenRes.ok) throw new Error(`token request failed: ${tokenRes.status}`);
  const auth = { Authorization: `Bearer ${(await tokenRes.json()).access_token}` };
  const url = dbUrl(DATABASE_URL, '.settings/rules');
  const read = async () => {
    const r = await fetch(url, { headers: auth });
    const body = await r.text();
    if (!r.ok) throw new Error(`GET rules: HTTP ${r.status} ${body.slice(0, 120)}`);
    return body;
  };

  const before = await read();
  if (sameRules(rules, before)) { console.log('The published rules already match database.rules.json, nothing to do.'); return; }
  if (dry) { console.log('Dry run: the published rules differ and would be replaced (access to read them works).'); return; }
  const put = await fetch(url, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: text });
  if (!put.ok) throw new Error(`PUT rules: HTTP ${put.status} ${(await put.text()).slice(0, 200)} (the service account needs permission to change the rules, see docs/security.md)`);
  if (!sameRules(rules, await read())) throw new Error('the rules were written, but reading them back gives something different');
  console.log('Rules published and verified.');
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) main().catch(e => { console.error(`::error::${e.message}`); process.exit(1); });
