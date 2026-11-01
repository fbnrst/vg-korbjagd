// Guards the structure of the colour tokens: public/theme.css is the single source (release, light + dark),
// public/dev-theme.css overrides some of them for the dev site (see the header of theme.css).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = f => fs.readFileSync(new URL('../public/' + f, import.meta.url), 'utf8');
const PAGES = ['index.html', 'privacy.html', 'docs/index.html'];

const theme = read('theme.css');
const darkAt = theme.indexOf('@media(prefers-color-scheme:dark)');
const names = css => new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]));
const light = names(theme.slice(0, darkAt));
const dark = names(theme.slice(darkAt));
const devCss = read('dev-theme.css');

// var(--x) uses that are not defined by the page itself at runtime (set by app.js for layout)
const RUNTIME = new Set(['--app-h', '--vvtop', '--conn-h', '--tabs']);
const used = css => new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]));
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '');

test('theme.css has a light and a dark block', () => {
  assert.ok(darkAt > 0);
  assert.ok(light.size > 10);
});

test('the dark block defines the same tokens as the light block', () => {
  assert.deepEqual([...dark].sort(), [...light].sort());
});

for (const page of PAGES) {
  test(`${page}: every var(--x) is defined in theme.css`, () => {
    const html = stripComments(read(page));
    for (const v of used(html)) {
      // layout variables defined in the page itself (e.g. :root{--tabs:46px}) are fine
      const local = new RegExp(v + '\\s*:').test(html);
      assert.ok(light.has(v) || RUNTIME.has(v) || local, `${page} uses ${v} which theme.css does not define`);
    }
  });

  test(`${page}: links theme.css before its styles and before dev-theme.css`, () => {
    const html = read(page);
    const rel = page.includes('/') ? '../' : '';
    const t = html.indexOf(`href="${rel}theme.css"`), s = html.indexOf('<style>'), d = html.indexOf(`href="${rel}dev-theme.css"`);
    assert.ok(t > 0 && t < s, 'theme.css must come before <style>');
    assert.ok(d > t, 'dev-theme.css must come after theme.css');
  });

  test(`${page}: defines no colour palette of its own`, () => {
    const html = stripComments(read(page));
    for (const block of html.match(/<style>[\s\S]*?<\/style>/g) || []) {
      for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:/g)) {
        assert.ok(!light.has(m[1]), `${page} redefines ${m[1]}; change theme.css instead`);
      }
    }
  });
}

test('dev-theme.css uses and overrides only tokens that exist in theme.css', () => {
  const css = stripComments(devCss);
  for (const v of names(css)) assert.ok(light.has(v), `dev-theme.css overrides unknown token ${v}`);
  for (const v of used(css)) assert.ok(light.has(v), `dev-theme.css uses unknown token ${v}`);
});

test('dev-theme.css overrides the key tokens in both light and dark', () => {
  const css = stripComments(devCss);
  const i = css.indexOf('@media');
  const a = names(css.slice(0, i)), b = names(css.slice(i));
  for (const v of ['--hdr', '--fill', '--green', '--scan-frame', '--tick']) assert.ok(a.has(v) && b.has(v), `${v} missing in a dev mode`);
});

test('sw.js precaches theme.css and dev-theme.css', () => {
  const sw = read('sw.js');
  const files = sw.match(/const FILES = \[([\s\S]*?)\];/)[1];
  assert.match(files, /'\.\/theme\.css'/);
  assert.match(files, /'\.\/dev-theme\.css'/);
});
