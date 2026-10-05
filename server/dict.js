// Dictionnaires : une langue = un gros texte "\nmot\nmot\n" (quelques Mo en mémoire,
// contre des dizaines pour un Set). Un mot est une clé normalisée : a-z, sans accents.
import fs from 'node:fs';
import zlib from 'node:zlib';

export const LANGS = { fr: 'Français', en: 'English', es: 'Español', de: 'Deutsch' };
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

export function loadDict(file) {
  return fromText(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

export const has = (d, key) => d.keys.includes(`\n${key}\n`);

// Forme à afficher (avec accents) pour une clé.
export function show(d, key) {
  const i = d.canon.indexOf(`\n${key}\t`);
  return i < 0 ? key : d.canon.slice(i + key.length + 2, d.canon.indexOf('\n', i + 1));
}

// Ces lettres de départ ouvrent-elles assez de mots pour que le suivant puisse jouer ?
export const open = (d, link, min) => (d.links.get(link) || 0) >= min;

// Lettres de départ tirées au sort, pondérées par la fréquence dans le dictionnaire.
export function randomStart(d, min) {
  for (let n = 0; n < 200; n++) {
    const i = d.keys.indexOf('\n', Math.floor(Math.random() * d.keys.length)) + 1;
    const link = d.keys.slice(i, i + LINK);
    if (link.length === LINK && open(d, link, min)) return link;
  }
  return [...d.links.keys()][0];
}
