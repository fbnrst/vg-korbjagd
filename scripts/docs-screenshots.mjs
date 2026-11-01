// Renders the screenshots of the help page (public/docs/index.html) from the real app.
//
//   npm install                       # once (playwright-core, small, no browser download)
//   npm run docs:screenshots          # writes public/docs/img/<lang>-<scene>.jpg
//   npm run docs:screenshots -- /tmp/out   # another output folder
//
// Needs Google Chrome (or set CHROME_PATH, or run `npx playwright install chromium`).
// The app is served from public/ with Firebase switched off (demo mode: a "shared" list lives in the browser only),
// and the VG server is replaced by the invented demo data in scripts/fixtures/vg/, so the images do not depend on the
// network, on VG data changes or on the production database. Re-run after UI changes and commit the images.
import { serve, launch, routeDemoOnly, PUBLIC } from './lib/demo-env.mjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(process.argv[2] || path.join(PUBLIC, 'docs/img'));
const LANGS = ['en', 'de'];

async function scenes(browser, base, lang) {
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 }, deviceScaleFactor: 1.6, colorScheme: 'light', locale: lang === 'de' ? 'de-DE' : 'en-US',
    isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });
  await context.addInitScript(() => { try { localStorage.setItem('installHintOff', 'true'); } catch (e) { /* none */ } }); // the iPhone UA would show the install gate in the pictures
  await routeDemoOnly(context); // only the demo server and the fixture VG data: nothing else may leave the machine
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  const open = async () => {
    await page.goto(`${base}/?lang=${lang}`);
    await page.addStyleTag({ content: '#toast,#demoBanner{display:none!important}' }); // no hint bubbles and no demo-mode banner in the pictures
    await page.waitForFunction(() => localStorage.getItem('kober-vg-v2'));
    await page.waitForTimeout(300);
  };
  const shot = async name => {
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(OUT, `${lang}-${name}.jpg`), type: 'jpeg', quality: 80 });
    console.log(`  ${lang}-${name}.jpg`);
  };
  const add = async v => { await page.fill('#addIn', v); await page.press('#addIn', 'Enter'); await page.waitForTimeout(80); };
  const row = (sel, text) => page.locator(`${sel} .item`).filter({ hasText: text }).first();
  const tab = t => page.click(`.tabs [data-t=${t}]`);

  await open();
  // 1) list: names stay open, typed VG numbers go straight into the basket
  for (const v of ['Haferdrink', 'Äpfel Elstar', 'Vollkornbrot', '4455', '7901']) { await add(v); await page.waitForTimeout(120); }
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await shot('list');
  // 2) number suggestions
  await page.fill('#addIn', '790');
  await page.waitForSelector('#addSuggest .sug');
  await shot('suggest');
  await page.fill('#addIn', '');
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  // 3) empties
  await tab('vDeposit');
  for (const [id, n] of [[1, 3], [3, 2], [6, 1]]) for (let i = 0; i < n; i++) { await page.click(`[data-dep-add="${id}"]`); await page.waitForTimeout(60); }
  await shot('empties');
  // 4) checkout: more items with numbers in the basket, one bakery item (number below 1000), and the empties from above
  await tab('vList');
  for (const v of ['790', '3105', '4464']) { await add(v); await page.waitForTimeout(150); }
  await page.evaluate(() => document.activeElement && document.activeElement.blur()); // keyboard away, the tab bar comes back
  await tab('vCheckout');
  await page.click('[data-checkout]:has-text("Möhren")'); await page.click('[data-checkout]:has-text("Milchflasche")'); // two rows done: they slide into the block at the bottom
  await shot('checkout');
  // 5) reset dialog (opened from the menu)
  await tab('vList');
  await page.click('#menuBtn'); await page.click('#menuReset'); await shot('reset'); await page.click('#resetCancel');
  // 6) share (demo mode keeps the shared list in the browser), the dialog with the QR code, then the menu
  await page.click('#shareBtn'); await page.click('#shareStart');
  await page.fill('#nameIn', 'Mia'); await page.click('#newList');
  await page.waitForSelector('#qr svg'); await shot('share');
  await page.click('#shareClose');
  // the menu on a shared list (this is where "Leave this list" lives)
  await page.click('#menuBtn'); await shot('menu'); await page.keyboard.press('Escape');
  // 7) ranking: Mia collects points, then Ben joins the same list and collects some too
  for (const t of ['Haferdrink', 'Vollkornbrot']) { await row('#items', t).locator('[data-chk]').click(); await page.waitForTimeout(150); }
  await tab('vDeposit'); for (let i = 0; i < 3; i++) { await page.click('[data-dep-add="1"]'); await page.waitForTimeout(80); }   // Mia: 2 items + 3 pieces = 5
  await page.evaluate(() => localStorage.setItem('me', JSON.stringify({ name: 'Ben', emoji: '🐼' })));
  await open();
  await tab('vList');
  await row('#items', 'Äpfel').locator('[data-chk]').click(); await page.waitForTimeout(150);
  await tab('vDeposit'); for (let i = 0; i < 3; i++) { await page.click('[data-dep-add="3"]'); await page.waitForTimeout(80); }   // Ben: 1 item + 3 pieces = 4
  await tab('vScore'); await shot('ranking');

  await context.close();
  if (errors.length) throw new Error(`page errors in ${lang}: ${errors.join('; ')}`);
}

fs.mkdirSync(OUT, { recursive: true });
const { server, base } = await serve();
const browser = await launch();
try {
  for (const lang of LANGS) { console.log(lang); await scenes(browser, base, lang); }
  console.log(`done: ${OUT}`);
} finally { await browser.close(); server.close(); }
