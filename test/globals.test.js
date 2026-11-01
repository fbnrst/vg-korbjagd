import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

// A top-level declaration named like a browser global hides that global in the whole module: `let history` in app.js once
// broke every history.replaceState call (sharing, leaving and joining a list threw). Names the app's modules must not declare.
const GLOBALS = ['history', 'location', 'navigator', 'document', 'window', 'self', 'localStorage', 'sessionStorage', 'screen', 'name', 'status',
  'origin', 'event', 'confirm', 'alert', 'prompt', 'fetch', 'caches', 'crypto', 'performance', 'open', 'close', 'print', 'top', 'parent', 'frames', 'length',
  'matchMedia', 'getSelection', 'visualViewport', 'URL', 'Image', 'Event', 'CSS'];

test('no module in public/ declares a top-level name that hides a browser global', () => {
  const dir = new URL('../public/', import.meta.url);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => [f, fs.readFileSync(new URL(f, dir), 'utf8')]);
  files.push(['docs/help.js', fs.readFileSync(new URL('docs/help.js', dir), 'utf8')]);
  const found = [];
  for (const [f, src] of files) {
    for (const m of src.matchAll(/^(?:export\s+)?(?:let|const|var|function\*?|async\s+function|class)\s+([A-Za-z_$][\w$]*)/gm)) if (GLOBALS.includes(m[1])) found.push(`${f}: ${m[1]}`);
    for (const m of src.matchAll(/^(?:export\s+)?(?:let|const|var)\s+[A-Za-z_$][\w$]*\s*=[^;\n]*?,\s*([A-Za-z_$][\w$]*)\s*=/gm)) if (GLOBALS.includes(m[1])) found.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(found, []);
});
