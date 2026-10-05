# Dictionnaires

Un fichier par langue, `<langue>.txt.gz` : une liste de mots triés (a-z, sans accents, 3 à 24 lettres), une ligne vide,
puis les formes accentuées d'affichage (`clé<TAB>forme`). Les formes fléchies sont comprises ; tirets et apostrophes sont exclus.

| langue | source | licence déclarée |
|---|---|---|
| fr | paquet npm [`an-array-of-french-words`](https://www.npmjs.com/package/an-array-of-french-words) | MIT |
| en | paquet npm [`an-array-of-english-words`](https://www.npmjs.com/package/an-array-of-english-words) | MIT |
| es | paquet npm [`an-array-of-spanish-words`](https://www.npmjs.com/package/an-array-of-spanish-words) | MIT |
| de | [enz/german-wordlist](https://github.com/enz/german-wordlist) | CC0 1.0 |

Régénération : `npm run dicts` (réseau requis, voir `scripts/build-dicts.mjs`).
