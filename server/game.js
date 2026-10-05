// Règles et état de la partie : une seule table, une seule partie à la fois.
// Aucun réseau ici : index.js branche les sockets et relaie les instantanés.
import { LANGS, LINK, MAX_LEN, norm, has, show, open, randomStart } from './dict.js';

export const RULES = {
  lives: 3,
  tries: 5,
  turnMs: 30_000, // temps par tour
  awayMs: 5_000, // temps accordé à un joueur déconnecté
  overMs: 20_000, // affichage du résultat avant retour au salon
  purgeMs: 30_000, // un déconnecté hors partie quitte la table après ça
  minPlayers: 2,
  maxPlayers: 2000,
  minLen: 3,
  minLink: 30, // une fin de mot doit ouvrir au moins N mots, sinon c'est une impasse
  startMin: 200, // les lettres de départ doivent ouvrir au moins N mots
};

export const cleanName = (s) =>
  [...String(s).normalize('NFC').replace(/[\p{C}\s]+/gu, ' ').trim()].slice(0, 16).join('').trim();

const letters = (s) => [...String(s).toLowerCase()].filter((c) => /\p{L}/u.test(c)).slice(0, MAX_LEN).join('');

export class Game {
  constructor(getDict, onChange, opts = {}) {
    this.getDict = getDict;
    this.onChange = onChange;
    this.r = { ...RULES, ...opts };
    this.players = new Map(); // jeton secret -> joueur
    this.nextId = 1;
    this.seq = 0;
    this.evSeq = 0;
    this.lang = 'fr';
    this.timer = this.overTimer = null;
    this.toLobby();
  }

  // ---- table ----------------------------------------------------------------

  join(token, rawName) {
    let p = this.players.get(token);
    if (p) {
      p.online = true;
      if (this.turn === p) this.until = this.fullUntil; // retour pendant son tour : on rend le temps
      this.arm();
    } else {
      const name = this.uniqueName(cleanName(rawName));
      if (!name) return { error: 'name' };
      if (this.players.size >= this.r.maxPlayers) return { error: 'full' };
      p = { id: this.nextId++, name, lives: this.r.lives, out: false, online: true, words: 0, offAt: 0 };
      this.players.set(token, p);
      if (this.phase === 'playing') this.queue.push(p); // on peut rejoindre en cours de route
      this.say({ k: 'join', id: p.id, who: p.name });
    }
    this.emit();
    return p;
  }

  disconnect(token) {
    const p = this.players.get(token);
    if (!p) return;
    p.online = false;
    p.offAt = Date.now();
    if (this.turn === p) {
      this.until = Math.min(this.until, Date.now() + this.r.awayMs);
      this.arm();
    }
    this.emit();
  }

  leave(token) {
    const p = this.players.get(token);
    if (!p) return;
    this.say({ k: 'leave', id: p.id, who: p.name });
    this.players.delete(token);
    if (this.phase === 'playing' && this.queue.includes(p)) this.drop(p);
    this.emit();
  }

  // Ménage : les déconnectés qui ne jouent plus quittent la table.
  sweep() {
    const now = Date.now();
    let changed = false;
    for (const [token, p] of this.players) {
      if (p.online || now - p.offAt < this.r.purgeMs) continue;
      if (this.phase === 'playing' && this.queue.includes(p)) continue;
      this.players.delete(token);
      changed = true;
    }
    if (changed) this.emit();
  }

  setLang(lang) {
    if (this.phase === 'playing' || !Object.hasOwn(LANGS, lang) || lang === this.lang) return;
    this.lang = lang;
    this.emit();
  }

  // ---- partie ---------------------------------------------------------------

  start(token) {
    const crew = [...this.players.values()].filter((p) => p.online);
    if (!this.players.has(token) || this.phase === 'playing' || crew.length < this.r.minPlayers) return;
    for (const [t, p] of this.players) if (!p.online) this.players.delete(t);
    this.resetRound();
    this.dict = this.getDict(this.lang);
    this.prefix = randomStart(this.dict, this.r.startMin);
    this.brk = true;
    this.queue = shuffle(crew);
    this.phase = 'playing';
    clearTimeout(this.overTimer);
    this.say({ k: 'start' });
    this.beginTurn();
    this.emit();
  }

  submit(token, raw) {
    const p = this.players.get(token);
    if (this.phase !== 'playing' || !p || this.turn !== p) return;
    const typed = letters(raw);
    const key = norm(typed);
    const miss = (why) => {
      this.say({ k: 'miss', id: p.id, who: p.name, w: typed, why });
      if (--this.left <= 0) this.lose(p, 'tries', { w: typed, miss: why }); // le dernier refus reste visible
    };

    if (key.length < this.r.minLen) miss('short');
    else if (!key.startsWith(this.prefix)) miss('prefix');
    else if (this.used.has(key)) miss('used');
    else if (key.length > MAX_LEN || !has(this.dict, key)) miss('unknown');
    else if (!open(this.dict, key.slice(-LINK), this.r.minLink)) {
      // impasse : refusé, mais l'essai n'est pas décompté
      this.say({ k: 'dead', id: p.id, who: p.name, w: show(this.dict, key), why: key.slice(-LINK) });
    } else {
      const w = show(this.dict, key);
      this.used.add(key);
      this.chain.push({ w, by: p.name, brk: this.brk });
      this.brk = false;
      this.prefix = key.slice(-LINK);
      p.words++;
      this.queue.push(this.queue.shift());
      this.say({ k: 'word', id: p.id, who: p.name, w });
      this.beginTurn();
    }
    this.emit();
  }

  // Ce que tape le joueur dont c'est le tour, vu en direct par les autres.
  // Renvoie { id, v } à relayer, ou null si rien n'a changé / ce n'est pas son tour.
  typing(token, raw) {
    const p = this.players.get(token);
    if (this.phase !== 'playing' || !p || this.turn !== p) return null;
    const v = letters(raw);
    if (v === this.draft) return null;
    this.draft = v;
    return { id: p.id, v };
  }

  // Le temps du tour est écoulé (appelé par le minuteur).
  expire() {
    if (this.phase !== 'playing') return;
    this.lose(this.turn, this.turn.online ? 'time' : 'away');
    this.emit();
  }

  // ---- internes -------------------------------------------------------------

  resetRound() {
    for (const p of this.players.values()) Object.assign(p, { lives: this.r.lives, out: false, words: 0 });
    this.result = null;
    this.brk = false; // vrai tant que les lettres imposées ont été tirées au sort plutôt que tirées du dernier mot
    this.chain = [];
    this.used = new Set();
    this.queue = [];
    this.prefix = '';
    this.turn = null;
    this.left = 0;
    this.draft = '';
    this.until = this.fullUntil = 0;
  }

  beginTurn() {
    this.turn = this.queue[0];
    this.left = this.r.tries;
    this.draft = '';
    this.fullUntil = Date.now() + this.r.turnMs;
    this.until = this.turn.online ? this.fullUntil : Date.now() + this.r.awayMs;
    this.arm();
  }

  arm() {
    clearTimeout(this.timer);
    if (this.phase !== 'playing') return;
    this.timer = setTimeout(() => this.expire(), Math.max(0, this.until - Date.now()));
    this.timer.unref?.();
  }

  lose(p, why, extra) {
    p.lives--;
    p.out = p.lives <= 0;
    this.say({ ...extra, k: p.out ? 'out' : 'life', id: p.id, who: p.name, why });
    this.queue.shift();
    if (!p.out) this.queue.push(p);
    this.afterQueueChange();
  }

  // Un joueur sort de la file en plein jeu.
  drop(p) {
    const wasTurn = this.turn === p;
    this.queue = this.queue.filter((q) => q !== p);
    if (this.queue.length <= 1) this.endGame();
    else if (wasTurn) this.beginTurn();
  }

  // Quelqu'un a raté (temps ou essais) : le suivant repart de nouvelles lettres, tirées au sort.
  afterQueueChange() {
    if (this.queue.length <= 1) return this.endGame();
    this.redraw();
    this.beginTurn();
  }

  redraw() {
    let next = this.prefix;
    for (let i = 0; i < 10 && next === this.prefix; i++) next = randomStart(this.dict, this.r.startMin);
    this.prefix = next;
    this.brk = true;
  }

  endGame() {
    clearTimeout(this.timer);
    this.phase = 'over';
    this.turn = null;
    this.until = 0;
    const winner = this.queue[0] || null;
    let longest = null;
    for (const c of this.chain) if (!longest || c.w.length > longest.w.length) longest = c;
    this.result = { id: winner?.id ?? 0, winner: winner?.name ?? null, words: this.chain.length, longest };
    this.overTimer = setTimeout(() => this.toLobby(), this.r.overMs);
    this.overTimer.unref?.();
  }

  toLobby() {
    clearTimeout(this.timer);
    clearTimeout(this.overTimer);
    for (const [t, p] of this.players) if (!p.online) this.players.delete(t);
    this.phase = 'lobby';
    this.ev = null;
    this.resetRound();
    this.emit();
  }

  // Dernier évènement, avec un numéro stable (les clients s'en servent pour ne l'annoncer qu'une fois).
  say(ev) {
    this.ev = { ...ev, n: ++this.evSeq };
  }

  uniqueName(base) {
    if (!base) return '';
    const taken = new Set([...this.players.values()].map((p) => p.name.toLowerCase()));
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base.slice(0, 13)} ${n}`;
    return name;
  }

  // ---- instantané envoyé à tout le monde -----------------------------------------

  snapshot() {
    const all = [...this.players.values()];
    const row = (p) => [p.id, p.name, p.lives, (p.out ? 1 : 0) | (p.online ? 0 : 2), p.words];
    return {
      t: 's',
      seq: ++this.seq,
      now: Date.now(),
      phase: this.phase,
      lang: this.lang,
      cfg: { lives: this.r.lives, tries: this.r.tries, turnMs: this.r.turnMs, minPlayers: this.r.minPlayers, link: LINK },
      prefix: this.prefix,
      fresh: this.brk,
      last: this.chain.slice(-40).map((c) => [c.w, c.by, c.brk ? 1 : 0]),
      total: this.chain.length,
      turn: this.turn?.id ?? 0,
      left: this.left,
      draft: this.draft,
      until: this.until,
      dur: this.fullUntil && this.until ? this.r.turnMs : 0,
      players: [...all.filter((p) => !p.out), ...all.filter((p) => p.out)].map(row),
      ev: this.ev,
      result: this.result,
    };
  }

  emit() {
    this.json = JSON.stringify(this.snapshot());
    this.onChange?.(this.json);
  }
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
