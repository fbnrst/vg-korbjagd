// Aisle grouping for the open items: a keyword dictionary plus what this phone learned from the person's own moves.
// Pure logic (no DOM), covered by test/aisles.test.js. VG data has no category field, so nothing here depends on it.
// An item that matches nothing is "other" (shown last): a wrong group costs more than none, so there is no guessing.

// Default walking order of the groups; "other" always comes last
export const AISLES = ['produce', 'bakery', 'dairy', 'meat', 'frozen', 'spreads', 'cereal', 'baking', 'pasta', 'spices', 'coffee', 'snacks', 'drinks', 'household'];
export const OTHER = 'other';
export const MAX_OVERRIDES = 500;

// Keywords are folded (lower case, umlauts as ae/oe/ue, ß as ss) and matched inside each word of the item.
const WORDS = {
  produce: 'apfel,aepfel,birne,banane,orange,mandarine,clementine,zitrone,limette,grapefruit,traube,erdbeere,himbeere,beere,kirsche,pflaume,zwetschge,pfirsich,nektarine,aprikose,melone,ananas,mango,kiwi,avocado,granatapfel,feige,kaki,papaya,maracuja,physalis,quitte,rhabarber,kokosnuss,kartoffel,zwiebel,knoblauch,lauch,porree,schalotte,moehre,karotte,sellerie,pastinake,kohlrabi,radieschen,rettich,gurke,tomate,paprika,peperoni,chili,zucchini,aubergine,kuerbis,hokkaido,brokkoli,broccoli,blumenkohl,rosenkohl,kohl,wirsing,spinat,mangold,fenchel,spargel,pilz,champignon,salat,rucola,chicoree,radicchio,ingwer,meerrettich,gemuese,sprossen,petersilie,schnittlauch,basilikum,dill,koriander,minze,rosmarin,thymian,salbei,oregano,baerlauch,kraeuter,obst,zuckermais,erbsen,bohnen,kresse,suesskartoffel,schoten,mais',
  dairy: 'milch,sahne,schmand,joghurt,quark,skyr,butter,margarine,kaese,gouda,emmentaler,camembert,mozzarella,feta,parmesan,frischkaese,kefir,pudding,ei,eier,sojadrink,haferdrink,mandeldrink,mandelmilch,tofu,tempeh,seitan',
  bakery: 'brot,broetchen,semmel,baguette,croissant,brezel,kuchen,toast,knaeckebrot,zwieback,torte,gebaeck,blaetterteig,hefeteig,laugen',
  spreads: 'marmelade,honig,sirup,dicksaft,nutella,nussmus,erdnussmus,erdnussmuss,mandelmus,cashewmus,erdnussbutter,tahini,aufstrich,bionella,zwergenwiese',
  cereal: 'haferflocken,flocken,muesli,cornflakes,granola,porridge,cerealien',
  baking: 'mehl,zucker,backpulver,natron,hefe,vanille,gelatine,sahnesteif,puddingpulver,guss,raspel,staerke,suessstoff,dattelsuesse,paniermehl',
  pasta: 'nudel,spaghetti,penne,spiralen,reis,couscous,bulgur,hirse,linse,kichererbse,quinoa,griess,polenta,gerste,dinkel,tortellini,gnocchi,lasagne,raviol,dosen,konserve,suppe,mus,oel,essig,balsamico,sojasauce,ketchup,mayonnaise,senf,bruehe,tomatenmark,kokosmilch,hummus,pesto,oliven,kartoffelpueree,sauerkraut,passierte,sosse,sauce,zwergensauce',
  spices: 'salz,pfeffer,zimt,curry,kurkuma,muskat,gewuerz,pulver,lorbeer,nelke,wacholder,hefeflocken',
  coffee: 'tee,kaffee,kaffeebohnen,espresso,kakao',
  snacks: 'nuss,nuesse,mandel,cashew,erdnuss,sonnenblumenkerne,kuerbiskerne,leinsamen,chiasamen,sesam,pinienkern,pistazie,studentenfutter,rosinen,datteln,trockenfruechte,trockenobst,cranberr,schokolade,gummibaer,chips,salzstangen,riegel,popcorn,bonbon,lakritz,marzipan,nougat,cracker,reiswaffel,keks',
  drinks: 'wasser,sprudel,saft,schorle,limonade,cola,bier,wein,sekt,getraenk,pfand,limo,prosecco,spirituose,wodka,gin,whisky,radler,drink,eistee',
  meat: 'wurst,aufschnitt,schinken,lachs,fisch,fleisch,hack,sojaschnetzel,burger,falafel,bratling,salami,speck,haehn,huhn,pute,rind,schwein,steak,brust',
  frozen: 'tk,tiefkuehl,pizza,pommes,kroketten,eis,eiswuerfel,beerenmix,blattspinat,eiscreme',
  household: 'zahnpasta,zahnbuerste,zahnseide,seife,duschgel,dusch,shampoo,deo,handcreme,toilettenpapier,klopapier,kuechenrolle,taschentuecher,spuelmittel,spuelbuerste,waschmittel,weichspueler,putzmittel,reiniger,muellbeutel,gefrierbeutel,backpapier,alufolie,frischhaltefolie,serviette,kerze,streichhoelzer,batterie,gluehbirne,windel,feuchttuecher,tampon,binde,spuelmaschine,schwamm,tragetasche,blumen,katzenfutter,hundefutter,futter,leckerli,rasier,sonnencreme,geschirrtuch,schere,filter',
};
// Words that count only as a whole word (the short ones would hit inside other words) and cans that decide on their own
const EXACT = new Set(['tk', 'ei', 'eier', 'eis', 'dose', 'glas', 'gin', 'deo', 'mais']);
const PHRASES = [['rote bete', 'produce'], ['rote beete', 'produce'], ['hafer barista', 'dairy'], ['ruehrei', 'dairy'], ['spiegelei', 'dairy']];
const CANNED = new Set(['dose', 'glas']);
// Spellings that only differ by a diacritic: é in Chicorée, ñ and so on
const fold = s => String(s).toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '');

const ENTRIES = Object.entries(WORDS).flatMap(([aisle, list]) => list.split(',').map(k => [k, aisle]));

// The key a learned choice is stored under: the name without case, umlauts and punctuation
export const aisleKey = title => fold(title).replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);

// Dictionary guess; null when nothing fits. German compounds name the thing with their last part, so a keyword at the end
// of a word beats one in the middle (Apfelsaft is a drink, Gemüsebrühe is a stock).
export function guessAisle(title) {
  const name = fold(title).replace(/[^a-z0-9 ]+/g, ' ');
  const phrase = PHRASES.find(([p]) => name.includes(p));
  if (phrase) return phrase[1];
  let best = null;
  for (const tok of name.split(/\s+/).filter(Boolean)) {
    if (CANNED.has(tok)) { if (!best || best[0] < 500) best = [500, 'pasta']; continue; }
    for (const [k, aisle] of ENTRIES) {
      if (EXACT.has(k) ? tok !== k : !tok.includes(k)) continue;
      const score = (tok.endsWith(k) ? 100 : 0) + k.length;
      if (!best || score > best[0]) best = [score, aisle];
    }
  }
  return best ? best[1] : null;
}

export const isAisle = a => AISLES.includes(a) || a === OTHER;

// What this phone learned (or was told) wins over the dictionary
export const aisleOf = (title, overrides = {}) => overrides[aisleKey(title)] || guessAisle(title) || OTHER;

// Items split into groups in walking order, only the groups that have items; the order inside a group is kept
export function groupByAisle(items, overrides = {}) {
  const groups = new Map([...AISLES, OTHER].map(a => [a, []]));
  for (const i of items) groups.get(aisleOf(i.title, overrides)).push(i);
  return [...groups].filter(([, list]) => list.length).map(([aisle, list]) => ({ aisle, items: list }));
}

// localStorage is user-writable: only known aisles under sane keys survive, at most MAX_OVERRIDES
export function sanitizeOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_OVERRIDES) break;
    if (typeof k === 'string' && k && k.length <= 60 && k === aisleKey(k) && isAisle(v)) out[k] = v;
  }
  return out;
}

// A choice from the move dialog; `aisle` null goes back to the automatic guess. The oldest choice makes room when full.
export function withChoice(overrides, title, aisle) {
  const key = aisleKey(title), next = { ...overrides };
  delete next[key];
  if (!key || !aisle) return next;
  next[key] = aisle;
  const keys = Object.keys(next);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_OVERRIDES))) delete next[old];
  return next;
}
