#!/usr/bin/env bash
# Restaure une sauvegarde créée par backup.sh.
# Utilisation : sudo ./scripts/restore.sh backups/mesvotes-AAAA-MM-JJ_HHMMSS.tar.gz
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
ARCHIVE="${1:-}"
[ -f "$ARCHIVE" ] || { echo "Indique une archive existante, par exemple : $(ls -1t backups/*.tar.gz 2>/dev/null | head -n1)"; exit 1; }

read -r -p "Remplacer les données actuelles par « $ARCHIVE » ? Une copie de sécurité sera gardée. [o/N] " ans < /dev/tty
[ "$ans" = "o" ] || [ "$ans" = "O" ] || { echo "Annulé."; exit 0; }

TMP="$(mktemp -d)"
tar -xzf "$ARCHIVE" -C "$TMP"
DB="$(ls "$TMP"/backups/mesvotes-*.db | head -n1)"
[ -f "$DB" ] || { echo "Archive invalide : base introuvable."; exit 1; }

docker compose stop app
SAFE="data.avant-restauration-$(date +%Y%m%d%H%M%S)"
cp -a data "$SAFE"
rm -f data/mesvotes.db data/mesvotes.db-wal data/mesvotes.db-shm
cp "$DB" data/mesvotes.db
if [ -d "$TMP/uploads" ]; then rm -rf data/uploads; cp -a "$TMP/uploads" data/uploads; fi
chown -R 1000:1000 data
rm -rf "$TMP"
docker compose start app
echo "✓ Restauré. Les anciennes données sont dans $DIR/$SAFE"
