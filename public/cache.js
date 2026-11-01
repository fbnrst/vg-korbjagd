// Per-list snapshot cache (localStorage, `NS + 'kober-cache:' + code`): the last live snapshot of a shared list, shown
// read-only on the next start while no live data has arrived (a first load with no network or a busy server).
// Bounded: at most KEEP lists (the most recently written), each at most MAX_BYTES. What comes out of the cache is as
// untrusted as server data (the user can edit localStorage): `sanitize` keeps only well-formed fields, and the renderer
// escapes everything with esc() as always. A live snapshot always replaces it.
import { NS } from './env.js';
import { isId, isUserKey, isListCode } from './store.js';

export const KEEP = 3, MAX_BYTES = 200000, MAX_AGE = 30 * 24 * 3600e3;
// At most this many items are kept from a snapshot: the rules cannot count children, and one member flooding a list with
// thousands of items must not freeze the phones of the others (app.js runs live snapshots through `sanitize` as well)
export const MAX_ITEMS = 1000;
const PREFIX = NS + 'kober-cache:';
const TYPE = /^[A-Za-z0-9_-]{1,20}$/;
const int = (v, lo, hi) => { const n = Math.round(Number(v)); return v !== null && v !== '' && v !== undefined && Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
const str = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const key = k => (isUserKey(k) ? k : null);

export function sanitize(s) {
  const out = { items: {}, scores: {}, deposit: {} };
  if (!s || typeof s !== 'object') return out;
  let n = 0;
  for (const [id, i] of Object.entries(s.items && typeof s.items === 'object' ? s.items : {})) {
    if (n >= MAX_ITEMS) break;
    if (!isId(id) || !i || typeof i !== 'object' || typeof i.title !== 'string' || !i.title.trim()) continue;
    out.items[id] = { id, title: i.title.trim().slice(0, 120), amount: int(i.amount, 1, 999) || 1, unit: str(i.unit, 20), info: str(i.info, 200),
      vgNum: int(i.vgNum, 1, 9999999), ean: /^\d{8,14}$/.test(i.ean) ? i.ean : null, checked: i.checked === true,
      checkedBy: i.checked === true ? key(i.checkedBy) : null, checkedAt: i.checked === true ? int(i.checkedAt, 0, 1e14) : null,
      claimedBy: i.checked === true ? null : key(i.claimedBy), addedBy: key(i.addedBy), addedAt: int(i.addedAt, 0, 1e14) || 0 };
    n++;
  }
  for (const [k, n] of Object.entries(s.scores && typeof s.scores === 'object' ? s.scores : {})) if (isUserKey(k) && int(n, 0, 100000) !== null) out.scores[k] = int(n, 0, 100000);
  for (const [typ, users] of Object.entries(s.deposit && typeof s.deposit === 'object' ? s.deposit : {})) {
    if (!TYPE.test(typ) || !users || typeof users !== 'object') continue;
    for (const [k, n] of Object.entries(users)) if (isUserKey(k) && int(n, 1, 100000)) (out.deposit[typ] = out.deposit[typ] || {})[k] = int(n, 1, 100000);
  }
  return out;
}

const validCode = isListCode;
const cacheKeys = storage => { const ks = []; try { for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(PREFIX)) ks.push(k); } } catch (e) { /* no enumeration: no pruning */ } return ks; };
const stamp = (storage, k) => { try { return Number(JSON.parse(storage.getItem(k)).ts) || 0; } catch (e) { return 0; } };

export function saveSnapshot(storage, code, snap, now = Date.now()) {
  if (!validCode(code)) return false;
  try {
    const json = JSON.stringify({ ts: now, data: sanitize(snap) });
    if (json.length > MAX_BYTES) { storage.removeItem(PREFIX + code); return false; }
    storage.setItem(PREFIX + code, json);
    const rest = cacheKeys(storage).filter(k => k !== PREFIX + code).sort((a, b) => stamp(storage, b) - stamp(storage, a));
    rest.slice(KEEP - 1).forEach(k => storage.removeItem(k)); // only the last-used lists stay
    return true;
  } catch (e) { return false; } // storage full or blocked: no cache, nothing else is affected
}

// The cached snapshot of a list ({items, scores, deposit, ts}) or null
export function loadSnapshot(storage, code, now = Date.now()) {
  if (!validCode(code)) return null;
  try {
    const c = JSON.parse(storage.getItem(PREFIX + code));
    if (!c || typeof c !== 'object' || !(now - Number(c.ts) < MAX_AGE)) return null;
    return { ...sanitize(c.data), ts: Number(c.ts) };
  } catch (e) { return null; }
}

export function dropSnapshot(storage, code) { try { storage.removeItem(PREFIX + code); } catch (e) { /* nothing to do */ } }
