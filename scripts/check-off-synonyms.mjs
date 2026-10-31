// Review aid (see "Name matching review" in AGENTS.md): checks the name check against the German synonyms of Open Food Facts.
//
//   npm run matching:off
//
// Downloads the OFF ingredient taxonomy on the fly (about 3 MB, from the openfoodfacts-server repository) and keeps it in
// memory only: nothing is stored in this repository, nothing is bundled into the app (the data is under the ODbL licence).
// Every line "de: Rosine, Rosinen, Weinbeere" is a set of names for the same ingredient. The report lists the pairs of a set
// that the name check would question. It is a source of candidates, not of truth: look at each one before it goes into
// SYNONYM_GROUPS in public/vg.js, and record the decision in scripts/fixtures/typical-items.txt.
import { similarNames } from '../public/vg.js';

const URL_TXT = 'https://raw.githubusercontent.com/openfoodfacts/openfoodfacts-server/main/taxonomies/food/ingredients.txt';
const r = await fetch(URL_TXT, { signal: AbortSignal.timeout(60000) });
if (!r.ok) throw new Error(`${URL_TXT} ${r.status}`);
const lines = (await r.text()).split('\n');

const sets = lines.filter(l => l.startsWith('de:')).map(l => l.slice(3).split(',').map(x => x.trim()).filter(Boolean))
  .filter(set => set.length >= 2 && set.every(t => t.split(/\s+/).length <= 3));
const failing = [];
for (const set of sets) {
  const questioned = [];
  for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++) if (!similarNames(set[i], set[j])) questioned.push(`${set[i]} / ${set[j]}`);
  if (questioned.length) failing.push({ set, questioned });
}
console.log(`${sets.length} German synonym sets in the OFF ingredient taxonomy, ${failing.length} contain pairs the name check would question:\n`);
for (const { set, questioned } of failing) console.log(`${set.join(', ')}\n    questioned: ${questioned.slice(0, 4).join(' | ')}`);
