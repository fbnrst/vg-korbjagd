// VG Dresden master data (products, manufacturers, countries, units) straight from the VG server, cached in the browser.
// The endpoints answer with CORS "*", so no proxy is needed (see docs/vg-api.md).
const BASE = 'https://app.vg-dresden.de/php/';
const CACHE_KEY = 'korbjagd-vg-v2';

const get = async (name, init) => {
  const r = await fetch(BASE + name, { ...init, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(name + ' ' + r.status);
  return r.text();
};
const getJson = async name => JSON.parse(await get(name));

// "Voll- milchschokolade" -> "Vollmilchschokolade", "Schafmilch- Joghurt" -> "Schafmilch-Joghurt"
export const cleanTitle = t => String(t).replace(/- (?=[A-ZÄÖÜ])/g, '-').replace(/- (?=[a-zäöüß])/g, '').replace(/\s+/g, ' ').trim();

// About a fifth of the VG list are unused number slots ("unbesetzt …", "RESERVIERT …"): never suggested
export const isPlaceholder = title => /\bunbesetzt/i.test(String(title)) || /^reserviert\b/i.test(String(title).trim());

export function buildIndex(raw) {
  const { products, man, countries, units } = raw;
  const deposits = raw.deposits || [];
  const byNum = new Map();
  const all = products.map(([vgNum, title, unitID, manID, countryID, regional]) => {
    const p = { vgNum, title: cleanTitle(title), unit: units[unitID] || '', manufacturer: man[manID] || '',
      country: countries[countryID] || '', regional: !!regional };
    p.key = p.title.toLowerCase();
    p.placeholder = isPlaceholder(p.title);
    // A real product wins over a placeholder with the same number
    const known = byNum.get(vgNum);
    if (!known || (known.placeholder && !p.placeholder)) byNum.set(vgNum, p);
    return p;
  });
  // Placeholders stay findable by their exact number (the shop may use a number the database calls "unbesetzt"),
  // but they are never suggested: all searches below use the list without them.
  const list = all.filter(p => !p.placeholder);
  return {
    size: list.length,
    deposits,
    lookup: n => byNum.get(+n) || null,
    // Products whose VG number starts with the typed digits (exact match first, then ascending)
    searchByNumber(prefix, limit = 6) {
      const p = String(prefix);
      const hits = list.filter(x => byNum.get(x.vgNum) === x && String(x.vgNum).startsWith(p));
      hits.sort((a, b) => (String(b.vgNum) === p) - (String(a.vgNum) === p) || a.vgNum - b.vgNum);
      return hits.slice(0, limit);
    },
    // Name suggestions without duplicates: products with the same name collapse into one entry.
    // Picking a name adds the item without a VG number (it can be added or changed on the list later).
    searchNames(q, limit = 6) {
      const seen = new Set(), out = [];
      for (const p of this.search(q, Infinity)) {
        if (seen.has(p.key)) continue;
        seen.add(p.key); out.push({ title: p.title });
        if (out.length >= limit) break;
      }
      return out;
    },
    byTitle: t => list.find(p => p.key === String(t).trim().toLowerCase()) || null,
    search(q, limit = 8) {
      const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return [];
      const hits = list.filter(p => words.every(w => p.key.includes(w)));
      hits.sort((a, b) => (b.key.startsWith(words[0]) - a.key.startsWith(words[0])) || a.title.length - b.title.length);
      return hits.slice(0, limit);
    },
  };
}

export const infoText = p => [p.unit && p.unit !== '---' ? p.unit : '', p.manufacturer && p.manufacturer !== 'Hersteller unbekannt' ? p.manufacturer : '',
  p.country && p.country !== 'siehe Etikett' ? p.country : '', p.regional ? 'regional' : ''].filter(Boolean).join(' · ');

const fromLs = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch (e) { return null; } };
const toLs = v => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(v)); } catch (e) { /* storage full: reload next time */ } };

// Loads the data (from the cache if the checksums still match). Returns null if nothing is available.
export async function loadVg() {
  const cached = fromLs();
  let sums = null;
  try { sums = JSON.stringify((await getJson('getChecksums.php')).map(c => [c.table.split('.').pop(), c.checksum]).sort()); } catch (e) { /* offline */ }
  if (cached && (!sums || cached.sums === sums)) return buildIndex(cached);
  if (!sums) return null;
  try {
    const [products, man, countries, units, deposits] = await Promise.all(['getProductList.php', 'getManufacturersList.php', 'getCountriesList.php', 'getUnitsList.php', 'getDepositsList.php'].map(getJson));
    const map = (a, f) => Object.fromEntries(a.map(x => [x.id, f(x)]));
    const raw = { sums,
      products: products.map(p => [p.vgNum, p.title, p.unitID, p.manufacturerID, p.countryID, p.isRegional ? 1 : 0]),
      deposits: deposits.map(d => ({ id: d.id, name: d.name, vgNum: d.vgNum })),
      man: map(man, x => x.manufacturer), countries: map(countries, x => x.country), units: map(units, x => x.unit) };
    toLs(raw);
    return buildIndex(raw);
  } catch (e) { return cached ? buildIndex(cached) : null; }
}

/* ---------- Scanned codes ---------- */
// VG shelf labels carry the VG number in their code (same rules as the original app):
//  - QR code text "VG <number> <unit> <name> <country>"
//  - 8 digits incl. check digit: "00073448" -> 7344
//  - 13 digits incl. check digit: the first 12 digits are the number, zero padded
// Anything else (an ordinary product EAN) returns null.
export function vgNumFromCode(text) {
  const s = String(text).trim();
  let n = NaN;
  if (/^VG\s/i.test(s)) n = Number(s.split(/\s+/)[1]);
  else if (/^\d{8}$/.test(s)) n = Number(s.slice(3, 7));
  else if (/^\d{13}$/.test(s)) n = Number(s.slice(0, 12));
  return Number.isInteger(n) && n >= 1 && n <= 9999999 ? n : null;
}

// How alike are two product names (0..1)? The best match between any two words, as the Dice coefficient of their
// letter pairs, after dropping umlauts/case, tiny words, numbers and generic words like "Bio"; listed synonyms
// (Porree/Lauch) count as 1. Plural and spelling
// variants score high (Tomate/Tomaten 0.91, Äpfel/Apfel 1), compounds and different products low
// (Apfel/Apfelsaft 0.67, Apfel/Orange 0). Nothing to compare (empty, only numbers) counts as 1: do not bother the user.
const GENERIC = new Set(['bio', 'frisch', 'frische', 'regional', 'natur', 'naturell', 'stueck', 'packung', 'mini', 'maxi', 'gross', 'klein',
  // colours say nothing about the product: "Traube rot" and "Paprika rot" share a word but not a product
  'rot', 'rote', 'roter', 'rotes', 'grun', 'grune', 'gruner', 'gelb', 'gelbe', 'gelber', 'weiss', 'weisse', 'weisser', 'schwarz', 'schwarze', 'schwarzer', 'blau', 'blaue', 'blauer', 'braun', 'braune', 'bunt', 'bunte']);
const normName = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss');
const nameWords = s => normName(s).split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !GENERIC.has(w) && !/^\d+$/.test(w));
function dice(a, b) {
  if (a === b) return 1;
  if (a.length < 4 || b.length < 4) return 0; // three letters share too many pairs by chance (brot ~ rot)
  const pairs = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) || 0) + 1); } return m; };
  const A = pairs(a), B = pairs(b); let common = 0;
  for (const [k, n] of A) common += Math.min(n, B.get(k) || 0);
  const total = (a.length - 1) + (b.length - 1);
  return total > 0 ? 2 * common / total : 0;
}
// Words that mean the same thing (regional names, spelling variants). Extend this list when a pair is questioned
// although the shopper would call it the same product. Words are compared without umlauts and case.
export const SYNONYM_GROUPS = [
  ['porree', 'lauch', 'breitlauch'], ['möhre', 'möhren', 'karotte', 'karotten', 'mohrrübe', 'mohrrüben', 'bundmöhren', 'bundmöhre', 'saftmöhren'],
  ['zucchini', 'courgette', 'zucchino'], ['tomate', 'tomaten', 'paradeiser', 'strauchtomate', 'strauchtomaten', 'cherrytomate', 'cherrytomaten', 'cocktailtomate', 'cocktailtomaten', 'fleischtomate', 'fleischtomaten', 'romatomate', 'rispentomate', 'rispentomaten', 'datteltomate', 'datteltomaten', 'buschtomate', 'buschtomaten', 'salattomate', 'salattomaten', 'eiertomate', 'eiertomaten', 'romatomaten', 'aromatomate', 'flaschentomate'], ['aprikose', 'aprikosen', 'marille', 'marillen'],
  ['rucola', 'rukola', 'ruccola', 'rauke'], ['blumenkohl', 'karfiol'], ['brokkoli', 'broccoli'],
  ['feldsalat', 'rapunzel', 'rapunzelsalat', 'nüsslisalat', 'vogerlsalat', 'ackersalat'],
  ['kartoffel', 'kartoffeln', 'erdapfel', 'erdäpfel', 'frühkartoffel', 'frühkartoffeln', 'speisekartoffel', 'speisekartoffeln'], ['süßkartoffel', 'süßkartoffeln', 'batate'],
  ['aubergine', 'auberginen', 'eierfrucht'], ['meerrettich', 'kren'], ['rotkohl', 'rotkraut', 'blaukraut'],
  ['weißkohl', 'weißkraut', 'kappes'], ['wirsing', 'wirz', 'welschkohl'], ['grünkohl', 'braunkohl', 'krauskohl', 'federkohl'],
  ['rosenkohl', 'sprossenkohl'], ['frühlingszwiebel', 'frühlingszwiebeln', 'lauchzwiebel', 'lauchzwiebeln', 'schlotten'],
  ['pflaume', 'pflaumen', 'zwetschge', 'zwetschgen', 'zwetschke', 'zwetschken', 'goldpflaume', 'edelpflaume', 'wildpflaume'], ['kohlrübe', 'steckrübe', 'wruke'],
  ['johannisbeere', 'johannisbeeren', 'ribisel', 'ribiseln'], ['gurke', 'gurken', 'salatgurke', 'salatgurken', 'schlangengurke', 'schlangengurken', 'landgurke', 'landgurken', 'minigurke', 'minigurken', 'snackgurke', 'snackgurken', 'urgurke'],
  ['paprika', 'paprikaschote', 'paprikaschoten', 'spitzpaprika', 'snackpaprika'], ['mais', 'zuckermais', 'maiskolben'], ['sellerie', 'knollensellerie'],
  ['sahne', 'rahm', 'obers', 'schlagsahne'], ['quark', 'topfen'], ['joghurt', 'jogurt', 'yoghurt', 'yogurt'],
  ['brötchen', 'semmel', 'schrippe', 'weckle', 'wecken'], ['hackfleisch', 'gehacktes', 'faschiertes'],
  ['marmelade', 'konfitüre', 'fruchtaufstrich', 'gelee'], ['traube', 'trauben', 'weintraube', 'weintrauben', 'tafeltraube', 'tafeltrauben'],
  // vegetables and salads: the shopper's short word against the sort named in the VG list
  ['bete', 'beete', 'rande', 'randen'], ['kürbis', 'kürbisse', 'hokkaido', 'hokkaidokürbis', 'butternut', 'butternusskürbis', 'muskatkürbis'],
  ['salat', 'kopfsalat', 'eichblattsalat', 'bataviasalat', 'eisbergsalat', 'romanasalat', 'lollosalat', 'pflücksalat', 'endiviensalat', 'zuckerhutsalat', 'eissalat', 'mixsalat', 'salatmix', 'blattsalat', 'multiblattsalat'],
  ['zwiebel', 'zwiebeln', 'gemüsezwiebel', 'gemüsezwiebeln', 'speisezwiebel', 'speisezwiebeln'],
  ['staudensellerie', 'stangensellerie', 'bleichsellerie'], ['peperoni', 'peperoncino', 'pfefferoni', 'chili', 'chilli', 'chilischote'],
  ['champignon', 'champignons', 'egerling', 'egerlinge', 'pilz', 'pilze'], ['zuckerschote', 'zuckerschoten', 'zuckererbse', 'zuckererbsen', 'kefe', 'kefen'],
  ['bohne', 'bohnen', 'buschbohne', 'buschbohnen', 'stangenbohne', 'stangenbohnen', 'gartenbohne', 'gartenbohnen', 'prinzessbohnen'],
  // fruit
  ['apfel', 'äpfel', 'tafelapfel', 'kinderapfel', 'frühapfel'], ['orange', 'orangen', 'saftorange', 'saftorangen', 'blutorange', 'blutorangen', 'navelorange'],
  ['mandarine', 'mandarinen', 'clementine', 'clementinen', 'satsuma'], ['grapefruit', 'pampelmuse'],
  ['melone', 'melonen', 'wassermelone', 'honigmelone', 'zuckermelone', 'galiamelone', 'cantaloupe'],
  ['heidelbeere', 'heidelbeeren', 'blaubeere', 'blaubeeren'], ['kirsche', 'kirschen', 'süßkirsche', 'süßkirschen', 'sauerkirsche', 'sauerkirschen'],
  ['maracuja', 'passionsfrucht', 'granadilla'], ['physalis', 'kapstachelbeere', 'andenbeere'],
  ['rosine', 'rosinen', 'sultanine', 'sultaninen', 'weinbeere', 'weinbeeren'],
  // nuts and muesli: the nut against its kernels
  ['mandel', 'mandeln', 'mandelkerne'], ['haselnuss', 'haselnüsse', 'haselnusskerne'], ['walnuss', 'walnüsse', 'walnusskerne'],
  ['erdnuss', 'erdnüsse', 'erdnusskerne', 'peanuts'], ['cashew', 'cashews', 'cashewkerne', 'cashewnüsse', 'cashewnuss'],
  ['pistazie', 'pistazien', 'pistazienkerne'], ['paranuss', 'paranüsse', 'paranusskerne'], ['pekannuss', 'pekannüsse', 'pekannusskerne', 'pecannuss'],
  ['müsli', 'muesli', 'müslis'],
  ['pfirsich', 'pfirsiche', 'weinbergpfirsich', 'weinbergpfirsiche'], ['nektarine', 'nektarinen', 'weinbergnektarine'], ['erdbeere', 'erdbeeren', 'walderdbeere', 'walderdbeeren'],
  ['dattel', 'datteln', 'zweigdatteln', 'medjooldatteln'], ['feige', 'feigen', 'bergfeigen'], ['spinat', 'babyspinat'], ['mangold', 'schnittmangold'],
  ['rettich', 'rettiche', 'japanrettich', 'schwarzrettich', 'winterrettich'], ['linse', 'linsen', 'berglinsen', 'tellerlinsen', 'belugalinsen'],
  ['minze', 'pfefferminze', 'apfelminze', 'krauseminze'], ['toast', 'toastbrot', 'dinkeltoast', 'dinkeltoastbrot', 'weizentoast'],
  ['honig', 'rapshonig', 'kleehonig', 'blütenhonig', 'waldhonig', 'akazienhonig', 'sonnenblumenhonig'],
  // milk alternatives are sold as "drink" (EU rule) but written as "milk" on every list
  ['hafermilch', 'haferdrink', 'haferdrinks'], ['sojamilch', 'sojadrink'], ['mandelmilch', 'mandeldrink'], ['reismilch', 'reisdrink'], ['schmand', 'sauerrahm'],
];
const SYNONYM_OF = new Map();
SYNONYM_GROUPS.forEach((g, i) => g.forEach(w => SYNONYM_OF.set(normName(w), i)));
// Collective words: the plain word fits every compound that ends in it ("Brot" ~ "Vollkornbrot", "Brötchen" ~ "Milchbrötchen",
// but Roggenbrot vs Dinkelbrot are two products and stay questioned)
const COLLECTIVES = ['brot', 'brotchen', 'baguette', 'croissant'];
const collective = (x, y) => COLLECTIVES.some(c => (x === c && y.endsWith(c)) || (y === c && x.endsWith(c)));
const synonyms = (x, y) => SYNONYM_OF.has(x) && SYNONYM_OF.get(x) === SYNONYM_OF.get(y);

export function nameSimilarity(a, b) {
  const wa = nameWords(a), wb = nameWords(b);
  if (!wa.length || !wb.length) return 1;
  let best = 0;
  for (const x of wa) for (const y of wb) best = Math.max(best, synonyms(x, y) || collective(x, y) ? 1 : dice(x, y));
  return best;
}
// Below this the app asks "is that really the same product?"
export const SIMILAR_ENOUGH = 0.75;
// strictly above: a plural against a compound lands exactly on 0.75 (Tomaten ~ Tomatenmark) and is a different product
export const similarNames = (a, b) => nameSimilarity(a, b) > SIMILAR_ENOUGH;

/* ---------- Import lists from the original VG app ---------- */
// Share link of the original app: https://app.vg-dresden.de/list?shareId=123#KEY
export function parseShareLink(text) {
  const m = String(text).match(/shareId=(\d+)#([^\s]+)/);
  return m ? { id: m[1], key: m[2] } : null;
}
// The list is stored AES-encrypted (CryptoJS passphrase) on the VG server; the key is only in the link.
export function decryptShared(CryptoJS, cipherText, key) {
  const plain = CryptoJS.AES.decrypt(cipherText, key).toString(CryptoJS.enc.Utf8);
  const items = JSON.parse(plain);
  if (!Array.isArray(items)) throw new Error('unexpected format');
  return items.filter(i => i && i.title).map(i => ({ title: String(i.title), vgNum: i.vgNum || null,
    amount: Math.max(1, Math.round(+i.amount || 1)), unit: i.unit || '', checked: !!i.checked }));
}
export async function fetchSharedList(CryptoJS, { id, key }) {
  const text = await get('getSharedList.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shareId: id }) });
  return decryptShared(CryptoJS, text, key);
}
