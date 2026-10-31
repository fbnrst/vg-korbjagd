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
