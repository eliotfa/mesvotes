#!/usr/bin/env bash
# Sauvegarde cohérente de la base SQLite et des fichiers joints. Garde les 14 dernières.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
KEEP="${KEEP:-14}"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
mkdir -p backups data/backups
chown 1000:1000 data/backups 2>/dev/null || true

# VACUUM INTO produit une copie cohérente même pendant que le site tourne.
docker compose exec -T app node --disable-warning=ExperimentalWarning -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('/data/mesvotes.db');
  db.exec(\"VACUUM INTO '/data/backups/mesvotes-$STAMP.db'\");
"
tar -czf "backups/mesvotes-$STAMP.tar.gz" -C data "backups/mesvotes-$STAMP.db" $( [ -d data/uploads ] && echo uploads )
rm -f "data/backups/mesvotes-$STAMP.db"

ls -1t backups/mesvotes-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
echo "✓ Sauvegarde : $DIR/backups/mesvotes-$STAMP.tar.gz ($(du -h "backups/mesvotes-$STAMP.tar.gz" | cut -f1))"
