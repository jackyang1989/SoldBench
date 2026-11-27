#!/bin/sh
set -eu
umask 077

load_password() {
  value=$(cat "$1")
  case "$value" in
    ""|replace-*) echo "missing or placeholder database credential" >&2; exit 1 ;;
    *'
'*) echo "database credential must fit on one line" >&2; exit 1 ;;
  esac
  printf '%s' "$value"
}

secrets="${SOLDBENCH_SECRETS_DIR:?set SOLDBENCH_SECRETS_DIR}"
case "$secrets" in /*) ;; *) echo "secret directory must be absolute" >&2; exit 1 ;; esac
host="${PGHOST:-127.0.0.1}"
case "$host" in 127.0.0.1|::1|/*) ;; *) echo "bootstrap requires native local PostgreSQL" >&2; exit 1 ;; esac

PGPASSWORD="$(load_password "$secrets/db-bootstrap")"
SOLD_MIGRATOR_PASSWORD="$(load_password "$secrets/db-migrator")"
SOLD_RUNTIME_PASSWORD="$(load_password "$secrets/db-runtime")"
SOLD_COLLECTOR_PASSWORD="$(load_password "$secrets/db-collector")"
SOLD_BACKUP_PASSWORD="$(load_password "$secrets/db-backup")"
export PGPASSWORD SOLD_MIGRATOR_PASSWORD SOLD_RUNTIME_PASSWORD SOLD_COLLECTOR_PASSWORD SOLD_BACKUP_PASSWORD

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

exec psql -X --no-password --set ON_ERROR_STOP=1 \
  --host "$host" --port "${PGPORT:-5432}" \
  --username "${POSTGRES_USER:?set the native bootstrap role}" \
  --dbname "${POSTGRES_DB:?set the target native database}" --file "$script_dir/provision.sql"
