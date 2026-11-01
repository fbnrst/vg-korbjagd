// Pure logic behind a few flows of app.js (no DOM, no storage access), so Node tests can cover it.

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
// is exactly as before and the whole thing can simply be tried again.
export async function uploadLocalList(remote, data, user) {
  const code = await remote.create();
  await remote.importList(code, data, user);
  return code;
}
