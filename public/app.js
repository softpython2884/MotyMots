// MotyMots, côté navigateur. Le serveur envoie un instantané complet à chaque changement :
// on garde le dernier et on l'affiche. Tout le texte passe par textContent (pas d'innerHTML).

const LANGS = { fr: 'Français', en: 'English', es: 'Español', de: 'Deutsch' };
const $ = (id) => document.getElementById(id);
const node = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const norm = (s) => s.toLowerCase().replace(/ß/g, 'ss').replace(/œ/g, 'oe').replace(/æ/g, 'ae').normalize('NFD').replace(/[^a-z]/g, '');
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

let token = store.get('mm.token');
if (!token) {
  token = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  store.set('mm.token', token);
}
let name = store.get('mm.name') || ''; // pseudo mémorisé : on se rassoit tout seul
let soundOn = store.get('mm.sound') !== '0';

let S = null; // dernier instantané
let me = null; // { id } une fois assis
let skew = 0; // décalage horloge serveur - horloge locale
let connected = false;
let pending = false; // un mot est parti, on attend la réponse
let lastEv = 0;
let joinError = '';
let seatsKey = '';
let clockTimer;
let draftSent = ''; // dernière saisie envoyée aux autres
let draftAt = 0;
let draftTimer;

// ---- réseau ---------------------------------------------------------------------

let ws;
let attempts = 0;
const send = (o) => ws?.readyState === 1 && ws.send(JSON.stringify(o));

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    attempts = 0;
    connected = true;
    $('net').hidden = true;
    if (name) send({ t: 'join', token, name });
    render();
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 's') onSnap(m);
    else if (m.t === 'you') { me = { id: m.id }; render(); }
    else if (m.t === 'd') onDraft(m);
    else if (m.t === 'err') {
      name = '';
      store.del('mm.name');
      joinError = m.why === 'full' ? 'La table est pleine, réessaie plus tard.' : 'Choisis un pseudo (au moins une lettre ou un chiffre).';
      render();
    }
  };
  ws.onclose = () => {
    connected = false;
    $('net').hidden = false;
    render();
    setTimeout(connect, Math.min(5000, 400 * 2 ** attempts++));
  };
}

function onSnap(s) {
  const prev = S;
  S = s;
  skew = s.now - Date.now();
  pending = false;
  render(prev);
}

// Saisie en direct du joueur dont c'est le tour : on la recopie dans le champ (désactivé) des autres.
function onDraft({ id, v }) {
  if (!S || id !== S.turn || (me && me.id === id)) return;
  S.draft = v;
  showDraft();
}

function showDraft() {
  const input = $('word');
  input.value = S.draft || '';
  $('entry').classList.toggle('live', !!S.draft);
}

// Envoie ma saisie aux autres, au plus 10 fois par seconde, en terminant toujours sur la dernière valeur.
function sendDraft() {
  if (!mine()) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const v = $('word').value;
    if (!mine() || v === draftSent) return;
    draftSent = v;
    draftAt = Date.now();
    send({ t: 'typing', v });
  }, Math.max(0, 100 - (Date.now() - draftAt)));
}

// ---- affichage ------------------------------------------------------------------

const mine = () => !!(S && me && connected && S.turn === me.id);

function render(prev = S) {
  if (!S) return;
  const ph = S.phase;
  const byId = new Map(S.players.map((r) => [r[0], r]));
  const turnRow = byId.get(S.turn);
  const iAm = mine();
  const seated = !!me;
  const online = S.players.filter((r) => !(r[3] & 2)).length;

  $('table').dataset.phase = ph;
  $('langTag').hidden = false;
  $('langCode').textContent = S.lang.toUpperCase();
  $('langName').textContent = ` · ${LANGS[S.lang]}`;
  $('leave').hidden = !seated;
  $('stage').classList.toggle('mine', iAm);

  // titre
  $('status').textContent = ph === 'lobby' ? 'Salon' : ph === 'over' ? 'Partie terminée' : iAm ? 'À toi de jouer' : `Au tour de ${turnRow?.[1] ?? '…'}`;
  document.title = iAm ? '▶ À toi ! · MotyMots' : 'MotyMots';

  // sections
  $('secLobby').hidden = ph !== 'lobby' || !seated; // le choix de langue est réservé à ceux qui sont assis
  $('secLast').hidden = ph !== 'playing' || S.total === 0;
  $('secPlay').hidden = ph !== 'playing';
  $('secResult').hidden = ph !== 'over';
  $('join').hidden = seated || !!name;
  $('start').hidden = ph !== 'lobby' || !seated;
  $('again').hidden = ph !== 'over' || !seated;
  if (!prev || prev.phase !== ph) $('rules').open = ph === 'lobby';

  if (ph === 'lobby') renderLobby(seated, online);
  if (ph === 'playing') renderPlay(prev, iAm, turnRow, byId);
  if (ph === 'over') renderResult();
  $('joinHint').textContent = joinError || (ph === 'playing' ? `Une partie est en cours : tu entres en fin de file avec ${plural(S.cfg.lives, 'vie')}.` : 'Pas de compte : juste un pseudo.');

  renderChain(prev);
  renderSeats();
  if (!prev || prev.turn !== S.turn || prev.until !== S.until || prev.phase !== ph) syncClock();

  if (S.ev && S.ev.n !== lastEv) {
    lastEv = S.ev.n;
    if (prev && prev !== S) announce(S.ev);
    else if (!prev) setFeed('', false); // à l'arrivée, on n'annonce pas du vieux
  }
  if (prev && prev !== S && prev.phase === 'playing' && ph === 'over') sfx(S.result?.id === me?.id ? 'win' : 'over');
  if (prev && prev !== S && S.turn !== prev.turn && iAm) sfx('turn');
}

function renderLobby(seated, online) {
  const box = $('langs');
  if (!box.querySelector('label')) {
    for (const [code, label] of Object.entries(LANGS)) {
      const lab = node('label');
      const inp = node('input');
      Object.assign(inp, { type: 'radio', name: 'lang', value: code });
      inp.onchange = () => send({ t: 'lang', lang: code });
      lab.append(inp, node('b', null, code), node('span', null, label));
      box.append(lab);
    }
  }
  box.classList.toggle('locked', !seated);
  for (const inp of box.querySelectorAll('input')) {
    inp.checked = inp.value === S.lang;
    inp.disabled = !seated;
  }
  const enough = online >= S.cfg.minPlayers;
  $('startBtn').disabled = !enough;
  $('startHint').textContent = enough
    ? `${plural(online, 'joueur')} à table. Prêts ?`
    : `Il faut au moins ${S.cfg.minPlayers} joueurs. Partage l’adresse de cette page pour inviter du monde.`;
}

function renderPlay(prev, iAm, turnRow, byId) {
  const input = $('word');
  const newTurn = !prev || prev.turn !== S.turn || prev.phase !== 'playing';

  // dernier mot
  const last = S.last.at(-1);
  if (last) {
    const [w, by] = last;
    $('lastLabel').textContent = `Dernier mot · ${by}`;
    const el = $('lastWord');
    el.replaceChildren(marked(w, false, true));
    el.style.setProperty('--n', [...w].length);
    if (prev && prev.total !== S.total) {
      el.classList.remove('fresh');
      void el.offsetWidth;
      el.classList.add('fresh');
    }
  }

  // lettres imposées
  const st = $('sticker');
  if (st.textContent !== S.prefix.toUpperCase()) {
    st.textContent = S.prefix.toUpperCase();
    st.classList.remove('pop');
    void st.offsetWidth;
    st.classList.add('pop');
  }
  $('fieldLabel').textContent = `Suite du mot qui commence par ${S.prefix.toUpperCase()}`;

  // saisie
  input.disabled = !iAm;
  $('go').disabled = !iAm;
  input.placeholder = iAm ? 'Tape la suite du mot…' : `${turnRow?.[1] ?? '…'} cherche…`;
  if (newTurn) {
    input.value = '';
    draftSent = '';
    clearTimeout(draftTimer);
    if (iAm) input.focus();
  }
  if (!iAm) showDraft(); // les autres regardent taper en direct

  // essais et vies du joueur dont c'est le tour
  const tries = $('tries');
  tries.replaceChildren(...Array.from({ length: S.cfg.tries }, (_, i) => node('i', i < S.left ? '' : 'off')));
  const lives = $('lives');
  const livesLeft = turnRow ? turnRow[2] : S.cfg.lives;
  lives.replaceChildren(...Array.from({ length: S.cfg.lives }, (_, i) => node('i', i < livesLeft ? '' : 'off')));
}

function renderResult() {
  const r = S.result || {};
  const won = me && r.id === me.id;
  $('champ').textContent = r.winner ?? 'Personne';
  $('verdict').textContent = r.winner ? (won ? 'Victoire : c’est toi qui restes debout.' : 'remporte la partie.') : 'Plus personne à table.';
  $('statWords').textContent = r.words ?? 0;
  const lg = $('statLongest');
  lg.replaceChildren();
  if (r.longest) lg.append(r.longest.w, ' ', node('small', null, `par ${r.longest.by}`));
  else lg.append('–');
}

function renderChain(prev) {
  $('chainCount').textContent = S.total || '';
  $('wordsEmpty').hidden = S.total > 0;
  if (prev && prev !== S && prev.total === S.total && $('words').childElementCount) return;
  const fresh = prev && prev !== S && S.total === prev.total + 1;
  const rows = S.last.slice().reverse().map(([w, by], i) => {
    const li = node('li', fresh && i === 0 ? 'fresh' : '');
    const word = node('span', 'w');
    word.append(marked(w, true, true));
    li.append(node('span', 'n', S.total - i), word, node('span', 'by', by));
    return li;
  });
  $('words').replaceChildren(...rows);
}

function renderSeats() {
  const key = JSON.stringify([S.players, S.turn, S.phase, me?.id]);
  if (key === seatsKey) return;
  seatsKey = key;
  $('seatCount').textContent = S.players.length || '';
  $('peopleEmpty').hidden = S.players.length > 0;
  let current;
  const rows = S.players.map(([id, nm, lives, fl, words]) => {
    const cls = [fl & 1 && 'out', fl & 2 && 'off', id === S.turn && 'turn'].filter(Boolean).join(' ');
    const li = node('li', cls);
    const pips = node('span', 'pips');
    for (let i = 0; i < S.cfg.lives; i++) pips.append(node('i', i < lives ? '' : 'off'));
    const who = node('span', 'nm', nm);
    if (me && id === me.id) who.append(node('small', null, 'toi'));
    else if (fl & 2 && !(fl & 1)) who.append(node('small', null, 'absent'));
    li.append(pips, who, node('span', 'ct', S.phase !== 'lobby' && words ? plural(words, 'mot') : ''));
    if (id === S.turn) current = li;
    return li;
  });
  const list = $('people');
  list.replaceChildren(...rows);
  if (current && (current.offsetTop < list.scrollTop || current.offsetTop + current.offsetHeight > list.scrollTop + list.clientHeight)) {
    list.scrollTop = current.offsetTop - list.clientHeight / 2;
  }
}

// Surligne les lettres de liaison d'un mot (début et/ou fin), accents et ß compris.
function marked(word, head, tail) {
  const ch = [...word];
  const n = ch.length;
  const L = S.cfg.link;
  const len = (x, y) => norm(ch.slice(x, y).join('')).length;
  let a = 0;
  let b = n;
  if (head) while (a < n && len(0, a) < L) a++;
  if (tail) while (b > 0 && len(b, n) < L) b--;
  const marks = [];
  if (head) marks.push([0, a]);
  if (tail) marks.push([b, n]);
  if (marks.length === 2 && marks[1][0] <= marks[0][1]) marks.splice(0, 2, [0, n]);
  const f = document.createDocumentFragment();
  let pos = 0;
  for (const [x, y] of marks) {
    if (x > pos) f.append(ch.slice(pos, x).join(''));
    f.append(node('span', 'k', ch.slice(x, y).join('')));
    pos = y;
  }
  if (pos < n) f.append(ch.slice(pos).join(''));
  return f;
}

// ---- horloge --------------------------------------------------------------------

function syncClock() {
  clearInterval(clockTimer);
  const bar = $('bar');
  const clock = $('clock');
  const stage = $('stage');
  if (S.phase !== 'playing' || !S.until) {
    clock.textContent = '';
    stage.classList.remove('low');
    bar.classList.remove('run');
    return;
  }
  const left = () => Math.max(0, S.until - skew - Date.now());
  const tick = () => {
    const s = Math.ceil(left() / 1000);
    clock.textContent = s;
    stage.classList.toggle('low', s <= 8);
  };
  tick();
  clockTimer = setInterval(tick, 250);
  bar.style.setProperty('--from', Math.min(1, left() / (S.dur || S.cfg.turnMs)));
  bar.style.setProperty('--dur', `${left()}ms`);
  bar.classList.remove('run');
  void bar.offsetWidth;
  bar.classList.add('run');
}

// ---- messages -------------------------------------------------------------------

const REASON = {
  short: (w) => `« ${w || '…'} » est trop court (3 lettres minimum).`,
  prefix: (w) => `« ${w} » ne commence pas par ${S.prefix.toUpperCase()}.`,
  used: (w) => `« ${w} » a déjà été joué.`,
  unknown: (w) => `« ${w} » n’est pas dans le dictionnaire.`,
};

function announce(e) {
  const you = !!me && e.id === me.id;
  const left = S.left;
  const rest = you ? `Il te reste ${plural(left, 'essai')}.` : `Encore ${plural(left, 'essai')}.`;
  let text = '';
  let bad = false;

  if (e.k === 'join') text = `${e.who} prend place.`;
  else if (e.k === 'leave') text = `${e.who} quitte la table.`;
  else if (e.k === 'start') text = `C’est parti ! Lettres de départ : ${S.prefix.toUpperCase()}.`;
  else if (e.k === 'word') {
    text = you ? 'Bien joué.' : `${e.who} joue ${e.w.toUpperCase()}.`;
    sfx('ok');
  } else if (e.k === 'miss') {
    text = `${you ? '' : `${e.who} : `}${REASON[e.why](e.w)} ${rest}`;
    bad = you;
    if (you) fail();
  } else if (e.k === 'dead') {
    text = `${you ? '' : `${e.who} : `}impasse, plus aucun mot ne commence par ${e.why.toUpperCase()}. Essai non décompté.`;
    bad = you;
    if (you) fail();
  } else if (e.k === 'life' || e.k === 'out') {
    const why = e.why === 'tries' ? `${REASON[e.miss](e.w)} ` : '';
    const base = {
      time: you ? 'Temps écoulé : tu perds une vie.' : `${e.who} n’a pas joué à temps : une vie en moins.`,
      tries: you ? 'Plus d’essais : tu perds une vie.' : `${e.who} n’a plus d’essais : une vie en moins.`,
      away: you ? 'Tu étais absent : tu perds une vie.' : `${e.who} a décroché : une vie en moins.`,
    }[e.why];
    text = why + base + (e.k === 'out' ? (you ? ' C’était ta dernière : tu sors de la partie.' : ` ${e.who} sort de la partie.`) : '');
    bad = you;
    sfx('life');
  }
  setFeed(text, bad);
}

function setFeed(text, bad) {
  const f = $('feed');
  f.textContent = text;
  f.classList.toggle('bad', bad);
}

function fail() {
  sfx('bad');
  const entry = $('entry');
  entry.classList.remove('shake');
  void entry.offsetWidth;
  entry.classList.add('shake');
  $('word').select();
}

// ---- sons (synthétisés, aucun fichier) ----------------------------------------------

const NOTES = {
  turn: [['triangle', 0.07, [[660, 0.12, 0], [880, 0.2, 0.1]]]],
  ok: [['triangle', 0.04, [[520, 0.08, 0]]]],
  bad: [['sawtooth', 0.04, [[150, 0.2, 0]]]],
  life: [['triangle', 0.07, [[320, 0.14, 0], [210, 0.3, 0.12]]]],
  win: [['triangle', 0.07, [[523, 0.15, 0], [659, 0.15, 0.12], [784, 0.15, 0.24], [1047, 0.4, 0.36]]]],
  over: [['triangle', 0.06, [[392, 0.2, 0], [294, 0.4, 0.18]]]],
};
let audio;
function sfx(kind) {
  if (!soundOn) return;
  try {
    audio ||= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
    const t0 = audio.currentTime;
    for (const [type, gain, notes] of NOTES[kind]) {
      for (const [freq, dur, at] of notes) {
        const o = audio.createOscillator();
        const g = audio.createGain();
        o.type = type;
        o.frequency.value = freq;
        g.gain.setValueAtTime(gain, t0 + at);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
        o.connect(g).connect(audio.destination);
        o.start(t0 + at);
        o.stop(t0 + at + dur + 0.02);
      }
    }
  } catch {}
}

// ---- actions --------------------------------------------------------------------

$('join').onsubmit = (e) => {
  e.preventDefault();
  const v = $('name').value.trim();
  if (!v) return $('name').focus();
  name = v;
  joinError = '';
  store.set('mm.name', v);
  send({ t: 'join', token, name: v });
  render();
};

$('entry').onsubmit = (e) => {
  e.preventDefault();
  if (!mine() || pending) return;
  const typed = $('word').value.replace(/[^\p{L}]/gu, '');
  if (!typed) return fail();
  // on tolère qu'on retape le mot en entier (lettres imposées comprises)
  const n = norm(typed);
  const full = n.startsWith(S.prefix) && n.length > S.prefix.length ? typed : S.prefix + typed;
  pending = true;
  send({ t: 'word', w: full });
};
$('word').oninput = (e) => {
  e.target.value = e.target.value.replace(/[^\p{L}]/gu, '');
  sendDraft();
};

$('startBtn').onclick = () => send({ t: 'start' });
$('again').onclick = () => send({ t: 'start' });
$('leave').onclick = () => {
  send({ t: 'leave' });
  me = null;
  name = '';
  store.del('mm.name');
  setFeed('', false);
  render();
};
$('sound').onclick = () => {
  soundOn = !soundOn;
  store.set('mm.sound', soundOn ? '1' : '0');
  $('sound').setAttribute('aria-pressed', soundOn);
  if (soundOn) sfx('ok');
};
$('sound').setAttribute('aria-pressed', soundOn);

connect();
