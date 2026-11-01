// Persistent outbox of INTENTS (not results) for writes to a shared list that could not be sent yet.
//
// The Firebase SDK queues offline writes in memory only: a reload loses them. So every queueable store operation is
// written down here (localStorage, `NS + 'kober-outbox'`) as {id, code, op, args, ts} before it is tried, and removed when
// the store call has resolved. On start (and whenever the connection is `ok` again) what is left is replayed, in order,
// through the same store methods. Replay is safe because those methods abort when the target state already matches
// (add of an existing item, check to the state it already has, remove of a missing item, setNum/setEan with the same value).
// Two things are not idempotent by nature and are handled on purpose:
//   - the point (`bump`) that follows an item change is a second transaction. It is journaled as its own entry
//     (`op: 'bump'`) the moment the item transaction has committed, so a reload in between neither loses nor doubles it;
//   - `depositAdd` adds one piece each time: it can only double if the page dies between the commit and the removal of
//     the entry (a window of milliseconds), which is accepted.
// Known limits (documented in AGENTS.md): a replayed `add` of an item somebody deleted meanwhile reappears; a replayed
// `check` overrides a change another person made while we were offline (last writer wins); two tabs of the same browser
// would both replay. Everything read from localStorage is untrusted (the user can edit it): every entry is validated
// again with the same rules as store.js, invalid ones are dropped.
import { NS } from './env.js';
import { isId, isUserKey, isPending } from './store.js';

export const MAX_ENTRIES = 200, MAX_AGE = 24 * 3600e3, MAX_TRIES = 3;
const TYPE = /^[A-Za-z0-9_-]{1,20}$/;
const num = (v, lo, hi) => { const n = Math.round(Number(v)); return v !== null && v !== '' && v !== undefined && Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
const str = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);

// Argument validators per operation: return the normalised argument list, or null for an invalid one
const VALID = {
  add: ([item, user]) => {
    if (!item || typeof item !== 'object' || !isId(item.id) || typeof item.title !== 'string' || !item.title.trim() || !isUserKey(user)) return null;
    const c = { id: item.id, title: item.title.trim().slice(0, 120) };
    if (num(item.vgNum, 1, 9999999)) c.vgNum = num(item.vgNum, 1, 9999999);
    if (/^\d{8,14}$/.test(item.ean)) c.ean = item.ean;
    if (num(item.amount, 1, 999)) c.amount = num(item.amount, 1, 999);
    if (str(item.unit, 20)) c.unit = str(item.unit, 20);
    if (str(item.info, 200)) c.info = str(item.info, 200);
    return [c, user];
  },
  check: ([id, user, want]) => isId(id) && isUserKey(user) && typeof want === 'boolean' ? [id, user, want] : null,
  setNum: ([id, user, vgNum, checkToo, extra]) => {
    if (!isId(id) || !isUserKey(user)) return null;
    const e = {}, x = extra && typeof extra === 'object' ? extra : {};
    if (str(x.title, 120)) e.title = str(x.title, 120);
    if (str(x.info, 200)) e.info = str(x.info, 200);
    return [id, user, num(vgNum, 1, 9999999), !!checkToo, e];
  },
  setEan: ([id, user, ean, checkToo]) => isId(id) && isUserKey(user) && /^\d{8,14}$/.test(String(ean)) ? [id, user, String(ean), !!checkToo] : null,
  remove: ([id]) => isId(id) ? [id] : null,
  depositAdd: ([typeId, user]) => TYPE.test(String(typeId)) && isUserKey(user) ? [String(typeId), user] : null,
  depositRemove: ([typeId, user]) => TYPE.test(String(typeId)) && isUserKey(user) ? [String(typeId), user] : null,
  bump: ([key, d]) => isUserKey(key) && (d === 1 || d === -1) ? [key, d] : null,
};
export const QUEUEABLE = Object.keys(VALID).filter(op => op !== 'bump');

// A stored or new entry in its clean form, or null
export function validEntry(e, now = Date.now()) {
  if (!e || typeof e !== 'object' || !VALID[e.op] || !/^[A-Z0-9]{6}$/.test(String(e.code)) || !Array.isArray(e.args)) return null;
  const args = VALID[e.op](e.args);
  const ts = Number(e.ts);
  if (!args || !Number.isFinite(ts) || ts <= 0) return null;
  return { id: typeof e.id === 'string' && /^[\w-]{1,40}$/.test(e.id) ? e.id : null, code: e.code, op: e.op, args, ts: Math.min(ts, now) };
}

// What the list will look like once the entries that wait to be sent are applied. Pure. Points are never shown ahead of the
// server (they are counted when the connection is back); empties are, because they are the number on the button.
export function overlay(state, entries) {
  if (!entries.length) return state;
  const items = { ...state.items }, deposit = { ...state.deposit };
  for (const e of entries) {
    const [a, b, c, d] = e.args;
    if (e.op === 'add') {
      if (!items[a.id]) items[a.id] = { id: a.id, title: a.title, amount: a.amount || 1, unit: a.unit || null, info: a.info || null, vgNum: a.vgNum || null, ean: a.ean || null, checked: false, checkedBy: null, checkedAt: null, addedBy: b, addedAt: e.ts };
    } else if (e.op === 'check') {
      const i = items[a];
      if (i && !!i.checked !== c) items[a] = { ...i, checked: c, checkedBy: c ? b : null, checkedAt: c ? e.ts : null };
    } else if (e.op === 'setNum' || e.op === 'setEan') {
      const i = items[a];
      if (!i) continue;
      const n = { ...i };
      if (e.op === 'setNum') {
        n.vgNum = c;
        if (e.args[4].title && /^VG(-Nr\.| no\.) \d+$/.test(i.title)) n.title = e.args[4].title;
        if (e.args[4].info) n.info = e.args[4].info;
      } else n.ean = c;
      if (d && !i.checked) { n.checked = true; n.checkedBy = b; n.checkedAt = e.ts; }
      items[a] = n;
    } else if (e.op === 'remove') delete items[a];
    else if (e.op === 'depositAdd') deposit[a] = { ...deposit[a], [b]: ((deposit[a] || {})[b] || 0) + 1 };
    else if (e.op === 'depositRemove') {
      const group = deposit[a] || {}, victim = group[b] > 0 ? b : Object.keys(group).sort((x, y) => group[y] - group[x])[0];
      if (victim && group[victim] > 0) { const g = { ...group, [victim]: group[victim] - 1 }; if (!g[victim]) delete g[victim]; if (Object.keys(g).length) deposit[a] = g; else delete deposit[a]; }
    }
  }
  return { ...state, items, deposit };
}

export function createOutbox({ storage = globalThis.localStorage, now = () => Date.now(), onFull, max = MAX_ENTRIES, maxAge = MAX_AGE, key = NS + 'kober-outbox' } = {}) {
  let seq = 0, fullWarned = false, entries = [];
  const live = new Map(); // id -> 'running' (a store call is on its way) | 'late' (timed out, the SDK still holds it)
  const subs = new Set();
  const notify = () => subs.forEach(fn => { try { fn(); } catch (e) { /* a listener must not break the outbox */ } });
  const newId = () => `${now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const save = () => { try { storage.setItem(key, JSON.stringify(entries.map(({ id, code, op, args, ts }) => ({ id, code, op, args, ts })))); } catch (e) { /* storage full or blocked: memory only */ } };
  const expired = e => now() - e.ts > maxAge;
  const load = () => {
    let raw = [];
    try { raw = JSON.parse(storage.getItem(key)) || []; } catch (e) { raw = []; }
    const seen = new Set();
    entries = (Array.isArray(raw) ? raw : []).map(e => validEntry(e, now())).filter(e => e && !expired(e)).map(e => {
      const id = e.id && !seen.has(e.id) ? e.id : newId(); seen.add(id); return { ...e, id };
    }).slice(-max);
    save();
  };
  load();

  const drop = id => {
    const n = entries.length;
    entries = entries.filter(e => e.id !== id); live.delete(id);
    if (entries.length !== n) { save(); if (!entries.length) fullWarned = false; notify(); }
  };
  const push = e => {
    const entry = { ...e, id: newId() };
    entries.push(entry);
    while (entries.length > max) { // too many: the oldest one that is not on its way goes
      const i = entries.findIndex(x => x !== entry && !live.has(x.id));
      if (i < 0) break;
      entries.splice(i, 1);
      if (!fullWarned) { fullWarned = true; onFull && onFull(); }
    }
    save(); notify();
    return entry;
  };
  const unsent = code => entries.filter(e => (code == null || e.code === code) && !live.has(e.id));

  const api = {
    key, MAX: max,
    entries: () => entries.slice(),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    // changes waiting for a list (the internal point entries are not "changes" for the person)
    count: code => entries.filter(e => e.code === code && e.op !== 'bump').length,
    has: code => entries.some(e => e.code === code),
    // the list with the waiting changes applied. Empties steps only while they have not been handed to the SDK (it shows
    // those by itself, and a counter step would count twice); setting a state again is harmless, so those show until struck out
    overlayFor: (state, code) => overlay(state, entries.filter(e => e.code === code && e.op !== 'bump' && (!live.has(e.id) || !/^deposit/.test(e.op)))),
    dropList(code) { entries.filter(e => e.code === code).forEach(e => drop(e.id)); },
    // Journal for store.js: the point after an item change is written down before it is sent
    journal: {
      begin(code, k, d) {
        const e = validEntry({ code, op: 'bump', args: [k, d], ts: now() }, now());
        if (!e) return null;
        const entry = push(e); live.set(entry.id, 'running'); return entry.id;
      },
      done: id => drop(id),
    },
    // The store whose queueable operations go through the outbox. `conn` says whether the connection can be used now.
    wrap(raw, conn) {
      const state = () => (conn ? conn.state() : 'ok');
      const tries = new Map();
      // Run one entry through the store. A timeout keeps it (the SDK still has the write; once that has finished it goes);
      // a real failure drops it, unless `keep` is set (replay: it is tried again later, a few times at most).
      async function run(e, keep = false) {
        live.set(e.id, 'running');
        try { const r = await raw[e.op](e.code, ...e.args); drop(e.id); return r; } catch (err) {
          if (isPending(err)) {
            live.set(e.id, 'late'); notify();
            err.late.then(() => drop(e.id), () => { live.delete(e.id); notify(); });
            return { committed: false, queued: true };
          }
          live.delete(e.id);
          if (keep) { const n = (tries.get(e.id) || 0) + 1; tries.set(e.id, n); if (n >= MAX_TRIES) drop(e.id); else notify(); } else drop(e.id);
          throw err;
        }
      }
      let flushing = false, again = null;
      // Replay what is waiting for `code`, oldest first, while the connection is ok
      async function flush(code) {
        if (flushing) { again = code; return; }
        flushing = true;
        const skip = new Set();
        try {
          for (;;) {
            if (state() !== 'ok') break;
            const e = unsent(code).find(x => !skip.has(x.id));
            if (!e) { if (again) { code = again; again = null; skip.clear(); continue; } break; }
            if (expired(e)) { drop(e.id); continue; }
            if (!validEntry(e, now())) { drop(e.id); continue; }
            const r = await run(e, true).catch(() => { skip.add(e.id); return null; });
            if (r && r.queued) break; // timed out: the connection is not good, the conn state decides when to go on
          }
        } finally { flushing = false; }
      }
      const queued = op => (code, ...args) => {
        const v = validEntry({ code, op, args, ts: now() }, now());
        if (!v) return raw[op](code, ...args); // invalid input: the store says no, as before
        const mine = push(v), st = state();
        if ((st === 'ok' || st === 'connecting') && !unsent(code).some(x => x !== mine)) return run(mine);
        if (st === 'ok') flush(code);
        return Promise.resolve({ committed: false, queued: true });
      };
      const store = { ...raw, flush, outbox: api };
      for (const op of QUEUEABLE) store[op] = queued(op);
      return store;
    },
  };
  return api;
}
