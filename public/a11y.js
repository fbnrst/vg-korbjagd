// Accessibility helpers: generic dialog semantics (role, label, focus in, focus trap, Escape, focus back), keyboard
// navigation of the "..." menu, and short names for button labels. The pure functions are tested in node
// (test/a11y.test.js); initDialogs() is the browser part.

// Default set of dialog containers. A dialog is "open" while it does not carry the class `hide`. A dialog built later only
// has to match the selector (or carry the attribute data-dialog) and is picked up by the observer.
export const DIALOG_SELECTOR = '#shareDlg,#importDlg,#resetDlg,#joinDlg,#installDlg,#diagDlg,#gateDlg,#scanner,[data-dialog]';
export const FOCUSABLE = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';

// Item names go into button labels: one line, at most `max` characters
export function shortName(s, max = 40) {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1).trimEnd() + '…' : one;
}

// Focus trap: given the focusable elements of the open dialog (in tab order), the active element and the Tab direction,
// returns the element that must get focus, or null when the browser may do its normal thing.
export function trapTarget(list, active, shift) {
  if (!list.length) return null;
  const i = list.indexOf(active);
  if (i < 0) return shift ? list[list.length - 1] : list[0]; // focus is outside (or on the dialog itself): pull it in
  if (!shift && i === list.length - 1) return list[0];
  if (shift && i === 0) return list[list.length - 1];
  return null;
}

// Arrow-key navigation of a menu: new index for a key, or -1 when the key is not a navigation key
export function menuIndex(key, index, count) {
  if (!count) return -1;
  if (key === 'ArrowDown') return index < 0 ? 0 : (index + 1) % count;
  if (key === 'ArrowUp') return index < 0 ? count - 1 : (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return -1;
}

export const isShown = el => !!el && el.isConnected && el.getClientRects().length > 0;
export const visibleFocusables = root => [...root.querySelectorAll(FOCUSABLE)].filter(el => !el.disabled && isShown(el));

// Applies the dialog semantics to every element matching `selector`, now and later (also when a dialog is created or
// shown after this call). opts.fallbackFocus(opener) may return another element to focus when the opener is gone.
export function initDialogs(doc = document, selector = DIALOG_SELECTOR, opts = {}) {
  const win = doc.defaultView;
  const state = new WeakMap(); // dialog -> { open, opener }
  const stack = []; // open dialogs, topmost last
  let lastFocus = null;
  const isText = el => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(button|checkbox|radio|submit)$/.test(el.type)));
  let seq = 0;

  const prepare = dlg => {
    if (!dlg.hasAttribute('role')) dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    if (!dlg.hasAttribute('tabindex')) dlg.setAttribute('tabindex', '-1'); // focus target when it opens
  };
  const label = dlg => { // the first visible heading (or an element marked data-dialog-title) names the dialog
    const title = [...dlg.querySelectorAll('[data-dialog-title],h1,h2,h3')].find(isShown);
    if (!title) return;
    if (!title.id) title.id = 'dlgTitle' + (++seq);
    dlg.setAttribute('aria-labelledby', title.id);
  };
  const sync = dlg => {
    prepare(dlg);
    const st = state.get(dlg) || { open: false, opener: null };
    state.set(dlg, st);
    const open = !dlg.classList.contains('hide') && !dlg.hidden;
    if (open === st.open) return;
    st.open = open;
    if (open) {
      const a = doc.activeElement;
      st.opener = a && a !== doc.body && !dlg.contains(a) ? a : lastFocus;
      stack.push(dlg); label(dlg);
      dlg.focus({ preventScroll: true });
    } else {
      const i = stack.indexOf(dlg); if (i >= 0) stack.splice(i, 1);
      const a = doc.activeElement, inside = !a || a === doc.body || dlg.contains(a);
      let back = st.opener;
      if (back && !isShown(back) && opts.fallbackFocus) back = opts.fallbackFocus(back);
      // never return to a text field: on a phone that would raise the keyboard again
      if (inside && !stack.length && back && isShown(back) && !isText(back)) back.focus({ preventScroll: true });
      else if (inside && stack.length) stack[stack.length - 1].focus({ preventScroll: true });
      st.opener = null;
    }
  };
  const scan = root => { for (const d of (root.matches && root.matches(selector) ? [root] : [])) sync(d); if (root.querySelectorAll) for (const d of root.querySelectorAll(selector)) sync(d); };

  doc.addEventListener('focusin', e => { if (!e.target.closest(selector)) lastFocus = e.target; }, true);
  doc.addEventListener('keydown', e => {
    const dlg = stack[stack.length - 1];
    if (!dlg) return;
    if (e.key === 'Tab') {
      const target = trapTarget(visibleFocusables(dlg), doc.activeElement, e.shiftKey);
      if (target) { e.preventDefault(); target.focus(); }
    } else if (e.key === 'Escape' && !e.defaultPrevented) {
      const btn = dlg.querySelector('.dlg-x,[data-dialog-close]');
      if (btn) { e.preventDefault(); btn.click(); } else dlg.classList.add('hide');
    }
  });

  const MO = win && win.MutationObserver;
  if (MO) {
    new MO(records => {
      const seen = new Set();
      for (const r of records) {
        if (r.type === 'attributes') { if (r.target.matches(selector)) seen.add(r.target); }
        else for (const n of r.addedNodes) if (n.nodeType === 1) scan(n);
      }
      for (const d of seen) sync(d);
    }).observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  }
  scan(doc.body);
  return { stack };
}
