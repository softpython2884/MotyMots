# MotyMots

Jeu de mots enchaînés, à plusieurs, dans le navigateur. Dictionnaires **français, anglais, espagnol, allemand**.

Un mot s'affiche. Tu en donnes un qui commence par ses **deux dernières lettres**, et ainsi de suite.

- une seule table, une seule partie à la fois, autant de joueurs qu'on veut (on peut s'asseoir en cours de route)
- **5 essais** et **30 secondes** par tour ; un mot refusé coûte un essai
- à court d'essais ou de temps : **une vie en moins** (3 vies). Le dernier debout gagne
- **saisie en direct** : tout le monde voit ce que tape le joueur dont c'est le tour, lettre par lettre (Entrée ou « Jouer » envoie le mot)
- accents facultatifs, mots déjà joués refusés
- **impasse** : un mot qui finit par des lettres où plus rien ne commence (`-nt` en français) est refusé, sans coûter d'essai

## Lancer

```sh
npm install
npm start          # http://localhost:3000   (PORT=8080 npm start pour changer)
npm test
```

Node 20 ou plus. Une seule dépendance : `ws`. Pas d'étape de build.

## Héberger

Le jeu garde les connexions WebSocket ouvertes et l'état de la partie en mémoire : il lui faut un **serveur Node qui tourne en continu**
(Render, Fly.io, Railway, un VPS...). Un hébergement « serverless » comme Vercel ne convient pas.
Derrière un proxy, il faut laisser passer les WebSocket sur `/ws`. `GET /healthz` répond `ok`.

Un redémarrage du serveur vide la table ; les navigateurs se reconnectent et se rasseyent tout seuls.

## Régler les règles

Tout est dans `RULES` (`server/game.js`) : vies, essais, durée du tour, nombre minimum de joueurs, plafond de joueurs (2000 par défaut),
seuil d'impasse... Le nombre de lettres de liaison est `LINK` dans `server/dict.js`.

## Dictionnaires

Les listes sont dans `data/*.txt.gz` (formes fléchies comprises, sans tirets ni apostrophes, 3 à 24 lettres) :

| langue | mots | source | licence |
|---|---|---|---|
| fr | 319 000 | paquet npm `an-array-of-french-words` | MIT |
| en | 275 000 | paquet npm `an-array-of-english-words` | MIT |
| es | 635 000 | paquet npm `an-array-of-spanish-words` | MIT |
| de | 659 000 | [enz/german-wordlist](https://github.com/enz/german-wordlist) | CC0 |

`npm run dicts` les reconstruit (réseau requis). Elles sont chargées à la demande, à la première partie dans la langue,
et gardées en mémoire sous forme d'un simple texte : quelques Mo par langue.

Les polices (Alfa Slab One, Libre Franklin) sont sous licence OFL, hébergées dans `public/fonts`.

## Structure

```
server/index.js   HTTP + WebSocket (/ws)
server/game.js    règles et état de la partie, sans réseau
server/dict.js    chargement et recherche dans les dictionnaires
public/           le client (HTML, CSS, JS sans framework)
scripts/          reconstruction des dictionnaires
test/             node --test : règles du jeu + parcours réel via WebSocket
```

## Limites

C'est un jeu pour s'amuser entre amis, pas une application durcie : pas de comptes, pas de modération des pseudos,
une seule table. Chaque changement renvoie l'état complet à tous les clients (≈ 3 Ko à 150 joueurs), ce qui est large
pour une soirée mais n'est pas fait pour des milliers de joueurs simultanés.
