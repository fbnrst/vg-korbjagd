// Dev site only (app.js imports this module only when IS_DEV, so the release has no trace of it): buttons in the share dialog
// that switch into a fresh shared test list without a code from another device, and back, and a diagnostics dialog in the
// "…" menu for what only a phone can show. `app` hands over the few app functions this needs.
import { t } from './i18n.js';
import { toast, dismissKeyboard, copyText } from './ui.js';

const $ = s => document.querySelector(s);

// app: { closeShareDialog, ensureName, localData, getRemote, myKey, startShared, startLocal, forgetShared, noDbMsg }
export function initDev(app) {
  const devBtn = (box, key, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn sec'; b.textContent = t(key); b.onclick = fn;
    const p = document.createElement('p'); p.style.margin = '12px 0 0'; p.appendChild(b);
    $(box).appendChild(p);
  };
  // The local list stays untouched; its items are copied (no points) into the new list
  devBtn('#shareLocalBox', 'devShareCreate', async () => {
    app.closeShareDialog(); app.ensureName();
    try {
      const data = await app.localData();
      const remote = await app.getRemote();
      const c = await remote.create();
      await remote.importList(c, data, app.myKey());
      await app.startShared(c);
    } catch (e) { toast(app.noDbMsg(e)); app.startLocal(); }
  });
  devBtn('#shareSharedBox', 'devShareBack', () => { app.closeShareDialog(); app.forgetShared(); app.startLocal(); });

  // Diagnostics (status bar colour, service worker, caches); plain text, never HTML
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
  // Entry in the "…" menu that opens the diagnostics in a small dialog
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
