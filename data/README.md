# Dictionnaires

Un fichier par ensemble, `<nom>.txt.gz` : une liste de mots triés (a-z, sans accents, 3 à 24 lettres), une ligne vide,
puis les formes d'affichage (`clé<TAB>forme`) pour les mots dont l'affichage diffère (accents, tirets, espaces).
Les formes fléchies sont comprises. Les mots composés sont « écrasés » (`porte-monnaie` devient `portemonnaie`),
comme dans la saisie du jeu, qui ne garde que les lettres.

| fichier | contenu | source | licence |
|---|---|---|---|
| `fr` `en` `es` | mots courants | paquets npm [`an-array-of-french-words`](https://www.npmjs.com/package/an-array-of-french-words), [`-english-`](https://www.npmjs.com/package/an-array-of-english-words), [`-spanish-`](https://www.npmjs.com/package/an-array-of-spanish-words) | MIT |
| `de` | mots courants | [enz/german-wordlist](https://github.com/enz/german-wordlist) | CC0 1.0 |
| `fr` `en` `es` `de` | pays, continents et langues, dans la langue du fichier | `Intl.DisplayNames` (Unicode CLDR) | Unicode License |
| `names` | prénoms | [Insee, fichier des prénoms](https://www.insee.fr/fr/statistiques/7633685) | Licence Ouverte 2.0 |
| `names` | prénoms | [smashew/NameDatabases](https://github.com/smashew/NameDatabases) | domaine public |
| `names` | prénoms | [sigpwned/popular-names-by-country-dataset](https://github.com/sigpwned/popular-names-by-country-dataset) | CC0 1.0 |
| `names` | villes de plus de 15 000 habitants, avec leurs noms dans d'autres langues | [GeoNames](https://www.geonames.org) `cities15000` | CC BY 4.0 |

Attribution : *Contient des données GeoNames (https://www.geonames.org), licence CC BY 4.0. Source : Insee, fichier des prénoms
depuis 1900, Licence Ouverte 2.0.*

`names` est marqué « noms propres » au chargement : ses mots sont acceptés, mais ne comptent pas pour décider qu'une fin de
mot est jouable (voir `loadDict` et `combine` dans `server/dict.js`).

Régénération : `npm run dicts` (réseau, `npm` et `unzip` requis ; voir `scripts/build-dicts.mjs`).
