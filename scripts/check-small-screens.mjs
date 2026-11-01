// Layout check for small phones (npm run test:screens). Drives the real app (demo mode, Firebase off, invented VG data, like
// scripts/docs-screenshots.mjs) through every screen at several viewports, in German and English, light and dark, and
// reports violations. Not part of `npm test` (needs a browser).
//
//   npm run test:screens                           # everything
//   npm run test:screens -- --only=320x568         # one viewport (also: --lang=de, --scheme=dark)
//   npm run test:screens -- --shots=/tmp/shots     # also writes a screenshot of every screen (to look at them)
//
// Viewports: 320x568 is the iPhone SE (1st generation, last iOS 15.8), 320x480 approximates it with the keyboard open (the
// visible area shrinks, the real keyboard and its pan cannot be reproduced in a desktop browser), 375x667 and 390x844 are
// the common bigger phones. Rules, per screen:
//   - no horizontal page scroll (documentElement/body scrollWidth <= innerWidth)
//   - no visible element wider than the viewport or sticking out on the left or right
//   - no button, link, label or heading whose own text is wider than its box (truncated or spilling over; text-overflow
//     ellipsis is a deliberate cut and allowed), and no placeholder cut off in an input
//   - controls outside the scrolling list (header, input bar, tab bar, dialogs) lie fully inside the viewport
//   - no two controls overlap
//   - every text field has a computed font-size of at least 16px (below that iOS zooms into the page on focus)
//   - every control of the visible layer (the open dialog or scanner, else #app) is at least 40x40 px TO TAP. This is measured
//     the way a finger meets it: `document.elementFromPoint` is sampled along the horizontal and vertical centre line of the
//     control, from 16px before to 16px behind its box; the extent of the points that hit the control (or a child of it) is its
//     tap area. Pseudo-element hit areas (`.chk::after{inset:-10px}`) therefore count, and so does a neighbour that steals
//     part of the area. A check box or radio button is measured through its <label>. Allowed exception: a link that sits
//     inside a sentence (inline `a` in a `p`), as everywhere in the web.
//   - a dialog is either fully visible or scrolls (its content can be reached), and never starts above the top edge
// Exit code 1 and a list of the violations when something fails.
import { serve, launch, routeDemoOnly } from './lib/demo-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1];
const ALL_VIEWPORTS = [[320, 568], [320, 480], [375, 667], [390, 844]];
const VIEWPORTS = arg('only') ? ALL_VIEWPORTS.filter(([w, h]) => `${w}x${h}` === arg('only')) : ALL_VIEWPORTS;
const LANGS = arg('lang') ? [arg('lang')] : ['de', 'en'];
const SCHEMES = arg('scheme') ? [arg('scheme')] : ['light', 'dark'];
const SHOTS = arg('shots') ? path.resolve(arg('shots')) : null;
const MIN_TAP = 40, TAP_SLACK = 1; // pixels; one pixel of slack for fractional layout

// The audit runs inside the page and returns a list of readable violations
function audit({ minTap, slack, taps }) {
  const out = [];
  const vw = innerWidth, vh = innerHeight;
  const visible = el => (el.checkVisibility ? el.checkVisibility({ checkVisibilityCSS: true }) : !!el.offsetParent) && el.getBoundingClientRect().width > 0;
  const name = el => {
    const txt = (el.getAttribute('aria-label') || el.textContent || el.value || el.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '';
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls}${txt ? ` "${txt}"` : ''}`;
  };
  const scrollsY = el => { for (let p = el.parentElement; p; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return true; return false; }; // main, a scrolling dialog
  const px = n => Math.round(n * 10) / 10;

  // 1) horizontal scroll and elements outside the viewport
  if (document.documentElement.scrollWidth > vw) out.push(`horizontal scroll: documentElement.scrollWidth ${document.documentElement.scrollWidth} > ${vw}`);
  if (document.body.scrollWidth > vw) out.push(`horizontal scroll: body.scrollWidth ${document.body.scrollWidth} > ${vw}`);
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('svg') && el.tagName !== 'svg') continue;
    if (el.closest('script,style,video') || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width > vw + 0.5) out.push(`wider than the viewport (${px(r.width)} > ${vw}): ${name(el)}`);
    else if (r.left < -0.5 || r.right > vw + 0.5) out.push(`sticks out horizontally (${px(r.left)}..${px(r.right)} of ${vw}): ${name(el)}`);
  }

  // 2) text wider than its own box (the width of the text itself, not of absolutely positioned hit areas)
  for (const el of document.querySelectorAll('button,a,label,h1,h2,h3,.badge,.t,.nm,.no,.rank>span,.pod>div,.menu *')) {
    const cs = getComputedStyle(el);
    if (!visible(el) || cs.display === 'inline' || cs.textOverflow === 'ellipsis' || !el.textContent.trim()) continue;
    const range = document.createRange(); range.selectNodeContents(el);
    const textW = range.getBoundingClientRect().width, room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    if (textW > room + 1) out.push(`content wider than its box (${px(textW)} > ${px(room)}): ${name(el)}`);
  }
  const canvas = document.createElement('canvas').getContext('2d');
  for (const el of document.querySelectorAll('input')) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    if (el.placeholder && !el.value) {
      const ph = getComputedStyle(el, '::placeholder'); // the placeholder may be smaller than the field (only the field's own size triggers the iOS zoom)
      canvas.font = `${ph.fontStyle} ${ph.fontWeight} ${ph.fontSize} ${ph.fontFamily}`;
      const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const w = canvas.measureText(el.placeholder).width;
      if (w > room + 1) out.push(`placeholder cut off (${px(w)} > ${px(room)}): ${name(el)}`);
    }
    if (!['checkbox', 'radio', 'hidden', 'submit', 'button'].includes(el.type) && parseFloat(cs.fontSize) < 16) out.push(`font-size ${cs.fontSize} < 16px (iOS zooms in on focus): ${name(el)}`);
  }

  // 3) controls: inside the viewport (outside the scrolling list), not overlapping, big enough to tap
  // the layer that is on top: an open menu, dialog or scanner, else the app
  const suggest = document.querySelector('#addSuggest');
  const layer = suggest && visible(suggest) ? document.querySelector('#addBar') : [...document.querySelectorAll('.menu,#shareDlg,#resetDlg,#joinDlg,#diagDlg,#gateDlg,#askDlg,#scanner')].find(el => el && visible(el)) || document.querySelector('#app') || document.body;
  const clipped = el => { const r = el.getBoundingClientRect(); for (let p = el.parentElement; p; p = p.parentElement) { if (getComputedStyle(p).overflowY === 'visible') continue; const q = p.getBoundingClientRect(); if (r.top < q.top - 1 || r.bottom > q.bottom + 1) return true; } return false; };
  const sel = 'button,input:not([type=hidden]),a[href],[data-checkout],[role=menuitem]';
  const controls = taps ? [...layer.querySelectorAll(sel)].filter(visible) : [];
  const tapTarget = el => (el.matches('input[type=checkbox],input[type=radio]') && el.closest('label')) || el;
  for (const el of controls) {
    if (!scrollsY(el)) { // what scrolls (the list, a tall dialog) may reach beyond the screen
      const r = el.getBoundingClientRect();
      if (r.left < -0.5 || r.right > vw + 0.5 || r.top < -0.5 || r.bottom > vh + 0.5) out.push(`control outside the viewport: ${name(el)}`);
    }
  }
  for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
    const a = controls[i], b = controls[j];
    if (a.contains(b) || b.contains(a) || clipped(a) || clipped(b)) continue; // (what is scrolled out of the list does not count)
    const p = a.getBoundingClientRect(), q = b.getBoundingClientRect();
    const w = Math.min(p.right, q.right) - Math.max(p.left, q.left), h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
    if (w > 1 && h > 1) out.push(`controls overlap: ${name(a)} / ${name(b)}`);
  }
  const seen = new Set();
  for (const el of controls) {
    const target = tapTarget(el);
    if (seen.has(target)) continue; seen.add(target);
    if (target.tagName === 'A' && getComputedStyle(target).display === 'inline' && target.closest('p')) continue; // a link inside a sentence
    target.scrollIntoView({ block: 'center', inline: 'nearest' }); // in the middle, so the scroll area's edge does not cut the hit area
    const r = target.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2), M = 16;
    const hit = (x, y) => { const e = x >= 0 && y >= 0 && x < vw && y < vh ? document.elementFromPoint(x, y) : null; return !!e && (e === target || target.contains(e)); };
    const blockers = new Set(); // what sits on the points inside the box that do not reach the control (for the message)
    const miss = (x, y) => { const e = document.elementFromPoint(x, y); if (e && !(e === target || target.contains(e))) { const b = e.getBoundingClientRect(); blockers.add(`${name(e)} at ${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)}`); } };
    let w = 0, h = 0;
    for (let x = Math.floor(r.left) - M; x <= Math.ceil(r.right) + M; x++) if (hit(x, cy)) w++; else if (x > r.left - 8 && x < r.right + 8) miss(x, cy);
    for (let y = Math.floor(r.top) - M; y <= Math.ceil(r.bottom) + M; y++) if (hit(cx, y)) h++; else if (y > r.top - 8 && y < r.bottom + 8) miss(cx, y);
    if (w < minTap - slack || h < minTap - slack) out.push(`tap area ${w}x${h} < ${minTap}x${minTap}: ${name(target)} at ${Math.round(r.left)},${Math.round(r.top)}${w && h ? ` (in the way: ${[...blockers].slice(0, 3).join(', ') || 'nothing, the hit area is just small'})` : ''}`);
  }

  // 4) dialogs: reachable (fits, or the dialog scrolls) and not cut off at the top
  for (const dlg of document.querySelectorAll('#shareDlg,#resetDlg,#joinDlg,#diagDlg,#gateDlg,#askDlg')) {
    if (!visible(dlg)) continue;
    const card = dlg.firstElementChild.getBoundingClientRect();
    const scrolls = dlg.scrollHeight > dlg.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(dlg).overflowY);
    if (card.top + dlg.scrollTop < -0.5) out.push(`dialog starts above the top edge (${px(card.top + dlg.scrollTop)}): ${name(dlg)}`);
    if (card.bottom > vh + 0.5 && !scrolls) out.push(`dialog taller than the screen and does not scroll (${px(card.bottom - card.top)} > ${vh}): ${name(dlg)}`);
  }
  const scanner = document.querySelector('#scanner');
  if (scanner && visible(scanner)) for (const el of scanner.children) {
    if (visible(el) && el.getBoundingClientRect().bottom > vh + 0.5) out.push(`scanner part below the screen: ${name(el)}`);
  }
  return [...new Set(out)];
}

async function runContext(browser, base, [w, h], lang, scheme, violations) {
  const tag = `${w}x${h} ${lang} ${scheme}`;
  const context = await browser.newContext({
    viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: scheme, locale: lang === 'de' ? 'de-DE' : 'en-US', isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1',
  });
  await routeDemoOnly(context);
  // The phone UA makes the app show its install gate in front of everything; it is switched off once per tab session (the gate
  // screens below remove the flag again and look at the gate on purpose)
  await context.addInitScript(() => { try { if (!sessionStorage.getItem('__gateOff')) { sessionStorage.setItem('__gateOff', '1'); localStorage.setItem('installHintOff', 'true'); } } catch (e) { /* none */ } });
  const page = await context.newPage();
  page.on('pageerror', e => violations.push(`[${tag}] page error: ${e.message}`));
  page.on('dialog', d => d.accept()); // a native dialog would block the walk (the app asks with #askDlg instead)
  let n = 0;
  const check = async (screen, { taps = true } = {}) => {
    await page.waitForTimeout(150); // transitions (toast, banner)
    for (const v of await page.evaluate(audit, { minTap: MIN_TAP, slack: TAP_SLACK, taps })) violations.push(`[${tag}] ${screen}: ${v}`);
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${w}x${h}-${lang}-${scheme}-${String(++n).padStart(2, '0')}-${screen}.png`) }); }
  };
  const blur = () => page.evaluate(() => document.activeElement && document.activeElement.blur()).then(() => page.waitForTimeout(250));
  const open = async (query = '', pathname = '/') => {
    await page.goto(`${base}${pathname}?lang=${lang}${query}`);
    if (pathname === '/') await page.waitForFunction(() => localStorage.getItem('kober-vg-v2'));
    await page.waitForTimeout(300);
  };
  const add = async v => { await page.fill('#addIn', v); await page.press('#addIn', 'Enter'); await page.waitForTimeout(100); };
  const tab = t => page.click(`.tabs [data-t=${t}]`);
  const menu = async () => { await page.click('#menuBtn'); await page.waitForTimeout(100); };

  await open();
  await check('list-empty');
  // the install gate in the iPhone browser: plain visit, then opened with a list link (shows the code and "copy code")
  await page.evaluate(() => localStorage.removeItem('installHintOff')); await open();
  await check('gate-install'); await page.click('#gateGo'); await page.waitForTimeout(200);
  await open('&list=ABC234'); await check('gate-join'); await page.click('#gateGo'); await page.waitForTimeout(400);
  await open();
  // list: long German names, a word that cannot be broken, typed VG numbers go straight into the basket
  for (const v of ['Hafer-Barista-Drink ungesüßt mit Calcium und Vitamin D im 1 Liter Tetrapak', 'Donaudampfschifffahrtsgesellschaftskapitänsmütze', 'Äpfel Elstar', 'Vollkornbrot', '4455', '7901']) await add(v);
  await blur();
  await check('list');
  await page.fill('.item [data-vg] input >> nth=0', '9999999'); // a long number in the quick field of a row
  await check('list-long-number');
  await page.press('.item [data-vg] input >> nth=0', 'Escape'); await blur();
  await page.click('#doneItems [data-editnum] >> nth=0'); await page.waitForSelector('[data-vgedit] input');
  await check('list-edit-number'); // number field with confirm, scan and delete buttons, keyboard open
  await blur();
  await page.fill('#addIn', '790'); await page.waitForSelector('#addSuggest .sug');
  await check('suggest-number');
  await page.fill('#addIn', 'ro'); await page.waitForTimeout(100);
  await check('suggest-name');
  await page.fill('#addIn', '12345'); await page.waitForSelector('#addSuggest .miss');
  await check('suggest-too-long'); // "+" muted, "VG numbers have 3 to 4 digits" in the suggestion area
  await page.fill('#addIn', ''); await blur();
  // empties and checkout
  await tab('vDeposit');
  for (const [id, k] of [[1, 3], [3, 12], [6, 1]]) for (let i = 0; i < k; i++) await page.click(`[data-dep-add="${id}"]`);
  await check('empties');
  await tab('vList'); for (const v of ['790', '3105', '4464']) await add(v);
  await blur(); await tab('vCheckout');
  await check('checkout');
  await tab('vList');
  // menu and the dialogs of the local list
  await menu(); await check('menu-local');
  await page.click('#menuReset'); await page.waitForTimeout(100); await check('reset-dialog'); await page.click('#resetCancel');
  await menu(); await page.click('#menuJoin'); await page.waitForTimeout(100); await check('join-dialog');
  await page.fill('#codeIn', 'K7M2QX'); await check('join-dialog-typed');
  await page.click('#joinScan'); await page.waitForTimeout(500); await check('scanner-join'); await page.click('#scanClose');
  await page.waitForTimeout(100);
  const joinOpen = await page.evaluate(() => !document.querySelector('#joinDlg').classList.contains('hide'));
  if (joinOpen) await page.click('#joinClose');
  await page.click('#scanBtn'); await page.waitForTimeout(500); await check('scanner');
  await page.fill('#eanIn', '790'); await page.waitForTimeout(200); await check('scanner-manual');
  await page.click('#scanClose');
  // share: the dialog of the local list, then name and emoji, then the QR code
  await page.click('#shareBtn'); await page.waitForTimeout(100); await check('share-dialog-local');
  await page.click('#shareStart');
  await page.fill('#nameIn', 'Maximilian-Alexander'); await check('name-screen'); // 20 characters, the longest name
  await page.click('#newList');
  await page.waitForSelector('#qr svg'); await check('share-dialog');
  await page.click('#shareClose');
  // shared list: four tabs, a badge with the long name, ranking with three players
  await page.click('#items .item:has-text("Äpfel") [data-chk]'); await page.waitForTimeout(200);
  await check('list-shared');
  await tab('vDeposit'); await page.click('[data-dep-add="1"]'); await check('empties-shared');
  await menu(); await check('menu-shared'); await page.keyboard.press('Escape'); await page.click('header h1').catch(() => {});
  await menu(); await page.click('#menuReset'); await page.check('#resetScores'); await page.check('#resetOpen'); await page.waitForTimeout(100);
  await check('reset-dialog-shared'); await page.click('#resetCancel'); // four options, the button is red
  await menu(); await page.click('#menuLeave'); await page.waitForTimeout(100); await check('ask-dialog'); await page.click('#askNo'); // the app's own question dialog (the longest text: leave with the code)
  for (const [who, emoji, item] of [['Ben', '🐼', 'Vollkornbrot'], ['Bartholomäus-Friedrich', '🦖', 'Hafer']]) {
    await page.evaluate(([name, e]) => localStorage.setItem('me', JSON.stringify({ name, emoji: e })), [who, emoji]);
    await open(); await tab('vList');
    await page.click(`#items .item:has-text("${item}") [data-chk]`); await page.waitForTimeout(200);
  }
  await tab('vScore'); await check('ranking');
  await page.click('#renameBtn'); await check('name-screen-rename'); await page.click('#nameCancel');
  await tab('vList'); await tab('vCheckout'); await check('checkout-shared');
  // connection banner (simulated overload) on a shared list
  await open('&sim=overload');
  await page.waitForSelector('#connBanner:not(.hide)', { timeout: 30000 }).catch(() => violations.push(`[${tag}] connection banner did not appear with ?sim=overload`));
  await check('conn-banner'); await tab('vScore'); await check('conn-banner-ranking');
  // static pages
  await open('', '/docs/index.html'); await check('help', { taps: false });
  await open('', '/privacy.html'); await check('privacy', { taps: false });
  await context.close();
}

fs.mkdirSync(SHOTS || '.', { recursive: true });
const { server, base } = await serve();
const browser = await launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const violations = [];
// The 16 combinations (viewport x language x scheme) are independent browser contexts: run several at once (default: the number of
// CPUs, at most 4; `--jobs=1` for the old one-by-one run). Each finishes with one line.
const JOBS = Math.max(1, Number((process.argv.find(a => a.startsWith('--jobs=')) || '').slice(7)) || Math.min(4, os.cpus().length));
const combos = [];
for (const vp of VIEWPORTS) for (const lang of LANGS) for (const scheme of SCHEMES) combos.push([vp, lang, scheme]);
try {
  let next = 0;
  const worker = async () => {
    while (next < combos.length) {
      const [vp, lang, scheme] = combos[next++];
      const mine = [];
      try { await runContext(browser, base, vp, lang, scheme, mine); }
      catch (e) { mine.push(`[${vp.join('x')} ${lang} ${scheme}] script error: ${e.message.split('\n').slice(0, 6).join(' | ')}`); }
      violations.push(...mine);
      console.log(`${vp.join('x')} ${lang} ${scheme} ... ${mine.length ? `${mine.length} violation(s)` : 'ok'}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(JOBS, combos.length) }, worker));
} finally { await browser.close(); server.close(); }
if (violations.length) {
  console.error(`\n${violations.length} violation(s):\n` + violations.map(v => '  ' + v).join('\n'));
  process.exit(1);
}
console.log('all screens ok');
