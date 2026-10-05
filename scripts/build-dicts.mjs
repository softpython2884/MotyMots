// Reconstruit data/*.txt.gz depuis les listes sources (réseau, npm et unzip requis ; Node avec ICU complet).
//
//   fr, en, es : paquets npm "an-array-of-*-words" (MIT), + pays, continents et langues (Intl.DisplayNames)
//   de         : github.com/enz/german-wordlist (CC0), + pays, continents et langues (Intl.DisplayNames)
//   names      : noms propres communs à toutes les langues
//                - prénoms : INSEE, fichier des prénoms (Licence Ouverte 2.0)
//                          smashew/NameDatabases (domaine public)
//                          sigpwned/popular-names-by-country-dataset (CC0)
//                - villes de plus de 15 000 habitants : GeoNames (CC BY 4.0)
//
// Les mots composés (tirets, espaces, apostrophes) sont gardés « écrasés » : la saisie n'accepte que des lettres,
// donc « États-Unis » se tape etatsunis. La forme d'origine reste utilisée pour l'affichage.
// Usage : npm run dicts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { norm, MAX_LEN } from '../server/dict.js';

const out = path.join(import.meta.dirname, '..', 'data');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motymots-'));
const text = async (url, opts) => {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, ...opts });
  if (!res.ok) throw new Error(`${url} : ${res.status}`);
  return res;
};
const lines = (s) => s.replace(/^﻿/, '').split(/\r?\n/);

function npmWords(pkg, file) {
  const tgz = execFileSync('npm', ['pack', pkg, '--silent', '--pack-destination', tmp], { encoding: 'utf8' }).trim().split('\n').pop();
  return JSON.parse(execFileSync('tar', ['-xOzf', path.join(tmp, tgz), `package/${file}`], { maxBuffer: 1 << 28 }));
}

async function zipEntry(url, entry) {
  const file = path.join(tmp, path.basename(url));
  fs.writeFileSync(file, Buffer.from(await (await text(url)).arrayBuffer()));
  return execFileSync('unzip', ['-p', file, entry], { maxBuffer: 1 << 29, encoding: 'utf8' });
}

// Un petit CSV (guillemets compris).
function csv(src) {
  return lines(src).filter(Boolean).map((line) => {
    const cells = [];
    let cur = '';
    let quoted = false;
    for (const c of line) {
      if (c === '"') quoted = !quoted;
      else if (c === ',' && !quoted) (cells.push(cur), (cur = ''));
      else cur += c;
    }
    return [...cells, cur];
  });
}

// Pays, continents (codes numériques M49) et langues, dans la langue demandée.
function localized(lang) {
  const names = [];
  const add = (dn, codes) => {
    for (const code of codes) {
      let n;
      try {
        n = dn.of(code);
      } catch {
        continue;
      }
      if (!n || n === code) continue;
      const m = n.match(/^(.*?)\s*\((.*)\)$/); // « Myanmar (Birmanie) » : les deux
      names.push(...(m ? [m[1], m[2]] : [n]));
    }
  };
  const az = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  const pairs = az.flatMap((a) => az.map((b) => a + b));
  add(new Intl.DisplayNames([lang], { type: 'region' }), [...pairs, ...Array.from({ length: 1000 }, (_, i) => String(i).padStart(3, '0'))]);
  add(new Intl.DisplayNames([lang], { type: 'language' }), pairs.map((p) => p.toLowerCase()));
  return names;
}

// Remplit `best` (clé normalisée -> forme d'affichage).
function collect(best, words, { alt = false } = {}) {
  for (const raw of words) {
    if (alt && (!/^\p{Lu}/u.test(raw) || raw === raw.toUpperCase())) continue; // codes, translittérations en minuscules
    const w = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!w || /[^\p{L}\p{M}\s'’\-.]/u.test(w)) continue; // chiffres, parenthèses...
    const flat = w.replace(/[\s'’\-.]+/g, '');
    // alphabet latin uniquement (une fois les accents retirés), sinon norm() mangerait des lettres
    if (!/^[a-zßœæ]+$/.test(flat.normalize('NFD').replace(/\p{M}/gu, ''))) continue;
    const key = norm(flat);
    if (key.length < 3 || key.length > MAX_LEN) continue;
    const cur = best.get(key);
    if (cur === undefined || (w === key && cur !== key)) best.set(key, w);
  }
}

function write(name, best) {
  const keys = [...best.keys()].sort();
  const canon = keys.filter((k) => best.get(k) !== k).map((k) => `${k}\t${best.get(k)}`);
  const body = `${keys.join('\n')}\n\n${canon.join('\n')}`;
  fs.writeFileSync(path.join(out, `${name}.txt.gz`), zlib.gzipSync(body, { level: 9 }));
  console.log(name.padEnd(6), String(keys.length).padStart(7), 'mots,', String(canon.length).padStart(6), 'à afficher autrement,', (body.length / 1e6).toFixed(1), 'Mo');
}

const base = {
  fr: async () => npmWords('an-array-of-french-words', 'index.json'),
  en: async () => npmWords('an-array-of-english-words', 'index.json'),
  es: async () => npmWords('an-array-of-spanish-words', 'index.json'),
  de: async () => lines(await (await text('https://raw.githubusercontent.com/enz/german-wordlist/master/words')).text()),
};
// Mots courants absents des listes sources.
const extra = { fr: ["aujourd'hui"] };
for (const [lang, load] of Object.entries(base)) {
  const best = new Map();
  collect(best, await load());
  collect(best, extra[lang] ?? []);
  collect(best, localized(lang));
  write(lang, best);
}

// ---- noms propres communs ----
const names = new Map();
const insee = await zipEntry('https://www.insee.fr/fr/statistiques/fichier/7633685/nat2022_csv.zip', 'nat2022.csv');
collect(names, new Set(lines(insee).slice(1).map((l) => l.split(';')[1]).filter((n) => n && !n.startsWith('_'))));
collect(names, lines(await (await text('https://raw.githubusercontent.com/smashew/NameDatabases/master/NamesDatabases/first%20names/all.txt')).text()));
for (const row of csv(await (await text('https://raw.githubusercontent.com/sigpwned/popular-names-by-country-dataset/main/common-forenames-by-country.csv')).text()).slice(1)) {
  collect(names, [row.at(-2), row.at(-1)]);
}
for (const l of lines(await zipEntry('https://download.geonames.org/export/dump/cities15000.zip', 'cities15000.txt')).filter(Boolean)) {
  const c = l.split('\t');
  collect(names, [c[1], c[2]]);
  collect(names, c[3].split(','), { alt: true });
}
write('names', names);

fs.rmSync(tmp, { recursive: true });
