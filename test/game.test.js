import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Game, cleanName } from '../server/game.js';
import { norm, fromText, has, show, open, loadDict, combine, randomStart } from '../server/dict.js';

// Mini dictionnaire : chaque fin de mot ouvre au moins un mot, sauf "ux".
const WORDS = ['maison', 'onde', 'dentelle', 'lecture', 'reste', 'tente', 'teste', 'ete', 'tenue', 'chaux', 'uxer', 'mare', 'rende'];
const dict = fromText(`${WORDS.join('\n')}\n\nete\tété`);

function table(names = ['Ana', 'Bob'], opts = {}) {
  const g = new Game(() => dict, null, { minLink: 1, startMin: 1, ...opts });
  const tokens = names.map((n) => {
    const t = `tok-${n}`;
    g.join(t, n);
    return t;
  });
  return { g, tokens };
}
const tokenOf = (g, p) => [...g.players.entries()].find(([, q]) => q === p)[0];
const play = (g, word) => g.submit(tokenOf(g, g.turn), word);

function begin(opts) {
  const t = table(['Ana', 'Bob', 'Cat'], opts);
  t.g.start(t.tokens[0]);
  t.g.prefix = 'ma'; // lettres de départ imposées pour le test
  return t.g;
}

test('norm : accents, ß, œ, ñ et ponctuation', () => {
  assert.equal(norm('Été'), 'ete');
  assert.equal(norm('Straße'), 'strasse');
  assert.equal(norm('cœur'), 'coeur');
  assert.equal(norm('niño'), 'nino');
  assert.equal(norm("l'eau-de-vie"), 'leaudevie');
});

test('dictionnaire : recherche exacte et forme accentuée', () => {
  assert.ok(has(dict, 'maison'));
  assert.ok(!has(dict, 'mais')); // pas de faux positif sur un préfixe
  assert.ok(!has(dict, 'aison')); // ni sur un suffixe
  assert.equal(show(dict, 'ete'), 'été');
  assert.equal(show(dict, 'maison'), 'maison');
  assert.ok(open(dict, 'on', 1) && !open(dict, 'zz', 1));
});

test('dictionnaires combinés : un mot est bon s’il existe dans l’un des deux', () => {
  const a = fromText('maison\nchat');
  const b = fromText('haus\nmaus\n\nhaus\thaüs');
  const d = combine([a, b]);
  assert.ok(has(d, 'maison') && has(d, 'haus') && !has(d, 'zzz'));
  assert.equal(show(d, 'haus'), 'haüs');
  assert.equal(show(d, 'chat'), 'chat');
  assert.equal(d.size, 4);
  assert.equal(d.links.get('ma'), 2); // maison + maus
  assert.ok(open(d, 'ma', 2) && !open(d, 'ma', 3));
  for (let i = 0; i < 20; i++) assert.ok(open(d, randomStart(d, 1), 1));
});

test('noms propres : acceptés, mais ils ne rouvrent pas les impasses', () => {
  const names = fromText('ntcheu\nntungamo');
  names.proper = true;
  const d = combine([fromText('maison\nchat'), names]);
  assert.ok(has(d, 'ntcheu')); // on peut jouer une ville
  assert.ok(!open(d, 'nt', 1)); // mais "-nt" reste une impasse
  assert.ok(open(d, 'ma', 1));
  assert.equal(d.size, 4);
});

test('pseudos : nettoyés et dédoublonnés', () => {
  assert.equal(cleanName('  Léa \n  Dupont  '), 'Léa Dupont');
  assert.equal(cleanName('x'.repeat(40)).length, 16);
  const { g } = table(['Ana', 'ana', 'ANA']);
  assert.deepEqual([...g.players.values()].map((p) => p.name), ['Ana', 'ana 2', 'ANA 3']);
  assert.deepEqual(g.join('t', '   '), { error: 'name' });
});

test('langue : les 4 langues et le mode mix, rien d’autre', () => {
  const { g } = table();
  for (const bad of ['__proto__', 'constructor', 'toString', 'xx', 42, null]) g.setLang(bad);
  assert.equal(g.lang, 'fr');
  g.setLang('de');
  assert.equal(g.lang, 'de');
  g.setLang('mix');
  assert.equal(g.lang, 'mix');
});

test('il faut 2 joueurs connectés pour lancer', () => {
  const { g, tokens } = table(['Solo']);
  g.start(tokens[0]);
  assert.equal(g.phase, 'lobby');
  const t2 = table(['A', 'B']);
  t2.g.start(t2.tokens[0]);
  assert.equal(t2.g.phase, 'playing');
});

test('un mot valide enchaîne : nouvelles lettres, tour suivant, mot grillé', () => {
  const g = begin();
  const first = g.turn;
  play(g, 'Maison');
  assert.equal(g.prefix, 'on');
  assert.notEqual(g.turn, first);
  assert.equal(first.words, 1);
  assert.deepEqual(g.chain.map((c) => c.w), ['maison']);
  const t = g.turn;
  play(g, 'maison'); // déjà joué (et ne commence pas par "on")
  assert.equal(g.turn, t);
  assert.equal(g.left, 4);
  play(g, 'onde');
  assert.equal(g.prefix, 'de');
});

test('saisie en direct : seul le joueur dont c’est le tour, lettres seulement, remise à zéro au tour suivant', () => {
  const g = begin();
  const p = g.turn;
  const mine = tokenOf(g, p);
  const other = [...g.players.entries()].find(([, q]) => q !== p)[0];
  assert.deepEqual(g.typing(mine, 'Ison!'), { id: p.id, v: 'ison' });
  assert.equal(g.typing(mine, 'ison'), null); // inchangé : rien à relayer
  assert.equal(g.typing(other, 'zzz'), null); // pas son tour
  g.emit();
  assert.equal(JSON.parse(g.json).draft, 'ison'); // un nouvel arrivant voit déjà la saisie
  assert.deepEqual(g.typing(mine, ''), { id: p.id, v: '' }); // effacer se voit aussi
  g.typing(mine, 'ison');
  play(g, 'maison');
  assert.equal(g.draft, ''); // tour suivant : on repart de zéro
  assert.equal(g.typing(mine, 'x'), null);
});

test('les accents sont facultatifs à la saisie et restitués à l’affichage', () => {
  const g = begin();
  g.prefix = 'et';
  play(g, 'ete');
  assert.equal(g.chain[0].w, 'été');
  assert.equal(g.prefix, 'te');
});

test('chaque refus coûte un essai ; au 5e, une vie en moins et au suivant', () => {
  const g = begin();
  const p = g.turn;
  for (const bad of ['ab', 'zzzzzz', 'onde', 'mmmm', 'maaaa']) play(g, bad);
  assert.equal(p.lives, 2);
  assert.notEqual(g.turn, p);
  assert.equal(g.left, g.r.tries);
  assert.equal(g.ev.k, 'life');
  assert.equal(g.ev.why, 'tries');
  assert.equal(g.ev.miss, 'unknown'); // la raison du dernier refus n'est pas perdue
  assert.notEqual(g.prefix, 'ma'); // quelqu'un a raté : nouvelles lettres pour le suivant
  assert.deepEqual(g.chain, []); // la chaîne, elle, n'a pas bougé
});

test('quelqu’un rate : nouvelles lettres tirées au sort, la chaîne marque la reprise', () => {
  const g = begin();
  play(g, 'maison');
  assert.equal(g.prefix, 'on');
  assert.equal(JSON.parse(g.json).fresh, false); // les lettres viennent du dernier mot
  const random = Math.random;
  Math.random = () => 0; // le tirage retombe sur le premier mot du dictionnaire : "ma"
  try {
    g.expire(); // le suivant n'a pas joué à temps
  } finally {
    Math.random = random;
  }
  assert.equal(g.prefix, 'ma');
  assert.equal(JSON.parse(g.json).fresh, true); // lettres tirées au sort : le dernier mot ne leur est plus lié
  assert.deepEqual(g.chain.map((c) => c.w), ['maison']); // les mots déjà joués restent
  play(g, 'mare');
  assert.equal(JSON.parse(g.json).fresh, false);
  assert.deepEqual(JSON.parse(g.json).last.map((c) => c[2]), [1, 1]); // 1er mot de la partie, puis reprise après l'échec
  play(g, 'rende');
  assert.deepEqual(JSON.parse(g.json).last.map((c) => c[2]), [1, 1, 0]); // enchaîné normalement
});

test('un simple mot refusé ne change pas les lettres', () => {
  const g = begin();
  play(g, 'zzzzz');
  assert.equal(g.prefix, 'ma');
  assert.equal(g.left, 4);
});

test('raisons de refus', () => {
  const g = begin();
  const why = (w) => (play(g, w), g.ev.why);
  assert.equal(why('ma'), 'short');
  assert.equal(why('tente'), 'prefix');
  assert.equal(why('mazout'), 'unknown');
});

test('impasse : refusée sans coûter d’essai', () => {
  const g = begin({ minLink: 2 }); // "ux" n'ouvre qu'un seul mot
  g.prefix = 'ch';
  play(g, 'chaux');
  assert.equal(g.ev.k, 'dead');
  assert.equal(g.ev.why, 'ux');
  assert.equal(g.left, g.r.tries);
  assert.equal(g.prefix, 'ch');
});

test('temps écoulé : une vie ; à 0 vie on sort ; le dernier debout gagne', () => {
  const t = table(['Ana', 'Bob']);
  const g = t.g;
  g.start(t.tokens[0]);
  const [a, b] = [...g.queue];
  for (let i = 0; i < 3; i++) g.expire(); // a perd, puis b, puis a...
  assert.equal(a.lives, 1);
  assert.equal(b.lives, 2);
  g.expire(); // b
  g.expire(); // a -> 0
  assert.ok(a.out);
  assert.equal(g.phase, 'over');
  assert.equal(g.result.winner, b.name);
  assert.equal(g.turn, null);
});

test('rejoindre en cours de partie : en fin de file avec toutes ses vies', () => {
  const g = begin();
  const before = g.queue.length;
  const p = g.join('late', 'Dan');
  assert.equal(g.queue.length, before + 1);
  assert.equal(g.queue.at(-1), p);
  assert.equal(p.lives, 3);
});

test('déconnexion pendant son tour : délai réduit ; retour : délai rendu', () => {
  const g = begin();
  const p = g.turn;
  const full = g.fullUntil;
  g.disconnect(tokenOf(g, p));
  assert.ok(g.until <= Date.now() + g.r.awayMs);
  g.join(tokenOf(g, p), 'peu importe');
  assert.equal(g.until, full);
  g.disconnect(tokenOf(g, p));
  g.expire();
  assert.equal(g.ev.why, 'away');
});

test('quitter en plein tour : le tour passe ; à deux, l’autre gagne', () => {
  const g = begin();
  const [a, b, c] = [...g.queue];
  g.leave(tokenOf(g, a));
  assert.equal(g.turn, b);
  g.leave(tokenOf(g, c));
  assert.equal(g.phase, 'over');
  assert.equal(g.result.winner, b.name);
});

test('retour au salon : les déconnectés partent, les vies reviennent', () => {
  const g = begin({ overMs: 5 });
  const [, b, c] = [...g.queue];
  g.disconnect(tokenOf(g, c));
  g.leave(tokenOf(g, b));
  while (g.phase === 'playing') g.expire(); // le déconnecté et le restant se font éliminer à tour de rôle
  assert.equal(g.phase, 'over');
  g.toLobby();
  assert.equal(g.phase, 'lobby');
  assert.equal(g.players.size, 1);
  assert.equal([...g.players.values()][0].lives, 3);
});

test('instantané : compact et sans secrets', () => {
  const g = begin();
  const s = JSON.parse(g.json);
  assert.equal(s.phase, 'playing');
  assert.equal(s.players.length, 3);
  assert.ok(!g.json.includes('tok-'));
  assert.ok(g.json.length < 800);
});

test('vrais dictionnaires', { skip: !fs.existsSync('data/fr.txt.gz') }, () => {
  const fr = loadDict('data/fr.txt.gz');
  assert.ok(fr.size > 250_000);
  assert.ok(has(fr, 'maison') && has(fr, 'ete') && !has(fr, 'xqzvw'));
  assert.equal(show(fr, 'ete'), 'été');
  assert.ok(open(fr, 'on', 8) && !open(fr, 'nt', 8)); // "-nt" : impasse
  const de = loadDict('data/de.txt.gz');
  assert.equal(show(de, 'strasse'), 'straße');
  const es = loadDict('data/es.txt.gz');
  assert.equal(show(es, 'nino'), 'niño');
  assert.ok(has(loadDict('data/en.txt.gz'), 'house'));
});

test('vrais dictionnaires : prénoms, pays, villes, mots composés', { skip: !fs.existsSync('data/names.txt.gz') }, () => {
  const names = loadDict('data/names.txt.gz', true);
  const [fr, en, es, de] = ['fr', 'en', 'es', 'de'].map((l) => loadDict(`data/${l}.txt.gz`));
  const french = combine([fr, names]);
  for (const w of ['marie', 'lea', 'mohamed', 'kevin', 'zinedine']) assert.ok(has(french, w), `prénom ${w}`);
  for (const w of ['france', 'allemagne', 'etatsunis', 'cotedivoire', 'europe', 'japonais']) assert.ok(has(french, w), `pays/langue ${w}`);
  for (const w of ['paris', 'londres', 'marseille', 'newyork']) assert.ok(has(french, w), `ville ${w}`);
  for (const w of ['portemonnaie', 'abatjour', 'peutetre', 'aujourdhui']) assert.ok(has(french, w), `composé ${w}`);
  assert.equal(show(french, 'etatsunis'), 'états-unis');
  assert.ok(!has(french, 'germany'), 'pays en anglais : pas dans le dictionnaire français');
  const mix = combine([fr, en, es, de, names]);
  for (const w of ['germany', 'alemania', 'deutschland', 'allemagne', 'maison', 'house', 'casa', 'haus']) assert.ok(has(mix, w), `mix ${w}`);
  assert.ok(!has(mix, 'qxzvw'));
  assert.ok(open(mix, 'on', 30) && !open(mix, 'nt', 30));
  // les 172 préfixes que les villes rouvriraient en français restent fermés
  for (const p of ['nt', 'ez', 'ts', 'sz', 'ds']) assert.ok(!open(french, p, 30), `impasse ${p} (fr + noms propres)`);
});

test('mode mix : un mot de chacune des quatre langues, un prénom ou une ville sont acceptés', { skip: !fs.existsSync('data/names.txt.gz') }, () => {
  const [fr, en, es, de] = ['fr', 'en', 'es', 'de'].map((l) => loadDict(`data/${l}.txt.gz`));
  const names = loadDict('data/names.txt.gz', true);
  const mix = combine([fr, en, es, de, names]);
  for (const w of ['maison', 'house', 'casa', 'haus', 'paris', 'zinedine']) {
    const g = new Game(() => mix, null);
    g.join('a', 'Ana');
    g.join('b', 'Bob');
    g.start('a');
    g.prefix = w.slice(0, 2);
    play(g, w);
    assert.deepEqual(g.chain.map((c) => c.w), [w], `« ${w} » devrait être accepté`);
  }
  // en mode français seul, un mot anglais est refusé
  const g = new Game(() => combine([fr, names]), null);
  g.join('a', 'Ana');
  g.join('b', 'Bob');
  g.start('a');
  g.prefix = 'ho';
  play(g, 'house');
  assert.equal(g.ev.why, 'unknown');
});
