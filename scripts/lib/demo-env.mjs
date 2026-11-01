// Shared by the browser scripts (docs-screenshots.mjs, check-small-screens.mjs): a static server for public/ with Firebase
// switched off (demo mode: a "shared" list lives in the browser only), the launcher for Chrome/Chromium, and the routing that
// replaces the VG server by the invented demo data in scripts/fixtures/vg/, so nothing leaves the machine.
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PUBLIC = path.join(ROOT, 'public');
const FIXTURES = path.join(ROOT, 'scripts/fixtures/vg');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };

// Static server for public/, with firebase-config.js replaced so the app runs in demo mode
export function serve() {
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

// Only the demo server and the fixture VG data: everything else is aborted
export function routeDemoOnly(context) {
  return context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    const file = url.hostname === 'app.vg-dresden.de' && VG_FILES[path.basename(url.pathname)];
    if (!file) return route.abort();
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'text/html' }, body: fs.readFileSync(path.join(FIXTURES, file)) });
  });
}

export async function launch(extra = {}) {
  const opts = { headless: true, ...extra };
  if (process.env.CHROME_PATH) return chromium.launch({ ...opts, executablePath: process.env.CHROME_PATH });
  try { return await chromium.launch({ ...opts, channel: 'chrome' }); } catch (e) { /* no Chrome: try a downloaded Chromium */ }
  try { return await chromium.launch(opts); } catch (e) {
    throw new Error('No browser found. Install Google Chrome, set CHROME_PATH, or run `npx playwright install chromium`.');
  }
}
