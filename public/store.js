// Datenschicht: Listenlogik einmal geschrieben, gegen einen Adapter (Firebase oder lokal).
// Adapter-Schnittstelle: subscribe(code, cb, onStatus) -> unsubscribe, get(code, path),
// update(code, path, fn) -> {committed} (Transaktion; fn gibt undefined zurück = abbrechen, null = löschen),
// set(code, path, value), remove(code, path).
// Firebase-Schlüsselzeichen und HTML-Sonderzeichen (Schlüssel landen im Rendering) werden ersetzt.
// Muss zu den Regeln in database.rules.json passen: "<Emoji ohne Leerzeichen> <Name>", höchstens 60 Zeichen.
const BAD = /[.$#\[\]\/<>&"'`\u0000-\u001f]/g;
export const userKey = (emoji, name) => {
  const e = String(emoji ?? '').replace(BAD, '_').replace(/\s+/g, '').slice(0, 20) || '🙂';
  const n = String(name ?? '').replace(BAD, '_').replace(/\s+/g, ' ').trim().slice(0, 30) || '_';
  return `${e} ${n}`;
};
export const isUserKey = k => typeof k === 'string' && k.length <= 60 && /^[^ <>&"'`]{1,20} [^<>&"'`]{1,30}$/.test(k);
export const isId = k => typeof k === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(k);
const toNum = v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 1 && n <= 9999999 ? n : null; };

export async function firebaseAdapter(cfg) {
  const V = '10.14.1';
  const [{ initializeApp }, { getDatabase, ref, onValue, runTransaction, set, get, remove }] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-database.js`),
  ]);
  const db = getDatabase(initializeApp(cfg));
  const r = (code, path) => ref(db, `lists/${code}${path ? '/' + path : ''}`);
  return {
    mode: 'firebase',
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

// Lokaler Adapter: JSON in einem Storage (localStorage), Tabs im selben Browser sehen sich über das storage-Event.
// Nur zum Ausprobieren ohne Firebase-Konto und für Tests (dort mit eigenem Storage-Objekt).
export function localAdapter(storage = globalThis.localStorage, listen = true) {
  const KEY = 'korbjagd-local-db', subs = new Set();
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
      // wie Firebase: leere Knoten verschwinden
      for (let i = chain.length - 1; i > 0 && !Object.keys(chain[i]).length; i--) delete chain[i - 1][ks[i - 1]];
    }
    save(d);
  };
  return {
    mode: 'local',
    subscribe(code, cb, onStatus) {
      const s = { code, cb }; subs.add(s);
      queueMicrotask(() => { cb(load()[code] ?? null); onStatus && onStatus(true); });
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

export function createStore(db) {
  const bump = (code, key, d) => isUserKey(key) ? db.update(code, `scores/${key}`, n => Math.min(100000, Math.max(0, (n || 0) + d))) : null;
  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const randCode = () => Array.from({ length: 6 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
  return {
    mode: db.mode,
    subscribe: (code, cb, onStatus) => db.subscribe(code, cb, onStatus),
    async create() {
      let code;
      do { code = randCode(); } while (await db.get(code, 'meta'));
      await db.set(code, 'meta', { created: Date.now() });
      return code;
    },
    async exists(code) { return !!(await db.get(code, 'meta')); },
    join: (code, user) => !isUserKey(user) ? null : db.update(code, `scores/${user}`, n => (n == null ? 0 : undefined)),
    add(code, item, user) {
      const title = String(item.title || '').trim().slice(0, 120);
      if (!title || !isId(item.id) || !isUserKey(user)) return null;
      return db.update(code, `items/${item.id}`, old => old ? undefined : {
        id: item.id, title, amount: item.amount > 1 ? Math.min(999, Math.round(item.amount)) : 1, unit: item.unit ? String(item.unit).slice(0, 20) : null,
        info: item.info ? String(item.info).slice(0, 200) : null, vgNum: toNum(item.vgNum), ean: /^\d{8,14}$/.test(item.ean) ? item.ean : null,
        checked: false, checkedBy: null, checkedAt: null, addedBy: user, addedAt: Date.now() });
    },
    async check(code, id, user, want) {
      if (!isId(id) || !isUserKey(user)) return;
      let prev;
      const r = await db.update(code, `items/${id}`, old => {
        prev = old;
        if (!old || !!old.checked === want) return undefined;
        return { ...old, checked: want, checkedBy: want ? user : null, checkedAt: want ? Date.now() : null };
      });
      if (r.committed) await bump(code, want ? user : prev.checkedBy, want ? 1 : -1);
    },
    // VG-Nummer nachtragen; mit checkToo landet der Artikel dabei im Korb
    // extra: {title, info} aus der VG-Datenbank; der Titel ersetzt nur den Platzhalter "VG no. 123" (früher "VG-Nr. 123")
    async setNum(code, id, user, vgNum, checkToo, extra = {}) {
      if (!isId(id) || !isUserKey(user)) return;
      vgNum = toNum(vgNum);
      let newlyChecked = false;
      await db.update(code, `items/${id}`, old => {
        newlyChecked = false;
        if (!old) return undefined;
        const next = { ...old, vgNum };
        if (extra.info) next.info = String(extra.info).slice(0, 200);
        if (extra.title && /^VG(-Nr\.| no\.) \d+$/.test(old.title)) next.title = String(extra.title).slice(0, 120);
        if (checkToo && !old.checked) { next.checked = true; next.checkedBy = user; next.checkedAt = Date.now(); newlyChecked = true; }
        return next;
      });
      if (newlyChecked) await bump(code, user, 1);
    },
    async remove(code, id) {
      let prev;
      await db.update(code, `items/${id}`, old => { prev = old; return old ? null : undefined; });
      if (prev && prev.checked) await bump(code, prev.checkedBy, -1);
    },
    // Leergut: deposit/<Typ>/<Nutzer> = Stück. Jedes Stück gibt dem, der es einträgt, einen Punkt.
    async depositAdd(code, typeId, user) {
      if (!/^[A-Za-z0-9_-]{1,20}$/.test(String(typeId)) || !isUserKey(user)) return;
      const r = await db.update(code, `deposit/${typeId}/${user}`, n => (n || 0) + 1);
      if (r.committed) await bump(code, user, 1);
    },
    // Weniger: erst eigene Stücke, sonst die des größten Beitragenden (Punkt geht dort wieder ab)
    async depositRemove(code, typeId, user) {
      if (!/^[A-Za-z0-9_-]{1,20}$/.test(String(typeId))) return;
      const group = (await db.get(code, `deposit/${typeId}`)) || {};
      const victim = group[user] > 0 ? user : Object.keys(group).sort((a, b) => group[b] - group[a])[0];
      if (!victim) return;
      let took = false;
      await db.update(code, `deposit/${typeId}/${victim}`, n => { took = n > 0; return n > 1 ? n - 1 : n > 0 ? null : undefined; });
      if (took) await bump(code, victim, -1);
    },
    clearDeposit: code => db.remove(code, 'deposit'),
    async clearChecked(code) {
      const items = (await db.get(code, 'items')) || {};
      await Promise.all(Object.values(items).filter(i => i.checked).map(i => db.remove(code, `items/${i.id}`)));
    },
    async resetScores(code) {
      const [items, old, dep] = await Promise.all([db.get(code, 'items'), db.get(code, 'scores'), db.get(code, 'deposit')]);
      const scores = Object.fromEntries(Object.keys(old || {}).map(k => [k, 0]));
      for (const i of Object.values(items || {})) if (i.checked && i.checkedBy) scores[i.checkedBy] = (scores[i.checkedBy] || 0) + 1;
      for (const g of Object.values(dep || {})) for (const [u, n] of Object.entries(g)) scores[u] = (scores[u] || 0) + n;
      await db.set(code, 'scores', scores);
    },
  };
}
