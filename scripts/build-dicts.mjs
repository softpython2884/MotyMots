// Reconstruit data/*.txt.gz depuis les listes sources (réseau + npm requis).
//   fr/en/es : paquets npm "an-array-of-*-words" (MIT)
//   de       : github.com/enz/german-wordlist (CC0)
// Usage : npm run dicts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { norm, MAX_LEN } from '../server/dict.js';

const out = path.join(import.meta.dirname, '..', 'data');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motymots-'));

function npmWords(pkg, file) {
  const tgz = execFileSync('npm', ['pack', pkg, '--silent', '--pack-destination', tmp], { encoding: 'utf8' }).trim().split('\n').pop();
  const json = execFileSync('tar', ['-xOzf', path.join(tmp, tgz), `package/${file}`], { maxBuffer: 1 << 28 });
  return JSON.parse(json);
}

const sources = {
  fr: async () => npmWords('an-array-of-french-words', 'index.json'),
  en: async () => npmWords('an-array-of-english-words', 'index.json'),
  es: async () => npmWords('an-array-of-spanish-words', 'index.json'),
  de: async () => (await (await fetch('https://raw.githubusercontent.com/enz/german-wordlist/master/words')).text()).split('\n'),
};

for (const [lang, load] of Object.entries(sources)) {
  const best = new Map(); // clé -> forme à afficher
  for (const raw of await load()) {
    const w = raw.trim().toLowerCase();
    if (!/^\p{L}+$/u.test(w)) continue; // pas de tirets, apostrophes, espaces
    // alphabet latin uniquement (une fois les accents retirés), sinon norm() mangerait des lettres
    if (!/^[a-zßœæ]+$/.test(w.normalize('NFD').replace(/\p{M}/gu, ''))) continue;
    const key = norm(w);
    if (key.length < 3 || key.length > MAX_LEN) continue;
    if (!best.has(key) || (w === key && best.get(key) !== key)) best.set(key, w);
  }
  const keys = [...best.keys()].sort();
  const canon = keys.filter((k) => best.get(k) !== k).map((k) => `${k}\t${best.get(k)}`);
  const text = `${keys.join('\n')}\n\n${canon.join('\n')}`;
  fs.writeFileSync(path.join(out, `${lang}.txt.gz`), zlib.gzipSync(text, { level: 9 }));
  console.log(lang, keys.length, 'mots,', canon.length, 'accentués,', (text.length / 1e6).toFixed(1), 'Mo');
}
fs.rmSync(tmp, { recursive: true });
