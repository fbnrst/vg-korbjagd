// Small UI pieces without list state: the toast, the question dialog, the keyboard, bundled scripts and copying.
// Used by app.js (and dev.js); the elements live in index.html.
import { t } from './i18n.js';

const $ = s => document.querySelector(s);

// Opening a dialog, menu or the scanner while a field has focus: the keyboard must go away first (iOS keeps it open
// when a button is tapped)
export function dismissKeyboard() {
  const el = document.activeElement;
  if (el && el !== document.body && typeof el.blur === 'function') el.blur();
}

// A toast is click-through. With an action ({label, aria, run}) it gets one button (the undo offer) and stays 8 s; a new offer
// replaces the previous one, so there is only ever one. A plain toast never pushes an offer away: it waits until the offer is
// gone (only the latest one waits). Plain toasts stay longer the longer the text is, and pointer or keyboard focus on the
// toast stops the clock until it leaves. Texts go in as text, never as HTML.
const toastMs = (msg, action) => (action ? 8000 : Math.min(8000, 2000 + 50 * String(msg).length));
let toastWaiting = null, toastTimer = 0;
export function toast(msg, action) {
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
function toastClock(ms) { clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, ms); }
function hideToast() {
  clearTimeout(toastTimer); $('#toast').classList.remove('show', 'act');
  if (toastWaiting) { const m = toastWaiting; toastWaiting = null; toast(m); }
}
{
  const el = $('#toast'), hold = () => clearTimeout(toastTimer);
  const go = () => { if (el.classList.contains('show') && !el.contains(document.activeElement)) toastClock(3000); };
  el.addEventListener('pointerenter', hold); el.addEventListener('focusin', hold);
  el.addEventListener('pointerleave', go); el.addEventListener('focusout', () => setTimeout(go, 0));
}

// A question before an action, in the app's own dialog (#askDlg) instead of the browser's confirm(): styled, in the app's
// language, accessible through initDialogs, and it does not freeze the page (the camera keeps running behind it).
// Resolves true for `yes`, false for Cancel, Escape or a tap beside it. `danger`: the yes button is the red one.
// `no: null` shows only the yes button (a message). A new question answers an open one with false.
let askDone = null;
export function ask(msg, { yes = t('ok'), no = t('cancel'), danger = false } = {}) {
  dismissKeyboard();
  if (askDone) askDone(false);
  return new Promise(resolve => {
    askDone = v => { askDone = null; $('#askDlg').classList.add('hide'); resolve(v); };
    $('#askText').textContent = msg;
    $('#askYes').textContent = yes; $('#askYes').classList.toggle('destroy', danger);
    $('#askNo').textContent = no ?? ''; $('#askNo').classList.toggle('hide', no === null);
    $('#askDlg').classList.remove('hide');
  });
}
$('#askYes').onclick = () => { if (askDone) askDone(true); };
$('#askNo').onclick = () => { if (askDone) askDone(false); };
export const asking = () => !$('#askDlg').classList.contains('hide');

// A bundled third-party script (vendor/), loaded on first use; `ready` says whether it is there already
export const loadScript = (url, ready) => ready() ? Promise.resolve() : new Promise((res, rej) => {
  const el = document.createElement('script');
  el.src = url.href;
  el.onload = res; el.onerror = rej; document.head.appendChild(el);
});

// Copy a text; without clipboard access the text of `el` is selected so it can be copied by hand
export async function copyText(el, text, copied = 'codeCopied', selected = 'codeSelected') {
  try { await navigator.clipboard.writeText(text); toast(t(copied)); }
  catch (e) { const r = document.createRange(); r.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast(t(selected)); }
}
