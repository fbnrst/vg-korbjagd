const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const PORT = 3999;
const base = `http://localhost:${PORT}`;
let proc;
const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(r => r.json());
const get = url => fetch(base + url).then(r => r.json());

test.before(async () => {
  const data = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vg-')), 'data.json');
  proc = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA: data }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/manifest.json'); return; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
});
test.after(() => proc.kill());

test('abhaken wird live an anderen Client gesendet, Punkte zählen', async () => {
  const { code } = await post('/api/lists');
  const res = await fetch(`${base}/api/lists/${code}/events`);
  const reader = res.body.getReader(); const dec = new TextDecoder();
  const events = [];
  (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return;
    for (const l of dec.decode(value).split('\n')) if (l.startsWith('data: ')) events.push(JSON.parse(l.slice(6))); } })();

  await post(`/api/lists/${code}/ops`, { ops: [{ type: 'add', id: 'a1', title: 'Milch', user: '🦊 Mia' }, { type: 'add', id: 'a2', title: 'Brot', user: '🐼 Ben' }] });
  await post(`/api/lists/${code}/ops`, { type: 'check', id: 'a1', checked: true, user: '🦊 Mia' });
  await post(`/api/lists/${code}/ops`, { type: 'setnum', id: 'a2', vgNum: 4711, checkToo: true, user: '🐼 Ben' });
  await new Promise(r => setTimeout(r, 200));

  const last = events.at(-1);
  assert.equal(last.state.items.a1.checkedBy, '🦊 Mia');
  assert.equal(last.state.items.a2.vgNum, 4711);
  assert.equal(last.state.items.a2.checked, true);
  assert.deepEqual(last.state.scores, { '🦊 Mia': 1, '🐼 Ben': 1 });
  assert.equal(last.event.kind, 'setnum');

  await post(`/api/lists/${code}/ops`, { type: 'check', id: 'a1', checked: false, user: '🐼 Ben' });
  assert.equal((await get(`/api/lists/${code}`)).scores['🦊 Mia'], 0); // Abzug beim ursprünglichen Abhaker
  reader.cancel();
});

test('add ist idempotent, doppeltes Abhaken zählt nicht doppelt', async () => {
  const { code } = await post('/api/lists');
  const op = { type: 'add', id: 'x', title: 'Apfel', user: 'A' };
  await post(`/api/lists/${code}/ops`, { ops: [op, op] });
  await post(`/api/lists/${code}/ops`, { ops: [{ type: 'check', id: 'x', checked: true, user: 'A' }, { type: 'check', id: 'x', checked: true, user: 'A' }] });
  const l = await get(`/api/lists/${code}`);
  assert.equal(Object.keys(l.items).length, 1);
  assert.equal(l.scores.A, 1);
});

test('Neue Runde und Erledigte entfernen', async () => {
  const { code } = await post('/api/lists');
  await post(`/api/lists/${code}/ops`, { ops: [{ type: 'add', id: 'y', title: 'Käse', user: 'B' }, { type: 'check', id: 'y', checked: true, user: 'B' }, { type: 'clearChecked', user: 'B' }] });
  let l = await get(`/api/lists/${code}`);
  assert.equal(Object.keys(l.items).length, 0);
  assert.equal(l.scores.B, 1);
  await post(`/api/lists/${code}/ops`, { type: 'resetScores', user: 'B' });
  l = await get(`/api/lists/${code}`);
  assert.equal(l.scores.B, 0);
});

test('unbekannte Liste -> 404', async () => {
  assert.equal((await fetch(base + '/api/lists/ZZZZZZ')).status, 404);
});

test('EAN wird am Artikel gespeichert, ungültige verworfen', async () => {
  const { code } = await post('/api/lists');
  await post(`/api/lists/${code}/ops`, { ops: [{ type: 'add', id: 'e1', title: 'Hafermilch', ean: '4056489123456', user: 'A' }, { type: 'add', id: 'e2', title: 'Brot', ean: 'abc', user: 'A' }] });
  const l = await get(`/api/lists/${code}`);
  assert.equal(l.items.e1.ean, '4056489123456');
  assert.equal(l.items.e2.ean, null);
});
