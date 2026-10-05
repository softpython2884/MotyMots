#!/usr/bin/env bash
# Déploie MotyMots sur cette machine : l'appli (PM2 ou simple npm start), nginx devant, HTTPS par certbot.
#
#   ./deploy.sh                                   installe / met à jour / relance l'appli sous PM2
#   ./deploy.sh jeu.exemple.fr vous@exemple.fr    idem + nginx + certificat HTTPS
#   ./deploy.sh --npm                             sans PM2 : lance « npm start » au premier plan (Ctrl+C pour arrêter)
#   ./deploy.sh --npm jeu.exemple.fr vous@exemple.fr   nginx + HTTPS, puis « npm start » au premier plan
#
# - À lancer avec un utilisateur normal qui a sudo : l'appli tourne sous cet utilisateur, pas en root.
# - Relançable à volonté, c'est aussi le script de mise à jour :  git pull && ./deploy.sh
# - Prérequis : Node 20.11+. Pour nginx et certbot : Debian ou Ubuntu, et le DNS du domaine déjà pointé ici.
# - PORT=4000 ./deploy.sh ...  change le port interne (3000 par défaut). Avec un domaine, seul nginx y accède.
# - Avec --npm, rien ne relance le jeu s'il plante ou si la machine redémarre : pour le laisser tourner après la
#   déconnexion SSH, passe par tmux/screen, ou garde PM2 (le mode par défaut).
set -euo pipefail

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mErreur : %s\033[0m\n' "$*" >&2; exit 1; }

RUNNER=pm2
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --npm) RUNNER=npm ;;
    -h | --help) usage; exit 0 ;;
    -*) die "option inconnue : $arg (voir ./deploy.sh --help)" ;;
    *) ARGS+=("$arg") ;;
  esac
done
DOMAIN="${ARGS[0]:-}"
EMAIL="${ARGS[1]:-}"
PORT="${PORT:-3000}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE=/etc/nginx/sites-available/motymots

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if [ -n "$DOMAIN" ] || [ "$RUNNER" = pm2 ]; then
    command -v sudo >/dev/null || die "sudo est introuvable : lance le script en root ou installe sudo."
  fi
  SUDO="sudo"
elif [ "$RUNNER" = pm2 ]; then
  echo "Note : tu es root, l'appli tournera donc en root. Un utilisateur normal avec sudo est préférable."
fi

# ---- vérifications avant de toucher à quoi que ce soit ----------------------------------

command -v node >/dev/null || die "Node.js est introuvable (version 20.11 ou plus requise)."
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 11) ? 0 : 1)' \
  || die "Node $(node -v) est trop ancien : il faut la version 20.11 ou plus."
[[ "$PORT" =~ ^[0-9]+$ ]] || die "PORT invalide : « $PORT »."
[ "${#ARGS[@]}" -le 2 ] || die "trop d'arguments (voir ./deploy.sh --help)."

if [ -n "$DOMAIN" ]; then
  # le domaine finit dans une config nginx : on n'accepte que des noms DNS en minuscules
  [[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] \
    || die "domaine invalide : « $DOMAIN » (minuscules, par exemple jeu.exemple.fr)."
  [[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] \
    || die "indique aussi ton e-mail pour Let's Encrypt :  ./deploy.sh $DOMAIN toi@exemple.fr"
  command -v apt-get >/dev/null \
    || die "l'installation automatique de nginx et certbot ne couvre que Debian/Ubuntu. Voir « Héberger » dans le README."
  getent ahosts "$DOMAIN" >/dev/null \
    || die "$DOMAIN ne résout pas encore : crée l'enregistrement DNS (A ou AAAA) vers cette machine, puis relance."
fi

# ---- étapes ------------------------------------------------------------------------------------

install_deps() {
  say "Dépendances"
  cd "$DIR"
  npm ci --omit=dev --no-audit --no-fund
}

start_pm2() {
  say "PM2"
  cd "$DIR"
  command -v pm2 >/dev/null \
    || npm install -g pm2 --no-audit --no-fund 2>/dev/null \
    || $SUDO env "PATH=$PATH" npm install -g pm2 --no-audit --no-fund
  PORT="$PORT" pm2 startOrReload ecosystem.config.cjs --update-env
  pm2 save

  # redémarrage automatique de PM2 (et donc du jeu) au boot de la machine
  if [ -d /run/systemd/system ]; then
    $SUDO env "PATH=$PATH" pm2 startup systemd -u "$(id -un)" --hp "$HOME" >/dev/null \
      || echo "Attention : le démarrage au boot n'a pas pu être configuré, lance « pm2 startup » à la main."
  fi

  say "Vérification"
  local ok=""
  for _ in $(seq 1 15); do
    if node -e "fetch('http://127.0.0.1:$PORT/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"; then
      ok=1
      break
    fi
    sleep 1
  done
  if [ -z "$ok" ]; then
    pm2 logs motymots --lines 30 --nostream || true
    die "l'appli ne répond pas sur le port $PORT (derniers logs ci-dessus)."
  fi
  echo "L'appli répond sur 127.0.0.1:$PORT"
}

setup_nginx() {
  say "nginx et certbot"
  local pkgs=()
  command -v nginx >/dev/null || pkgs+=(nginx)
  command -v certbot >/dev/null || pkgs+=(certbot python3-certbot-nginx)
  if [ "${#pkgs[@]}" -gt 0 ]; then
    $SUDO apt-get update -qq
    $SUDO apt-get install -y "${pkgs[@]}"
  fi

  # Si la config existe déjà pour ce domaine, on ne la réécrit pas : certbot y a ajouté la partie HTTPS.
  if [ -f "$SITE" ] && grep -q "server_name $DOMAIN;" "$SITE" && grep -q "127.0.0.1:$PORT;" "$SITE"; then
    echo "Config nginx déjà en place ($SITE), je n'y touche pas."
  else
    local sedargs=(-e "s/__DOMAIN__/$DOMAIN/g" -e "s/__PORT__/$PORT/g")
    # sans IPv6 sur la machine, « listen [::]:80 » empêcherait nginx de démarrer : on retire la ligne
    [ -f /proc/net/if_inet6 ] || sedargs+=(-e '/\[::\]/d')
    sed "${sedargs[@]}" "$DIR/deploy/nginx.conf" | $SUDO tee "$SITE" >/dev/null
    echo "Config nginx écrite : $SITE"
  fi
  $SUDO ln -sf "$SITE" /etc/nginx/sites-enabled/motymots
  $SUDO nginx -t
  $SUDO systemctl enable --now nginx
  $SUDO systemctl reload nginx

  if command -v ufw >/dev/null && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
    $SUDO ufw allow 'Nginx Full' >/dev/null
    echo "Pare-feu : ports 80 et 443 ouverts."
  fi

  say "Certificat HTTPS (Let's Encrypt)"
  $SUDO certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --no-eff-email --redirect --non-interactive
}

# ---- déroulé -------------------------------------------------------------------------------------

install_deps
[ "$RUNNER" = pm2 ] && start_pm2
[ -z "$DOMAIN" ] || setup_nginx

if [ "$RUNNER" = npm ]; then
  # npm start reste au premier plan : on le lance en dernier, une fois nginx prêt
  if [ -n "$DOMAIN" ]; then
    say "npm start : https://$DOMAIN  (Ctrl+C pour arrêter)"
    export HOST=127.0.0.1 # joignable uniquement via nginx
  else
    say "npm start : http://localhost:$PORT  (Ctrl+C pour arrêter)"
  fi
  cd "$DIR"
  PORT="$PORT" exec npm start
fi

if [ -n "$DOMAIN" ]; then
  say "C'est en ligne : https://$DOMAIN"
else
  say "Terminé (appli seule). Pour nginx et HTTPS :  ./deploy.sh <domaine> <e-mail>"
fi
echo "Logs : pm2 logs motymots  |  Redémarrer : pm2 restart motymots  |  Mettre à jour : git pull && ./deploy.sh"
