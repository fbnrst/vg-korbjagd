// Review aid for the name matching (see "Name matching review" in AGENTS.md): holds a list of everyday shopping-list
// words against the real VG product list and shows where the suggestions or the name check cope badly.
//
//   npm run matching:check                    # downloads the VG product list (read-only)
//   npm run matching:check -- products.json   # or a saved copy of getProductList.php
//
// Nothing here changes any file. A capable reader (an agent or a person) looks at the report and decides which words
// belong together; those go into SYNONYM_GROUPS (or COLLECTIVES) in public/vg.js, with a test in test/vg.test.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanTitle, isPlaceholder, nameSimilarity, similarNames, SIMILAR_ENOUGH } from '../public/vg.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lines = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/typical-items.txt'), 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
const words = [...new Set(lines.filter(l => !l.includes(' => ') && !l.includes(' != ')))];   // plain items; the checked pairs belong to the test

async function loadProducts() {
  const file = process.argv[2];
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const r = await fetch('https://app.vg-dresden.de/php/getProductList.php', { headers: { Origin: 'https://fbnrst.github.io' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`getProductList.php ${r.status}`);
  return JSON.parse(await r.text());
}
const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');

const titles = [...new Set((await loadProducts()).map(p => cleanTitle(p.title)).filter(t => !isPlaceholder(t)))];
console.log(`${titles.length} distinct VG product names, ${words.length} typical items\n`);

const noHit = [], near = [], fine = [];
for (const w of words) {
  const typed = w.toLowerCase();
  const suggested = titles.filter(t => typed.split(/\s+/).every(x => t.toLowerCase().includes(x)));   // what the add bar suggests
  const matching = titles.filter(t => similarNames(w, t));                                           // what the name check accepts
  // names that share the first letters (a stem) but are rejected: candidates for a synonym group or a collective word
  const stem = norm(w).replace(/[^a-z]/g, '').slice(0, 5);
  const missed = stem.length >= 4 ? titles.filter(t => norm(t).includes(stem) && !similarNames(w, t)) : [];
  if (!suggested.length && !matching.length) noHit.push(w);
  else if (missed.length) near.push({ w, matching: matching.length, missed });
  else fine.push(w);
}

console.log(`== Nothing in the VG list for these ${noHit.length} words (not sold, or named so differently that nothing matches) ==`);
console.log(noHit.join(', '), '\n');
console.log(`== Near misses: VG names with the same word start that the name check would question (${near.length} words) ==`);
console.log('(many are right: Apfel vs Apfelsaft is a different product. Look for names that are the same product in other words.)');
for (const { w, matching, missed } of near) {
  const best = missed.map(t => [nameSimilarity(w, t), t]).sort((a, b) => b[0] - a[0]).slice(0, 4);
  console.log(`${w} [${matching} accepted, ${missed.length} questioned]: ${best.map(([s, t]) => `${t} ${s.toFixed(2)}`).join(' | ')}`);
}
console.log(`\n${fine.length} words are fine.`);
