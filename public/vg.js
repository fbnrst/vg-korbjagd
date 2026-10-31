// VG-Dresden-Stammdaten (Produkte, Hersteller, Länder, Einheiten) direkt vom VG-Server, im Browser zwischengespeichert.
// Die Endpunkte antworten mit CORS "*", daher braucht es keinen Proxy (siehe docs/vg-api.md).
const BASE = 'https://app.vg-dresden.de/php/';
const CACHE_KEY = 'korbjagd-vg-v1';

const get = async (name, init) => {
  const r = await fetch(BASE + name, { ...init, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(name + ' ' + r.status);
  return r.text();
};
const getJson = async name => JSON.parse(await get(name));

// "Voll- milchschokolade" -> "Vollmilchschokolade", "Schafmilch- Joghurt" -> "Schafmilch-Joghurt"
export const cleanTitle = t => String(t).replace(/- (?=[A-ZÄÖÜ])/g, '-').replace(/- (?=[a-zäöüß])/g, '').replace(/\s+/g, ' ').trim();

export function buildIndex(raw) {
  const { products, man, countries, units } = raw;
  const byNum = new Map();
  const list = products.map(([vgNum, title, unitID, manID, countryID, regional]) => {
    const p = { vgNum, title: cleanTitle(title), unit: units[unitID] || '', manufacturer: man[manID] || '',
      country: countries[countryID] || '', regional: !!regional };
    p.key = p.title.toLowerCase();
    if (!byNum.has(vgNum)) byNum.set(vgNum, p);
    return p;
  });
  return {
    size: list.length,
    lookup: n => byNum.get(+n) || null,
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
const toLs = v => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(v)); } catch (e) { /* Speicher voll: nächstes Mal neu laden */ } };

// Lädt die Daten (aus dem Cache, wenn die Prüfsummen noch stimmen). Gibt null zurück, wenn nichts verfügbar ist.
export async function loadVg() {
  const cached = fromLs();
  let sums = null;
  try { sums = JSON.stringify((await getJson('getChecksums.php')).map(c => [c.table.split('.').pop(), c.checksum]).sort()); } catch (e) { /* offline */ }
  if (cached && (!sums || cached.sums === sums)) return buildIndex(cached);
  if (!sums) return null;
  try {
    const [products, man, countries, units] = await Promise.all(['getProductList.php', 'getManufacturersList.php', 'getCountriesList.php', 'getUnitsList.php'].map(getJson));
    const map = (a, f) => Object.fromEntries(a.map(x => [x.id, f(x)]));
    const raw = { sums,
      products: products.map(p => [p.vgNum, p.title, p.unitID, p.manufacturerID, p.countryID, p.isRegional ? 1 : 0]),
      man: map(man, x => x.manufacturer), countries: map(countries, x => x.country), units: map(units, x => x.unit) };
    toLs(raw);
    return buildIndex(raw);
  } catch (e) { return cached ? buildIndex(cached) : null; }
}

/* ---------- Listen aus der Original-VG-App importieren ---------- */
// Teilen-Link der Original-App: https://app.vg-dresden.de/list?shareId=123#SCHLÜSSEL
export function parseShareLink(text) {
  const m = String(text).match(/shareId=(\d+)#([^\s]+)/);
  return m ? { id: m[1], key: m[2] } : null;
}
// Die Liste liegt AES-verschlüsselt (CryptoJS-Passphrase) auf dem VG-Server, der Schlüssel steht nur im Link.
export function decryptShared(CryptoJS, cipherText, key) {
  const plain = CryptoJS.AES.decrypt(cipherText, key).toString(CryptoJS.enc.Utf8);
  const items = JSON.parse(plain);
  if (!Array.isArray(items)) throw new Error('unerwartetes Format');
  return items.filter(i => i && i.title).map(i => ({ title: String(i.title), vgNum: i.vgNum || null,
    amount: Math.max(1, Math.round(+i.amount || 1)), unit: i.unit || '', checked: !!i.checked }));
}
export async function fetchSharedList(CryptoJS, { id, key }) {
  const text = await get('getSharedList.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shareId: id }) });
  return decryptShared(CryptoJS, text, key);
}
