// Sync-Server für die gemeinsame Einkaufsliste. Keine Abhängigkeiten, nur Node >= 18.
// Start: node server.js   (PORT=3000, DATA=./data.json)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA || path.join(__dirname, 'data.json');
const PUBLIC = path.join(__dirname, 'public');

let lists = {};
try { lists = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
let saveTimer = null;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(DATA_FILE, JSON.stringify(lists), () => {}), 200);
};

const clients = {}; // code -> Set<res>
const newCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from(crypto.randomBytes(6), b => chars[b % chars.length]).join(''); } while (lists[c]);
  return c;
};
const newList = () => ({ items: {}, scores: {}, rev: 0, created: Date.now() });

function broadcast(code, event) {
  const l = lists[code];
  l.rev++;
  const msg = `data: ${JSON.stringify({ state: l, event })}\n\n`;
  for (const res of clients[code] || []) res.write(msg);
  save();
}

// Operationen sind idempotent bzw. last-write-wins, damit Offline-Nachsendungen sicher sind.
function applyOp(l, op) {
  const { type, user } = op;
  const it = op.id && l.items[op.id];
  const bump = (name, d) => { if (name) l.scores[name] = Math.max(0, (l.scores[name] || 0) + d); };
  switch (type) {
    case 'join':
      if (user && !(user in l.scores)) l.scores[user] = 0;
      return { kind: 'join', user };
    case 'add': {
      if (it) return null;
      if (typeof op.id !== 'string' || !op.id) return null;
      const title = String(op.title || '').slice(0, 120).trim();
      if (!title) return null;
      l.items[op.id] = { id: op.id, title, amount: Math.max(1, +op.amount || 1), unit: op.unit || '',
        vgNum: op.vgNum ? +op.vgNum : null, ean: /^\d{8,14}$/.test(op.ean) ? op.ean : null, checked: false, checkedBy: null, checkedAt: null,
        addedBy: user, addedAt: Date.now() };
      return { kind: 'add', user, title };
    }
    case 'check': {
      if (!it) return null;
      const want = !!op.checked;
      if (want === it.checked) return null;
      if (want) { it.checked = true; it.checkedBy = user; it.checkedAt = Date.now(); bump(user, 1); }
      else { bump(it.checkedBy, -1); it.checked = false; it.checkedBy = null; it.checkedAt = null; }
      return { kind: want ? 'check' : 'uncheck', user, title: it.title };
    }
    case 'setnum':
      if (!it) return null;
      it.vgNum = op.vgNum ? +op.vgNum : null;
      if (op.title) it.title = String(op.title).slice(0, 120);
      if (op.checkToo && !it.checked) { it.checked = true; it.checkedBy = user; it.checkedAt = Date.now(); bump(user, 1); }
      return { kind: 'setnum', user, title: it.title };
    case 'amount':
      if (!it) return null;
      it.amount = Math.max(1, +op.amount || 1);
      return { kind: 'amount', user, title: it.title };
    case 'remove':
      if (!it) return null;
      if (it.checked) bump(it.checkedBy, -1);
      delete l.items[op.id];
      return { kind: 'remove', user, title: it.title };
    case 'clearChecked':
      for (const k of Object.keys(l.items)) if (l.items[k].checked) delete l.items[k];
      return { kind: 'clear', user };
    case 'resetScores':
      for (const k of Object.keys(l.scores)) l.scores[k] = 0;
      for (const k of Object.keys(l.items)) if (l.items[k].checked) l.scores[l.items[k].checkedBy] = (l.scores[l.items[k].checkedBy] || 0) + 1;
      return { kind: 'reset', user };
  }
  return null;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', d => { b += d; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(e); } });
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/api\/lists(?:\/([A-Z0-9]{6})(?:\/(events|ops))?)?$/);
  if (m) {
    const [, code, sub] = m;
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!code && req.method === 'POST') {
      const c = newCode(); lists[c] = newList(); save(); return json(200, { code: c });
    }
    if (!code || !lists[code]) return json(404, { error: 'Liste nicht gefunden' });
    if (sub === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ state: lists[code] })}\n\n`);
      (clients[code] = clients[code] || new Set()).add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients[code].delete(res); });
      return;
    }
    if (sub === 'ops' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const ops = Array.isArray(body.ops) ? body.ops : [body];
        for (const op of ops) {
          const ev = applyOp(lists[code], op);
          if (ev) broadcast(code, ev);
        }
        return json(200, { ok: true, rev: lists[code].rev });
      } catch (e) { return json(400, { error: 'bad request' }); }
    }
    return json(200, lists[code]);
  }
  // statische Dateien
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC, 'index.html'), (e2, d2) => { // SPA-Fallback (?list=CODE)
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(d2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Einkaufsliste läuft auf http://localhost:${PORT}`));
