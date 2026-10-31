import firebaseConfig from './firebase-config.js';
import { createStore, firebaseAdapter, localAdapter, userKey } from './store.js';
import { loadVg, parseShareLink, fetchSharedList } from './vg.js';
import { t, applyStatic } from './i18n.js';

const $ = s => document.querySelector(s);
const EMOJIS = ['🦊','🐼','🐯','🦄','🐸','🐙','🦖','🚀','⭐','🍓','🐵','🦁'];
const LS = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } },
             set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };

const me = LS.get('me', { name: '', emoji: EMOJIS[0] });
// The list lives on this phone (code LOCAL) until it is shared; then it moves to the server under a 6-character code.
const LOCAL = 'LOCAL';
let code = LOCAL;
const isLocal = () => code === LOCAL;
let state = { items: {}, scores: {}, deposit: {} };
let store = null, localDb = null, localStore = null, remoteStore = null, pending = null;
let unsub = null, first = true, vg = null;

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const myKey = () => userKey(me.emoji, me.name || 'Me');
const splitKey = k => { const i = k.indexOf(' '); return { emoji: k.slice(0, i), name: k.slice(i + 1) }; };

function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------- Sync ---------- */
function onSnapshot(s) {
  if (!isLocal() && !(s && s.meta)) { // the shared list was deleted (by someone else or by the cleanup)
    toast(t('toastListGone')); forgetShared(); startLocal(); return;
  }
  const next = { items: (s && s.items) || {}, scores: (s && s.scores) || {}, deposit: (s && s.deposit) || {} };
  if (!first && !isLocal()) { // show other people's changes as a toast
    for (const i of Object.values(next.items)) {
      const was = state.items[i.id];
      if (i.checked && !(was && was.checked) && i.checkedBy && i.checkedBy !== myKey()) {
        const w = splitKey(i.checkedBy); toast(t('toastCheckedBy', { who: `${w.emoji} ${w.name}`, item: i.title }));
      } else if (!was && i.addedBy && i.addedBy !== myKey()) {
        const w = splitKey(i.addedBy); toast(t('toastAddedBy', { who: `${w.emoji} ${w.name}`, item: i.title }));
      }
    }
  }
  first = false; state = next; render();
}
function connect() {
  if (unsub) unsub();
  first = true;
  state = { items: {}, scores: {}, deposit: {} }; render();
  unsub = store.subscribe(code, onSnapshot, on => $('#dot').classList.toggle('on', on));
}

/* ---------- Rendering ---------- */
function itemHtml(i) {
  const by = !isLocal() && i.checked && i.checkedBy ? `<span class="badge">${esc(i.checkedBy)}</span>` : '';
  const sub = i.vgNum ? `VG ${i.vgNum}` : '';
  const vgIn = i.vgNum || i.checked ? '' : `<form data-vg="${esc(i.id)}"><input class="vg" type="number" inputmode="numeric" placeholder="${t('noShort')}"></form>`;
  return `<div class="item ${i.checked ? 'done' : ''}">
      <button class="chk" data-chk="${esc(i.id)}" aria-label="${t(i.checked ? 'ariaBack' : 'ariaCheck')}">${i.checked ? '✓' : ''}</button>
      <div class="t">${i.amount > 1 ? `${esc(i.amount)}${i.unit ? ' ' + esc(i.unit) : '×'} ` : ''}${esc(i.title)}<small>${esc(sub)}</small></div>${by}${vgIn}
      <button class="x" data-del="${esc(i.id)}" aria-label="${t('ariaDelete')}">×</button></div>`;
}
function render() {
  const all = Object.values(state.items).sort((a, b) => ((a.addedAt || 0) - (b.addedAt || 0)));
  const open = all.filter(i => !i.checked);
  const done = all.filter(i => i.checked).sort((a, b) => (b.checkedAt || 0) - (a.checkedAt || 0)); // most recently checked off first
  $('#items').innerHTML = open.length ? open.map(itemHtml).join('')
    : `<p class="muted" style="text-align:center">${t(all.length ? 'allInBasket' : 'nothingYet')}</p>`;
  $('#doneCard').classList.toggle('hide', !done.length);
  $('#doneHead').textContent = t('inBasketHead', { n: done.length });
  $('#doneItems').innerHTML = done.map(itemHtml).join('');
  $('#headInfo').textContent = `🛒 ${done.length}/${all.length}`;
  $('#headInfo').title = t('countInBasket', { done: done.length, all: all.length });
  renderDeposit(); renderCheckout();

  const rank = Object.entries(state.scores).sort((a, b) => b[1] - a[1]);
  // same points = same place (1, 1, 3, …), no medal without points
  const placed = rank.map(([k, n]) => ({ k, n, place: 1 + rank.findIndex(r => r[1] === n) }));
  const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };
  const max = Math.max(1, placed[0] ? placed[0].n : 1);
  const at = p => placed.filter(x => x.place === p && x.n > 0);
  const podium = [...at(2), ...at(1), ...at(3)];
  $('#podium').innerHTML = podium.map(({ k, n, place }) => {
    const w = splitKey(k), h = 30 + 80 * n / max;
    return `<div class="pod"><div class="e">${esc(w.emoji)}</div><div>${esc(w.name)}</div><div class="bar" style="height:${h}px">${MEDAL[place]} ${esc(n)}</div></div>`;
  }).join('') || `<span class="muted">${t('noPoints')}</span>`;
  $('#ranks').innerHTML = placed.map(({ k, n, place }) => `<div class="rank"><span>${n > 0 && MEDAL[place] ? MEDAL[place] : place + '.'}</span><span>${esc(k)}</span><b>${esc(n)}</b></div>`).join('');
}

/* ---------- Checkout ---------- */
const checkoutDone = new Set(); // marked done locally (per phone)
const byTitle = (a, b) => a.title.localeCompare(b.title, 'de');
function checkoutRow(key, title, amount, unit, no) {
  const weight = ['g', 'kg', 'Liter'].includes(unit) || amount === 1;
  const mid = unit && amount ? `<small>[${weight ? esc(amount) + ' ' : ''}${esc(unit)}]</small>` : '';
  const times = !weight && amount > 1 ? `<small>${esc(amount)} × </small>` : '';
  return `<div class="kr${checkoutDone.has(key) ? ' off' : ''}" data-checkout="${esc(key)}"><div class="nm">${esc(title)}${mid}</div><div class="no">${times}${esc(no || '–')}</div></div>`;
}
function renderCheckout() {
  const inBasket = Object.values(state.items).filter(i => i.checked).sort(byTitle);
  const sec = (head, rows) => rows.length ? `<div class="card ks"><h3>${head}</h3>${rows.join('')}</div>` : '';
  const row = i => checkoutRow(i.id, i.title, i.amount, i.unit, i.vgNum);
  const dep = vg ? vg.deposits.filter(d => depSum(d.id) > 0).map(d => checkoutRow('d' + d.id, d.name, depSum(d.id), '', d.vgNum)) : [];
  $('#checkout').innerHTML = sec(t('secItems'), inBasket.filter(i => i.vgNum >= 1000).map(row))
    + sec(t('secBakery'), inBasket.filter(i => i.vgNum && i.vgNum < 1000).map(row))
    + sec(t('secEmpties'), dep)
    || `<p class="muted" style="text-align:center">${t('checkoutEmpty')}</p>`;
}
let wakeLock = null;
async function setWake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { wakeLock = null; }
}

/* ---------- Empties ---------- */
const depSum = id => Object.values(state.deposit[id] || {}).reduce((s, n) => s + (Number(n) || 0), 0);
function renderDeposit() {
  const types = vg ? vg.deposits : null;
  $('#depItems').innerHTML = !types ? `<p class="muted" style="text-align:center">${t('loadingVg')}</p>`
    : types.map(d => `<div class="dep"><div class="t">${esc(d.name)}<small>VG ${esc(d.vgNum)}</small></div>
        <button data-dep-sub="${esc(d.id)}" aria-label="${t('ariaLess')}">−</button><span class="n">${depSum(d.id)}</span><button class="add" data-dep-add="${esc(d.id)}" aria-label="${t('ariaMore')}">+</button></div>`).join('');
  const total = types ? types.reduce((s, d) => s + depSum(d.id), 0) : 0;
  $('#depTotal').textContent = t('pcs', { n: total });
}

/* ---------- Events ---------- */
document.addEventListener('click', e => {
  const chk = e.target.closest('[data-chk]');
  if (chk) { const it = state.items[chk.dataset.chk]; if (it) store.check(code, it.id, myKey(), !it.checked); return; }
  const sg = e.target.closest('[data-sug]');
  if (sg) { // a suggested product was tapped: add it right away
    const p = vg && vg.lookup(sg.dataset.sug);
    if (p) store.add(code, { id: uid(), title: p.title, vgNum: p.vgNum }, myKey());
    $('#addIn').value = ''; $('#addIn').dispatchEvent(new Event('input'));
    return;
  }
  const kr = e.target.closest('[data-checkout]');
  if (kr) { const k = kr.dataset.checkout; checkoutDone.has(k) ? checkoutDone.delete(k) : checkoutDone.add(k); renderCheckout(); return; }
  const dadd = e.target.closest('[data-dep-add]'), dsub = e.target.closest('[data-dep-sub]');
  if (dadd) { store.depositAdd(code, dadd.dataset.depAdd, myKey()); return; }
  if (dsub) { store.depositRemove(code, dsub.dataset.depSub, myKey()); return; }
  const del = e.target.closest('[data-del]');
  if (del) { const it = state.items[del.dataset.del]; if (it && confirm(t('confirmDelete', { item: it.title }))) store.remove(code, it.id); }
});
document.addEventListener('submit', e => {
  const f = e.target.closest('[data-vg]');
  if (!f) return;
  e.preventDefault();
  const v = parseInt(f.querySelector('input').value, 10);
  if (!(v > 0)) return;
  const p = vg && vg.lookup(v);
  store.setNum(code, f.dataset.vg, myKey(), v, true, p ? { title: p.title } : {}); // entering the number puts it in the basket
  toast(p ? `✓ ${p.title}` : t(vg ? 'vgNotInDb' : 'vgSaved', { n: v }));
});
$('#addForm').onsubmit = e => {
  e.preventDefault();
  const v = $('#addIn').value.trim(); if (!v) return;
  $('#addIn').value = ''; $('#addSuggest').classList.add('hide'); $('#vgSug').innerHTML = '';
  if (parseShareLink(v)) return openImport(v); // a share link from the original app was pasted
  const isNum = /^\d+$/.test(v);
  const p = vg && (isNum ? vg.lookup(v) : vg.byTitle(v));
  if (p) store.add(code, { id: uid(), title: p.title, vgNum: p.vgNum }, myKey());
  else store.add(code, { id: uid(), title: isNum ? t('vgPlaceholderTitle', { n: v }) : v, vgNum: isNum ? +v : null }, myKey());
  if (isNum && !p) toast(vg ? t('vgNotInDb', { n: v }) : t('vgNotLoaded'));
};
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

// Input bar above the keyboard: hide the tab bar and pin the bar to the bottom edge of the visible area
// (iOS only moves the visual viewport; Chrome/Android resize the page thanks to resizes-content)
{
  const vv = window.visualViewport, bar = $('#addBar');
  const place = () => { const kb = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0; document.body.style.setProperty('--kb', kb + 'px'); };
  $('#addIn').addEventListener('focus', () => { document.body.classList.add('typing'); place(); });
  $('#addIn').addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== $('#addIn')) { document.body.classList.remove('typing'); document.body.style.removeProperty('--kb'); } }, 100));
  if (vv) { vv.addEventListener('resize', place); vv.addEventListener('scroll', place); }
  // buttons in the bar must not steal focus, otherwise the keyboard closes
  bar.addEventListener('pointerdown', e => { if (e.target.closest('button') && e.target.id !== 'scanBtn') e.preventDefault(); });
}

// While typing: names -> suggestions without numbers, number -> product preview
$('#addIn').oninput = () => {
  if (numMode) $('#addIn').value = $('#addIn').value.replace(/\D/g, '');
  const q = $('#addIn').value.trim(), box = $('#addSuggest');
  const isNum = /^\d+$/.test(q);
  $('#vgSug').innerHTML = vg && q.length >= 2 && !isNum
    ? vg.search(q).map(p => `<option value="${esc(p.title)}"></option>`).join('') : '';
  // From three digits on: a tappable list of matching products (tap = add it)
  const rows = vg && isNum && q.length >= 3 ? vg.searchByNumber(q) : [];
  const miss = vg && isNum && q.length >= 4 && !rows.length;
  box.classList.toggle('hide', !rows.length && !miss);
  box.innerHTML = rows.length
    ? rows.map(p => `<button type="button" class="sug" data-sug="${esc(p.vgNum)}"><b>${esc(p.vgNum)}</b><span>${esc(p.title)}</span></button>`).join('')
    : miss ? `<span class="miss">${esc(t('noVgMatch'))}</span>` : '';
};

/* ---------- Import from the original VG app ---------- */
let CryptoJSP = null;
function loadCrypto() {
  if (window.CryptoJS) return Promise.resolve(window.CryptoJS);
  return CryptoJSP = CryptoJSP || new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = new URL('vendor/crypto-js.js', import.meta.url).href;
    s.onload = () => res(window.CryptoJS); s.onerror = rej; document.head.appendChild(s);
  });
}
function openImport(text = '') {
  $('#importDlg').classList.remove('hide'); $('#importIn').value = text; $('#importMsg').textContent = '';
  if (text) $('#importGo').click();
}
$('#importClose').onclick = () => $('#importDlg').classList.add('hide');
$('#importGo').onclick = async () => {
  const link = parseShareLink($('#importIn').value), msg = $('#importMsg');
  if (!link) { msg.textContent = t('importBad'); return; }
  msg.textContent = t('importLoading');
  try {
    const items = await fetchSharedList(await loadCrypto(), link);
    const have = new Set(Object.values(state.items).map(i => i.title.toLowerCase()));
    let added = 0;
    for (const it of items) {
      const title = it.title;
      if (have.has(title.toLowerCase())) continue;
      have.add(title.toLowerCase());
      store.add(code, { id: uid(), title, vgNum: it.vgNum, amount: it.amount, unit: it.unit }, myKey());
      added++;
    }
    msg.textContent = `${t('importDone', { added, total: items.length })}${added < items.length ? t('importRest') : ''}.`;
    toast(t('toastImported', { n: added }));
  } catch (e) { msg.textContent = t('importFail'); }
};
$('#resetBtn').onclick = () => { if (confirm(t('confirmReset'))) store.resetScores(code); };
/* ---------- Sharing (QR code + link) ---------- */
const shareUrl = () => new URL(`?list=${code}`, location.href.split('?')[0]).href;
function loadQr() {
  if (window.qrcode) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = new URL('vendor/qrcode.js', import.meta.url).href;
    s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
}
async function openShareDialog() {
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
$('#shareBtn').onclick = openShareDialog;
$('#shareClose').onclick = closeShareDialog;
$('#shareCloseLocal').onclick = closeShareDialog;
$('#shareDlg').onclick = e => { if (e.target.id === 'shareDlg') closeShareDialog(); };
$('#shareStart').onclick = () => { closeShareDialog(); me.name ? shareLocalList() : askIdentity(shareLocalList); };
$('#joinBtn').onclick = () => { const c = $('#codeIn').value.trim().toUpperCase(); if (c) { closeShareDialog(); joinShared(c); } };
const forgetShared = () => { LS.set('code', ''); history.replaceState(null, '', location.pathname); };
// "?" menu in the header: help and privacy
{
  const menu = $('#helpMenu'), btn = $('#helpBtn');
  const setOpen = open => { menu.classList.toggle('hide', !open); btn.setAttribute('aria-expanded', String(open)); };
  btn.onclick = e => { e.stopPropagation(); setOpen(menu.classList.contains('hide')); };
  document.addEventListener('click', e => { if (!e.target.closest('#helpMenu')) setOpen(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });
}

// Reset dialog (header): choose what to clear (default: checked-off items and empties). Also the home of the
// VG app import and, on a shared list, of "leave this list".
const closeReset = () => $('#resetDlg').classList.add('hide');
$('#listBtn').onclick = () => {
  document.querySelector('input[name=resetWhat][value=done]').checked = true; $('#resetEmpties').checked = true;
  $('#resetShared').classList.toggle('hide', isLocal()); $('#resetLeave').classList.toggle('hide', isLocal());
  $('#resetDlg').classList.remove('hide');
};
$('#resetCancel').onclick = closeReset;
$('#resetDlg').onclick = e => { if (e.target.id === 'resetDlg') closeReset(); };
$('#resetGo').onclick = async () => {
  const all = document.querySelector('input[name=resetWhat]:checked').value === 'all';
  if (all && Object.keys(state.items).length && !confirm(t(isLocal() ? 'confirmClearAll' : 'confirmClearAllShared'))) return;
  closeReset();
  await (all ? store.clearAll(code) : store.clearChecked(code));
  if ($('#resetEmpties').checked) await store.clearDeposit(code);
};
$('#resetImport').onclick = () => { closeReset(); openImport(); };
$('#resetLeave').onclick = () => {
  if (!confirm(t('confirmLeave'))) return;
  closeReset(); forgetShared(); startLocal();
};
$('#deleteBtn').onclick = async () => {
  if (!confirm(t('confirmDeleteList'))) return;
  const c = code;
  if (unsub) { unsub(); unsub = null; } // do not react to our own deletion as if someone else had deleted the list
  try { await store.deleteList(c); } catch (e) { connect(); toast(t('noDb')); return; }
  closeShareDialog(); forgetShared(); startLocal(); toast(t('toastListDeleted'));
};
$('#shareLink').onclick = async () => {
  const url = shareUrl();
  try { if (navigator.share) return await navigator.share({ title: t('shareTitleText'), text: t('shareText', { code }), url }); } catch (e) { return; }
  try { await navigator.clipboard.writeText(url); toast(t('linkCopied')); } catch (e) { prompt(t('linkPrompt'), url); }
};
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  show(b.dataset.t);
});
function show(id) {
  if (isLocal() && id === 'vScore') id = 'vList'; // the game only exists once the list is shared
  $('#vWelcome').classList.add('hide');
  for (const v of ['vList', 'vDeposit', 'vCheckout', 'vScore']) $('#' + v).classList.toggle('hide', v !== id);
  setWake(id === 'vCheckout');
}

/* ---------- Barcode scanner ---------- */
let zxingReader = null, scanStream = null, scanBusy = false;
function loadZxing() {
  if (window.ZXing) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
    s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
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
// Check off a known item, otherwise create it and put it in the basket right away
async function handleEan(ean) {
  if (scanBusy) return; scanBusy = true;
  try {
    let it = Object.values(state.items).find(i => i.ean === ean);
    if (!it) {
      $('#scanMsg').textContent = t('lookingUp');
      const name = await productName(ean);
      it = name && Object.values(state.items).find(i => i.title.toLowerCase() === name.toLowerCase());
      if (!it) { it = { id: uid(), title: name || t('itemFallback', { ean }) }; store.add(code, { id: it.id, title: it.title, ean }, myKey()); }
    }
    if (!it.checked) { store.check(code, it.id, myKey(), true); toast(t('toastInBasket', { item: it.title })); }
    else toast(t('toastAlready', { item: it.title }));
    if (navigator.vibrate) navigator.vibrate(60);
    closeScanner();
  } finally { scanBusy = false; }
}
async function openScanner() {
  $('#scanner').classList.remove('hide'); $('#scanMsg').textContent = t('scanHint');
  const video = $('#cam');
  try {
    if ('BarcodeDetector' in window) { // Chrome/Android: built in
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = scanStream; await video.play();
      const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
      const loop = async () => {
        if (!scanStream) return;
        try { const r = await det.detect(video); if (r[0]) return handleEan(r[0].rawValue); } catch (e) {}
        setTimeout(loop, 200);
      };
      loop();
    } else { // iOS/Safari etc.: load zxing on demand
      await loadZxing();
      zxingReader = new ZXing.BrowserMultiFormatReader();
      zxingReader.decodeFromConstraints({ video: { facingMode: 'environment' } }, video, r => { if (r) handleEan(r.getText()); });
    }
  } catch (e) {
    $('#scanMsg').textContent = t('cameraFail');
  }
}
function closeScanner() {
  if (zxingReader) { zxingReader.reset(); zxingReader = null; }
  if (scanStream) { scanStream.getTracks().forEach(track => track.stop()); scanStream = null; }
  $('#cam').srcObject = null; $('#scanner').classList.add('hide');
}
$('#scanBtn').onclick = openScanner;
$('#scanClose').onclick = closeScanner;
$('#eanForm').onsubmit = e => { e.preventDefault(); const v = $('#eanIn').value.trim(); $('#eanIn').value = ''; if (/^\d{8,14}$/.test(v)) handleEan(v); };

/* ---------- Start / joining ---------- */
function buildEmojis() {
  $('#emojis').innerHTML = EMOJIS.map(e => `<button type="button" class="${e === me.emoji ? 'on' : ''}">${e}</button>`).join('');
  $('#emojis').onclick = ev => { const b = ev.target.closest('button'); if (!b) return; me.emoji = b.textContent; buildEmojis(); };
}
// Name and emoji are only needed once there are other people (sharing or joining).
function askIdentity(next) {
  pending = next;
  $('#welcomeErr').textContent = ''; $('#nameIn').value = me.name;
  for (const v of ['vList', 'vDeposit', 'vCheckout', 'vScore']) $('#' + v).classList.add('hide');
  $('#tabs').classList.add('hide'); $('#vWelcome').classList.remove('hide');
}
$('#newList').onclick = () => {
  const n = $('#nameIn').value.trim().slice(0, 20);
  if (!n) { $('#welcomeErr').textContent = t('needName'); return; }
  me.name = n; LS.set('me', me);
  const next = pending; pending = null; if (next) next();
};
function enterApp() {
  $('#tabs').classList.remove('hide'); $('#shareBtn').classList.remove('hide'); $('#listBtn').classList.remove('hide');
  document.body.classList.toggle('local', isLocal());
  show('vList');
  connect();
}
function startLocal() {
  code = LOCAL; store = localStore;
  enterApp();
}
function startShared(c) {
  code = c; store = remoteStore;
  LS.set('code', c); history.replaceState(null, '', `?list=${c}`);
  store.join(code, myKey());
  enterApp();
}
async function joinShared(c) {
  const go = async () => {
    try {
      if (!(await remoteStore.exists(c))) { toast(t('noList')); return startLocal(); }
    } catch (e) { toast(t('noDb')); return startLocal(); }
    startShared(c);
  };
  me.name ? go() : askIdentity(go);
}
// Upload the local list, then continue on the shared one. The local copy is removed only after the upload succeeded.
async function shareLocalList() {
  try {
    const data = { items: (await localDb.get(LOCAL, 'items')) || {}, deposit: (await localDb.get(LOCAL, 'deposit')) || {} };
    const c = await remoteStore.create();
    await remoteStore.importList(c, data, myKey());
    await localDb.remove(LOCAL, '');
    startShared(c);
    openShareDialog();
  } catch (e) { toast(t('noDb')); startLocal(); }
}

async function init() {
  applyStatic();
  buildEmojis();
  localDb = localAdapter(); localStore = createStore(localDb);
  remoteStore = firebaseConfig ? createStore(await firebaseAdapter(firebaseConfig)) : localStore;
  if (!firebaseConfig) $('#demoBanner').classList.remove('hide');
  render();
  loadVg().then(v => { vg = v; render(); }).catch(() => {});
  const urlCode = (new URLSearchParams(location.search).get('list') || '').toUpperCase();
  const savedCode = LS.get('code', '');
  if (urlCode && urlCode !== savedCode) joinShared(urlCode);
  else if (savedCode && me.name) startShared(savedCode);
  else startLocal();
}
init();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
