// Per-list snapshot cache (localStorage, `NS + 'kober-cache:' + code`): the last live snapshot of a shared list, shown
// read-only on the next start while no live data has arrived (a first load with no network or a busy server).
// Bounded: at most KEEP lists (the most recently written), each at most MAX_BYTES. What comes out of the cache is as
// untrusted as server data (the user can edit localStorage): `sanitize` keeps only well-formed fields, and the renderer
// escapes everything with esc() as always. A live snapshot always replaces it.
import { NS } from './env.js';
import { toPos } from './order.js';
import { isId, isUserKey, isListCode, isTypeId, intIn as int, strMax as str } from './store.js';

export const KEEP = 3, MAX_BYTES = 200000, MAX_AGE = 30 * 24 * 3600e3;
// At most this many items are kept from a snapshot: the rules cannot count children, and one member flooding a list with
// thousands of items must not freeze the phones of the others (app.js runs live snapshots through `sanitize` as well)
export const MAX_ITEMS = 1000;
const PREFIX = NS + 'kober-cache:';
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
      pos: toPos(i.pos), addedBy: key(i.addedBy), addedAt: int(i.addedAt, 0, 1e14) || 0 };
    n++;
  }
  for (const [k, n] of Object.entries(s.scores && typeof s.scores === 'object' ? s.scores : {})) if (isUserKey(k) && int(n, 0, 100000) !== null) out.scores[k] = int(n, 0, 100000);
  for (const [typ, users] of Object.entries(s.deposit && typeof s.deposit === 'object' ? s.deposit : {})) {
    if (!isTypeId(typ) || !users || typeof users !== 'object') continue;
    for (const [k, n] of Object.entries(users)) if (isUserKey(k) && int(n, 1, 100000)) (out.deposit[typ] = out.deposit[typ] || {})[k] = int(n, 1, 100000);
  }
  return out;
}

const validCode = isListCode;
// Index of the cached lists ({code: ts of the last write}) so pruning never has to parse the snapshots themselves. It is
// user-writable like everything in localStorage: anything off (not an object, a bad code or time stamp, too many entries)
// makes it count as missing, and a missing index is rebuilt once from the cache keys (also the migration from caches
// written before the index existed, and the way an orphaned cache key is found again).
const INDEX = NS + 'kober-cache-index', INDEX_MAX = 20;
function readIndex(storage) {
  try {
    const o = JSON.parse(storage.getItem(INDEX));
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const e = Object.entries(o);
    return e.length <= INDEX_MAX && e.every(([c, ts]) => validCode(c) && typeof ts === 'number' && Number.isFinite(ts) && ts >= 0) ? o : null;
  } catch (e) { return null; }
}
// A failed index write removes the index, so the next save rebuilds it instead of trusting a stale one
function writeIndex(storage, idx) { try { storage.setItem(INDEX, JSON.stringify(idx)); } catch (e) { try { storage.removeItem(INDEX); } catch (e2) { /* nothing to do */ } } }
const cacheKeys = storage => { const ks = []; try { for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(PREFIX)) ks.push(k); } } catch (e) { /* no enumeration: no pruning */ } return ks; };
const stamp = (storage, k) => { try { return Number(JSON.parse(storage.getItem(k)).ts) || 0; } catch (e) { return 0; } };
function rebuildIndex(storage) {
  const idx = {};
  for (const k of cacheKeys(storage)) {
    const c = k.slice(PREFIX.length);
    if (validCode(c)) idx[c] = stamp(storage, k); else storage.removeItem(k); // never readable anyway
  }
  return idx;
}

export function saveSnapshot(storage, code, snap, now = Date.now()) {
  if (!validCode(code)) return false;
  try {
    const json = JSON.stringify({ ts: now, data: sanitize(snap) });
    if (json.length > MAX_BYTES) { dropSnapshot(storage, code); return false; }
    storage.setItem(PREFIX + code, json);
    const idx = readIndex(storage) || rebuildIndex(storage);
    delete idx[code];
    const drop = Object.keys(idx).sort((a, b) => idx[b] - idx[a]).slice(KEEP - 1); // only the last-used lists stay
    drop.forEach(c => { delete idx[c]; });
    idx[code] = now;
    writeIndex(storage, idx);
    drop.forEach(c => storage.removeItem(PREFIX + c));
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

export function dropSnapshot(storage, code) {
  try {
    storage.removeItem(PREFIX + code);
    const idx = readIndex(storage);
    if (idx && code in idx) { delete idx[code]; writeIndex(storage, idx); }
  } catch (e) { /* nothing to do */ }
}
