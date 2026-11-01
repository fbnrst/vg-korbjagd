// Old-phone guard: scans the app (public/*.js, *.html, *.css, docs/*.html; not vendor/) for JS and CSS features that Safari 15
// does not have. The target is the iPhone SE (1st generation): its last system is iOS 15.8, so Safari 15.x is the floor.
// A static scan is no replacement for a real device, but it stops the usual accident: a modern one-liner that silently
// breaks the app on an old phone (a blank screen is the typical result, not an error message).
//
// Adding a feature to DENY needs: the pattern, the first Safari version that has it, a sample that must match (checked below,
// so the pattern cannot rot), and a short reason.
//
// A line that uses a denied feature on purpose (with a fallback next to it, or because it degrades quietly) carries the marker
// `compat-ok: <reason>` in a comment on the same line. The marker has to name the reason, and a marker on a line without a
// match is an error (stale markers hide real problems later).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public');
const TARGET = 15.0; // lowest Safari the app must run on; entries with a higher `min` are denied

// min: first Safari version with the feature (MDN / caniuse). A feature present from 15.0 on is not listed.
const DENY = [
  // --- CSS ---
  { name: 'dvh/svh/lvh and the other dynamic viewport units', min: 15.4, re: /\b\d*\.?\d+(dvh|svh|lvh|dvw|svw|lvw|dvi|dvb|svi|svb|lvi|lvb)\b/, sample: 'height:100dvh', why: 'put a vh/% declaration first and make the rule fill the screen without the unit (see #app)' },
  { name: ':has()', min: 15.4, re: /:has\(/, sample: '.a:has(b){}', why: 'ignored rule; fine only when nothing breaks without it' },
  { name: '@layer', min: 15.4, re: /@layer\b/, sample: '@layer base{}', why: 'the whole block is dropped' },
  { name: ':focus-visible', min: 15.4, re: /:focus-visible/, sample: 'a:focus-visible{}', why: 'the whole rule is dropped' },
  { name: '::backdrop / :modal / <dialog>', min: 15.4, re: /::backdrop|:modal\b|<dialog\b|\.showModal\(/, sample: '<dialog>', why: 'no native dialogs on iOS 15.0-15.3' },
  { name: 'accent-color', min: 15.4, re: /\baccent-color\s*:/, sample: 'accent-color:red', why: 'ignored, check boxes keep the system colour' },
  { name: 'lab()/lch()/oklab()/oklch()', min: 15.4, re: /\b(oklab|oklch|lab|lch)\(/, sample: 'color:oklch(1 0 0)', why: 'invalid colour, the declaration is dropped' },
  { name: 'color-mix()', min: 16.2, re: /\bcolor-mix\(/, sample: 'color:color-mix(in srgb,red,blue)', why: 'inside var() it is invalid only at computed time, so the cascade falls back to `unset`, not to the earlier value: wrap it in @supports' },
  { name: 'light-dark()', min: 17.5, re: /\blight-dark\(/, sample: 'color:light-dark(#000,#fff)', why: 'use prefers-color-scheme' },
  { name: 'container queries / units', min: 16.0, re: /@container\b|\bcontainer-type\s*:|\b\d*\.?\d+(cqw|cqh|cqi|cqb|cqmin|cqmax)\b/, sample: '@container (min-width:1px){}', why: 'use media queries' },
  { name: 'subgrid', min: 16.0, re: /grid-template-(columns|rows)\s*:\s*subgrid/, sample: 'grid-template-rows:subgrid', why: 'layout falls apart' },
  { name: 'overflow: clip', min: 16.0, re: /\boverflow(-[xy])?\s*:\s*clip\b/, sample: 'overflow:clip', why: 'use hidden' },
  { name: 'overscroll-behavior', min: 16.0, re: /\boverscroll-behavior(-[xy])?\s*:/, sample: 'overscroll-behavior:none', why: 'ignored: only the rubber band chaining differs' },
  { name: 'lh / rlh units', min: 16.4, re: /\b\d*\.?\d+r?lh\b/, sample: 'margin:1lh', why: 'use em' },
  { name: 'media query range syntax', min: 16.4, re: /@media[^{]*\(\s*(width|height|aspect-ratio)\s*[<>]=?|@media[^{]*[<>]=?\s*(width|height)\s*\)/, sample: '@media (width >= 600px){}', why: 'use min-width/max-width' },
  { name: '@property', min: 16.4, re: /@property\b/, sample: '@property --a{}', why: 'registered custom properties are missing' },
  { name: 'CSS nesting', min: 17.2, re: /[{;}]\s*&(?!&)\s*[\s.:#\[>+~]/, sample: '.a{ &:hover{} }', why: 'write the full selector' },
  { name: '@scope', min: 17.4, re: /@scope\b/, sample: '@scope (.a){}', why: 'the whole block is dropped' },
  { name: 'text-wrap', min: 17.5, re: /\btext-wrap(-[a-z]+)?\s*:/, sample: 'text-wrap:balance', why: 'ignored: only the line breaks differ' },
  { name: 'scrollbar-gutter / scrollbar-width', min: 18.2, re: /\bscrollbar-(gutter|width)\s*:/, sample: 'scrollbar-width:none', why: 'ignored' },
  { name: 'unprefixed backdrop-filter', min: 18.0, re: /(?<!-webkit-)\bbackdrop-filter\s*:/, sample: 'backdrop-filter:blur(4px)', why: 'add -webkit-backdrop-filter' },
  { name: 'view transitions / anchor positioning / scroll-driven animations', min: 18.0, re: /view-transition|\banchor-name\b|\banimation-timeline\b|@starting-style/, sample: 'view-transition-name:a', why: 'ignored' },
  // --- JS ---
  { name: 'structuredClone', min: 15.4, re: /\bstructuredClone\(/, sample: 'structuredClone(a)', why: 'ReferenceError: JSON.parse(JSON.stringify()) or a spread' },
  { name: 'Array/String .at()', min: 15.4, re: /[\w\])]\.at\(/, sample: 'a.at(-1)', why: 'TypeError: use a[a.length - 1]' },
  { name: 'findLast / findLastIndex', min: 15.4, re: /\.findLast(Index)?\(/, sample: 'a.findLast(f)', why: 'TypeError: loop backwards' },
  { name: 'Object.hasOwn', min: 15.4, re: /\bObject\.hasOwn\(/, sample: 'Object.hasOwn(a,"b")', why: 'TypeError: Object.prototype.hasOwnProperty.call' },
  { name: 'crypto.randomUUID', min: 15.4, re: /\brandomUUID\(/, sample: 'crypto.randomUUID()', why: 'TypeError: use getRandomValues' },
  { name: 'AbortSignal.timeout', min: 16.0, re: /\bAbortSignal\.timeout\b/, sample: 'AbortSignal.timeout(5)', why: 'TypeError: AbortController plus setTimeout' },
  { name: 'toSorted / toReversed / toSpliced', min: 16.0, re: /\.(toSorted|toReversed|toSpliced)\(/, sample: 'a.toSorted()', why: 'TypeError: copy first, then sort()' },
  { name: 'Array.fromAsync / isWellFormed', min: 16.4, re: /\bArray\.fromAsync\b|\.isWellFormed\(|\.toWellFormed\(/, sample: 'Array.fromAsync(a)', why: 'TypeError' },
  { name: 'regex lookbehind', min: 16.4, re: /\(\?<[=!]/, sample: '/(?<=a)b/', why: 'SyntaxError: the whole module fails to load' },
  { name: 'class static blocks', min: 16.4, re: /\bstatic\s*\{/, sample: 'class A { static { } }', why: 'SyntaxError: the whole module fails to load' },
  { name: 'adoptedStyleSheets', min: 16.4, re: /\badoptedStyleSheets\b/, sample: 'document.adoptedStyleSheets', why: 'missing' },
  { name: 'import maps', min: 16.4, re: /type=["']importmap["']/, sample: '<script type="importmap">', why: 'bare imports stop working' },
  { name: 'Navigator.wakeLock', min: 16.4, re: /\bnavigator\.wakeLock\b/, sample: 'navigator.wakeLock.request()', why: 'guard with `in navigator`' },
  { name: 'import attributes (with/assert {type})', min: 17.2, re: /\bimport\b[^;\n]*\b(with|assert)\s*\{\s*type/, sample: 'import a from "./a.json" with { type: "json" }', why: 'SyntaxError' },
  { name: 'Object.groupBy / Map.groupBy', min: 17.4, re: /\b(Object|Map)\.groupBy\(/, sample: 'Object.groupBy(a,f)', why: 'TypeError' },
  { name: 'Promise.withResolvers', min: 17.4, re: /\bPromise\.withResolvers\b/, sample: 'Promise.withResolvers()', why: 'TypeError' },
  { name: 'AbortSignal.any', min: 17.4, re: /\bAbortSignal\.any\b/, sample: 'AbortSignal.any([])', why: 'TypeError' },
  { name: 'Set methods (union, intersection, ...)', min: 17.0, re: /\.(union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/, sample: 'a.union(b)', why: 'TypeError' },
  { name: 'requestIdleCallback', min: 99, re: /\brequestIdleCallback\b/, sample: 'requestIdleCallback(f)', why: 'not in Safari at all (use setTimeout)' },
  { name: 'BarcodeDetector', min: 99, re: /\bBarcodeDetector\b/, sample: 'new BarcodeDetector()', why: 'not in Safari: needs a fallback (the app has one: zxing)' },
  { name: 'navigator.vibrate', min: 99, re: /\bnavigator\.vibrate\b/, sample: 'navigator.vibrate(1)', why: 'not in iOS' },
  // --- HTML ---
  { name: 'popover attribute', min: 17.0, re: /<[a-z][^>]*\spopover[\s=>]/, sample: '<div popover>', why: 'ignored: the element just shows' },
  { name: 'inert attribute', min: 15.5, re: /<[a-z][^>]*\sinert[\s=>]/, sample: '<div inert>', why: 'ignored: the element stays reachable' },
];

// Comments out, line structure kept (so line numbers are right). A denied word in a comment is no use of the feature.
function stripComments(text) {
  const blank = m => m.replace(/[^\n]/g, ' ');
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/<!--[\s\S]*?-->/g, blank).replace(/(^|[^:'"`\\\w])\/\/.*$/gm, (m, pre) => pre + blank(m.slice(pre.length)));
}

function files(dir = PUBLIC) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'vendor' || e.name === 'img' || e.name === 'icons') continue; // third-party code and pictures
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.(js|mjs|html|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

const tooNew = DENY.filter(d => d.min > TARGET);

// One finding per line and feature: `{ file, line, name, min, ok }` where ok is the compat-ok reason, if any
function scan(text, file = 'sample') {
  const lines = text.split('\n'), clean = stripComments(text).split('\n'), found = [];
  clean.forEach((l, i) => {
    const marker = lines[i].match(/compat-ok(?::\s*(.*?))?(?:\*\/|-->|$)/);
    for (const d of tooNew) if (d.re.test(l)) found.push({ file, line: i + 1, name: d.name, min: d.min, ok: marker ? (marker[1] || '').trim() : null });
  });
  const markersWithoutMatch = lines.flatMap((l, i) => /compat-ok/.test(l) && !found.some(f => f.line === i + 1) ? [{ file, line: i + 1 }] : []);
  return { found, markersWithoutMatch };
}

test('every deny-list entry matches its sample (the patterns cannot rot)', () => {
  for (const d of DENY) {
    assert.ok(d.min && d.why && d.sample, `${d.name}: min, why and sample are required`);
    assert.ok(d.re.test(d.sample), `${d.name}: the pattern does not match its sample ${JSON.stringify(d.sample)}`);
  }
});

test('the scanner ignores comments and understands the allow marker', () => {
  assert.equal(scan('/* height:100dvh */ a{}').found.length, 0);
  assert.equal(scan('// uses structuredClone(x)\nfoo();').found.length, 0);
  assert.equal(scan('const u = "https://example.org"; const a = b.at(-1);').found.length, 1);
  assert.equal(scan('a{height:100dvh} /* compat-ok: 100vh above */').found[0].ok, '100vh above');
  assert.equal(scan('foo(); // compat-ok: nothing here').markersWithoutMatch.length, 1);
  assert.equal(scan('...at(2)').found.length, 0); // a local function called `at`, not Array.prototype.at
});

test('public/ uses no JS or CSS feature that Safari 15 (iPhone SE 1st generation, iOS 15.8) lacks, unless allowed with a reason', () => {
  const bad = [], stale = [], list = files();
  assert.ok(list.length > 5, 'the scan found the app files');
  for (const f of list) {
    const { found, markersWithoutMatch } = scan(fs.readFileSync(f, 'utf8'), path.relative(PUBLIC, f));
    for (const x of found) {
      if (x.ok === null) bad.push(`${x.file}:${x.line}: ${x.name} (Safari ${x.min >= 99 ? 'never' : x.min}+): ${DENY.find(d => d.name === x.name).why}`);
      else if (!x.ok) bad.push(`${x.file}:${x.line}: compat-ok needs a reason after the colon (${x.name})`);
    }
    for (const m of markersWithoutMatch) stale.push(`${m.file}:${m.line}`);
  }
  assert.deepEqual(bad, [], `Too new for Safari ${TARGET} (add a fallback and mark the line with "compat-ok: <reason>", or avoid it):\n  ` + bad.join('\n  '));
  assert.deepEqual(stale, [], `compat-ok marker on a line without a denied feature (remove it):\n  ` + stale.join('\n  '));
});

test('the Firebase SDK stays on a major that was checked against Safari 15', () => {
  // Firebase 10.x (modular, ES2017 builds) lists Safari 11+ as supported. Check the "supported environments" page of the
  // Firebase docs before moving to another major, then change this number.
  const store = fs.readFileSync(path.join(PUBLIC, 'store.js'), 'utf8');
  const v = store.match(/const V = '(\d+)\.\d+\.\d+'/);
  assert.ok(v, 'store.js declares the Firebase version as `const V = \'x.y.z\'`');
  assert.equal(v[1], '10');
});

test('the viewport meta tag lets the page use the whole screen of a 320px phone', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1/);
  assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1/, 'pinch zoom stays available');
});
