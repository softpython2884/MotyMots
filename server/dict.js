// Dictionnaires : une langue = un gros texte "\nmot\nmot\n" (quelques Mo en mémoire,
// contre des dizaines pour un Set). Un mot est une clé normalisée : a-z, sans accents.
import fs from 'node:fs';
import zlib from 'node:zlib';

// « mix » : un mot est bon s'il existe dans l'une des quatre langues.
export const LANGS = { fr: 'Français', en: 'English', es: 'Español', de: 'Deutsch', mix: 'Les 4 langues' };
export const LINK = 2; // nb de lettres qui relient deux mots
export const MAX_LEN = 24;

export function norm(s) {
  return String(s)
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .normalize('NFD')
    .replace(/[^a-z]/g, '');
}

// Format du fichier : clés triées, ligne vide, puis "clé<TAB>forme accentuée".
export function fromText(text) {
  const [keys, canon = ''] = text.split('\n\n');
  const d = { keys: `\n${keys}\n`, canon: `\n${canon}\n`, size: 0, links: new Map() };
  for (let i = d.keys.indexOf('\n') + 1; i < d.keys.length; ) {
    const end = d.keys.indexOf('\n', i);
    if (end < 0) break;
    const link = d.keys.slice(i, i + LINK);
    d.links.set(link, (d.links.get(link) || 0) + 1);
    d.size++;
    i = end + 1;
  }
  return d;
}

// `proper` : liste de noms propres. Ses mots sont acceptés, mais ne comptent pas pour juger qu'une fin de mot est
// jouable : les translittérations de villes (« Ntcheu », « Szeged »...) rouvriraient des impasses comme -nt ou -ez.
export function loadDict(file, proper = false) {
  return Object.assign(fromText(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')), { proper });
}

// Plusieurs dictionnaires vus comme un seul (une langue + les noms propres, ou les quatre langues).
export function combine(parts) {
  const d = { parts, size: 0, links: new Map() };
  for (const p of parts) {
    d.size += p.size;
    if (p.proper) continue;
    for (const [link, n] of p.links) d.links.set(link, (d.links.get(link) || 0) + n);
  }
  return d;
}

export const has = (d, key) => (d.parts ? d.parts.some((p) => has(p, key)) : d.keys.includes(`\n${key}\n`));

// Forme à afficher (avec accents) pour une clé.
export function show(d, key) {
  if (d.parts) return show(d.parts.find((p) => has(p, key)) ?? d.parts[0], key);
  const i = d.canon.indexOf(`\n${key}\t`);
  return i < 0 ? key : d.canon.slice(i + key.length + 2, d.canon.indexOf('\n', i + 1));
}

// Ces lettres de départ ouvrent-elles assez de mots pour que le suivant puisse jouer ?
export const open = (d, link, min) => (d.links.get(link) || 0) >= min;

// Un des dictionnaires de base, tiré au hasard proportionnellement à sa taille.
function leaf(d) {
  if (!d.parts) return d;
  let r = Math.random() * d.size;
  for (const p of d.parts) if ((r -= p.size) < 0) return leaf(p);
  return leaf(d.parts[0]);
}

// Lettres de départ tirées au sort, pondérées par la fréquence dans le dictionnaire.
export function randomStart(d, min) {
  for (let n = 0; n < 200; n++) {
    const p = leaf(d);
    const i = p.keys.indexOf('\n', Math.floor(Math.random() * p.keys.length)) + 1;
    const link = p.keys.slice(i, i + LINK);
    if (link.length === LINK && open(d, link, min)) return link;
  }
  return [...d.links.keys()][0];
}
