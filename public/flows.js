// Pure logic behind a few flows of app.js (no DOM, no storage access), so Node tests can cover it.
import { parseListCode, isListCode } from './store.js';
import { vgNumFromCode } from './vg.js';

/* ---------- Input bar ---------- */
// VG numbers have 3 to 4 digits: a longer run of digits can never be a VG number (the "+" stays muted and the
// suggestion area says why). The manual field of the scanner dialog is separate and still takes 8-14 digit barcodes.
export const MAX_VG_DIGITS = 4;
export const tooLongNumber = q => /^\d+$/.test(q) && q.length > MAX_VG_DIGITS;

/* ---------- Reset dialog ---------- */
// Which store calls the reset dialog runs, in order. The ranking is only reset on a shared list (the game does not exist locally).
export function resetPlan({ open = false, done = false, empties = false, scores = false } = {}, shared = false) {
  const ops = [];
  if (open && done) ops.push('clearAll');
  else if (open) ops.push('clearOpen');
  else if (done) ops.push('clearChecked');
  if (empties) ops.push('clearDeposit');
  if (scores && shared) ops.push('resetScores');
  return ops;
}

/* ---------- Checkout ticks ---------- */
// Rows ticked off at the checkout ("already typed in at the till") survive a reload, per list: at most TICK_MAX keys,
// dropped when the list code changes or after TICK_TTL without a change. localStorage is user-writable: sanitise on load.
export const TICK_TTL = 24 * 3600 * 1000;
export const TICK_MAX = 200;
const TICK_KEY = /^[A-Za-z0-9_-]{1,41}$/;
export function packTicks(code, keys, now) {
  return { code, ts: now, keys: [...keys].filter(k => TICK_KEY.test(k)).slice(-TICK_MAX) };
}
export function sanitizeTicks(raw, code, now) {
  if (!raw || typeof raw !== 'object' || raw.code !== code) return [];
  if (!Number.isFinite(raw.ts) || now - raw.ts > TICK_TTL || raw.ts > now + 60000) return [];
  if (!Array.isArray(raw.keys)) return [];
  return [...new Set(raw.keys.filter(k => typeof k === 'string' && TICK_KEY.test(k)))].slice(-TICK_MAX);
}
// Ticks of rows that do not exist any more are dropped
export const pruneTicks = (keys, live) => [...keys].filter(k => live.has(k));

/* ---------- Checkout rows ---------- */
// The checkout tab: items with a number of 1000 and up, bakery (numbers below 1000) and empties, each sorted by title; rows
// already typed in at the till leave their block and go into one block at the end. `deposits`: [{id, name, vgNum, n}] with
// n > 0, `ticks`: the set of ticked row keys. Weighed goods (g, kg, Liter) and single pieces show the amount beside the
// unit, counted pieces as "3 ×" before the number.
export function checkoutSections(items, deposits, ticks) {
  const byTitle = (a, b) => a.title.localeCompare(b.title, 'de');
  const row = (key, title, amount, unit, no) => {
    const weight = ['g', 'kg', 'Liter'].includes(unit) || amount === 1;
    return { key, title, amount, unit: unit || '', no: no || null, weight, done: ticks.has(key) };
  };
  const inBasket = items.filter(i => i.checked).sort(byTitle);
  const item = i => row(i.id, i.title, i.amount, i.unit, i.vgNum);
  const big = inBasket.filter(i => i.vgNum >= 1000).map(item), bakery = inBasket.filter(i => i.vgNum && i.vgNum < 1000).map(item);
  const empties = deposits.map(d => row('d' + d.id, d.name, d.n, '', d.vgNum));
  const open = rows => rows.filter(r => !r.done);
  return { items: open(big), bakery: open(bakery), empties: open(empties), done: [...big, ...bakery, ...empties].filter(r => r.done) };
}

/* ---------- Ranking ---------- */
// Ties are sorted by name, so the order never jumps between updates; same points = same place (1, 1, 3, …). The podium shows
// the first three places in the classic order 2-1-3 (no medal without points), then everybody without points.
export function rankPlaces(scores) {
  const rank = Object.entries(scores || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const placed = rank.map(([k, n]) => ({ k, n, place: 1 + rank.findIndex(r => r[1] === n) }));
  const at = p => placed.filter(x => x.place === p && x.n > 0);
  return { placed, podium: [...at(2), ...at(1), ...at(3), ...placed.filter(x => x.n === 0)], max: Math.max(1, placed[0] ? placed[0].n : 1) };
}

/* ---------- Scanning ---------- */
// What a scanned (or typed) code means. While joining only a list code or join link counts. A VG shelf label carries the
// VG number (vgNumFromCode), whether or not the VG data has loaded; any other run of 8-14 digits is a product barcode;
// anything else (a QR code with a URL, some text) is unknown.
export function classifyScan(text, { join = false } = {}) {
  const s = String(text ?? '').trim();
  if (join) { const code = parseListCode(s); return code ? { kind: 'list', code } : { kind: 'unknown' }; }
  const n = vgNumFromCode(s);
  if (n) return { kind: 'vg', n };
  if (/^\d{8,14}$/.test(s)) return { kind: 'ean', ean: s };
  return { kind: 'unknown' };
}

/* ---------- VG data loading ---------- */
// State of the VG data for the Empties tab: 'loading' -> 'ready', or 'unreachable' (the load failed, or took longer than
// slowMs; a late success still turns it 'ready'). start() is a retry: while a load is still running it only shows
// 'loading' again instead of starting a second one. Never throws, never blocks the rest of the app.
export function createVgLoader({ load, onChange = () => {}, slowMs = 10000, setTimeout: st = globalThis.setTimeout, clearTimeout: ct = globalThis.clearTimeout }) {
  let state = 'idle', data = null, timer = null, running = false;
  const emit = s => { state = s; onChange(s, data); };
  const settle = v => {
    running = false;
    if (state === 'ready') return;
    if (timer) { ct(timer); timer = null; }
    if (v) { data = v; emit('ready'); } else emit('unreachable');
  };
  return {
    get state() { return state; },
    get data() { return data; },
    start() {
      if (state === 'ready') return;
      if (timer) ct(timer);
      timer = st(() => { timer = null; if (state === 'loading') emit('unreachable'); }, slowMs);
      emit('loading');
      if (running) return;
      running = true;
      Promise.resolve().then(load).then(settle, () => settle(null));
    },
  };
}

/* ---------- Sharing the local list ---------- */
// Upload the local list into a new shared list and return its code. Touches nothing local: when it throws, the local list
// is exactly as before and the whole thing can simply be tried again. `made` carries the code of a list an earlier attempt
// created (keep the same object across retries): a retry fills that list instead of leaving a half-filled one behind.
export async function uploadLocalList(remote, data, user, made = {}) {
  if (made.code && !(await remote.exists(made.code))) made.code = null; // the earlier attempt never got the list up
  if (!made.code) {
    try { made.code = await remote.create(); } catch (e) { if (e && isListCode(e.listCode)) made.code = e.listCode; throw e; }
  }
  await remote.importList(made.code, data, user);
  return made.code;
}

/* ---------- Browser hint (iOS) ---------- */
// On iOS an installed web app cannot take over links: the camera app opens a scanned `?list=` link in Safari, and Safari and the
// installed app have separate storage. Only there the hint makes sense. `nav` and `mm` are navigator and matchMedia (fakes in tests).
export function isIosLike(nav) {
  if (!nav) return false;
  if (/iPhone|iPad|iPod/.test(String(nav.userAgent || ''))) return true;
  return nav.platform === 'MacIntel' && nav.maxTouchPoints > 1; // iPadOS pretends to be a Mac
}
export function isStandalone(nav, mm) {
  if (nav && nav.standalone === true) return true;
  try { return !!(mm && mm('(display-mode: standalone)').matches); } catch (e) { return false; }
}
// `seen` is the array of list codes the hint was already shown for
export function shouldShowBrowserHint(nav, mm, code, seen) {
  return isIosLike(nav) && !isStandalone(nav, mm) && isListCode(code) && !(Array.isArray(seen) && seen.includes(code));
}
// iPhone/iPad browser tab, not the installed app: suggest adding Kober to the home screen (once the person closed it, never again)
export function shouldShowInstallHint(nav, mm, dismissed) {
  return isIosLike(nav) && !isStandalone(nav, mm) && dismissed !== true;
}
// Android browser tab (Chrome fires `beforeinstallprompt`): offer the real install button; closing the dialog once means never again.
// There is no storage split on Android (an installed web app shares it with the browser and can take over links), so no join advice.
export function isAndroid(nav) { return !!nav && /Android/.test(String(nav.userAgent || '')); }
export function shouldShowAndroidInstall(nav, mm, dismissed) {
  return isAndroid(nav) && !isStandalone(nav, mm) && dismissed !== true;
}
// Stored list of codes (localStorage is user-writable): only valid codes, at most 20, newest last
export function sanitizeHintSeen(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(c => typeof c === 'string' && isListCode(c)).slice(-20);
}
export function addHintSeen(seen, code) {
  return seen.includes(code) ? seen : [...seen, code].slice(-20);
}

/* ---------- Own item history (suggestions) ---------- */
// For all lists together: the names the person added or checked off, with a count and the last use. `{ ALL: [{ t, n, ts, v? }] }` in
// localStorage (user-writable: everything is validated again). Bounded: HISTORY_MAX names.
export const HISTORY_MAX = 1000;
export const HISTORY_TITLE_MAX = 60;
export const HISTORY_KEY = 'ALL'; // one table for every list on this phone
const historyCode = c => c === HISTORY_KEY;
const historyKey = title => String(title).trim().toLowerCase();
const cleanTitle = s => typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, HISTORY_TITLE_MAX) : '';
export function sanitizeHistory(raw, now = Date.now()) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const code of Object.keys(raw).filter(historyCode)) {
    const seen = new Set(), list = [];
    for (const e of Array.isArray(raw[code]) ? raw[code] : []) {
      if (!e || typeof e !== 'object') continue;
      const t = cleanTitle(e.t), k = historyKey(t);
      if (!t || seen.has(k) || !Number.isInteger(e.n) || e.n < 1 || !Number.isFinite(e.ts) || e.ts > now + 60000) continue;
      seen.add(k);
      list.push({ t, n: Math.min(e.n, 9999), ts: e.ts, ...(Number.isInteger(e.v) && e.v > 0 && e.v < 10000 ? { v: e.v } : {}) });
    }
    if (list.length) out[code] = list.sort((a, b) => b.ts - a.ts).slice(0, HISTORY_MAX);
  }
  return out;
}
// Count one use of `title` on list `code` (a VG number, when the item has one, is remembered). Returns a new table; the oldest
// lists and the least used old names fall out when the bounds are hit.
export function recordHistory(table, code, title, vgNum, now = Date.now()) {
  const t = cleanTitle(title); if (!t || !historyCode(code)) return table;
  const list = [...(table[code] || [])], k = historyKey(t), i = list.findIndex(e => historyKey(e.t) === k);
  const v = Number.isInteger(vgNum) && vgNum > 0 && vgNum < 10000 ? vgNum : null;
  if (i >= 0) { const e = list[i]; list[i] = { t: e.t, n: Math.min(e.n + 1, 9999), ts: now, ...(v ? { v } : e.v ? { v: e.v } : {}) }; }
  else list.push({ t, n: 1, ts: now, ...(v ? { v } : {}) });
  list.sort((a, b) => b.ts - a.ts);
  const next = { ...table }; delete next[code]; next[code] = list.slice(0, HISTORY_MAX); // the newest list is last
  return next;
}
// Matching names for what is typed (every word is a prefix of a word or a part of the name), most used first, then most recent.
// Names that equal the typed text exactly are left out (nothing to suggest).
export function historyMatches(list, q, limit = 4) {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length || words.join(' ').length < 2) return [];
  const typed = words.join(' ');
  return (list || []).filter(e => { const k = historyKey(e.t); return k !== typed && words.every(w => k.includes(w)); })
    .sort((a, b) => (historyKey(b.t).startsWith(words[0]) - historyKey(a.t).startsWith(words[0])) || b.n - a.n || b.ts - a.ts)
    .slice(0, limit);
}
// Remove from `names` (VG name suggestions) those the history already shows
export const withoutHistory = (names, hist) => { const s = new Set(hist.map(e => historyKey(e.t))); return names.filter(p => !s.has(historyKey(p.title))); };
