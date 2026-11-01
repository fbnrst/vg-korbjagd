// Connection health for a shared list. Pure logic: no DOM, no Firebase, every clock and timer is injected, so the tests
// can run it with a manual clock. The app feeds it the facts (`onStatus` from .info/connected, `opResult` from the
// write guard in store.js) and shows what `state()` says.
//
// States:
//   ok          connected and stable
//   connecting  start of a subscription, the first seconds (grace period, nothing is shown)
//   degraded    disconnected for 3 s or more, or flapping (3+ drops in 60 s), or writes are timing out
//   busy        never connected within 15 s of the start, or repeated connect-then-drop within ~2 s (what the server
//               does when the connection limit is reached: it accepts the connection and drops it again)
// Hysteresis: worse states are entered only after the condition has held for its time (3 s of disconnect, ...), and the
// way back to ok needs 5 s of stable connection.
export const GRACE = 3000, BUSY_FIRST = 15000, STABLE = 5000, SHORT_LIVED = 2000, FLAP_WINDOW = 60000, FAIL_WINDOW = 30000, ATTEMPT_WINDOW = 15000;
const BACKOFF_BASE = 5000, BACKOFF_CAP = 120000, BACKOFF_MIN = 1000;

// Upper bound of the n-th retry delay: 5 s, 10 s, 20 s, 40 s, ... capped at 120 s
export const backoffCeiling = attempt => Math.min(BACKOFF_CAP, BACKOFF_BASE * 2 ** Math.max(0, attempt));
// Exponential backoff with full jitter (uniform below the ceiling), but never zero: a client that retries at once
// every time would only add to the load that caused the trouble.
export const backoffDelay = (attempt, random = Math.random) => Math.round(BACKOFF_MIN + random() * (backoffCeiling(attempt) - BACKOFF_MIN));
export function createBackoff(random = Math.random) {
  let n = 0;
  return { next: () => backoffDelay(n++, random), reset: () => { n = 0; }, attempts: () => n };
}

// A snapshot of "no list" only counts as "the list was deleted" when it comes from a healthy connection. While the
// connection is connecting, degraded or busy, an empty snapshot says nothing (and no snapshot at all is no news).
export const shouldForgetList = (snapshot, connState) => connState === 'ok' && !(snapshot && snapshot.meta);

export function createConn({ now = () => Date.now(), setTimeout: st = (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: ct = id => globalThis.clearTimeout(id), random = Math.random } = {}) {
  const subs = new Set(), backoff = createBackoff(random);
  let cur = 'connecting', connected = null, everConnected = false;
  let startedAt = now(), downSince = startedAt, upSince = null;
  let drops = [], shortDrops = [], fails = [];
  let timer = null, adapter = null, hidden = false, waiting = false, deliberate = false, retryTimer = null, attemptTimer = null;

  function evaluate() {
    const t = now();
    drops = drops.filter(x => t - x < FLAP_WINDOW); shortDrops = shortDrops.filter(x => t - x < FLAP_WINDOW); fails = fails.filter(x => t - x < FAIL_WINDOW);
    let next = Infinity, want;
    const soon = at => { next = Math.min(next, Math.max(0, at - t)); };
    if (connected === true) {
      const stableAt = upSince + STABLE;
      if (t >= stableAt) { shortDrops = []; if (cur === 'busy') drops = []; } // stable for a while: the limit is not what we hit any more
      if (shortDrops.length >= 2) want = 'busy';
      else if (drops.length >= 3 || fails.length) want = 'degraded';
      else want = 'ok';
      if (t < stableAt && cur === 'busy') want = 'busy';
      else if (want === 'ok' && cur !== 'ok' && cur !== 'connecting' && t < stableAt) want = cur;
      if (t < stableAt && (cur !== 'ok' && cur !== 'connecting' || shortDrops.length)) soon(stableAt);
      if (drops.length) soon(drops[0] + FLAP_WINDOW);
      if (fails.length) soon(fails[0] + FAIL_WINDOW);
    } else {
      if (cur === 'busy' || shortDrops.length >= 2 || (!everConnected && t - startedAt >= BUSY_FIRST)) want = 'busy';
      else if (t - downSince >= GRACE || fails.length) want = 'degraded';
      else want = cur; // inside the grace period nothing changes
      if (t - downSince < GRACE) soon(downSince + GRACE);
      if (!everConnected && t - startedAt < BUSY_FIRST) soon(startedAt + BUSY_FIRST);
      if (fails.length) soon(fails[0] + FAIL_WINDOW);
    }
    if (timer) ct(timer);
    timer = next === Infinity ? null : st(() => { timer = null; evaluate(); }, next);
    if (want !== cur) {
      const prev = cur; cur = want;
      if (cur === 'ok') settle(); else if (cur === 'busy') scheduleRetry();
      subs.forEach(fn => fn(cur, prev));
    }
  }
  const settle = () => { // healthy again: the retry machinery rests and the backoff starts from the beginning
    if (retryTimer) ct(retryTimer); if (attemptTimer) ct(attemptTimer);
    retryTimer = attemptTimer = null; waiting = false; deliberate = false; backoff.reset();
  };

  // Deliberate reconnects while busy: go offline (stop adding to the load), wait the backoff, come back. Never while the
  // tab is hidden; `setHidden(false)` / `wake()` make one immediate attempt.
  function scheduleRetry() {
    if (!adapter || retryTimer) return;
    deliberate = true; adapter.disconnect();
    retryTimer = st(() => { retryTimer = null; if (hidden) waiting = true; else attempt(); }, backoff.next());
  }
  function attempt() {
    if (!adapter) return;
    if (retryTimer) { ct(retryTimer); retryTimer = null; }
    if (attemptTimer) ct(attemptTimer);
    waiting = false; deliberate = false; adapter.connect();
    attemptTimer = st(() => { attemptTimer = null; if (cur === 'busy') scheduleRetry(); }, ATTEMPT_WINDOW);
  }

  return {
    state: () => cur,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    // .info/connected
    onStatus(on) {
      on = !!on; if (on === connected) return;
      const t = now();
      if (on) { connected = true; everConnected = true; upSince = t; }
      else {
        if (connected === true && !deliberate) { drops.push(t); if (t - upSince < SHORT_LIVED) shortDrops.push(t); }
        if (connected !== null) downSince = t;
        connected = false;
      }
      evaluate();
    },
    // Result of a write: ok = it went through (also when it finished late), not ok = it timed out
    opResult(ok) { if (ok) fails = []; else fails.push(now()); evaluate(); },
    // A new subscription begins (list opened or switched): forget the history
    reset() {
      if (timer) ct(timer); timer = null;
      if (deliberate && adapter) adapter.connect(); // do not leave the SDK switched off from an earlier busy phase
      settle();
      connected = null; everConnected = false; startedAt = downSince = now(); upSince = null; drops = []; shortDrops = []; fails = [];
      const prev = cur; cur = 'connecting';
      if (prev !== cur) subs.forEach(fn => fn(cur, prev));
      evaluate();
    },
    // The adapter with optional connect()/disconnect() (Firebase: goOnline/goOffline); null for the local list
    attach(a) { adapter = a && a.connect && a.disconnect ? a : null; },
    setHidden(h) { hidden = !!h; if (!hidden) this.wake(); },
    // The tab became visible or the browser came online: one immediate attempt instead of waiting for the backoff
    wake() {
      if (hidden || !adapter) return;
      if (cur === 'busy' && (retryTimer || waiting)) attempt();
      else if (cur === 'degraded' && !deliberate) adapter.connect();
    },
  };
}
