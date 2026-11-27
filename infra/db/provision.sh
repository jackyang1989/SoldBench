#!/bin/sh
set -eu
umask 077

load_password() {
  value=$(cat "$1")
  case "$value" in
    ""|replace-*) echo "missing or placeholder database credential" >&2; exit 1 ;;
  esac
  printf '%s' "$value"
}

export PGPASSWORD="$(load_password /run/secrets/db_bootstrap)"
export SOLD_MIGRATOR_PASSWORD="$(load_password /run/secrets/db_migrator)"
export SOLD_RUNTIME_PASSWORD="$(load_password /run/secrets/db_runtime)"
export SOLD_COLLECTOR_PASSWORD="$(load_password /run/secrets/db_collector)"
export SOLD_BACKUP_PASSWORD="$(load_password /run/secrets/db_backup)"

exec psql -X --no-password --set ON_ERROR_STOP=1 \
  --host "${PGHOST:-/var/run/postgresql}" --port "${PGPORT:-5432}" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --file /opt/soldbench/db/provision.sql
