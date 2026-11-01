// Data layer: list logic written once, against an adapter (Firebase or local).
// Adapter interface: subscribe(code, cb, onStatus) -> unsubscribe, get(code, path),
// update(code, path, fn) -> {committed} (transaction; fn returns undefined = abort, null = delete),
// set(code, path, value), remove(code, path). Optional: connect() / disconnect() (Firebase: goOnline / goOffline), used by
// conn.js for deliberate reconnects while the server is busy.
// Firebase key characters and HTML special characters (keys end up in the rendering) are replaced.
// Must match the rules in database.rules.json: "<emoji without spaces> <name>", at most 60 characters.
import { NS } from './env.js';
import { toPos } from './order.js';
const BAD = /[.$#\[\]\/<>&"'`\u0000-\u001f]/g;
export const userKey = (emoji, name) => {
  const e = String(emoji ?? '').replace(BAD, '_').replace(/\s+/g, '').slice(0, 20) || '🙂';
  const n = String(name ?? '').replace(BAD, '_').replace(/\s+/g, ' ').trim().slice(0, 30) || '_';
  return `${e} ${n}`;
};
export const isUserKey = k => typeof k === 'string' && k.length <= 60 && /^[^ <>&"'`]{1,20} [^<>&"'`]{1,30}$/.test(k);
// List codes: 8 characters for new lists, 6 for lists created before (both stay valid; database.rules.json allows the same)
export const isListCode = c => /^[A-Z0-9]{6,8}$/.test(String(c));
// A list code typed by hand, or the link / QR content of a shared list ("...?list=CODE"): the code or null
export function parseListCode(text) {
  let s = String(text || '').trim();
  try { const c = new URL(s).searchParams.get('list'); if (c) s = c; } catch (e) { /* not a link: plain code */ }
  s = s.toUpperCase();
  return isListCode(s) ? s : null;
}
export const isId = k => typeof k === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(k);
// Shared validators (also used by outbox.js and cache.js for what comes back from localStorage); in line with database.rules.json.
// Empties type ids (deposit/<type>), as in the rules
export const isTypeId = v => /^[A-Za-z0-9_-]{1,20}$/.test(String(v));
// A whole number in [lo, hi] (rounded; inclusive) or null; null, '' and undefined are null, not 0
export const intIn = (v, lo, hi) => { const n = Math.round(Number(v)); return v !== null && v !== '' && v !== undefined && Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
// A non-empty string cut to max characters, or null
export const strMax = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);
// The placeholder title of an item added by number before the VG data had loaded ("VG-Nr. 123" / "VG no. 123")
export const isPlaceholderTitle = t => /^VG(-Nr\.| no\.) \d+$/.test(t);
const toNum = v => intIn(v, 1, 9999999);

export async function firebaseAdapter(cfg) {
  // Firebase JS SDK 10.14.1, served from our own origin (vendor/firebase/, see LICENSE.txt there); loaded only for shared lists
  const [{ initializeApp }, { getDatabase, ref, onValue, runTransaction, set, get, remove, goOnline, goOffline, serverTimestamp }] = await Promise.all([
    import('./vendor/firebase/firebase-app.js'),
    import('./vendor/firebase/firebase-database.js'),
  ]);
  const db = getDatabase(initializeApp(cfg));
  const r = (code, path) => ref(db, `lists/${code}${path ? '/' + path : ''}`);
  return {
    mode: 'firebase',
    // The server fills in its own time: a phone with a wrong clock must not make an active list look old to the cleanup
    serverTime: () => serverTimestamp(),
    connect: () => goOnline(db),
    disconnect: () => goOffline(db),
    subscribe(code, cb, onStatus) {
      const off1 = onValue(r(code), s => cb(s.val()));
      const off2 = onValue(ref(db, '.info/connected'), s => onStatus && onStatus(!!s.val()));
      return () => { off1(); off2(); };
    },
    async get(code, path) { return (await get(r(code, path))).val(); },
    async update(code, path, fn) { const res = await runTransaction(r(code, path), v => fn(v ?? null)); return { committed: res.committed }; },
    set: (code, path, v) => set(r(code, path), v),
    remove: (code, path) => remove(r(code, path)),
  };
}

// Local adapter: JSON in a storage (localStorage); tabs in the same browser see each other via the storage event.
// Only for trying things out without a Firebase account and for tests (with their own storage object).
export function localAdapter(storage = globalThis.localStorage, listen = true) {
  const KEY = NS + 'kober-local-db', subs = new Set();
  const load = () => { try { return JSON.parse(storage.getItem(KEY)) || {}; } catch (e) { return {}; } };
  const notify = () => { const d = load(); subs.forEach(s => s.cb(d[s.code] ?? null)); };
  const save = d => { storage.setItem(KEY, JSON.stringify(d)); notify(); };
  if (listen && typeof addEventListener === 'function') addEventListener('storage', e => { if (e.key === KEY) notify(); });
  const parts = p => (p ? p.split('/') : []);
  const read = (d, code, path) => parts(path).reduce((o, k) => (o == null ? null : o[k] ?? null), d[code] ?? null);
  const write = (code, path, value) => {
    const d = load(); d[code] = d[code] || {};
    const ks = parts(path);
    if (!ks.length) d[code] = value ?? {};
    else {
      const chain = [d[code]];
      ks.slice(0, -1).forEach(k => { chain.push(chain[chain.length - 1][k] = chain[chain.length - 1][k] || {}); });
      const last = ks[ks.length - 1];
      if (value == null) delete chain[chain.length - 1][last]; else chain[chain.length - 1][last] = value;
      // like Firebase: empty nodes disappear
      for (let i = chain.length - 1; i > 0 && !Object.keys(chain[i]).length; i--) delete chain[i - 1][ks[i - 1]];
    }
    save(d);
  };
  return {
    mode: 'local',
    connect() {}, // nothing to reconnect
    disconnect() {},
    subscribe(code, cb, onStatus) {
      const s = { code, cb }; subs.add(s);
      queueMicrotask(() => { onStatus && onStatus(true); cb(load()[code] ?? null); }); // connected first, then the data, like the server
      return () => subs.delete(s);
    },
    async get(code, path) { return read(load(), code, path); },
    async update(code, path, fn) {
      const old = read(load(), code, path), next = fn(old);
      if (next === undefined) return { committed: false };
      write(code, path, next); return { committed: true };
    },
    async set(code, path, v) { write(code, path, v); },
    async remove(code, path) { write(code, path, null); },
  };
}

// Normalised item as stored in the database (also used when moving a local list to a shared one)
const makeItem = (i, user) => ({
  id: i.id, title: String(i.title).trim().slice(0, 120), amount: i.amount > 1 ? Math.min(999, Math.round(i.amount)) : 1,
  unit: i.unit ? String(i.unit).slice(0, 20) : null, info: i.info ? String(i.info).slice(0, 200) : null,
  vgNum: toNum(i.vgNum), ean: /^\d{8,14}$/.test(i.ean) ? i.ean : null,
  checked: false, checkedBy: null, checkedAt: null, pos: toPos(i.pos), addedBy: user, addedAt: Date.now() });

// An item as it was (id, number, ean, amount, state), for putting a deleted item back. Pure; null for an unusable item.
export function restoredItem(i, user) {
  if (!i || !isId(i.id) || !String(i.title || '').trim()) return null;
  const item = makeItem(i, isUserKey(i.addedBy) ? i.addedBy : user);
  if (Number(i.addedAt) > 0) item.addedAt = Number(i.addedAt);
  if (i.checked) { item.checked = true; item.checkedBy = isUserKey(i.checkedBy) ? i.checkedBy : user; item.checkedAt = Number(i.checkedAt) || Date.now(); }
  return item;
}
// Nothing on the list at all (open or checked off): the start hint is shown
export const isEmptyList = items => !items || !Object.keys(items).length;

// A write that does not answer in time. The operation itself is not cancelled (Firebase keeps transactions queued and
// runs them when the connection is back): `late` settles with its real outcome, so callers can continue then.
export class PendingError extends Error {
  constructor(op, late) { super(`${op} is pending`); this.name = 'PendingError'; this.pending = true; this.late = late; }
}
export const isPending = e => !!(e && e.pending);

// Timeout guard around the adapter calls: a hanging call becomes a PendingError after `timeoutMs` instead of hanging
// the UI. `onResult(true)` reports every call that finished (also late), `onResult(false)` every timeout.
export function guardAdapter(db, { timeoutMs = 8000, setTimeout: st = (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: ct = id => globalThis.clearTimeout(id), onResult } = {}) {
  const wrap = op => (...args) => {
    let p;
    try { p = Promise.resolve(db[op](...args)); } catch (e) { p = Promise.reject(e); }
    return new Promise((resolve, reject) => {
      let timedOut = false;
      const timer = st(() => { timedOut = true; onResult && onResult(false); reject(new PendingError(op, p)); }, timeoutMs);
      p.then(v => { ct(timer); if (onResult) onResult(true); if (!timedOut) resolve(v); }, e => { ct(timer); if (!timedOut) reject(e); });
    });
  };
  return { ...db, get: wrap('get'), update: wrap('update'), set: wrap('set'), remove: wrap('remove') };
}

export function createStore(rawDb, guardOpts = {}) {
  const db = guardAdapter(rawDb, guardOpts), conn = guardOpts.conn, journal = guardOpts.journal;
  // Time stamps the cleanup relies on (meta.created, activity): server time where the adapter has it, else this device's clock
  const stampNow = () => (rawDb.serverTime ? rawDb.serverTime() : Date.now());
  // Taking a point from a player who is not on the board (renamed meanwhile) changes nothing: no phantom player with 0 points
  const bumpOnce = (code, key, d) => db.update(code, `scores/${key}`, n => (n == null && d < 0 ? undefined : Math.min(100000, Math.max(0, (n || 0) + d))));
  // One retry for a failure that is not a timeout: the item is already changed, a lost point would never be corrected
  const bump = (code, key, d) => isUserKey(key) ? bumpOnce(code, key, d).catch(e => { if (isPending(e)) throw e; return bumpOnce(code, key, d); }) : null;
  // The point after an item change. With a journal (the outbox) it is written down before it is sent and struck out when it
  // went through, so a reload between the item transaction and the point neither loses nor doubles it.
  const point = (code, key, d) => {
    if (!isUserKey(key)) return null;
    const id = journal ? journal.begin(code, key, d) : null;
    const p = bump(code, key, d);
    if (id) p.then(() => journal.done(id), e => { if (isPending(e)) e.late.then(() => journal.done(id), () => {}); else journal.done(id); });
    return p;
  };
  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  // The code is the only secret of a list: crypto randomness, not Math.random. 32 characters divide 256, so `% 32` has no bias.
  // 8 characters = 40 bits (lists created before have 6 and stay valid)
  const randCode = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => CHARS[b % CHARS.length]).join('');
  // The point (bump) is a second transaction after the one that changed the item. If the first one timed out it is still
  // queued and may commit later, and then the point must follow it, otherwise it is lost.
  const followUp = async (txn, next) => {
    let r;
    try { r = await txn; } catch (e) { if (isPending(e)) e.late.then(next).catch(() => {}); throw e; }
    return next(r);
  };
  // A step that timed out is still queued in the SDK: wait for its real outcome instead of giving up halfway
  const settled = p => p.catch(e => (isPending(e) ? e.late : Promise.reject(e)));
  const store = {
    mode: rawDb.mode,
    subscribe: (code, cb, onStatus) => rawDb.subscribe(code, cb, onStatus),
    connect: () => rawDb.connect && rawDb.connect(),
    disconnect: () => rawDb.disconnect && rawDb.disconnect(),
    async create() {
      let code;
      do { code = randCode(); } while (await db.get(code, 'meta'));
      // a timeout says which code it was: the write is still queued, so a retry can check whether the list came up
      try { await db.set(code, 'meta', { created: stampNow() }); } catch (e) { if (isPending(e)) e.listCode = code; throw e; }
      return code;
    },
    async exists(code) { return !!(await db.get(code, 'meta')); },
    // Change name or emoji on a list: points, empties and the "by <name>" marks move to the new key, so the old
    // name does not stay behind in the ranking as a second player. Points and empties move in one transaction each, so a
    // point that lands on the old name meanwhile is not lost. A step that times out is waited for, never skipped: the rename
    // finishes when the connection is back instead of stopping halfway (the caller awaits the whole thing).
    async renameUser(code, from, to) {
      if (!isUserKey(from) || !isUserKey(to) || from === to) return;
      const move = group => { const next = { ...group, [to]: Math.min(100000, (group[to] || 0) + (group[from] || 0)) }; delete next[from]; return next; };
      await settled(db.update(code, 'scores', s => (s && s[from] != null) || !(s && s[to] != null) ? move(s || {}) : undefined));
      await settled(db.update(code, 'deposit', d => {
        if (!d || !Object.values(d).some(users => users && users[from] != null)) return undefined;
        return Object.fromEntries(Object.entries(d).map(([typ, users]) => [typ, users && users[from] != null ? move(users) : users]));
      }));
      for (const [id, it] of Object.entries((await settled(db.get(code, 'items'))) || {})) {
        if (!it || !isId(id) || (it.checkedBy !== from && it.addedBy !== from)) continue;
        await settled(db.update(code, `items/${id}`, old => old ? { ...old, ...(old.checkedBy === from ? { checkedBy: to } : {}), ...(old.addedBy === from ? { addedBy: to } : {}) } : undefined));
      }
    },
    // Replay of a journaled point (outbox.js): the plain counter change, not journaled again
    bump: (code, key, d) => isUserKey(key) && (d === 1 || d === -1) ? bump(code, key, d) : null,
    join: (code, user) => !isUserKey(user) ? null : db.update(code, `scores/${user}`, n => (n == null ? 0 : undefined)),
    add(code, item, user) {
      const title = String(item.title || '').trim().slice(0, 120);
      if (!title || !isId(item.id) || !isUserKey(user)) return null;
      return db.update(code, `items/${item.id}`, old => old ? undefined : makeItem({ ...item, title }, user));
    },
    async check(code, id, user, want) {
      if (!isId(id) || !isUserKey(user)) return;
      let prev;
      const toggle = db.update(code, `items/${id}`, old => {
        prev = old;
        if (!old || !!old.checked === want) return undefined;
        return { ...old, checked: want, checkedBy: want ? user : null, checkedAt: want ? Date.now() : null };
      });
      await followUp(toggle, r => r.committed && point(code, want ? user : prev.checkedBy, want ? 1 : -1));
    },
    // Manual order: set the position of ONE open item (see order.js). Aborts when it already has that position or is gone/checked,
    // so an outbox replay is harmless. A reorder that needs several writes (renumbering) is several of these calls.
    async move(code, id, pos) {
      pos = toPos(pos);
      if (!isId(id) || pos === null) return;
      await db.update(code, `items/${id}`, old => (!old || old.checked || old.pos === pos ? undefined : { ...old, pos }));
    },
    // Add the VG number later; with checkToo the item also goes into the basket
    // extra: {title, info} from the VG database; the title only replaces the placeholder "VG no. 123" (formerly "VG-Nr. 123")
    async setNum(code, id, user, vgNum, checkToo, extra = {}) {
      if (!isId(id) || !isUserKey(user)) return;
      vgNum = toNum(vgNum);
      let newlyChecked = false;
      await followUp(db.update(code, `items/${id}`, old => {
        newlyChecked = false;
        if (!old) return undefined;
        const next = { ...old, vgNum };
        if (extra.info) next.info = String(extra.info).slice(0, 200);
        if (extra.title && isPlaceholderTitle(old.title)) next.title = String(extra.title).slice(0, 120);
        if (checkToo && !old.checked) { next.checked = true; next.checkedBy = user; next.checkedAt = Date.now(); newlyChecked = true; }
        return next;
      }), () => newlyChecked && point(code, user, 1));
    },
    // Remember a scanned product barcode on an item (so scanning it again finds the item); optionally check it off
    async setEan(code, id, user, ean, checkToo) {
      if (!isId(id) || !isUserKey(user) || !/^\d{8,14}$/.test(String(ean))) return;
      let newlyChecked = false;
      await followUp(db.update(code, `items/${id}`, old => {
        newlyChecked = false;
        if (!old) return undefined;
        const next = { ...old, ean: String(ean) };
        if (checkToo && !old.checked) { next.checked = true; next.checkedBy = user; next.checkedAt = Date.now(); newlyChecked = true; }
        return next;
      }), () => newlyChecked && point(code, user, 1));
    },
    async remove(code, id) {
      let prev;
      await followUp(db.update(code, `items/${id}`, old => { prev = old; return old ? null : undefined; }), () => prev && prev.checked && point(code, prev.checkedBy, -1));
    },
    // Undo of remove: the item comes back under the same id with its old data. Deleting a checked item took the point back
    // from the person who got it, so restoring gives it back: the score ends up where it was, nothing is counted twice.
    // If the id exists again meanwhile (somebody re-added it) nothing happens.
    async restore(code, item, user) {
      const full = restoredItem(item, user);
      if (!full) return;
      await followUp(db.update(code, `items/${full.id}`, old => old ? undefined : full), r => r.committed && full.checked && point(code, full.checkedBy, 1));
    },
    // Deposit: deposit/<type>/<user> = pieces. Each piece gives the person who enters it one point.
    async depositAdd(code, typeId, user) {
      if (!isTypeId(typeId) || !isUserKey(user)) return;
      await followUp(db.update(code, `deposit/${typeId}/${user}`, n => (n || 0) + 1), r => r.committed && point(code, user, 1));
    },
    // Fewer: own pieces first, otherwise those of the largest contributor (the point is deducted there)
    async depositRemove(code, typeId, user) {
      if (!isTypeId(typeId)) return;
      const group = (await db.get(code, `deposit/${typeId}`)) || {};
      const victim = group[user] > 0 ? user : Object.keys(group).sort((a, b) => group[b] - group[a])[0];
      if (!victim) return;
      let took = false;
      await followUp(db.update(code, `deposit/${typeId}/${victim}`, n => { took = n > 0; return n > 1 ? n - 1 : n > 0 ? null : undefined; }), () => took && point(code, victim, -1));
    },
    clearDeposit: code => db.remove(code, 'deposit'),
    // Move a local list into a (new) shared list. Items keep their state, but no points are awarded:
    // the game starts with sharing. Empties of all local contributors are summed up under `user`.
    async importList(code, { items = {}, deposit = {} } = {}, user) {
      if (!isUserKey(user)) return;
      for (const i of Object.values(items || {})) {
        if (!i || !isId(i.id) || !String(i.title || '').trim()) continue;
        const item = makeItem(i, user);
        if (i.checked) { item.checked = true; item.checkedBy = user; item.checkedAt = Number(i.checkedAt) || Date.now(); }
        item.addedAt = Number(i.addedAt) || item.addedAt;
        await db.set(code, `items/${i.id}`, item);
      }
      for (const [typeId, group] of Object.entries(deposit || {})) {
        const n = Math.round(Object.values(group || {}).reduce((sum, v) => sum + (Number(v) || 0), 0));
        if (n > 0 && isTypeId(typeId)) await db.set(code, `deposit/${typeId}/${user}`, Math.min(100000, n));
      }
      await db.update(code, `scores/${user}`, n => (n == null ? 0 : undefined));
    },
    // Remove every item (points and empties stay, like clearChecked)
    clearAll: code => db.remove(code, 'items'),
    async clearChecked(code) {
      const items = (await db.get(code, 'items')) || {};
      await Promise.all(Object.values(items).filter(i => i.checked).map(i => db.remove(code, `items/${i.id}`)));
    },
    async clearOpen(code) {
      const items = (await db.get(code, 'items')) || {};
      await Promise.all(Object.values(items).filter(i => !i.checked).map(i => db.remove(code, `items/${i.id}`)));
    },
    // New round: every counter goes back to zero (the members stay). What already lies in the basket counts for nobody;
    // taking an old item out later cannot push a counter below zero. One transaction: a player who joins or a point that
    // lands meanwhile is not overwritten by a stale copy of the board.
    async resetScores(code) {
      await db.update(code, 'scores', s => (s && Object.keys(s).length ? Object.fromEntries(Object.keys(s).map(k => [k, 0])) : undefined));
    },
  };

  // Activity stamp (`activity`, ms): the server-side cleanup deletes lists after 30 days without activity.
  // Opening or changing a list counts; the stamp is written at most once per hour per list.
  const touched = {};
  const touch0 = code => Promise.resolve(db.set(code, 'activity', stampNow())).catch(() => {}); // rules not updated yet or offline: harmless
  const touch = code => {
    const now = Date.now();
    if (!code || now - (touched[code] || 0) < 3600e3) return null;
    if (conn && conn.state() !== 'ok') return null; // no extra write while the connection is shaky; the next change stamps it
    touched[code] = now;
    return touch0(code);
  };
  for (const name of ['join', 'bump', 'add', 'check', 'move', 'setNum', 'setEan', 'remove', 'restore', 'depositAdd', 'depositRemove', 'clearDeposit', 'clearChecked', 'clearOpen', 'clearAll', 'resetScores', 'importList', 'renameUser']) {
    const fn = store[name];
    store[name] = async (code, ...args) => { const r = await fn(code, ...args); touch(code); return r; };
  }
  const create = store.create;
  store.create = async () => { const code = await create(); touched[code] = Date.now(); await touch0(code); return code; };
  // Delete a whole list for everyone (the rules allow writes at list level only for deleting).
  store.deleteList = async code => { delete touched[code]; await db.remove(code, ''); };
  return store;
}
