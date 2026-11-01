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
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const FIXTURES = path.join(ROOT, 'scripts/fixtures/vg');
const OUT = path.resolve(process.argv[2] || path.join(PUBLIC, 'docs/img'));
const LANGS = ['en', 'de'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };

// Static server for public/, with firebase-config.js replaced so the app runs in demo mode
function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/firebase-config.js') { res.writeHead(200, { 'Content-Type': MIME['.js'] }); return res.end('export default null;'); }
    let file = path.join(PUBLIC, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

const VG_FILES = { 'getChecksums.php': 'checksums.json', 'getProductList.php': 'products.json', 'getManufacturersList.php': 'manufacturers.json',
  'getCountriesList.php': 'countries.json', 'getUnitsList.php': 'units.json', 'getDepositsList.php': 'deposits.json' };

async function launch() {
  const opts = { headless: true };
  if (process.env.CHROME_PATH) return chromium.launch({ ...opts, executablePath: process.env.CHROME_PATH });
  try { return await chromium.launch({ ...opts, channel: 'chrome' }); } catch (e) { /* no Chrome: try a downloaded Chromium */ }
  try { return await chromium.launch(opts); } catch (e) {
    throw new Error('No browser found. Install Google Chrome, set CHROME_PATH, or run `npx playwright install chromium`.');
  }
}

async function scenes(browser, base, lang) {
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 }, deviceScaleFactor: 1.6, colorScheme: 'light', locale: lang === 'de' ? 'de-DE' : 'en-US',
    isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });
  // Only the demo server and the fixture VG data: nothing else may leave the machine
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    const file = url.hostname === 'app.vg-dresden.de' && VG_FILES[path.basename(url.pathname)];
    if (!file) return route.abort();
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'text/html' }, body: fs.readFileSync(path.join(FIXTURES, file)) });
  });
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
  // 1) list: names and numbers, two items already in the basket
  for (const v of ['Haferdrink', 'Äpfel Elstar', '4455', '7901', '3105', 'Vollkornbrot', '4464']) await add(v);
  await row('#items', 'Aprikosen').locator('[data-chk]').click();
  await row('#items', 'Porree').locator('[data-chk]').click();
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
  await add('790');
  for (const t of ['Roggenbrot', 'Balsamico', 'Möhren']) { await row('#items', t).locator('[data-chk]').click(); await page.waitForTimeout(150); }
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
