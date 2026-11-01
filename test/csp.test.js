import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

// Every page carries a Content-Security-Policy (meta tag, GitHub Pages sets no headers). It is the second layer behind
// esc(): even an injected <script> or a compromised third party cannot load code from elsewhere.
const PUB = path.join(import.meta.dirname, '../public');
const read = f => fs.readFileSync(path.join(PUB, f), 'utf8');
const csp = html => {
  const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  return m && Object.fromEntries(m[1].split(';').map(d => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
};

test('all pages carry a CSP without inline scripts or eval', () => {
  for (const f of ['index.html', 'privacy.html', 'docs/index.html']) {
    const html = read(f), p = csp(html);
    assert.ok(p, `${f}: no CSP meta tag`);
    assert.deepStrictEqual(p['default-src'], ["'self'"], f);
    assert.deepStrictEqual(p['object-src'], ["'none'"], f);
    const scripts = p['script-src'] || p['default-src'];
    assert.ok(!scripts.includes("'unsafe-inline'") && !scripts.includes("'unsafe-eval'"), `${f}: script-src allows inline/eval`);
    // inline scripts would be blocked: every <script> needs a src
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/, `${f}: inline <script>`);
    assert.doesNotMatch(html, /\son[a-z]+="/, `${f}: inline event handler`);
  }
});

test('the app CSP allows exactly the hosts the code talks to', () => {
  const p = csp(read('index.html'));
  // hosts the app calls with fetch (connect-src) and loads code from (script-src)
  const src = fs.readdirSync(PUB).filter(f => f.endsWith('.js')).map(read).join('\n');
  for (const host of ['https://app.vg-dresden.de', 'https://world.openfoodfacts.org']) {
    assert.ok(src.includes(host), `${host} is no longer used: drop it from the CSP`);
    assert.ok(p['connect-src'].includes(host), `connect-src misses ${host}`);
  }
  assert.ok(src.includes('https://www.gstatic.com/firebasejs/'));
  assert.ok(p['script-src'].includes('https://www.gstatic.com'));
  // the Realtime Database: WebSocket, and long polling (JSONP script tags in an iframe) as a fallback
  for (const cfg of ['firebase-config.js', 'firebase-config.dev.js']) {
    const url = read(cfg).match(/databaseURL: '([^']+)'/);
    if (!url) continue; // demo mode
    assert.match(new URL(url[1]).host, /\.firebasedatabase\.app$/, `${cfg}: database host not covered by the CSP`);
  }
  assert.ok(p['connect-src'].includes('wss://*.firebasedatabase.app') && p['connect-src'].includes('https://*.firebasedatabase.app'));
  assert.ok(p['script-src'].includes('https://*.firebasedatabase.app'));
  assert.deepStrictEqual(p['frame-src'], ['https://*.firebasedatabase.app']);
  // no other third-party code: everything else is bundled in vendor/
  assert.doesNotMatch(src, /cdn\.jsdelivr\.net|unpkg\.com/);
});
