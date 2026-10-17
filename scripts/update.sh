#!/usr/bin/env bash
# Met à jour mesvotes : récupère le code, sauvegarde, reconstruit et redémarre.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"

echo "→ Sauvegarde avant mise à jour"
"$DIR/scripts/backup.sh" || echo "! Sauvegarde impossible (première installation ?), on continue."

echo "→ Récupération du code ($BRANCH)"
git fetch -q origin "$BRANCH"
BEFORE=$(git rev-parse --short HEAD)
git pull -q --ff-only origin "$BRANCH"
AFTER=$(git rev-parse --short HEAD)

echo "→ Reconstruction et redémarrage"
docker compose up -d --build
docker image prune -f >/dev/null 2>&1 || true

for i in $(seq 1 30); do
  if docker compose exec -T app wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
    echo "✓ mesvotes à jour ($BEFORE → $AFTER) et en ligne"; exit 0
  fi
  sleep 2
done
echo "✗ L'application ne répond pas. Journaux : docker compose logs app" >&2
exit 1
