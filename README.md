# MotyMots

[![CI](https://github.com/softpython2884/MotyMots/actions/workflows/ci.yml/badge.svg)](https://github.com/softpython2884/MotyMots/actions/workflows/ci.yml)

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

## Héberger sur ta machine

Le jeu garde les connexions WebSocket ouvertes et l'état de la partie en mémoire : il lui faut un **serveur Node qui tourne en continu**
(une machine à toi, un petit VPS...). Un hébergement « serverless » comme Vercel ne convient pas.

Prérequis : Node 20.11+, git, un nom de domaine dont le DNS (A, et AAAA si IPv6) pointe déjà vers la machine, les ports 80 et 443 ouverts.

```sh
git clone https://github.com/softpython2884/MotyMots.git && cd MotyMots
./deploy.sh jeu.exemple.fr toi@exemple.fr
```

Le script, à lancer avec un utilisateur normal qui a `sudo` (l'appli ne tourne pas en root) :

1. installe les dépendances (`npm ci`) ;
2. lance le jeu sous **PM2** (un seul processus, redémarrage automatique en cas de plantage et au boot de la machine) ;
3. configure **nginx** en reverse proxy, WebSocket comprise : le jeu n'écoute que sur `127.0.0.1`, jamais directement sur Internet ;
4. obtient le certificat **Let's Encrypt** avec certbot et active la redirection HTTPS (le renouvellement est automatique).

Les étapes 3 et 4 supposent Debian ou Ubuntu ; ailleurs, utilise `deploy/nginx.conf` comme modèle.

| commande | effet |
|---|---|
| `./deploy.sh` | installe / met à jour / relance le jeu sous PM2, sans nginx |
| `./deploy.sh jeu.exemple.fr toi@exemple.fr` | idem + nginx + HTTPS |
| `./deploy.sh --npm` | **sans PM2** : lance `npm start` au premier plan (Ctrl+C pour arrêter) |
| `./deploy.sh --npm jeu.exemple.fr toi@exemple.fr` | nginx + HTTPS, puis `npm start` au premier plan |
| `PORT=4000 ./deploy.sh ...` | change le port interne (3000 par défaut) |

Le mode `--npm` ne relance rien si le jeu plante ou si la machine redémarre ; pour le laisser tourner après la déconnexion SSH,
passe par `tmux`/`screen`, ou garde PM2.

**Mettre à jour** : `git pull && ./deploy.sh`. Le script est relançable sans risque, et ne réécrit pas la config nginx déjà en place.
**Suivre le jeu** : `pm2 logs motymots`, `pm2 restart motymots`, `pm2 status`.

Un redémarrage du jeu vide la table ; les navigateurs se reconnectent et se rasseyent tout seuls.
`GET /healthz` répond `ok`.

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

Les polices (Alfa Slab One, Libre Franklin) sont sous licence OFL, hébergées dans `public/fonts` avec leur licence.
Voir aussi `data/README.md`.

## Licence

[MIT](LICENSE) © NightFury. Les polices et les listes de mots gardent leur propre licence (voir ci-dessus).

## Structure

```
deploy.sh              déploiement : PM2 (ou npm start) + nginx + certbot
ecosystem.config.cjs   configuration PM2
deploy/nginx.conf      modèle de config nginx (WebSocket comprise)
server/index.js        HTTP + WebSocket (/ws)
server/game.js         règles et état de la partie, sans réseau
server/dict.js         chargement et recherche dans les dictionnaires
public/                le client (HTML, CSS, JS sans framework)
scripts/               reconstruction des dictionnaires
test/                  node --test : règles du jeu + parcours réel via WebSocket
```

## Limites

C'est un jeu pour s'amuser entre amis, pas une application durcie : pas de comptes, pas de modération des pseudos,
une seule table. Chaque changement renvoie l'état complet à tous les clients (≈ 3 Ko à 150 joueurs), ce qui est large
pour une soirée mais n'est pas fait pour des milliers de joueurs simultanés.
