import firebaseConfig from './firebase-config.js';
import { createStore, firebaseAdapter, localAdapter, userKey, parseListCode, isPending, isEmptyList } from './store.js';
import { createConn, shouldForgetList } from './conn.js';
import { createOutbox } from './outbox.js';
import { saveSnapshot, loadSnapshot, dropSnapshot, sanitize } from './cache.js';
import { IS_DEV, NS } from './env.js';
import { BUILD } from './version.js';
import { loadVg, similarNames } from './vg.js';
import { t, applyStatic } from './i18n.js';
import { shouldShowAndroidInstall, shouldShowInstallHint, shouldShowBrowserHint, sanitizeHintSeen, addHintSeen, tooLongNumber, resetPlan, packTicks, sanitizeTicks, pruneTicks, sanitizeHistory, recordHistory, historyMatches, HISTORY_KEY, createVgLoader, uploadLocalList, checkoutSections, rankPlaces, classifyScan } from './flows.js';
import { initDialogs, shortName, menuIndex, visibleFocusables } from './a11y.js';

const $ = s => document.querySelector(s);
// Player emojis: single code points only (no skin tones or joined sequences, those render differently across phones)
const EMOJIS = ['🦊','🐼','🦖','🦈','🦄','🐙','🤖','👽','🧙','🐲','🚀','⚡'];
const LS = { get(k, d) { try { return JSON.parse(localStorage.getItem(NS + k)) ?? d; } catch (e) { return d; } },
             set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) {} } };

// Own item history for suggestions: one table for all lists on this phone (lists come and go, shopping habits stay); bounded, validated on load
let history = sanitizeHistory(LS.get('history', null));
const remember = (title, vgNum) => { history = recordHistory(history, HISTORY_KEY, title, vgNum); LS.set('history', history); };

const me = LS.get('me', { name: '', emoji: EMOJIS[0] });
// The list lives on this phone (code LOCAL) until it is shared; then it moves to the server under an 8-character code (6 for older lists).
const LOCAL = 'LOCAL';
let code = LOCAL;
const isLocal = () => code === LOCAL;
let state = { items: {}, scores: {}, deposit: {} }; // what is shown: `raw` (the last snapshot or cache) plus the changes still waiting in the outbox
let raw = { items: {}, scores: {}, deposit: {} };
let stale = false; // `raw` comes from the cache of an earlier visit: read-only until a live snapshot arrives
let store = null, localDb = null, localStore = null, remotePromise = null, pending = null, pendingCancel = null;
let unsub = null, first = true, vg = null;
// VG data for suggestions, number checks and the Empties tab: loads in the background, never blocks the app. After ~10 s
// without data the Empties tab offers "Try again" (also retried on `online` and when that tab is opened).
const vgLoader = createVgLoader({ load: () => loadVg(), onChange: (s, d) => { if (d) vg = d; render(); pruneCheckout(); } });
let loadingStuck = false, emptyPending = false, watchdog = 0; // first snapshot of a shared list did not arrive in time / only an empty one so far
let editingId = null; // item whose VG number is being edited

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const myKey = () => userKey(me.emoji, me.name || 'Me');
const splitKey = k => { const i = k.indexOf(' '); return { emoji: k.slice(0, i), name: k.slice(i + 1) }; };

// Opening a dialog, menu or the scanner while a field has focus: the keyboard must go away first (iOS keeps it open
// when a button is tapped)
function dismissKeyboard() {
  const el = document.activeElement;
  if (el && el !== document.body && typeof el.blur === 'function') el.blur();
}

// A toast is click-through. With an action ({label, aria, run}) it gets one button (the undo offer) and stays 8 s; a new offer
// replaces the previous one, so there is only ever one. A plain toast never pushes an offer away: it waits until the offer is
// gone (only the latest one waits). Plain toasts stay longer the longer the text is, and pointer or keyboard focus on the
// toast stops the clock until it leaves. Texts go in as text, never as HTML.
const toastMs = (msg, action) => (action ? 8000 : Math.min(8000, 2000 + 50 * String(msg).length));
let toastWaiting = null;
function toast(msg, action) {
  const el = $('#toast');
  if (!action && el.classList.contains('act') && el.classList.contains('show')) { toastWaiting = msg; return; }
  el.classList.toggle('act', !!action); el.classList.add('show');
  void el.offsetHeight; // the region is rendered (not visibility:hidden) before its text changes, so screen readers announce it
  el.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'toastAct'; b.textContent = action.label; b.setAttribute('aria-label', action.aria || action.label);
    b.onclick = () => { hideToast(); action.run(); };
    el.append(b);
  }
  toastClock(toastMs(msg, action));
}
function toastClock(ms) { clearTimeout(toast.t); toast.t = setTimeout(hideToast, ms); }
function hideToast() {
  clearTimeout(toast.t); $('#toast').classList.remove('show', 'act');
  if (toastWaiting) { const m = toastWaiting; toastWaiting = null; toast(m); }
}
{
  const el = $('#toast'), hold = () => clearTimeout(toast.t);
  const go = () => { if (el.classList.contains('show') && !el.contains(document.activeElement)) toastClock(3000); };
  el.addEventListener('pointerenter', hold); el.addEventListener('focusin', hold);
  el.addEventListener('pointerleave', go); el.addEventListener('focusout', () => setTimeout(go, 0));
}
// The cached list of an earlier visit is only for reading: every flow that changes the list asks this first, so it neither
// shows a success that did not happen nor throws away what was typed
const readOnly = () => { if (!stale) return false; toast(t('connCached')); return true; };
// Delete without asking; the toast offers to bring the item back with all its data (same id, number, state)
function deleteItem(it) {
  if (readOnly()) return;
  const prev = { ...it }, c = code;
  bg.remove(c, it.id);
  const name = shortName(it.title);
  toast(t('toastDeleted', { item: name }), { label: t('undo'), aria: t('ariaUndo', { item: name }), run: () => { if (c === code) bg.restore(c, prev, myKey()); } });
}

/* ---------- Connection ---------- */
// The server can be overloaded (connection limit of the free plan), the network can flap. The list stays usable
// (changes are kept by the SDK and sent later); the state only shows as a calm banner, and as one toast on recovery.
const conn = createConn();
// Changes that could not be sent yet are kept across reloads (outbox.js) and shown at once (optimistic view)
const outbox = createOutbox({ onFull: () => toast(t('outboxFull')) });
let viewTimer = 0;
outbox.subscribe(() => { clearTimeout(viewTimer); viewTimer = setTimeout(() => { render(); renderConn(); }, 0); });
const busyish = () => conn.state() === 'busy' || conn.state() === 'degraded';
const noDbMsg = e => t(isPending(e) || busyish() ? 'noDbBusy' : 'noDb'); // for actions that need the server right now
// Fire-and-forget store calls: a timeout (pending) is covered by the banner, anything else gets a toast; never an unhandled rejection
const bg = new Proxy({}, { get: (_, name) => (...args) => {
  if (readOnly()) return Promise.resolve(); // a backstop: the flows check this themselves before they show anything
  const p = store[name](...args);
  Promise.resolve(p).catch(e => { if (!isPending(e)) toast(noDbMsg(e)); });
  return p;
} });
function renderConn() {
  const el = $('#connBanner'), s = conn.state();
  // the empty state of a list that never loaded says it itself
  const bad = s === 'busy' || s === 'degraded';
  const base = isLocal() || (first && loadingStuck && !stale) ? '' : !bad ? '' : stale ? t('connCached') : s === 'busy' ? t('connBusy') : t('connDegraded');
  const n = base ? outbox.count(code) : 0;
  const text = base && n ? `${base}\n${t(n === 1 ? 'connPending1' : 'connPending', { n })}` : base;
  if (el.dataset.text !== text) { el.dataset.text = text; el.innerHTML = text.split('\n').map(esc).join('<br>'); }
  el.classList.toggle('hide', !text);
  const later = $('#scoreLater'), laterText = !isLocal() && bad && outbox.has(code) ? t('connScoreLater') : '';
  later.textContent = laterText; later.classList.toggle('hide', !laterText);
  // the bar floats over the list, so the list makes room below it (the shell itself keeps its height)
  document.body.style.setProperty('--conn-h', text ? el.offsetHeight + 'px' : '0px');
}
conn.subscribe((s, prev) => {
  renderConn();
  if (s !== 'ok' || isLocal()) return;
  // Replay what waits in the outbox, but only once the list itself has arrived: before the first snapshot the SDK knows
  // nothing of the list, a transaction then sees null, aborts, and the entry would be struck out unsent (onSnapshot replays
  // after the first snapshot instead)
  if (store.flush && !first) store.flush(code);
  if (prev === 'busy' || prev === 'degraded') toast(t('connRestored'));
  if (emptyPending) { // an empty snapshot came while the connection was not healthy: ask once whether the list really is gone
    emptyPending = false;
    const c = code;
    store.exists(c).then(there => { if (!there && c === code && conn.state() === 'ok') onSnapshot(null); }).catch(() => {});
  }
});
document.addEventListener('visibilitychange', () => conn.setHidden(document.hidden));
addEventListener('online', () => { conn.wake(); vgLoader.start(); });

/* ---------- Sync ---------- */
function onSnapshot(s) {
  if (!isLocal() && !(s && s.meta)) {
    if (shouldForgetList(s, conn.state())) { // the shared list was deleted (by someone else or by the cleanup)
      toast(t('toastListGone')); forgetShared(); startLocal(); return;
    }
    emptyPending = true; return; // no live value from a healthy connection: this says nothing about the list
  }
  clearTimeout(watchdog); loadingStuck = false; emptyPending = false; stale = false;
  const next = sanitize(s); // server data is untrusted: well-formed fields only, and a bounded number of items
  if (!first && !isLocal()) { // show other people's changes as a toast; several at once become one
    const news = [];
    for (const i of Object.values(next.items)) {
      const was = state.items[i.id];
      if (i.checked && !(was && was.checked) && i.checkedBy && i.checkedBy !== myKey()) news.push({ who: i.checkedBy, msg: t('toastCheckedBy', { who: i.checkedBy, item: i.title }) });
      else if (!was && i.addedBy && i.addedBy !== myKey()) news.push({ who: i.addedBy, msg: t('toastAddedBy', { who: i.addedBy, item: i.title }) });
    }
    if (news.length === 1) toast(news[0].msg);
    else if (news.length) toast(new Set(news.map(x => x.who)).size === 1 ? t('toastChangesBy', { who: news[0].who, n: news.length }) : t('toastChanges', { n: news.length }));
  }
  const wasFirst = first;
  first = false; raw = next; render(); renderConn(); pruneCheckout();
  if (!isLocal()) { // keep the last live snapshot for the next start (at most once a second)
    clearTimeout(cacheTimer); const c = code, snap = next; // this snapshot, not whatever `raw` is when the timer fires
    cacheTimer = setTimeout(() => saveSnapshot(localStorage, c, snap), 1000);
    if (wasFirst && conn.state() === 'ok' && store.flush) store.flush(code); // now the SDK knows the list: replay the outbox
  }
}
let cacheTimer = 0;
function connect() {
  if (unsub) unsub();
  clearTimeout(cacheTimer);
  clearTimeout(watchdog); loadingStuck = false; emptyPending = false;
  first = true; loadTicks();
  stale = false; raw = { items: {}, scores: {}, deposit: {} };
  if (!isLocal()) { const c = loadSnapshot(localStorage, code); if (c) { raw = c; stale = true; } } // shown read-only until live data arrives
  render();
  conn.reset(); conn.attach(isLocal() ? null : store); renderConn();
  unsub = store.subscribe(code, onSnapshot, conn.onStatus);
  // No first snapshot after 10 s: say so in the list area and offer the local list (the saved code is kept)
  if (!isLocal()) watchdog = setTimeout(() => { if (first) { loadingStuck = true; render(); renderConn(); } }, 10000);
}

/* ---------- Rendering ---------- */
function itemHtml(i) {
  const by = !isLocal() && i.checked && i.checkedBy ? `<span class="badge">${esc(i.checkedBy)}</span>` : '';
  const id = esc(i.id);
  // Number: open items without one get the quick field (entering it puts the item in the basket); every other item
  // shows a small button to change or add the number
  const editing = editingId === i.id;
  const chip = i.vgNum ? esc(i.vgNum) : i.checked ? `＋ ${t('noShort')}` : '';
  const nm = esc(shortName(i.title)); // item name for the button labels (escaped: it goes into an attribute)
  const sub = chip && !editing ? `<button type="button" class="numedit" data-editnum="${id}" aria-label="${t('ariaEditNumItem', { name: nm })}">${chip}</button>` : '';
  // iPhones have no Return key on the number pad: every number field has a confirm button, plus a scan button
  const buttons = checkToo => `<button class="rowbtn ok" type="submit" aria-label="${t('ariaConfirmItem', { name: nm })}">✓</button><button class="rowbtn" type="button" data-scanrow="${id}" data-checktoo="${checkToo}" aria-label="${t('ariaScanItem', { name: nm })}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M8 7v10"/><path d="M12 7v10"/><path d="M16 7v10"/></svg></button>`;
  const vgIn = editing ? `<form data-vgedit="${id}"><input class="vg" type="number" inputmode="numeric" enterkeyhint="done" value="${esc(i.vgNum || '')}" placeholder="${t('noShort')}" aria-label="${t('ariaNumItem', { name: nm })}">${buttons(0)}</form>`
    : i.vgNum || i.checked ? '' : `<form data-vg="${id}" class="quick"><input class="vg" type="number" inputmode="numeric" enterkeyhint="done" placeholder="${t('noShort')}" aria-label="${t('ariaNumItem', { name: nm })}">${buttons(1)}</form>`;
  return `<div class="item ${i.checked ? 'done' : ''}">
      <button class="chk" data-chk="${esc(i.id)}" aria-label="${t(i.checked ? 'ariaBackItem' : 'ariaCheckItem', { name: nm })}"></button>
      <div class="t">${i.amount > 1 ? `${esc(i.amount)}${i.unit ? ' ' + esc(i.unit) : '×'} ` : ''}${esc(i.title)}<small>${sub}</small></div>${by}${vgIn}
      <button class="x" data-del="${esc(i.id)}" aria-label="${t('ariaDeleteItem', { name: nm })}">×</button></div>`;
}
// The start hint: shown only while the list has no item at all (open or checked off)
function emptyHint() {
  const svg = d => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const share = svg('<path d="M12 15V4"/><path d="M8 8l4-4 4 4"/><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/>');
  const cam = svg('<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M8 7v10"/><path d="M12 7v10"/><path d="M16 7v10"/>');
  return `<div class="empty"><p><span class="eic">+</span><span>${esc(t('emptyAdd'))}</span></p>
    <p><span class="eic">123</span><span>${esc(t('emptyShop'))}</span></p>
    <p><span class="eic">${share}</span><span>${esc(t('emptyShare'))}</span></p>
    <button type="button" class="emptyJoinBox" id="emptyJoin">${esc(t('emptyJoin'))}</button>
    <div class="emptyLinks"><a href="docs/index.html" class="emptyHelp">${esc(t('emptyHelp'))}</a></div></div>`;
}
// A number field on a row has focus (someone is typing a number): rebuilding the rows now would throw the digits and the
// keyboard away, so the rows wait until the field is left (`rowsLater`). Our own submits blur the field first.
let rowsLater = false;
const rowFieldFocused = () => { const a = document.activeElement; return !!a && a.tagName === 'INPUT' && !!a.closest('#items, #doneItems'); };
// A button that had keyboard focus is found again after the rebuild (the + of the empties, a check box, a checkout row)
const FOCUS_KEYS = ['data-dep-add', 'data-dep-sub', 'data-chk', 'data-checkout', 'data-editnum'];
function focusedKey() {
  const a = document.activeElement, k = a && a.tagName === 'BUTTON' && FOCUS_KEYS.find(x => a.hasAttribute(x));
  return k ? `[${k}="${CSS.escape(a.getAttribute(k))}"]` : null;
}
function render() {
  state = isLocal() ? raw : outbox.overlayFor(raw, code); // changes waiting to be sent show at once; a live snapshot replaces `raw`
  const typed = editingId ? document.querySelector('[data-vgedit] input')?.value : null; // survive re-renders while typing
  const refocus = focusedKey();
  const all = Object.values(state.items).sort((a, b) => ((a.addedAt || 0) - (b.addedAt || 0)));
  const open = all.filter(i => !i.checked);
  const done = all.filter(i => i.checked).sort((a, b) => (b.checkedAt || 0) - (a.checkedAt || 0)); // most recently checked off first
  rowsLater = rowFieldFocused();
  if (!rowsLater) {
    $('#items').innerHTML = first && loadingStuck && !stale && !isLocal() ? `<div class="stuck"><p class="muted">${esc(t('connLoadingList'))}</p><button type="button" class="btn sec" id="useLocal">${esc(t('connUseLocal'))}</button></div>`
      : open.length ? open.map(itemHtml).join('')
      : !isEmptyList(state.items) ? `<p class="muted" style="text-align:center">${t('allInBasket')}</p>`
      : first && !isLocal() ? '' // the first snapshot of a shared list is still on its way
      : emptyHint();
    $('#doneCard').classList.toggle('hide', !done.length);
    $('#doneHead').textContent = t('inBasketHead', { n: done.length });
    $('#doneItems').innerHTML = done.map(itemHtml).join('');
  }
  renderDeposit(); renderCheckout();
  if (editingId) {
    const input = document.querySelector('[data-vgedit] input');
    if (input) { if (typed !== null && typed !== undefined) input.value = typed; if (document.activeElement !== input) { input.focus(); input.select(); } }
    else editingId = null; // the item is gone
  }
  if (refocus && (!document.activeElement || document.activeElement === document.body)) document.querySelector(refocus)?.focus({ preventScroll: true });

  const { placed, podium, max } = rankPlaces(state.scores);
  const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };
  $('#podium').innerHTML = podium.map(({ k, n, place }) => {
    const w = splitKey(k), h = 30 + 80 * n / max;
    return `<div class="pod"><div class="e">${esc(w.emoji)}</div><div>${esc(w.name)}</div><div class="bar" style="height:${h}px">${n > 0 ? MEDAL[place] + ' ' : ''}${esc(n)}</div></div>`;
  }).join('');
  $('#ranks').innerHTML = placed.map(({ k, n, place }) => `<div class="rank"><span>${n > 0 && MEDAL[place] ? MEDAL[place] : place + '.'}</span><span>${esc(k)}</span><b>${esc(n)}</b></div>`).join('');
}

/* ---------- Checkout ---------- */
const checkoutDone = new Set(); // rows ticked at the checkout (typed in at the till): local to this phone, kept per list for 24 h
const loadTicks = () => { checkoutDone.clear(); for (const k of sanitizeTicks(LS.get('checkoutTicks', null), code, Date.now())) checkoutDone.add(k); };
const saveTicks = () => LS.set('checkoutTicks', packTicks(code, checkoutDone, Date.now()));
const setTicks = keys => { checkoutDone.clear(); keys.forEach(k => checkoutDone.add(k)); saveTicks(); };
const depRows = () => (vg ? vg.deposits.map(d => ({ ...d, n: depSum(d.id) })).filter(d => d.n > 0) : []);
// Ticks of rows that are gone are dropped (not while the list or the VG data is still loading); runs after a snapshot or
// when the VG data arrives, never while rendering
function pruneCheckout() {
  if (first || stale || !checkoutDone.size) return;
  const live = new Set(Object.keys(state.items));
  if (vg) depRows().forEach(d => live.add('d' + d.id)); else for (const k of checkoutDone) if (k[0] === 'd') live.add(k);
  const kept = pruneTicks(checkoutDone, live);
  if (kept.length !== checkoutDone.size) setTicks(kept);
}
// A row is a toggle button: pressed = already typed in at the till (keyboard and screen readers can use it too)
function checkoutRow(r) {
  const mid = r.unit && r.amount ? `<small>[${r.weight ? esc(r.amount) + ' ' : ''}${esc(r.unit)}]</small>` : '';
  const times = !r.weight && r.amount > 1 ? `<small>${esc(r.amount)} × </small>` : '';
  return `<button type="button" class="kr${r.done ? ' off' : ''}" data-checkout="${esc(r.key)}" aria-pressed="${r.done}"><span class="nm">${esc(r.title)}${mid}</span><span class="no">${times}${esc(r.no || '–')}</span></button>`;
}
function renderCheckout() {
  const s = checkoutSections(Object.values(state.items), depRows(), checkoutDone);
  const sec = (head, rows) => rows.length ? `<div class="card ks"><h3>${head}</h3>${rows.map(checkoutRow).join('')}</div>` : '';
  // rows that are done slide down into their own block below everything else (tap again to bring one back)
  $('#checkout').innerHTML = sec(t('secItems'), s.items) + sec(t('secBakery'), s.bakery) + sec(t('secEmpties'), s.empties) + sec(t('secDone'), s.done)
    || `<p class="muted" style="text-align:center">${t('checkoutEmpty')}</p>`;
}
let wakeLock = null;
async function setWake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); // compat-ok: guarded by 'in navigator' (Safari < 16.4: no wake lock, the screen may dim)
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { wakeLock = null; }
}

/* ---------- Empties ---------- */
const depSum = id => Object.values(state.deposit[id] || {}).reduce((s, n) => s + (Number(n) || 0), 0);
let depSaid = null; // the empties type just changed with + or −: its new count is read out (#srLive)
function renderDeposit() {
  const types = vg ? vg.deposits : null;
  const said = depSaid && types && types.find(d => String(d.id) === depSaid);
  if (said) { depSaid = null; $('#srLive').textContent = `${said.name}: ${depSum(said.id)}`; }
  $('#depItems').innerHTML = !types ? (vgLoader.state === 'unreachable'
      ? `<div class="stuck"><p class="muted">${esc(t('vgUnreachable'))}</p><button type="button" class="btn sec" id="vgRetry">${esc(t('tryAgain'))}</button></div>`
      : `<p class="muted" style="text-align:center">${t('loadingVg')}</p>`)
    : types.map(d => `<div class="dep"><div class="t">${esc(d.name)}<small>${esc(d.vgNum)}</small></div>
        <button data-dep-sub="${esc(d.id)}" aria-label="${t('ariaLessItem', { name: esc(shortName(d.name)) })}">−</button><span class="n">${depSum(d.id)}</span><button class="add" data-dep-add="${esc(d.id)}" aria-label="${t('ariaMoreItem', { name: esc(shortName(d.name)) })}">+</button></div>`).join('');
}

/* ---------- Events ---------- */
document.addEventListener('click', e => {
  if (e.target.closest('#vgRetry')) { vgLoader.start(); return; }
  if (e.target.closest('#useLocal')) { startLocal(); return; } // the saved list code stays, the next start tries it again
  const chk = e.target.closest('[data-chk]');
  if (chk) { const it = state.items[chk.dataset.chk]; if (it && !it.checked) remember(it.title, it.vgNum); if (it) bg.check(code, it.id, myKey(), !it.checked); return; }
  const sg = e.target.closest('[data-sug]');
  if (sg) { // a suggested product was tapped: it goes into the basket right away
    if (readOnly()) return;
    const p = vg && vg.lookup(sg.dataset.sug);
    if (p) addToBasket(p.title, { vgNum: p.vgNum });
    clearField('#addIn');
    return;
  }
  const sh = e.target.closest('[data-sughist]');
  if (sh) { // an own past item was tapped: added like a typed name; its remembered VG number only goes along when it still names a similar product
    if (readOnly()) return;
    const title = sh.dataset.sughist, v = +sh.dataset.sugnum || 0, p = v && vg ? vg.lookup(v) : null;
    const num = p && !p.placeholder && similarNames(p.title, title) ? { vgNum: p.vgNum } : {};
    remember(title, num.vgNum);
    bg.add(code, { id: uid(), title, ...num }, myKey());
    clearField('#addIn');
    return;
  }
  const sn = e.target.closest('[data-sugname]');
  if (sn) { // a suggested name was tapped: add it right away, without a VG number
    if (readOnly()) return;
    remember(sn.dataset.sugname, null);
    bg.add(code, { id: uid(), title: sn.dataset.sugname }, myKey());
    clearField('#addIn');
    return;
  }
  const kr = e.target.closest('[data-checkout]');
  if (kr) {
    const k = kr.dataset.checkout, refocus = focusedKey();
    checkoutDone.has(k) ? checkoutDone.delete(k) : checkoutDone.add(k); saveTicks(); renderCheckout();
    if (refocus) document.querySelector(refocus)?.focus({ preventScroll: true }); // the row moved: keyboard focus goes with it
    return;
  }
  const ss = e.target.closest('[data-scansug]');
  if (ss) { clearField('#eanIn'); handleCode(`VG ${ss.dataset.scansug}`); return; }
  const sr = e.target.closest('[data-scanrow]');
  if (sr) { scanTarget = { id: sr.dataset.scanrow, checkToo: sr.dataset.checktoo === '1' }; openScanner(); return; }
  const en = e.target.closest('[data-editnum]');
  if (en) { editingId = en.dataset.editnum; render(); return; }
  const dadd = e.target.closest('[data-dep-add]'), dsub = e.target.closest('[data-dep-sub]');
  if (dadd) { depSaid = dadd.dataset.depAdd; bg.depositAdd(code, dadd.dataset.depAdd, myKey()); return; }
  if (dsub) { depSaid = dsub.dataset.depSub; bg.depositRemove(code, dsub.dataset.depSub, myKey()); return; }
  const del = e.target.closest('[data-del]');
  if (del) { const it = state.items[del.dataset.del]; if (it) deleteItem(it); }
});
// Empty a field and let its input handler catch up (suggestions, the add button, the camera of the scanner)
function clearField(sel) { $(sel).value = ''; $(sel).dispatchEvent(new Event('input')); }
const buzz = () => { if (navigator.vibrate) navigator.vibrate(60); }; // compat-ok: guarded, iOS has no vibration
// The quick number field: its confirm button only shows while there is a number to confirm (Enter works either way)
document.addEventListener('input', e => {
  const f = e.target.closest('[data-vg]');
  if (f) f.classList.toggle('has', parseInt(e.target.value, 10) > 0);
});
// A typed number whose product has a completely different name than the item (apple vs. orange), or that the database
// lists as unused ("unbesetzt"): ask first. The shop may still use it, so it can be confirmed.
function numberFits(p, n, item) {
  if (!p) return true;
  if (p.placeholder) return confirm(t('confirmPlaceholder', { n, product: p.title })); // an unused number is most likely a typo
  if (!item || similarNames(p.title, item.title)) return true;
  return confirm(t('confirmNumberMismatch', { n, product: p.title, listed: item.title }));
}
document.addEventListener('submit', e => {
  const fe = e.target.closest('[data-vgedit]');
  if (fe) { // change, add or (empty field) remove the VG number of an item; the basket state stays as it is
    e.preventDefault();
    if (readOnly()) return;
    const raw = fe.querySelector('input').value.trim(), v = parseInt(raw, 10);
    if (raw && !(v > 0)) return;
    const id = fe.dataset.vgedit, p = raw && vg ? vg.lookup(v) : null;
    if (!numberFits(p, v, state.items[id])) return; // keep editing so the number can be corrected
    editingId = null; dismissKeyboard(); // the field goes away: the rows may be rebuilt now
    bg.setNum(code, id, myKey(), raw ? v : null, false, p ? { title: p.title } : {});
    if (raw) toast(p ? `✓ ${p.title}` : t(vg ? 'vgNotInDb' : 'vgSaved', { n: v }));
    render();
    return;
  }
  const f = e.target.closest('[data-vg]');
  if (!f) return;
  e.preventDefault();
  if (readOnly()) return;
  const v = parseInt(f.querySelector('input').value, 10);
  if (!(v > 0)) return;
  const p = vg && vg.lookup(v);
  if (!numberFits(p, v, state.items[f.dataset.vg])) return; // the field keeps the typed number
  dismissKeyboard(); // the item moves into the basket: the rows may be rebuilt now
  bg.setNum(code, f.dataset.vg, myKey(), v, true, p ? { title: p.title } : {}); // entering the number puts it in the basket
  toast(p ? `✓ ${p.title}` : t(vg ? 'vgNotInDb' : 'vgSaved', { n: v }));
});
// Leaving the edit field (blur) or pressing Escape cancels the edit
document.addEventListener('focusout', e => {
  if (!e.target.closest('[data-vgedit]')) return;
  setTimeout(() => { if (editingId && !document.activeElement?.closest('[data-vgedit]') && $('#scanner').classList.contains('hide')) { editingId = null; render(); } }, 350);
});
// The rows waited while a number field had focus (see render): rebuild them once focus has left the rows' fields
document.addEventListener('focusout', e => {
  if (!rowsLater || !e.target.closest('#items, #doneItems')) return;
  setTimeout(() => { if (rowsLater && !rowFieldFocused()) render(); }, 0);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && editingId) { editingId = null; dismissKeyboard(); render(); } });
$('#addForm').onsubmit = e => {
  e.preventDefault();
  const v = $('#addIn').value.trim(); if (!v) return;
  if (readOnly()) return; // the typed text stays in the field
  const isNum = /^\d+$/.test(v);
  const p = vg && isNum ? vg.lookup(v) : null; // names are added as typed, without a number
  if (tooLongNumber(v)) return; // VG numbers have 3-4 digits: the "+" is muted and the suggestion area says so; the typed number stays in the field
  if (p && p.placeholder && !numberFits(p, v, null)) return; // declined: the typed number stays in the field
  $('#addIn').value = ''; $('#addSuggest').classList.add('hide'); syncAddButton();
  if (p) addToBasket(p.title, { vgNum: p.vgNum });
  else if (isNum) addToBasket(t('vgPlaceholderTitle', { n: v }), { vgNum: +v });
  else { remember(v, null); bg.add(code, { id: uid(), title: v }, myKey()); }
  if (isNum && !p) toast(vg ? t('vgNotInDb', { n: v }) : t('vgNotLoaded'));
};
// A product typed, tapped or scanned at the shelf goes straight into the basket: an item with that VG number (or barcode) on
// the list is checked off instead of adding it twice. Names typed in the input bar are added as open items elsewhere.
// Returns {title, already} for the toast (null: the list is read-only). The add and the check are sent in order; a timed-out
// add is still queued, so the check follows once it has gone through.
function addToBasket(title, { vgNum = null, ean = null } = {}) {
  if (readOnly()) return null;
  const known = Object.values(state.items).find(i => (vgNum && i.vgNum === vgNum) || (ean && i.ean === ean));
  if (known) { if (!known.checked) bg.check(code, known.id, myKey(), true); return { title: known.title, already: !!known.checked }; }
  const id = uid(), c = code, item = { id, title, ...(vgNum ? { vgNum } : {}), ...(ean ? { ean } : {}) };
  (async () => {
    try { await store.add(c, item, myKey()); }
    catch (e) { if (isPending(e)) e.late.then(() => bg.check(c, id, myKey(), true)).catch(() => {}); else toast(noDbMsg(e)); return; }
    bg.check(c, id, myKey(), true);
  })();
  return { title, already: false };
}
// Number mode: numeric keyboard, digits only (like the "123" switch of the original app)
let numMode = LS.get('numMode', false);
function applyMode(focus) {
  const inp = $('#addIn');
  inp.inputMode = numMode ? 'numeric' : 'text';
  inp.enterKeyHint = 'go';
  inp.placeholder = t(numMode ? 'addPlaceholderNum' : 'addPlaceholder');
  if (numMode) inp.value = inp.value.replace(/\D/g, '');
  $('#modeBtn').classList.toggle('on', numMode); $('#modeBtn').setAttribute('aria-pressed', numMode);
  inp.dispatchEvent(new Event('input'));
  if (focus) inp.focus(); // keep the keyboard open; it just switches layout
}
$('#modeBtn').onclick = () => { numMode = !numMode; LS.set('numMode', numMode); applyMode(true); };
applyMode(false);

// Keyboard: while typing, the app shell (and the dialogs/scanner overlay) is exactly as high as the visible area (iOS pans the visual viewport and
// overlays the keyboard, Chrome/Android resize the page). The header stays on top, the list stays anchored at the top and
// loses space at the bottom, the input bar sits right above the keyboard, the tab bar is hidden.
{
  const vv = window.visualViewport, bar = $('#addBar');
  const place = () => {
    if (!vv) return;
    document.body.style.setProperty('--app-h', Math.round(vv.height) + 'px');
    document.body.style.setProperty('--vvtop', Math.max(0, Math.round(vv.offsetTop)) + 'px');
  };
  // Any text field counts: the input bar, the number fields on the rows, and the fields in the dialogs and the scanner
  const isTextField = el => el && el.tagName === 'INPUT' && !['radio', 'checkbox', 'button', 'submit'].includes(el.type);
  document.addEventListener('focusin', e => { if (isTextField(e.target)) { document.body.classList.add('typing'); place(); } });
  document.addEventListener('focusout', e => { if (isTextField(e.target)) setTimeout(() => {
    if (isTextField(document.activeElement)) return;
    document.body.classList.remove('typing'); document.body.style.removeProperty('--app-h'); document.body.style.removeProperty('--vvtop');
  }, 100); });
  if (vv) { const follow = () => { if (document.body.classList.contains('typing')) place(); }; vv.addEventListener('resize', follow); vv.addEventListener('scroll', follow); }
  // buttons in the bar must not steal focus, otherwise the keyboard closes
  bar.addEventListener('pointerdown', e => { if (e.target.closest('button') && e.target.id !== 'scanBtn') e.preventDefault(); });
}

// While typing: tappable suggestions (names without numbers, or products for typed digits)
// The add button is only in the accent colour (and tappable) when there is something to add
const syncAddButton = () => { const q = $('#addIn').value.trim(); $('#addGo').disabled = !q || tooLongNumber(q); };
$('#addIn').oninput = () => {
  if (numMode) $('#addIn').value = $('#addIn').value.replace(/\D/g, '');
  syncAddButton();
  const q = $('#addIn').value.trim(), box = $('#addSuggest');
  const isNum = /^\d+$/.test(q);
  // Tappable list, tap = add the item: from three digits on for numbers, from two letters on for names (no duplicates)
  const nums = vg && isNum && q.length >= 3 ? vg.searchByNumber(q) : [];
  const hist = !isNum && q.length >= 2 ? historyMatches(history[HISTORY_KEY], q) : []; // own past items come first
  const names = vg && !isNum && q.length >= 2 && !hist.length ? vg.searchNames(q) : []; // one source at a time: VG names only when no own name matches
  const long = tooLongNumber(q); // more than 4 digits can never be a VG number: say so here instead of after the tap
  const miss = vg && isNum && !long && q.length >= 4 && !nums.length && !vg.lookup(q); // an exact placeholder number is accepted silently
  box.classList.toggle('hide', !nums.length && !hist.length && !names.length && !miss && !long);
  box.innerHTML = hist.map(h => `<button type="button" class="sug hist" data-sughist="${esc(h.t)}" data-sugnum="${esc(h.v || '')}"><span>${esc(h.t)}</span><i aria-hidden="true">↺</i></button>`).join('')
    + nums.map(p => `<button type="button" class="sug" data-sug="${esc(p.vgNum)}"><b>${esc(p.vgNum)}</b><span>${esc(p.title)}</span></button>`).join('')
    + names.map(p => `<button type="button" class="sug" data-sugname="${esc(p.title)}"><span>${esc(p.title)}</span></button>`).join('')
    + (miss ? `<span class="miss">${esc(t('noVgMatch'))}</span>` : '')
    + (long ? `<span class="miss">${esc(t('vgTooLong'))}</span>` : '');
};

$('#resetBtn').onclick = () => { if (confirm(t('confirmReset'))) bg.resetScores(code); };
/* ---------- Sharing (QR code + link) ---------- */
const shareUrl = () => new URL(`?list=${code}`, location.href.split('?')[0]).href;
// A bundled third-party script (vendor/), loaded on first use; `ready` says whether it is there already
const loadScript = (url, ready) => ready() ? Promise.resolve() : new Promise((res, rej) => {
  const el = document.createElement('script');
  el.src = url.href;
  el.onload = res; el.onerror = rej; document.head.appendChild(el);
});
const loadQr = () => loadScript(new URL('vendor/qrcode.js', import.meta.url), () => window.qrcode);
// Copy a text; without clipboard access the text of `el` is selected so it can be copied by hand
async function copyText(el, text, copied = 'codeCopied', selected = 'codeSelected') {
  try { await navigator.clipboard.writeText(text); toast(t(copied)); }
  catch (e) { const r = document.createRange(); r.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast(t(selected)); }
}
async function openShareDialog(error = '') { // `error`: the first upload failed, the dialog stays open with a retry
  dismissKeyboard();
  $('#shareErr').textContent = error; $('#shareErr').classList.toggle('hide', !error);
  $('#shareStart').textContent = t(error ? 'tryAgain' : 'shareStart');
  $('#shareLocalBox').classList.toggle('hide', !isLocal());
  $('#shareSharedBox').classList.toggle('hide', isLocal());
  $('#shareDlg').classList.remove('hide');
  if (isLocal()) return;
  $('#shareCode').textContent = code;
  try {
    await loadQr();
    const qr = window.qrcode(0, 'M'); qr.addData(shareUrl()); qr.make();
    $('#qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  } catch (e) { $('#qr').textContent = t('qrFail'); }
}
const closeShareDialog = () => $('#shareDlg').classList.add('hide');
$('#shareBtn').onclick = () => openShareDialog();
$('#menuShare').onclick = () => openShareDialog(); // the same dialog from the ⋯ menu, where people also look for it
$('#shareClose').onclick = closeShareDialog;
$('#copyCode').onclick = () => copyText($('#shareCode'), $('#shareCode').textContent);
$('#shareStart').onclick = () => { closeShareDialog(); me.name ? shareLocalList() : askIdentity(shareLocalList, backToList); };
// Dev site only (the elements do not exist in the release): switch into a fresh shared test list without a code from another
// device, and back. The local list stays untouched; its items are copied (no points) into the new list.
if (IS_DEV) {
  const devBtn = (box, key, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn sec'; b.textContent = t(key); b.onclick = fn;
    const p = document.createElement('p'); p.style.margin = '12px 0 0'; p.appendChild(b);
    $(box).appendChild(p);
  };
  devBtn('#shareLocalBox', 'devShareCreate', async () => {
    closeShareDialog();
    if (!me.name) { me.name = 'Tester'; LS.set('me', me); }
    try {
      const data = { items: (await localDb.get(LOCAL, 'items')) || {}, deposit: (await localDb.get(LOCAL, 'deposit')) || {} };
      const remote = await getRemote();
      const c = await remote.create();
      await remote.importList(c, data, myKey());
      await startShared(c);
    } catch (e) { toast(noDbMsg(e)); startLocal(); }
  });
  devBtn('#shareSharedBox', 'devShareBack', () => { closeShareDialog(); forgetShared(); startLocal(); });
  // Diagnostics for what only a phone can show (status bar colour, service worker, caches); plain text, never HTML
  const diag = async out => {
    const meta = h => (h.match(/<meta[^>]*name="theme-color"[^>]*>/g) || []).join(' ') || '(none)';
    const lines = [];
    try { lines.push('server meta: ' + meta(await (await fetch(location.href, { cache: 'reload' })).text())); } catch (e) { lines.push('server meta: ' + e.message); }
    lines.push('live meta: ' + [...document.querySelectorAll('meta[name=theme-color]')].map(m => m.content).join(', '));
    lines.push('header: ' + getComputedStyle($('header')).backgroundColor + ', html: ' + getComputedStyle(document.documentElement).backgroundColor);
    lines.push('standalone: ' + (navigator.standalone === true) + ', dark: ' + matchMedia('(prefers-color-scheme: dark)').matches);
    try { lines.push('caches: ' + (await caches.keys()).join(', ')); } catch (e) { lines.push('caches: ' + e.message); }
    try { const r = await navigator.serviceWorker.getRegistration(); lines.push('sw: ' + (r && r.active ? r.active.scriptURL : 'none') + ', controlled: ' + !!navigator.serviceWorker.controller); } catch (e) { lines.push('sw: ' + e.message); }
    lines.push('url: ' + location.href);
    out.textContent = lines.join('\n');
  };
  // Entry in the "…" menu that opens the diagnostics in a small dialog (built here, so the release has no trace of it)
  const dlg = document.createElement('div');
  dlg.id = 'diagDlg'; dlg.className = 'hide';
  const card = document.createElement('div'); card.className = 'card'; card.style.cssText = 'max-width:340px;width:100%';
  const h = document.createElement('h2'); h.style.margin = '0 0 8px'; h.textContent = t('devDiag');
  const pre = document.createElement('pre'); pre.style.cssText = 'font-size:12px;white-space:pre-wrap;word-break:break-all;text-align:left;margin:0 0 12px';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'btn sec'; close.setAttribute('data-dialog-close', ''); close.textContent = t('close'); close.onclick = () => dlg.classList.add('hide');
  const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn sec'; copy.textContent = t('devDiagCopy'); copy.style.marginRight = '8px';
  copy.onclick = () => copyText(pre, pre.textContent, 'devDiagCopied', 'devDiagSelected');
  dlg.setAttribute('data-backdrop-close', '');
  card.append(h, pre, copy, close); dlg.appendChild(card); document.body.appendChild(dlg);
  const item = document.createElement('button');
  item.type = 'button'; item.setAttribute('role', 'menuitem'); item.textContent = t('devDiag');
  item.onclick = () => { dismissKeyboard(); pre.textContent = '…'; dlg.classList.remove('hide'); diag(pre); };
  $('#menu').appendChild(item); // last entry
}
$('#menuVersion').textContent = t('version', { v: BUILD });
// Join dialog (menu on the local list): type the code, or scan the QR code
const closeJoin = () => { $('#joinDlg').classList.add('hide'); $('#codeIn').value = ''; };
function openJoin() { dismissKeyboard(); $('#joinDlg').classList.remove('hide'); }
$('#menuJoin').onclick = openJoin;
$('#items').addEventListener('click', e => { if (e.target.closest('#emptyJoin')) openJoin(); }); // the empty-list hint offers the same dialog
$('#joinClose').onclick = closeJoin;
$('#joinScan').onclick = () => { closeJoin(); scanTarget = null; openScanner(true); };
$('#joinForm').onsubmit = e => {
  e.preventDefault();
  const c = parseListCode($('#codeIn').value);
  if (!c) { toast(t('notACode')); return; } // the dialog stays open with what was typed
  closeJoin(); joinShared(c);
};
const forgetShared = () => {
  clearTimeout(cacheTimer); // a snapshot about to be saved must not bring the cache of this list back
  const c = LS.get('code', ''); if (c) { dropSnapshot(localStorage, c); outbox.dropList(c); } // nothing to show or send for a list we left
  LS.set('code', ''); history.replaceState(null, '', location.pathname); };
// "..." menu in the header: reset, leave (shared lists only), help and privacy
{
  const menu = $('#menu'), btn = $('#menuBtn');
  const items = () => visibleFocusables(menu);
  const setOpen = open => {
    const was = !menu.classList.contains('hide');
    menu.classList.toggle('hide', !open); btn.setAttribute('aria-expanded', String(open));
    if (open && !was) { const first = items()[0]; if (first) first.focus(); } // keyboard users land on the first entry
  };
  btn.onclick = e => { e.stopPropagation(); dismissKeyboard(); setOpen(menu.classList.contains('hide')); };
  document.addEventListener('click', e => { if (!e.target.closest('#menu')) setOpen(false); });
  menu.addEventListener('click', e => { if (e.target.closest('button')) setOpen(false); });
  menu.addEventListener('keydown', e => {
    const list = items(), i = menuIndex(e.key, list.indexOf(document.activeElement), list.length);
    if (i >= 0) { e.preventDefault(); list[i].focus(); }
    else if (e.key === 'Tab') setOpen(false); // leaving the menu with Tab closes it
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || menu.classList.contains('hide')) return;
    setOpen(false); btn.focus(); e.preventDefault();
  });
}
// Dialogs (share, reset, join, diagnostics, scanner and any dialog added later): one generic helper gives them
// role, label, focus handling, a focus trap and Escape (a11y.js). From the menu, focus goes back to the menu button.
initDialogs(document, undefined, { fallbackFocus: el => (el.closest('#menu') ? $('#menuBtn') : null) });

// Reset dialog (menu): check boxes for what to clear (default: items in the basket and empties; the ranking only on a
// shared list, on by default). The button turns red while the open items are ticked.
const closeReset = () => $('#resetDlg').classList.add('hide');
const syncResetButton = () => {
  $('#resetGo').disabled = !['#resetOpen', '#resetDone', '#resetEmpties', '#resetScores'].some(s => $(s).checked);
  $('#resetGo').classList.toggle('destroy', $('#resetOpen').checked);
};
$('#menuReset').onclick = () => {
  dismissKeyboard();
  $('#resetOpen').checked = false; $('#resetDone').checked = true; $('#resetEmpties').checked = true; $('#resetScores').checked = !isLocal(); syncResetButton(); // ranking on by default, shared lists only
  $('#resetShared').classList.toggle('hide', isLocal()); $('#resetScoresOpt').classList.toggle('hide', isLocal());
  $('#resetDlg').classList.remove('hide');
};
$('#resetDlg').addEventListener('change', syncResetButton);
$('#resetCancel').onclick = closeReset;
$('#resetGo').onclick = async () => {
  if (readOnly()) return;
  const open = $('#resetOpen').checked, done = $('#resetDone').checked;
  const plan = resetPlan({ open, done, empties: $('#resetEmpties').checked, scores: $('#resetScores').checked }, !isLocal());
  // open items are still to be bought: removing them is asked once more
  if (open && Object.values(state.items).some(i => !i.checked) && !confirm(t(isLocal() ? 'confirmClearOpen' : 'confirmClearOpenShared'))) return;
  closeReset();
  try {
    for (const op of plan) await store[op](code);
  } catch (e) { if (!isPending(e)) toast(noDbMsg(e)); }
};
$('#menuLeave').onclick = () => {
  if (!confirm(`${t('confirmLeave')}\n\n${t('leaveCode', { code })}`)) return; // the code is shown so the person can come back
  forgetShared(); startLocal();
};
$('#deleteBtn').onclick = async () => {
  if (!confirm(t('confirmDeleteList'))) return;
  const c = code;
  if (unsub) { unsub(); unsub = null; } // do not react to our own deletion as if someone else had deleted the list
  try { await store.deleteList(c); } catch (e) { connect(); toast(noDbMsg(e)); return; }
  closeShareDialog(); forgetShared(); startLocal(); toast(t('toastListDeleted'));
};
$('#shareLink').onclick = async () => {
  const url = shareUrl();
  try { if (navigator.share) return await navigator.share({ title: t('shareTitleText'), text: t('shareText', { code }), url }); } catch (e) { return; }
  try { await navigator.clipboard.writeText(url); toast(t('linkCopied')); } catch (e) { prompt(t('linkPrompt'), url); }
};
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => show(b.dataset.t));
function show(id) {
  if (isLocal() && id === 'vScore') id = 'vList'; // the game only exists once the list is shared
  document.querySelectorAll('.tabs button').forEach(x => { // also when the app switches lists
    const on = x.dataset.t === id;
    x.classList.toggle('on', on); if (on) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current');
  });
  $('#vWelcome').classList.add('hide');
  for (const v of ['vList', 'vDeposit', 'vCheckout', 'vScore']) $('#' + v).classList.toggle('hide', v !== id);
  $('#addBar').classList.toggle('hide', id !== 'vList'); // the input bar belongs to the list tab
  setWake(id === 'vCheckout');
  if (id === 'vDeposit') vgLoader.start(); // no-op once the data is there; otherwise a retry
}

/* ---------- Barcode scanner ---------- */
let zxingReader = null, scanStream = null, scanBusy = false;
let scanTarget = null; // {id, checkToo} while the scanner was opened for one list item
const loadZxing = () => loadScript(new URL('vendor/zxing.min.js', import.meta.url), () => window.ZXing); // @zxing/library 0.21.3, bundled (no CDN)
// The line under the camera; a passing complaint ("not recognised") goes back to the aiming hint after a moment
let scanMsgTimer = 0;
function scanMsg(text, passing = false) {
  $('#scanMsg').textContent = text; clearTimeout(scanMsgTimer);
  if (passing) scanMsgTimer = setTimeout(() => { const sc = $('#scanner'); if (!sc.classList.contains('hide')) $('#scanMsg').textContent = t(sc.classList.contains('join') ? 'scanQrHint' : 'scanHint'); }, 2500);
}
async function productName(ean) {
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${ean}.json?fields=product_name,product_name_de,brands`);
    const j = await r.json();
    if (j.status !== 1) return null;
    const p = j.product, name = p.product_name_de || p.product_name;
    return name ? (p.brands ? `${name} (${p.brands.split(',')[0]})` : name) : null;
  } catch (e) { return null; }
}
// Scan for one list item (button on the row): a VG label sets its number, an ordinary barcode is remembered on the item.
// If the scanned product is named completely differently, ask first. `c` is what classifyScan made of the code.
async function scanForRow(c, p, target) {
  const checkToo = scanTarget.checkToo && !target.checked;
  if (p) {
    if (p.placeholder) { if (!numberFits(p, p.vgNum, target)) return; }
    else if (!similarNames(p.title, target.title) && !confirm(t('confirmScanMismatch', { scanned: p.title, listed: target.title }))) return;
    bg.setNum(code, target.id, myKey(), p.vgNum, checkToo, { title: p.title });
    toast(`✓ ${p.title}`);
  } else if (c.kind === 'vg') { // a VG number the database does not know (or the VG data has not loaded): keep it anyway, like in the input bar
    bg.setNum(code, target.id, myKey(), c.n, checkToo, {});
    toast(t(vg ? 'vgNotInDb' : 'vgSaved', { n: c.n }));
  } else if (c.kind === 'ean') {
    scanMsg(t('lookingUp'));
    const name = await productName(c.ean);
    if (name && !similarNames(name, target.title) && !confirm(t('confirmScanMismatch', { scanned: name, listed: target.title }))) return;
    bg.setEan(code, target.id, myKey(), c.ean, checkToo);
    toast(`✓ ${target.title}`);
  } else { toast(t('scanUnknown')); return; }
  buzz();
}
// A scanned or typed code (the camera, the manual field, a tapped suggestion)
async function handleCode(raw) {
  const join = $('#scanner').classList.contains('join');
  const c = classifyScan(raw, { join });
  if (join) { // scanning a list's QR code: only a list code or join link counts
    if (c.kind !== 'list') { scanMsg(t('notAList'), true); return; } // keep looking
    closeScanner(); joinShared(c.code); return;
  }
  if (scanBusy) return; scanBusy = true;
  try {
    if (readOnly()) { closeScanner(); return; }
    const p = c.kind === 'vg' && vg ? vg.lookup(c.n) : null; // a VG shelf label carries the VG number
    if (scanTarget) {
      const target = state.items[scanTarget.id];
      if (target) await scanForRow(c, p, target);
      closeScanner(); return;
    }
    // zxing (iOS) also reads QR codes: anything that is not a barcode number (a URL, some text) is ignored, keep looking
    if (c.kind === 'unknown') { scanMsg(t('scanUnknown'), true); return; }
    if (p && p.placeholder && !numberFits(p, c.n, null)) { closeScanner(); return; } // unused number, declined
    let r;
    if (p) r = addToBasket(p.title, { vgNum: p.vgNum }); // the labelled product (or the item with its number) goes into the basket
    else if (c.kind === 'vg') { // a VG number the database does not know, or the VG data has not loaded yet: a placeholder name
      r = addToBasket(t('vgPlaceholderTitle', { n: c.n }), { vgNum: c.n });
      if (r && !r.already) { toast(t(vg ? 'vgNotInDb' : 'vgSaved', { n: c.n })); r = null; }
    } else { // a product barcode: the item that has it, one with the product's name, or a new one
      const items = Object.values(state.items);
      let title = items.find(i => i.ean === c.ean)?.title;
      if (!title) {
        scanMsg(t('lookingUp'));
        const name = await productName(c.ean);
        const same = name && items.find(i => i.title.toLowerCase() === name.toLowerCase());
        if (same) { if (!same.checked) bg.check(code, same.id, myKey(), true); r = { title: same.title, already: !!same.checked }; }
        else title = name || t('itemFallback', { ean: c.ean });
      }
      if (!r) r = addToBasket(title, { ean: c.ean });
    }
    if (r) toast(t(r.already ? 'toastAlready' : 'toastInBasket', { item: r.title }));
    buzz();
    closeScanner();
  } finally { scanBusy = false; }
}
// The camera can be stopped while it is still starting (typing a number): a token invalidates pending starts.
let camToken = 0;
function stopCamera() {
  camToken++;
  if (zxingReader) { zxingReader.reset(); zxingReader = null; }
  if (scanStream) { scanStream.getTracks().forEach(track => track.stop()); scanStream = null; }
  $('#cam').srcObject = null;
}
async function startCamera() {
  const my = ++camToken, video = $('#cam');
  try {
    const join = $('#scanner').classList.contains('join'); // QR codes of lists instead of product barcodes
    if ('BarcodeDetector' in window && (!join || (await BarcodeDetector.getSupportedFormats()).includes('qr_code'))) { // compat-ok: guarded by 'in window' (Chrome/Android: built in, iOS uses zxing)
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      if (my !== camToken) { stream.getTracks().forEach(track => track.stop()); return; }
      scanStream = stream; video.srcObject = stream; await video.play();
      const det = new BarcodeDetector({ formats: join ? ['qr_code'] : ['ean_13', 'ean_8', 'upc_a', 'upc_e'] }); // compat-ok: only reached when the guard above found the detector (iOS uses zxing)
      const loop = async () => {
        if (!scanStream || my !== camToken) return;
        try { const r = await det.detect(video); if (r[0]) { await handleCode(r[0].rawValue); if (!scanStream || my !== camToken) return; } } catch (e) {}
        setTimeout(loop, 200);
      };
      loop();
    } else { // iOS/Safari etc.: load zxing on demand
      await loadZxing();
      if (my !== camToken) return;
      zxingReader = new ZXing.BrowserMultiFormatReader();
      zxingReader.decodeFromConstraints({ video: { facingMode: 'environment' } }, video, r => { if (r) handleCode(r.getText()); });
    }
  } catch (e) {
    if (my === camToken) scanMsg(t('cameraFail'));
  }
}
function openScanner(join = false) {
  dismissKeyboard();
  $('#scanner').classList.remove('hide', 'manual'); $('#scanner').classList.toggle('join', join);
  scanMsg(t(join ? 'scanQrHint' : 'scanHint'));
  startCamera();
}
function closeScanner() {
  stopCamera();
  $('#scanner').classList.add('hide'); $('#scanner').classList.remove('manual', 'join'); scanTarget = null;
  $('#eanIn').value = ''; $('#scanSuggest').classList.add('hide');
}
$('#scanBtn').onclick = () => { scanTarget = null; openScanner(); };
$('#scanClose').onclick = closeScanner;
// Suggestions under the manual field of the scanner dialog (VG numbers from three digits on, tap = use it)
$('#eanIn').oninput = () => {
  const q = $('#eanIn').value.trim(), box = $('#scanSuggest'), sc = $('#scanner');
  // Typing a number: the camera is not needed any more, so switch it off (and on again when the field is emptied)
  if (q && !sc.classList.contains('manual')) { sc.classList.add('manual'); stopCamera(); }
  else if (!q && sc.classList.contains('manual')) { sc.classList.remove('manual'); scanMsg(t('scanHint')); startCamera(); }
  const rows = vg && /^\d{3,7}$/.test(q) ? vg.searchByNumber(q) : [];
  const miss = vg && /^\d{4,7}$/.test(q) && !rows.length && !vg.lookup(q);
  box.classList.toggle('hide', !rows.length && !miss);
  box.innerHTML = rows.map(p => `<button type="button" class="sug" data-scansug="${esc(p.vgNum)}"><b>${esc(p.vgNum)}</b><span>${esc(p.title)}</span></button>`).join('')
    + (miss ? `<span class="miss">${esc(t('noVgMatch'))}</span>` : '');
};
// Manual entry in the scanner dialog: 1-7 digits are a VG number, 8-14 digits a barcode number
$('#eanForm').onsubmit = e => {
  e.preventDefault();
  const v = $('#eanIn').value.trim(); $('#eanIn').value = '';
  if (/^\d{1,7}$/.test(v)) handleCode(`VG ${v}`);
  else if (/^\d{8,14}$/.test(v)) handleCode(v);
  else { $('#eanIn').dispatchEvent(new Event('input')); scanMsg(t('scanUnknown'), true); } // invalid: the camera comes back
};

/* ---------- Start / joining ---------- */
function buildEmojis() {
  $('#emojis').innerHTML = EMOJIS.map(e => `<button type="button" class="${e === me.emoji ? 'on' : ''}" aria-pressed="${e === me.emoji}">${e}</button>`).join('');
  $('#emojis').onclick = ev => { const b = ev.target.closest('button'); if (!b) return; me.emoji = b.textContent; buildEmojis(); $(`#emojis [aria-pressed=true]`)?.focus({ preventScroll: true }); };
}
// Name and emoji are only needed once there are other people (sharing or joining).
// Cancel puts back the name and emoji from before (the emoji buttons change `me` right away) and calls onCancel.
// iOS only: a link opened in Safari does not reach the installed app (separate storage). So in the iPhone browser a gate comes
// BEFORE everything else: install first, then how to join a list there. It can be clicked away ("Continue in the browser").
// Per list code and tab session for links (sessionStorage), for a plain visit until it was closed once (LS).
const hintSeenRead = () => { try { return sanitizeHintSeen(JSON.parse(sessionStorage.getItem(NS + 'hintSeen') || '[]')); } catch (e) { return []; } };
const browserHintDue = c => shouldShowBrowserHint(navigator, q => matchMedia(q), c, hintSeenRead());
function browserHintDone(c) { try { sessionStorage.setItem(NS + 'hintSeen', JSON.stringify(addHintSeen(hintSeenRead(), c))); } catch (e) { /* private mode: shown again next time */ } }
let gateCode = null;
let installPrompt = null; // Android: the browser's own install prompt, kept for the button
function showGate(c, proceed, kind = 'ios') {
  gateCode = c;
  const android = kind === 'android';
  $('#gateTitle').textContent = t(android ? 'gateTitleAndroid' : 'gateTitle');
  const steps = $('#gateSteps'); steps.textContent = '';
  const texts = android ? [t('gateStepAndroid')] : [t('gateStep1'), t('gateStep2'), ...(c ? [t('gateStepJoin', { code: c })] : [])];
  for (const text of texts) { const li = document.createElement('li'); li.textContent = text; steps.appendChild(li); }
  if (c && !android) { // the code in the join step is its own element, so it can be selected when copying is not allowed
    const [before, after] = t('gateStepJoin', { code: '\n' }).split('\n'), b = document.createElement('b');
    b.id = 'gateCodeText'; b.textContent = c; steps.lastChild.replaceChildren(before, b, after ?? '');
  }
  $('#gateCopy').classList.toggle('hide', !c || android);
  $('#gateInstall').classList.toggle('hide', !android);
  $('#gateGo').onclick = () => { $('#gateDlg').classList.add('hide'); if (c) browserHintDone(c); else LS.set('installHintOff', true); proceed(); };
  $('#gateDlg').classList.remove('hide');
}
$('#gateInstall').onclick = async () => {
  const p = installPrompt; installPrompt = null;
  $('#gateDlg').classList.add('hide'); LS.set('installHintOff', true);
  if (p) { try { p.prompt(); await p.userChoice; } catch (e) { /* the browser decided */ } }
};
// Android Chrome: when the browser says "installable", offer it once in front of the app (never inside the installed app)
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); installPrompt = e;
  if (shouldShowAndroidInstall(navigator, q => matchMedia(q), LS.get('installHintOff', false))) showGate(null, () => {}, 'android');
});
window.addEventListener('appinstalled', () => { installPrompt = null; $('#gateDlg').classList.add('hide'); LS.set('installHintOff', true); });
$('#gateCopy').onclick = () => copyText($('#gateCodeText'), gateCode);
// `joining`: the (validated) list code shown as a note. `check(key)` may return an error text that keeps the screen open.
let pendingCheck = null;
function askIdentity(next, onCancel = null, joining = null, check = null) {
  const before = { ...me };
  pending = next; pendingCheck = check; pendingCancel = onCancel && (() => { me.name = before.name; me.emoji = before.emoji; buildEmojis(); onCancel(); });
  $('#nameCancel').classList.toggle('hide', !onCancel);
  $('#joinNote').textContent = joining ? t('joiningList', { code: joining }) : ''; $('#joinNote').classList.toggle('hide', !joining);
  $('#welcomeErr').textContent = ''; $('#nameIn').value = me.name;
  for (const v of ['vList', 'vDeposit', 'vCheckout', 'vScore']) $('#' + v).classList.add('hide');
  $('#tabs').classList.add('hide'); $('#addBar').classList.add('hide'); $('#vWelcome').classList.remove('hide');
  $('#vWelcome h2').focus({ preventScroll: true }); // screen readers hear that the screen changed; the keyboard stays down
}
// A form, so the Return/Go key of the keyboard continues as well
$('#nameForm').onsubmit = e => {
  e.preventDefault();
  const n = $('#nameIn').value.trim().slice(0, 20);
  if (!n) { $('#welcomeErr').textContent = t('needName'); return; }
  const err = pendingCheck && pendingCheck(userKey(me.emoji, n));
  if (err) { $('#welcomeErr').textContent = err; return; }
  me.name = n; LS.set('me', me);
  const next = pending; pending = pendingCancel = pendingCheck = null; if (next) next();
};
$('#nameCancel').onclick = () => { const back = pendingCancel; pending = pendingCancel = pendingCheck = null; if (back) back(); };
// Ranking tab: the one place where the name is visible, so this is where it can be changed. Points move along.
$('#renameBtn').onclick = () => {
  const oldKey = myKey();
  const back = () => { $('#vWelcome').classList.add('hide'); $('#tabs').classList.remove('hide'); $('.tabs [data-t=vScore]').click(); };
  askIdentity(async () => {
    const newKey = myKey(); back();
    if (newKey === oldKey) return;
    outbox.renameKey(code, oldKey, newKey); // changes still waiting to be sent carry the old name
    try { await store.renameUser(code, oldKey, newKey); toast(t('toastRenamed', { who: newKey })); } catch (e) { toast(noDbMsg(e)); }
  }, back, null, key => (key !== oldKey && key in state.scores ? t('nameTaken') : '')); // the same name and emoji would merge two players
};
function enterApp() {
  $('#tabs').classList.remove('hide'); $('#shareBtn').classList.remove('hide');
  for (const id of ['#menuShare', '#menuReset', '#menuJoin', '#menuLeave']) $(id).classList.remove('hide'); // #menuLeave is hidden on the local list by CSS (body.local)
  document.body.classList.toggle('local', isLocal());
  show('vList');
  connect();
}
function startLocal() {
  code = LOCAL; store = localStore;
  enterApp();
}
async function startShared(c) {
  const remote = await Promise.race([getRemote(), new Promise((_, no) => setTimeout(() => no(Object.assign(new Error('SDK did not load'), { pending: true })), 15000))]); // throws when the SDK cannot be loaded (offline) or takes too long
  code = c; store = remote;
  LS.set('code', c); history.replaceState(null, '', `?list=${c}`);
  bg.join(code, myKey());
  enterApp();
}
async function joinShared(c) {
  const go = async () => {
    try {
      if (!(await (await getRemote()).exists(c))) { toast(t('noList')); return startLocal(); }
    } catch (e) { toast(noDbMsg(e)); return startLocal(); }
    try { await startShared(c); } catch (e) { toast(noDbMsg(e)); startLocal(); return; }
  };
  // cancel: back to the list on screen, or (a join link opened the app) to the local list
  me.name ? go() : askIdentity(go, () => { history.replaceState(null, '', location.pathname); store ? backToList() : startLocal(); }, c);
}
// Leave the name screen without changes
function backToList() { $('#tabs').classList.remove('hide'); show('vList'); }
// Upload the local list, then continue on the shared one. The local copy is removed only after the upload succeeded.
// A retry after a failed upload fills the list the first attempt created (`shareMade`) instead of starting another one.
let shareMade = {};
async function shareLocalList() {
  try {
    const data = { items: (await localDb.get(LOCAL, 'items')) || {}, deposit: (await localDb.get(LOCAL, 'deposit')) || {} };
    await startShared(await uploadLocalList(await getRemote(), data, myKey(), shareMade));
    shareMade = {};
  } catch (e) { // name and emoji are saved and the local list is untouched: keep the share flow open, one tap tries again
    if (!$('#vWelcome').classList.contains('hide')) backToList();
    openShareDialog(noDbMsg(e));
    return;
  }
  try { await localDb.remove(LOCAL, ''); } catch (e) { /* the shared list is up; a leftover local copy is harmless */ }
  openShareDialog();
}

// The Firebase SDK is only loaded when a shared list is needed, so the local list starts without any network.
// `?sim=overload|slow|flap|recover:<seconds>` swaps in a simulated server (sim.js) to see the overload handling: only in demo
// mode or on the dev site, never on the release with a real database.
const simName = new URLSearchParams(location.search).get('sim');
const remoteStore = db => outbox.wrap(createStore(db, { onResult: conn.opResult, conn, journal: outbox.journal }), conn);
async function simulatedRemote() {
  const { createSim, applyScenario } = await import('./sim.js');
  const sim = createSim(localDb);
  if (!applyScenario(sim, simName)) return null;
  return remoteStore(sim);
}
const getRemote = () => remotePromise = remotePromise || (async () => {
  if (simName && (!firebaseConfig || IS_DEV)) { const s = await simulatedRemote(); if (s) return s; }
  return firebaseConfig ? firebaseAdapter(firebaseConfig).then(remoteStore) : localStore;
})().catch(e => { remotePromise = null; throw e; });

async function init() {
  applyStatic();
  if (IS_DEV) { $('#devTag').classList.remove('hide'); document.title += ' DEV'; } // after applyStatic, which sets the title
  buildEmojis();
  localDb = localAdapter(); localStore = createStore(localDb);
  if (!firebaseConfig) $('#demoBanner').classList.remove('hide');
  render();
  vgLoader.start();
  const urlList = new URLSearchParams(location.search).get('list');
  const urlCode = parseListCode(urlList); // same check as typed and scanned codes
  if (urlList && !urlCode) toast(t('notAList'));
  const savedCode = LS.get('code', '');
  const startFlow = () => {
    if (urlCode && urlCode !== savedCode) joinShared(urlCode);
    else if (savedCode && me.name) startShared(savedCode).catch(e => { toast(noDbMsg(e)); startLocal(); }); // offline: local list, saved code is kept
    else startLocal();
  };
  const gateFor = urlCode && browserHintDue(urlCode) ? urlCode : null;
  if (gateFor || (!urlList && shouldShowInstallHint(navigator, q => matchMedia(q), LS.get('installHintOff', false)))) showGate(gateFor, startFlow);
  else startFlow();
}
init();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
