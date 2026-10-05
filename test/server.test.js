import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import WebSocket from 'ws';
import { loadDict, open } from '../server/dict.js';
import { RULES } from '../server/game.js';

let proc, base;

async function spawnServer() {
  const child = spawn('node', ['server/index.js'], { env: { ...process.env, PORT: '0' } });
  const line = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(String(d))));
  return { child, port: line.match(/localhost:(\d+)/)[1] };
}

before(async () => {
  const srv = await spawnServer();
  proc = srv.child;
  base = srv.port;
});
after(() => proc.kill());

// Client WebSocket minimal : garde le dernier instantané et attend des conditions.
function client(port = base) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const c = { ws, snap: null, you: null, err: null, drafts: [], waiters: [] };
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.t === 's') c.snap = m;
    else if (m.t === 'you') c.you = m;
    else if (m.t === 'err') c.err = m;
    else if (m.t === 'd') c.drafts.push(m);
    c.waiters = c.waiters.filter((w) => !w());
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.until = (cond) => new Promise((resolve, reject) => {
    const check = () => (cond(c) ? (resolve(c), true) : false);
    if (check()) return;
    c.waiters.push(check);
    setTimeout(() => reject(new Error('timeout')), 3000).unref();
  });
  return new Promise((resolve) => ws.on('open', () => resolve(c)));
}
const token = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
const get = (path) => new Promise((resolve) => http.get({ port: base, path }, (res) => (res.resume(), resolve(res))));

test('santé et fichiers : pas de sortie du dossier public', async () => {
  assert.equal((await get('/healthz')).statusCode, 200);
  assert.equal((await get('/%2e%2e/package.json')).statusCode, 404);
  assert.equal((await get('/..%2fpackage.json')).statusCode, 404);
  assert.equal((await get('/server/index.js')).statusCode, 404);
});

test('partie complète à deux joueurs réels', async () => {
  const [a, b] = [await client(), await client()];
  const [ta, tb] = [token(), token()];
  await a.until((c) => c.snap); // on voit la table avant de s'asseoir
  assert.equal(a.snap.phase, 'lobby');

  a.send({ t: 'join', token: ta, name: 'Ana' });
  b.send({ t: 'join', token: tb, name: 'Bob' });
  await Promise.all([a, b].map((c) => c.until((x) => x.you && x.snap.players.length === 2)));

  a.send({ t: 'lang', lang: 'en' });
  await b.until((c) => c.snap.lang === 'en');
  b.send({ t: 'start' });
  await a.until((c) => c.snap.phase === 'playing');
  const { prefix, turn } = a.snap;
  assert.equal(prefix.length, 2);

  // la saisie en direct : les autres la voient, pas son auteur ; hors tour, on est ignoré
  const [typer, watcher] = a.you.id === turn ? [a, b] : [b, a];
  watcher.send({ t: 'typing', v: 'zz' });
  typer.send({ t: 'typing', v: 'ab' });
  typer.send({ t: 'typing', v: 'a' });
  await watcher.until((c) => c.drafts.length === 2);
  assert.deepEqual(watcher.drafts.map((d) => d.v), ['ab', 'a']);
  assert.equal(watcher.drafts[0].id, turn);
  assert.equal(typer.drafts.length, 0);

  // le joueur dont ce n'est pas le tour est ignoré
  const [me, other] = a.you.id === turn ? [a, b] : [b, a];
  other.send({ t: 'word', w: 'house' });
  me.send({ t: 'word', w: 'zzzzzz' });
  await me.until((c) => c.snap.ev?.k === 'miss');
  assert.equal(me.snap.left, 4);
  assert.equal(me.snap.ev.why, 'prefix');

  // un vrai mot du dictionnaire anglais qui commence par les bonnes lettres
  const en = loadDict('data/en.txt.gz');
  const w = en.keys.split('\n').find((k) => k.startsWith(prefix) && k.length > 4 && open(en, k.slice(-2), RULES.minLink));
  me.send({ t: 'word', w });
  await other.until((c) => c.snap.ev?.k === 'word');
  assert.equal(other.snap.turn, other.you.id);
  assert.equal(other.snap.prefix, w.slice(-2));
  assert.deepEqual(other.snap.last.at(-1)[0], w);

  me.ws.close(); // un départ ne bloque pas la partie
  other.ws.close();
});

test('jeton invalide ou pseudo vide refusé', async () => {
  const c = await client();
  c.send({ t: 'join', token: 'nope', name: 'X' });
  c.send({ t: 'join', token: token(), name: '   ' });
  await c.until((x) => x.err?.why === 'name');
  assert.equal(c.you, null);
  c.ws.close();
});

test('messages hostiles : le serveur reste debout', async () => {
  const c = await client();
  const t = token();
  c.send({ t: 'join', token: t, name: 'Vilain' });
  await c.until((x) => x.you);
  for (const raw of ['pas du json', '[]', 'null', '42', '{"t":"lang","lang":"__proto__"}', '{"t":"word","w":{"a":1}}', '{"t":"start"}', '{"t":"join","token":{},"name":1}']) c.ws.send(raw);
  c.ws.send('x'.repeat(5000)); // dépasse maxPayload : la connexion est coupée, pas le serveur
  await new Promise((resolve) => c.ws.on('close', resolve));
  assert.equal((await get('/healthz')).statusCode, 200);
  const d = await client();
  await d.until((x) => x.snap);
  assert.ok(['lobby', 'playing'].includes(d.snap.phase));
  d.ws.close();
});

test('mode mix : choisi au salon, la partie démarre avec les quatre langues', async () => {
  const srv = await spawnServer(); // une table vierge, indépendante des autres tests
  try {
    const [a, b] = [await client(srv.port), await client(srv.port)];
    a.send({ t: 'join', token: token(), name: 'Ana' });
    b.send({ t: 'join', token: token(), name: 'Bob' });
    await Promise.all([a, b].map((c) => c.until((x) => x.you && x.snap.players.length === 2)));
    a.send({ t: 'lang', lang: 'mix' });
    await b.until((c) => c.snap.lang === 'mix');
    b.send({ t: 'start' });
    await a.until((c) => c.snap.phase === 'playing');
    assert.equal(a.snap.lang, 'mix');
    assert.equal(a.snap.prefix.length, 2);
    // la partie tourne bien avec le dictionnaire combiné : un mot inconnu est refusé
    const me = a.you.id === a.snap.turn ? a : b;
    me.send({ t: 'word', w: 'zzzz' });
    await me.until((c) => c.snap.ev?.k === 'miss');
    a.ws.close();
    b.ws.close();
  } finally {
    srv.child.kill();
  }
});
