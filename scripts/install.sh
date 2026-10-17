#!/usr/bin/env bash
# Installation automatique de mesvotes sur un VPS Ubuntu ou Debian.
#
# Utilisation (en root ou avec sudo) :
#   curl -fsSL https://raw.githubusercontent.com/eliotfa/mesvotes/main/scripts/install.sh | sudo bash -s -- \
#        --domain mesvotes.fr --email toi@exemple.fr
#
# Options :
#   --domain DOMAINE        nom de domaine (obligatoire, ex. mesvotes.fr)
#   --email EMAIL           e-mail pour Let's Encrypt (recommandé)
#   --admin-email EMAIL     ce compte deviendra administrateur (sinon : le premier inscrit)
#   --dir DOSSIER           dossier d'installation (défaut : /opt/mesvotes)
#   --repo URL              dépôt git (défaut : https://github.com/eliotfa/mesvotes.git)
#   --branch BRANCHE        branche (défaut : main)
#   --demo                  active le mode démo et charge les exemples
#   --behind-proxy          un autre serveur web occupe déjà les ports 80/443 (détecté automatiquement)
#   --app-port PORT         port local de l'application (défaut : 3010)
#   --no-firewall           ne touche pas au pare-feu
#   --yes                   ne pose aucune question
set -euo pipefail

DOMAIN=""; ACME_EMAIL=""; ADMIN_EMAIL=""; DIR="/opt/mesvotes"
REPO="https://github.com/eliotfa/mesvotes.git"; BRANCH="main"
DEMO="false"; FIREWALL="true"; ASSUME_YES="false"; PROXY="auto"; APP_PORT="3010"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) ACME_EMAIL="$2"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --demo) DEMO="true"; shift ;;
    --no-firewall) FIREWALL="false"; shift ;;
    --behind-proxy) PROXY="external"; shift ;;
    --app-port) APP_PORT="$2"; shift 2 ;;
    --yes|-y) ASSUME_YES="true"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "Option inconnue : $1" ;;
  esac
done

ask() { # ask VAR "Question" "défaut"
  local __var="$1" __q="$2" __def="${3:-}" __ans=""
  if [ "$ASSUME_YES" = "true" ] || [ ! -r /dev/tty ]; then printf -v "$__var" '%s' "$__def"; return; fi
  read -r -p "$__q${__def:+ [$__def]} : " __ans < /dev/tty || true
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

bold "Installation de mesvotes"
[ "$(id -u)" -eq 0 ] || die "Lance ce script en root (ou avec sudo)."
. /etc/os-release 2>/dev/null || true
case "${ID:-}${ID_LIKE:-}" in
  *debian*|*ubuntu*) ok "Système détecté : ${PRETTY_NAME:-Debian/Ubuntu}" ;;
  *) warn "Système non testé (${PRETTY_NAME:-inconnu}). Le script vise Ubuntu et Debian." ;;
esac

[ -n "$DOMAIN" ] || ask DOMAIN "Nom de domaine du site" "mesvotes.fr"
[ -n "$DOMAIN" ] || die "Le domaine est obligatoire (--domain)."
[ -n "$ACME_EMAIL" ] || ask ACME_EMAIL "E-mail pour les alertes du certificat HTTPS" "contact@$DOMAIN"
[ -n "$ACME_EMAIL" ] || ACME_EMAIL="contact@$DOMAIN"

info "Installation des paquets de base"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git ufw dnsutils >/dev/null
ok "Paquets installés"

if ! command -v docker >/dev/null 2>&1; then
  info "Installation de Docker"
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || die "Docker Compose est introuvable après l'installation de Docker."
ok "Docker prêt ($(docker --version | cut -d, -f1))"

if [ -d "$DIR/.git" ]; then
  info "Mise à jour du code dans $DIR"
  git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q "$BRANCH" && git -C "$DIR" pull -q --ff-only origin "$BRANCH"
else
  info "Téléchargement du code dans $DIR"
  git clone -q --branch "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"
ok "Code à jour ($(git rev-parse --short HEAD))"

setenv() { # setenv CLE valeur  (remplace ou ajoute dans .env)
  local key="$1" val="$2" esc
  esc=$(printf '%s' "$val" | sed -e 's/[\/&|]/\\&/g')
  if grep -qE "^#? ?${key}=" .env; then sed -i -E "s|^#? ?${key}=.*|${key}=${esc}|" .env; else printf '%s=%s\n' "$key" "$val" >> .env; fi
}
# Les ports 80/443 sont-ils déjà pris par un autre programme que mesvotes ?
if [ "$PROXY" = "auto" ]; then
  if ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v docker-proxy | grep -q LISTEN; then
    PROXY="external"
    warn "Les ports 80/443 sont déjà utilisés ($(ss -ltnpH '( sport = :80 or sport = :443 )' | grep -v docker-proxy | grep -o 'users:(("[^"]*' | cut -d'"' -f2 | sort -u | tr '\n' ' '))."
    warn "mesvotes tournera derrière ton serveur web existant, sans Caddy."
  else PROXY="caddy"; fi
fi
if ss -ltnH "( sport = :$APP_PORT )" 2>/dev/null | grep -v docker-proxy | grep -q LISTEN; then die "Le port local $APP_PORT est déjà pris. Relance avec --app-port 3020 (par exemple)."; fi

if [ ! -f .env ]; then
  cp .env.example .env
  setenv DOMAIN "$DOMAIN"
  setenv BASE_URL "https://$DOMAIN"
  setenv ACME_EMAIL "$ACME_EMAIL"
  setenv ADMIN_EMAIL "$ADMIN_EMAIL"
  setenv DEMO_MODE "$DEMO"
  setenv SEED_DEMO "$DEMO"
  setenv APP_PORT "$APP_PORT"
  if [ "$PROXY" = "external" ]; then setenv COMPOSE_PROFILES ""; else setenv COMPOSE_PROFILES "caddy"; fi
  chmod 600 .env
  ok "Configuration créée : $DIR/.env"
else
  ok "Configuration existante conservée : $DIR/.env"
fi

mkdir -p data backups
chown -R 1000:1000 data
chmod +x scripts/*.sh

APP_PORT=$(grep -E '^APP_PORT=' .env | cut -d= -f2); APP_PORT=${APP_PORT:-3010}
grep -qE '^COMPOSE_PROFILES=.*caddy' .env && PROXY="caddy" || PROXY="external"

if [ "$FIREWALL" = "true" ]; then
  info "Pare-feu : SSH, HTTP et HTTPS ouverts, le reste fermé"
  ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
  ufw --force enable >/dev/null
  ok "Pare-feu actif"
fi

PUBLIC_IP=$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || true)
DNS_IP=$(dig +short A "$DOMAIN" 2>/dev/null | tail -n1 || true)
if [ -n "$PUBLIC_IP" ] && [ "$PUBLIC_IP" != "$DNS_IP" ]; then
  warn "Le domaine $DOMAIN pointe vers « ${DNS_IP:-rien} » alors que ce serveur a l'adresse $PUBLIC_IP."
  warn "Crée un enregistrement DNS A « $DOMAIN → $PUBLIC_IP » chez ton registraire. Le certificat HTTPS sera obtenu dès que le DNS sera à jour."
fi

info "Construction et démarrage (première fois : 1 à 2 minutes)"
docker compose up -d --build --remove-orphans
[ "$PROXY" = "external" ] && docker compose rm -sf caddy >/dev/null 2>&1 || true
ok "Conteneurs démarrés"

cat > /etc/cron.d/mesvotes <<CRON
# Sauvegarde quotidienne de mesvotes (base + fichiers joints), conservée 14 jours
17 3 * * * root $DIR/scripts/backup.sh >> /var/log/mesvotes-backup.log 2>&1
CRON
ok "Sauvegarde quotidienne programmée (3 h 17, dossier $DIR/backups)"

info "Vérification de l'application"
for i in $(seq 1 30); do
  if docker compose exec -T app wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1; then ok "L'application répond"; break; fi
  sleep 2
  [ "$i" -eq 30 ] && warn "L'application ne répond pas encore. Regarde : cd $DIR && docker compose logs app"
done

echo
if [ "$PROXY" = "external" ]; then
  bold "L'application tourne sur http://127.0.0.1:$APP_PORT (visible seulement depuis ce serveur)."
  echo "  Dernière étape : faire servir $DOMAIN par ton serveur web existant."
  echo "  Le guide pas à pas (Nginx, Apache, Traefik, Caddy) : $DIR/docs/reverse-proxy.md"
  echo
else
  bold "C'est en ligne : https://$DOMAIN"
fi
echo "  • Le premier compte créé ${ADMIN_EMAIL:+(ou $ADMIN_EMAIL) }devient administrateur."
echo "  • Configuration : $DIR/.env  (puis : cd $DIR && docker compose up -d)"
echo "  • Journaux      : cd $DIR && docker compose logs -f app"
echo "  • Mise à jour   : sudo $DIR/scripts/update.sh"
echo "  • Sauvegarde    : sudo $DIR/scripts/backup.sh   ·   Restauration : sudo $DIR/scripts/restore.sh <fichier>"
