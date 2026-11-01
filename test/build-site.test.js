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
    // The dev worker precaches the dev icons, the release worker the release icons; every precached icon exists
    const icons = sw => sw.match(/'\.\/icons\/[^']+'/g).map(s => s.slice(3, -1));
    assert.ok(icons(rel('dev/sw.js')).every(i => i.startsWith('icons/dev-')), 'dev sw.js precaches the dev icons');
    assert.ok(icons(rel('sw.js')).every(i => !i.includes('dev-')), 'release sw.js keeps the release icons');
    for (const i of icons(rel('dev/sw.js'))) assert.ok(fs.existsSync(path.join(out, 'dev', i)), i);
    for (const i of icons(rel('sw.js'))) assert.ok(fs.existsSync(path.join(out, i)), i);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

// VERSION in sw.js is stamped per site from a hash of its files: a changed file gives a new cache name, an unchanged
// site keeps its worker byte for byte (no reinstall).
test('build-site: sw.js VERSION follows the content of each site', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kober-ver-'));
  const build = (out, env = {}) => {
    execFileSync('node', [path.join(root, 'scripts/build-site.mjs'), path.join(tmp, 'pub'), path.join(root, 'public'), out], { stdio: 'pipe', env: { ...process.env, RELEASE_LABEL: 'v9.9.9', DEV_LABEL: 'dev abc1234', ...env } });
    const v = f => fs.readFileSync(path.join(out, f), 'utf8').match(/^const VERSION = '([^']*)';/m)[1];
    return { rel: v('sw.js'), dev: v('dev/sw.js') };
  };
  try {
    fs.cpSync(path.join(root, 'public'), path.join(tmp, 'pub'), { recursive: true });
    const src = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8').match(/^const VERSION = '([^']*)';/m)[1];
    const a = build(path.join(tmp, 'a'));
    assert.match(a.rel, /^v[0-9a-f]{12}$/); assert.match(a.dev, /^v[0-9a-f]{12}$/);
    assert.notEqual(a.rel, src, 'the source default is replaced');
    const b = build(path.join(tmp, 'b'));
    assert.deepEqual(b, a, 'same files, same VERSION');
    assert.notEqual(build(path.join(tmp, 'c'), { DEV_LABEL: 'dev def5678' }).dev, a.dev, 'a new dev commit is a new dev cache');
    fs.appendFileSync(path.join(tmp, 'pub/app.js'), '\n// changed\n');
    const d = build(path.join(tmp, 'd'));
    assert.notEqual(d.rel, a.rel, 'a changed release file is a new release cache');
    assert.equal(d.dev, a.dev, 'the dev site did not change');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
