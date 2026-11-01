// Simulated database for testing overload handling (see conn.js and AGENTS.md, "?sim="). A fake adapter that wraps a real
// one (the local adapter) and injects faults: refused or dropped connections, slow or hanging writes, the connection limit
// of the Spark plan, flapping. Like Firebase, operations made while the connection is down are queued and run when it is
// back; only `refuse` rejects at once.
// Used by test/overload.test.js (with the manual clock below) and by the app through `?sim=...` (demo mode or dev site only).

// Manual clock for tests: timers only run when `advance` is called, in order, with the microtasks flushed in between.
export function createClock(start = 0) {
  let t = start, seq = 0, timers = [];
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  return {
    now: () => t,
    setTimeout(fn, ms) { const id = ++seq; timers.push({ id, at: t + Math.max(0, ms), fn }); return id; },
    clearTimeout(id) { timers = timers.filter(x => x.id !== id); },
    pending: () => timers.length,
    async advance(ms) {
      const end = t + ms;
      await flush();
      for (;;) {
        const due = timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers = timers.filter(x => x !== due); t = Math.max(t, due.at); due.fn(); await flush();
      }
      t = end; await flush();
    },
  };
}

const MODES = ['ok', 'refuse', 'slow', 'drop', 'blackhole'];

export function createSim(base, { clock = null } = {}) {
  const st = clock ? clock.setTimeout.bind(clock) : (f, ms) => globalThis.setTimeout(f, ms);
  const ct = clock ? clock.clearTimeout.bind(clock) : id => globalThis.clearTimeout(id);
  const sleep = ms => new Promise(res => st(res, ms));
  let mode = 'ok', wanted = true, up = false, cap = Infinity, others = 0, slowMs = 3000, cycle = null, flapTimer = null, flapMs = 0;
  const calls = [], subs = new Set(), statusFns = new Set(), waiters = [], failures = {}, delays = {}, dropAfterOps = new Set();

  // Do operations get through right now? (connected, a mode that lets them pass, a free connection slot)
  const flowing = () => wanted && up && (mode === 'ok' || mode === 'slow') && others + 1 <= cap;
  const setUp = v => {
    if (v === up) return;
    up = v; statusFns.forEach(f => f(v));
    if (flowing()) release();
  };
  function release() {
    waiters.splice(0).forEach(w => w());
    subs.forEach(s => Promise.resolve(base.get(s.code, '')).then(v => { if (flowing()) s.cb(v); }));
  }
  // Re-decide the connection from mode, wish and capacity. A connection above the limit is accepted and dropped again
  // within a second, over and over (the SDK retries by itself): the signature conn.js looks for.
  function sync() {
    if (cycle) { ct(cycle); cycle = null; }
    if (!wanted || !(mode === 'ok' || mode === 'slow' || mode === 'blackhole')) { setUp(false); return; }
    if (mode === 'blackhole') { setUp(true); return; } // half-open: the phone thinks it is connected, nothing gets through
    if (others + 1 <= cap) { const before = up; setUp(true); if (before && flowing()) release(); return; }
    setUp(true);
    cycle = st(() => { cycle = null; setUp(false); cycle = st(() => { cycle = null; sync(); }, 1000); }, 800);
  }

  async function run(op, code, path, exec) {
    calls.push({ op, code, path, at: clock ? clock.now() : Date.now() });
    const inj = failures[op] && failures[op].shift();
    if (inj) throw inj;
    if (mode === 'refuse') throw new Error('connection refused');
    while (!flowing()) await new Promise(res => waiters.push(res));
    const d = (delays[op] || 0) + (mode === 'slow' ? slowMs : 0);
    if (d) await sleep(d);
    const r = await exec();
    if (dropAfterOps.delete(op)) api.setMode('drop'); // the connection dies right after this operation
    return r;
  }

  const api = {
    mode: base.mode,
    calls,
    callCount: op => calls.filter(c => !op || c.op === op).length,
    subscribe(code, cb, onStatus) {
      const s = { code, cb }; subs.add(s);
      if (onStatus) { statusFns.add(onStatus); queueMicrotask(() => onStatus(up)); }
      const off = base.subscribe(code, v => { if (flowing()) cb(v); }, null);
      sync();
      return () => { off(); subs.delete(s); if (onStatus) statusFns.delete(onStatus); };
    },
    get: (code, path) => run('get', code, path, () => base.get(code, path)),
    update: (code, path, fn) => run('update', code, path, () => base.update(code, path, fn)),
    set: (code, path, v) => run('set', code, path, () => base.set(code, path, v)),
    remove: (code, path) => run('remove', code, path, () => base.remove(code, path)),
    // The adapter side (conn.js calls these for deliberate reconnects)
    connect() { wanted = true; sync(); },
    disconnect() { wanted = false; sync(); },
    // Knobs
    setMode(m) { if (!MODES.includes(m)) throw new Error('unknown mode ' + m); mode = m; sync(); },
    slowMs(ms) { slowMs = ms; },
    // The server accepts `n` connections; `others` slots are already taken by other clients (default: all of them)
    maxConnections(n, taken = n) { cap = n; others = taken; sync(); },
    releaseOthers(k = others) { others = Math.max(0, others - k); sync(); },
    failNext(op, err = new Error('injected failure')) { (failures[op] = failures[op] || []).push(err); },
    delay(op, ms) { delays[op] = ms; },
    dropAfter(op) { dropAfterOps.add(op); },
    // Connection down and up again every periodMs (0 stops it and restores the connection)
    flap(periodMs) {
      if (flapTimer) ct(flapTimer); flapTimer = null; flapMs = periodMs;
      if (!periodMs) { api.setMode('ok'); return; }
      const tick = () => { api.setMode(mode === 'ok' ? 'drop' : 'ok'); flapTimer = flapMs ? st(tick, flapMs) : null; };
      flapTimer = st(tick, periodMs);
    },
    // Is there a free state to look at? (for tests)
    online: () => up, flowing, queued: () => waiters.length,
  };
  sync(); // like the SDK: the connection is made at once
  return api;
}

// `?sim=overload|slow|flap|recover:<seconds>` for the app: a ready-made scenario on a fresh sim
export function applyScenario(sim, name) {
  const [kind, arg] = String(name || '').split(':');
  if (kind === 'overload') sim.maxConnections(100); // the plan's limit is reached and stays so
  else if (kind === 'slow') { sim.slowMs(12000); sim.setMode('slow'); }
  else if (kind === 'flap') sim.flap(6000);
  else if (kind === 'recover') { // down for <seconds> (default 20), then everything works
    sim.maxConnections(100);
    setTimeout(() => sim.releaseOthers(), Math.max(1, Number(arg) || 20) * 1000);
  } else return false;
  return true;
}
