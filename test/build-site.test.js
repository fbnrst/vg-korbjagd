import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Builds the site from the real public/ for both versions and checks that the dev copy became its own app
// and the release stayed untouched.
test('build-site: release at the root, dev under /dev/ with its own config, name and icons', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kober-site-'));
  try {
    execFileSync('node', [path.join(root, 'scripts/build-site.mjs'), path.join(root, 'public'), path.join(root, 'public'), out], { stdio: 'pipe', env: { ...process.env, RELEASE_LABEL: 'v9.9.9', DEV_LABEL: 'dev abc1234' } });
    const rel = f => fs.readFileSync(path.join(out, f), 'utf8');
    assert.equal(JSON.parse(rel('manifest.json')).name, 'Kober');
    assert.ok(rel('index.html').includes('icons/apple-touch-icon.png'));
    assert.equal(rel('firebase-config.js'), fs.readFileSync(path.join(root, 'public/firebase-config.js'), 'utf8'));
    const m = JSON.parse(rel('dev/manifest.json'));
    assert.equal(m.name, 'Kober DEV');
    assert.ok(m.icons.every(i => i.src.startsWith('icons/dev-')));
    assert.ok(rel('dev/index.html').includes('icons/dev-apple-touch-icon.png'));
    assert.ok(rel('dev/index.html').includes('content="Kober DEV"'));
    assert.notEqual(rel('dev/firebase-config.js'), rel('firebase-config.js'), 'dev must not use the production database');
    assert.ok(!fs.existsSync(path.join(out, 'firebase-config.dev.js')) && !fs.existsSync(path.join(out, 'dev/firebase-config.dev.js')));
    assert.ok(rel('version.js').includes('"v9.9.9"') && rel('dev/version.js').includes('"dev abc1234"'), 'the menu shows which build this is');
    for (const f of ['dev/sw.js', 'dev/env.js', 'dev/icons/dev-icon-192.png']) assert.ok(fs.existsSync(path.join(out, f)), f);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
