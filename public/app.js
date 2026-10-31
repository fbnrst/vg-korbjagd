import firebaseConfig from './firebase-config.js';
import { createStore, firebaseAdapter, localAdapter, userKey } from './store.js';
import { loadVg, parseShareLink, fetchSharedList } from './vg.js';

const $ = s => document.querySelector(s);
const EMOJIS = ['🦊','🐼','🐯','🦄','🐸','🐙','🦖','🚀','⭐','🍓','🐵','🦁'];
const LS = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } },
             set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };

const me = LS.get('me', { name: '', emoji: EMOJIS[0] });
let code = (new URLSearchParams(location.search).get('list') || LS.get('code', '') || '').toUpperCase();
let state = { items: {}, scores: {}, deposit: {} };
let store = null, unsub = null, first = true, vg = null;

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const myKey = () => userKey(me.emoji, me.name);
const splitKey = k => { const i = k.indexOf(' '); return { emoji: k.slice(0, i), name: k.slice(i + 1) }; };

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------- Sync ---------- */
function onSnapshot(s) {
  const next = { items: (s && s.items) || {}, scores: (s && s.scores) || {}, deposit: (s && s.deposit) || {} };
  if (!first) { // Änderungen anderer als Hinweis zeigen
    for (const i of Object.values(next.items)) {
      const was = state.items[i.id];
      if (i.checked && !(was && was.checked) && i.checkedBy && i.checkedBy !== myKey()) {
        const w = splitKey(i.checkedBy); toast(`${w.emoji} ${w.name} hat ${i.title} in den Korb gelegt 🛒`);
      } else if (!was && i.addedBy && i.addedBy !== myKey()) {
        const w = splitKey(i.addedBy); toast(`${w.emoji} ${w.name} hat ${i.title} hinzugefügt`);
      }
    }
  }
  first = false; state = next; render();
}
function connect() {
  if (unsub) unsub();
  first = true;
  unsub = store.subscribe(code, onSnapshot, on => $('#dot').classList.toggle('on', on));
}

/* ---------- Rendering ---------- */
function itemHtml(i) {
  const by = i.checked && i.checkedBy ? `<span class="badge">${esc(i.checkedBy)}</span>` : '';
  const sub = i.vgNum ? `VG ${i.vgNum}` : '';
  const vgIn = i.vgNum || i.checked ? '' : `<form data-vg="${i.id}"><input class="vg" type="number" inputmode="numeric" placeholder="Nr."></form>`;
  return `<div class="item ${i.checked ? 'done' : ''}">
      <button class="chk" data-chk="${i.id}" aria-label="${i.checked ? 'zurück auf die Liste' : 'abhaken'}">${i.checked ? '✓' : ''}</button>
      <div class="t">${i.amount > 1 ? `${i.amount}${i.unit ? ' ' + esc(i.unit) : '×'} ` : ''}${esc(i.title)}<small>${esc(sub)}</small></div>${by}${vgIn}
      <button class="x" data-del="${i.id}" aria-label="löschen">×</button></div>`;
}
function render() {
  const all = Object.values(state.items).sort((a, b) => ((a.addedAt || 0) - (b.addedAt || 0)));
  const open = all.filter(i => !i.checked);
  const done = all.filter(i => i.checked).sort((a, b) => (b.checkedAt || 0) - (a.checkedAt || 0)); // zuletzt abgehakt oben
  $('#items').innerHTML = open.length ? open.map(itemHtml).join('')
    : `<p class="muted" style="text-align:center">${all.length ? 'Alles im Korb 🎉' : 'Noch nichts auf der Liste.'}</p>`;
  $('#doneCard').classList.toggle('hide', !done.length);
  $('#doneHead').textContent = `Im Korb · ${done.length}`;
  $('#doneItems').innerHTML = done.map(itemHtml).join('');
  $('#count').textContent = `${done.length}/${all.length} im Korb`;
  renderDeposit(); renderKasse();

  const rank = Object.entries(state.scores).sort((a, b) => b[1] - a[1]);
  // Gleiche Punkte = gleicher Platz (1, 1, 3, …), ohne Punkte keine Medaille
  const placed = rank.map(([k, n]) => ({ k, n, place: 1 + rank.findIndex(r => r[1] === n) }));
  const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };
  const max = Math.max(1, placed[0] ? placed[0].n : 1);
  const at = p => placed.filter(x => x.place === p && x.n > 0);
  const podium = [...at(2), ...at(1), ...at(3)];
  $('#podium').innerHTML = podium.map(({ k, n, place }) => {
    const w = splitKey(k), h = 30 + 80 * n / max;
    return `<div class="pod"><div class="e">${w.emoji}</div><div>${esc(w.name)}</div><div class="bar" style="height:${h}px">${MEDAL[place]} ${n}</div></div>`;
  }).join('') || '<span class="muted">Noch keine Punkte – ab in den Korb!</span>';
  $('#ranks').innerHTML = placed.map(({ k, n, place }) => `<div class="rank"><span>${n > 0 && MEDAL[place] ? MEDAL[place] : place + '.'}</span><span>${esc(k)}</span><b>${n}</b></div>`).join('');
}

/* ---------- Kasse ---------- */
const kasseOff = new Set(); // lokal als erledigt markiert
const byTitle = (a, b) => a.title.localeCompare(b.title, 'de');
function kasseRow(key, title, amount, unit, no) {
  const weight = ['g', 'kg', 'Liter'].includes(unit) || amount === 1;
  const mid = unit && amount ? `<small>[${weight ? amount + ' ' : ''}${esc(unit)}]</small>` : '';
  const times = !weight && amount > 1 ? `<small>${amount} × </small>` : '';
  return `<div class="kr${kasseOff.has(key) ? ' off' : ''}" data-kasse="${esc(key)}"><div class="nm">${esc(title)}${mid}</div><div class="no">${times}${no || '–'}</div></div>`;
}
function renderKasse() {
  const inBasket = Object.values(state.items).filter(i => i.checked).sort(byTitle);
  const sec = (head, rows) => rows.length ? `<div class="card ks"><h3>${head}</h3>${rows.join('')}</div>` : '';
  const row = i => kasseRow(i.id, i.title, i.amount, i.unit, i.vgNum);
  const dep = vg ? vg.deposits.filter(t => depSum(t.id) > 0).map(t => kasseRow('d' + t.id, t.name, depSum(t.id), '', t.vgNum)) : [];
  $('#kasse').innerHTML = sec('Artikel', inBasket.filter(i => i.vgNum >= 1000).map(row))
    + sec('Backwaren', inBasket.filter(i => i.vgNum && i.vgNum < 1000).map(row))
    + sec('Ohne VG-Nummer', inBasket.filter(i => !i.vgNum).map(row))
    + sec('Leergut', dep)
    || '<p class="muted" style="text-align:center">Lege Artikel in den Korb, dann erscheinen sie hier mit ihren VG-Nummern.</p>';
}
let wakeLock = null;
async function setWake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { wakeLock = null; }
}

/* ---------- Leergut ---------- */
const depSum = id => Object.values(state.deposit[id] || {}).reduce((s, n) => s + n, 0);
function renderDeposit() {
  const types = vg ? vg.deposits : null;
  $('#depItems').innerHTML = !types ? '<p class="muted" style="text-align:center">VG-Daten werden geladen …</p>'
    : types.map(t => `<div class="dep"><div class="t">${esc(t.name)}<small>VG ${t.vgNum}</small></div>
        <button data-dep-sub="${t.id}" aria-label="weniger">−</button><span class="n">${depSum(t.id)}</span><button class="add" data-dep-add="${t.id}" aria-label="mehr">+</button></div>`).join('');
  const total = types ? types.reduce((s, t) => s + depSum(t.id), 0) : 0;
  $('#depTotal').textContent = `${total} Stück`;
}

/* ---------- Events ---------- */
document.addEventListener('click', e => {
  const chk = e.target.closest('[data-chk]');
  if (chk) { const it = state.items[chk.dataset.chk]; if (it) store.check(code, it.id, myKey(), !it.checked); return; }
  const kr = e.target.closest('[data-kasse]');
  if (kr) { const k = kr.dataset.kasse; kasseOff.has(k) ? kasseOff.delete(k) : kasseOff.add(k); renderKasse(); return; }
  const dadd = e.target.closest('[data-dep-add]'), dsub = e.target.closest('[data-dep-sub]');
  if (dadd) { store.depositAdd(code, dadd.dataset.depAdd, myKey()); return; }
  if (dsub) { store.depositRemove(code, dsub.dataset.depSub, myKey()); return; }
  const del = e.target.closest('[data-del]');
  if (del) { const it = state.items[del.dataset.del]; if (it && confirm(`„${it.title}“ löschen?`)) store.remove(code, it.id); }
});
document.addEventListener('submit', e => {
  const f = e.target.closest('[data-vg]');
  if (!f) return;
  e.preventDefault();
  const v = parseInt(f.querySelector('input').value, 10);
  if (!(v > 0)) return;
  const p = vg && vg.lookup(v);
  store.setNum(code, f.dataset.vg, myKey(), v, true, p ? { title: p.title } : {}); // Nummer eingeben = im Korb
  toast(p ? `✓ ${p.title}` : vg ? `VG-Nr. ${v} nicht in der VG-Datenbank` : `VG-Nr. ${v} gespeichert (VG-Daten nicht geladen)`);
});
$('#addForm').onsubmit = e => {
  e.preventDefault();
  const v = $('#addIn').value.trim(); if (!v) return;
  $('#addIn').value = ''; $('#addPreview').classList.add('hide'); $('#vgSug').innerHTML = '';
  if (parseShareLink(v)) return openImport(v); // Teilen-Link der Original-App eingefügt
  const isNum = /^\d+$/.test(v);
  const p = vg && (isNum ? vg.lookup(v) : vg.byTitle(v));
  if (p) store.add(code, { id: uid(), title: p.title, vgNum: p.vgNum }, myKey());
  else store.add(code, { id: uid(), title: isNum ? `VG-Nr. ${v}` : v, vgNum: isNum ? +v : null }, myKey());
  if (isNum && !p) toast(vg ? `VG-Nr. ${v} nicht in der VG-Datenbank` : 'VG-Daten noch nicht geladen');
};
// Nummern-Modus: Zahlentastatur, nur Ziffern (wie der „123“-Schalter der Original-App)
let numMode = LS.get('numMode', false);
function applyMode(focus) {
  const inp = $('#addIn');
  inp.inputMode = numMode ? 'numeric' : 'text';
  inp.enterKeyHint = 'go';
  inp.placeholder = numMode ? 'VG-Nummer …' : 'Artikel oder VG-Nummer …';
  if (numMode) inp.value = inp.value.replace(/\D/g, '');
  $('#modeBtn').classList.toggle('on', numMode); $('#modeBtn').setAttribute('aria-pressed', numMode);
  inp.dispatchEvent(new Event('input'));
  if (focus) inp.focus(); // Tastatur bleibt offen und wechselt das Layout
}
$('#modeBtn').onclick = () => { numMode = !numMode; LS.set('numMode', numMode); applyMode(true); };
applyMode(false);

// Eingabeleiste über der Tastatur: Tab-Leiste ausblenden, Leiste an die Unterkante des sichtbaren Bereichs legen
// (iOS verschiebt nur den sichtbaren Bereich, Chrome/Android ändert dank resizes-content die Seitenhöhe)
{
  const vv = window.visualViewport, bar = $('#addBar');
  const place = () => { const kb = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0; document.body.style.setProperty('--kb', kb + 'px'); };
  $('#addIn').addEventListener('focus', () => { document.body.classList.add('typing'); place(); });
  $('#addIn').addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== $('#addIn')) { document.body.classList.remove('typing'); document.body.style.removeProperty('--kb'); } }, 100));
  if (vv) { vv.addEventListener('resize', place); vv.addEventListener('scroll', place); }
  // Knöpfe in der Leiste dürfen den Fokus nicht stehlen, sonst klappt die Tastatur zu
  bar.addEventListener('pointerdown', e => { if (e.target.closest('button') && e.target.id !== 'scanBtn') e.preventDefault(); });
}

// Beim Tippen: Namen -> Vorschläge ohne Nummer, Nummer -> Produktvorschau
$('#addIn').oninput = () => {
  if (numMode) $('#addIn').value = $('#addIn').value.replace(/\D/g, '');
  const q = $('#addIn').value.trim(), pv = $('#addPreview');
  const isNum = /^\d+$/.test(q);
  $('#vgSug').innerHTML = vg && q.length >= 2 && !isNum
    ? vg.search(q).map(p => `<option value="${esc(p.title)}"></option>`).join('') : '';
  const p = vg && isNum ? vg.lookup(q) : null;
  pv.classList.toggle('hide', !isNum || !vg || (!p && q.length < 4));
  pv.classList.toggle('miss', isNum && !p);
  pv.textContent = p ? `→ ${p.title}` : 'Keine VG-Nummer mit diesem Wert gefunden';
};

/* ---------- Import aus der Original-VG-App ---------- */
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
$('#importBtn').onclick = () => openImport();
$('#importClose').onclick = () => $('#importDlg').classList.add('hide');
$('#importGo').onclick = async () => {
  const link = parseShareLink($('#importIn').value), msg = $('#importMsg');
  if (!link) { msg.textContent = 'Das sieht nicht nach einem Teilen-Link der VG-App aus (…/list?shareId=123#…).'; return; }
  msg.textContent = 'Lade Liste …';
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
    msg.textContent = `${added} von ${items.length} Artikeln übernommen${added < items.length ? ' (Rest war schon auf der Liste)' : ''}.`;
    toast(`${added} Artikel aus der VG-App importiert`);
  } catch (e) { msg.textContent = 'Liste konnte nicht geladen werden (Link abgelaufen oder falsch?).'; }
};
$('#clearBtn').onclick = () => { if (confirm('Alle abgehakten Artikel entfernen?')) store.clearChecked(code); };
$('#depClear').onclick = () => { if (confirm('Leergut-Liste leeren? Die Punkte bleiben.')) store.clearDeposit(code); };
$('#resetBtn').onclick = () => { if (confirm('Rangliste für eine neue Runde zurücksetzen?')) store.resetScores(code); };
/* ---------- Teilen (QR-Code + Link) ---------- */
const shareUrl = () => new URL(`?list=${code}`, location.href.split('?')[0]).href;
function loadQr() {
  if (window.qrcode) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = new URL('vendor/qrcode.js', import.meta.url).href;
    s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
}
$('#shareBtn').onclick = async () => {
  $('#shareCode').textContent = code;
  $('#shareDlg').classList.remove('hide');
  try {
    await loadQr();
    const qr = window.qrcode(0, 'M'); qr.addData(shareUrl()); qr.make();
    $('#qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  } catch (e) { $('#qr').textContent = 'QR-Code konnte nicht erzeugt werden.'; }
};
$('#shareClose').onclick = () => $('#shareDlg').classList.add('hide');
$('#shareDlg').onclick = e => { if (e.target.id === 'shareDlg') $('#shareDlg').classList.add('hide'); };
$('#shareLink').onclick = async () => {
  const url = shareUrl();
  try { if (navigator.share) return await navigator.share({ title: 'Einkaufsliste', text: `Komm in unsere Einkaufsliste (Code ${code})`, url }); } catch (e) { return; }
  try { await navigator.clipboard.writeText(url); toast('Link kopiert'); } catch (e) { prompt('Link zum Teilen:', url); }
};
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  show(b.dataset.t);
});
function show(id) {
  for (const v of ['vList', 'vDeposit', 'vCheckout', 'vScore']) $('#' + v).classList.toggle('hide', v !== id);
  setWake(id === 'vCheckout');
}

/* ---------- Barcode-Scanner ---------- */
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
// Bekannten Artikel abhaken, sonst neu anlegen und gleich in den Korb legen
async function handleEan(ean) {
  if (scanBusy) return; scanBusy = true;
  try {
    let it = Object.values(state.items).find(i => i.ean === ean);
    if (!it) {
      $('#scanMsg').textContent = 'Suche Produkt …';
      const name = await productName(ean);
      it = name && Object.values(state.items).find(i => i.title.toLowerCase() === name.toLowerCase());
      if (!it) { it = { id: uid(), title: name || `Artikel ${ean}` }; store.add(code, { id: it.id, title: it.title, ean }, myKey()); }
    }
    if (!it.checked) { store.check(code, it.id, myKey(), true); toast(`✓ ${it.title} im Korb`); }
    else toast(`${it.title} ist schon im Korb`);
    if (navigator.vibrate) navigator.vibrate(60);
    closeScanner();
  } finally { scanBusy = false; }
}
async function openScanner() {
  $('#scanner').classList.remove('hide'); $('#scanMsg').textContent = 'Barcode in den Rahmen halten';
  const video = $('#cam');
  try {
    if ('BarcodeDetector' in window) { // Chrome/Android: eingebaut
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = scanStream; await video.play();
      const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
      const loop = async () => {
        if (!scanStream) return;
        try { const r = await det.detect(video); if (r[0]) return handleEan(r[0].rawValue); } catch (e) {}
        setTimeout(loop, 200);
      };
      loop();
    } else { // iOS/Safari u. a.: zxing nachladen
      await loadZxing();
      zxingReader = new ZXing.BrowserMultiFormatReader();
      zxingReader.decodeFromConstraints({ video: { facingMode: 'environment' } }, video, r => { if (r) handleEan(r.getText()); });
    }
  } catch (e) {
    $('#scanMsg').textContent = 'Kamera nicht verfügbar (HTTPS und Erlaubnis nötig). Code kann unten von Hand eingegeben werden.';
  }
}
function closeScanner() {
  if (zxingReader) { zxingReader.reset(); zxingReader = null; }
  if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
  $('#cam').srcObject = null; $('#scanner').classList.add('hide');
}
$('#scanBtn').onclick = openScanner;
$('#scanClose').onclick = closeScanner;
$('#eanForm').onsubmit = e => { e.preventDefault(); const v = $('#eanIn').value.trim(); $('#eanIn').value = ''; if (/^\d{8,14}$/.test(v)) handleEan(v); };

/* ---------- Start / Beitritt ---------- */
function buildEmojis() {
  $('#emojis').innerHTML = EMOJIS.map(e => `<button type="button" class="${e === me.emoji ? 'on' : ''}">${e}</button>`).join('');
  $('#emojis').onclick = ev => { const b = ev.target.closest('button'); if (!b) return; me.emoji = b.textContent; buildEmojis(); };
}
function needName() {
  const n = $('#nameIn').value.trim().slice(0, 20);
  if (!n) { $('#welcomeErr').textContent = 'Bitte zuerst einen Namen eingeben.'; return false; }
  me.name = n; LS.set('me', me); return true;
}
async function enter(c) {
  try {
    if (!(await store.exists(c))) { $('#welcomeErr').textContent = 'Diese Liste gibt es nicht.'; return; }
  } catch (e) { $('#welcomeErr').textContent = 'Keine Verbindung zur Datenbank.'; return; }
  code = c; LS.set('code', c);
  history.replaceState(null, '', `?list=${c}`);
  startList();
}
function startList() {
  $('#vWelcome').classList.add('hide'); $('#tabs').classList.remove('hide'); $('#shareBtn').classList.remove('hide');
  show('vList');
  store.join(code, myKey());
  connect();
}
$('#newList').onclick = async () => { if (needName()) { try { enter(await store.create()); } catch (e) { $('#welcomeErr').textContent = 'Keine Verbindung zur Datenbank.'; } } };
$('#joinBtn').onclick = () => { if (needName()) enter($('#codeIn').value.trim().toUpperCase()); };

async function init() {
  buildEmojis();
  $('#nameIn').value = me.name;
  store = createStore(firebaseConfig ? await firebaseAdapter(firebaseConfig) : localAdapter());
  if (store.mode === 'local') $('#demoBanner').classList.remove('hide');
  render();
  loadVg().then(v => { vg = v; render(); }).catch(() => {});
  if (code && me.name && await store.exists(code).catch(() => false)) startList();
  else { $('#vWelcome').classList.remove('hide'); $('#codeIn').value = code; }
}
init();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
