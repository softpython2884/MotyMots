// Serveur : fichiers statiques + une WebSocket (/ws). Tout le jeu est dans game.js.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { Game } from './game.js';
import { loadDict } from './dict.js';

const ROOT = path.join(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;

// Un dictionnaire n'est chargé (et gardé) qu'à la première partie dans sa langue.
const dicts = {};
const getDict = (lang) => (dicts[lang] ??= loadDict(path.join(ROOT, 'data', `${lang}.txt.gz`)));

const send = (ws, data) => ws.readyState === 1 && ws.bufferedAmount < 1e6 && ws.send(data);
const wss = new WebSocketServer({ noServer: true, maxPayload: 512 });
const game = new Game(getDict, (json) => wss.clients.forEach((ws) => send(ws, json)));
const conns = new Map(); // jeton -> sockets ouverts (plusieurs onglets possibles)

// ---- HTTP -------------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};
const CSP = "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/healthz') return void res.end('ok');
  let file;
  try {
    file = path.join(PUBLIC, pathname === '/' ? 'index.html' : decodeURIComponent(pathname));
  } catch {
    file = '';
  }
  fs.stat(file, (err, st) => {
    if (!file.startsWith(PUBLIC + path.sep) || err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return void res.end('Introuvable');
    }
    const etag = `W/"${st.size}-${Math.round(st.mtimeMs)}"`;
    const headers = {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': file.endsWith('.woff2') ? 'public, max-age=31536000, immutable' : 'no-cache',
      etag,
      'x-content-type-options': 'nosniff',
      'content-security-policy': CSP,
    };
    if (req.headers['if-none-match'] === etag) return void res.writeHead(304, headers).end();
    res.writeHead(200, { ...headers, 'content-length': st.size });
    fs.createReadStream(file).pipe(res);
  });
});

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

// ---- WebSocket --------------------------------------------------------------------

const TOKEN = /^[a-f0-9-]{16,64}$/;

wss.on('connection', (ws) => {
  ws.alive = true;
  ws.token = null;
  ws.budget = 20; // anti-flood : ~20 messages/s
  ws.stamp = Date.now();
  ws.on('pong', () => (ws.alive = true));
  ws.on('error', () => {});
  send(ws, game.json); // on regarde la table avant de s'y asseoir

  ws.on('message', (data) => {
    const now = Date.now();
    ws.budget = Math.min(20, ws.budget + (now - ws.stamp) / 50);
    ws.stamp = now;
    if (ws.budget < 1) return;
    ws.budget--;

    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    try {
      handle(ws, m);
    } catch (err) {
      console.error('message ignoré :', err); // un message louche ne doit jamais faire tomber la table
    }
  });

  function handle(ws, m) {
    if (m.t === 'join') {
      if (typeof m.token !== 'string' || !TOKEN.test(m.token) || (ws.token && ws.token !== m.token)) return;
      const p = game.join(m.token, m.name);
      if (p.error) return send(ws, JSON.stringify({ t: 'err', why: p.error }));
      ws.token = m.token;
      if (!conns.has(m.token)) conns.set(m.token, new Set());
      conns.get(m.token).add(ws);
      return send(ws, JSON.stringify({ t: 'you', id: p.id }));
    }
    if (!ws.token) return;
    if (m.t === 'word' && typeof m.w === 'string') game.submit(ws.token, m.w.slice(0, 64));
    else if (m.t === 'typing' && typeof m.v === 'string') {
      const d = game.typing(ws.token, m.v.slice(0, 64));
      if (d) {
        const msg = JSON.stringify({ t: 'd', ...d }); // quelques octets, pas un instantané complet
        for (const other of wss.clients) if (other !== ws) send(other, msg);
      }
    } else if (m.t === 'lang') game.setLang(m.lang);
    else if (m.t === 'start') game.start(ws.token);
    else if (m.t === 'leave') {
      detach(ws);
      game.leave(ws.token);
      ws.token = null;
    }
  }

  ws.on('close', () => {
    const token = ws.token;
    if (token && detach(ws) === 0) game.disconnect(token);
  });
});

// retire le socket du jeton ; renvoie le nombre de sockets restants
function detach(ws) {
  const set = conns.get(ws.token);
  set?.delete(ws);
  if (set && !set.size) conns.delete(ws.token);
  return set?.size ?? 0;
}

// Heartbeat (connexions mortes) + ménage de la table.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) ws.terminate();
    else {
      ws.alive = false;
      ws.ping();
    }
  }
}, 30_000).unref();
setInterval(() => game.sweep(), 15_000).unref();

server.listen(PORT, () => console.log(`MotyMots → http://localhost:${server.address().port}`));
process.on('SIGTERM', () => process.exit(0));
