#!/usr/bin/env bash
set -euo pipefail

# Verified offline-capable PostgreSQL 16 backup, integrity check, and restore utility.
# Fails closed on missing inputs, existing target dumps, or SHA-256 / archive structure mismatch.

usage() {
  echo "Usage:" >&2
  echo "  $0 backup <database_url> <out_dir>" >&2
  echo "  $0 verify <out_dir>" >&2
  echo "  $0 restore <out_dir> <target_database_url>" >&2
  exit 2
}

sha256_of() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    echo "missing sha256sum or shasum" >&2
    exit 1
  fi
}

require_nonempty_url() {
  local url="$1"
  if [[ -z "$url" || ! "$url" =~ ^postgres(ql)?:// ]]; then
    echo "invalid database url" >&2
    exit 1
  fi
}

cmd_backup() {
  local db_url="$1"
  local out_dir="$2"
  require_nonempty_url "$db_url"
  mkdir -p -m 0700 "$out_dir"
  local dump_path="$out_dir/backup.dump"
  local sha_path="$out_dir/backup.dump.sha256"
  local meta_path="$out_dir/backup-meta.json"
  if [[ -e "$dump_path" || -e "$sha_path" || -e "$meta_path" ]]; then
    echo "backup_already_exists: $out_dir" >&2
    exit 1
  fi

  local tmp_dump="$out_dir/.backup.dump.$$.tmp"
  cleanup_tmp() {
    rm -f "$tmp_dump"
  }
  trap cleanup_tmp EXIT

  pg_dump --format=custom --no-owner --no-acl --file="$tmp_dump" "$db_url"
  pg_restore --list "$tmp_dump" >/dev/null
  mv "$tmp_dump" "$dump_path"
  chmod 0600 "$dump_path"
  trap - EXIT

  local digest bytes created_at migrations
  digest="$(sha256_of "$dump_path")"
  bytes="$(wc -c < "$dump_path" | tr -d '[:space:]')"
  created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  migrations="null"
  if command -v psql >/dev/null 2>&1; then
    local m_count
    if m_count="$(psql "$db_url" -Atqc "SELECT count(*) FROM soldbench_migrations" 2>/dev/null)"; then
      if [[ "$m_count" =~ ^[0-9]+$ ]]; then
        migrations="$m_count"
      fi
    fi
  fi

  printf '%s  backup.dump\n' "$digest" > "$sha_path"
  chmod 0600 "$sha_path"
  cat > "$meta_path" <<EOF
{
  "schema": "soldbench.pg-backup.v1",
  "created_at": "$created_at",
  "dump_file": "backup.dump",
  "sha256": "$digest",
  "bytes": $bytes,
  "migrations": $migrations
}
EOF
  chmod 0600 "$meta_path"
  cat "$meta_path"
}

cmd_verify() {
  local out_dir="$1"
  local dump_path="$out_dir/backup.dump"
  local sha_path="$out_dir/backup.dump.sha256"
  if [[ ! -f "$dump_path" || ! -f "$sha_path" ]]; then
    echo "missing backup.dump or backup.dump.sha256 in $out_dir" >&2
    exit 1
  fi
  local expected actual
  expected="$(awk 'NR==1 {print $1}' "$sha_path")"
  if [[ ! "$expected" =~ ^[a-f0-9]{64}$ ]]; then
    echo "invalid sha256 manifest in $sha_path" >&2
    exit 1
  fi
  actual="$(sha256_of "$dump_path")"
  if [[ "$actual" != "$expected" ]]; then
    echo "backup_checksum_mismatch: expected $expected got $actual" >&2
    exit 1
  fi
  pg_restore --list "$dump_path" >/dev/null
  echo "{\"ok\":true,\"sha256\":\"$actual\"}"
}

cmd_restore() {
  local out_dir="$1"
  local target_url="$2"
  require_nonempty_url "$target_url"
  cmd_verify "$out_dir" >/dev/null
  pg_restore --single-transaction --exit-on-error --no-owner --no-acl --dbname="$target_url" "$out_dir/backup.dump"
  echo "{\"ok\":true,\"restored_from\":\"$out_dir/backup.dump\"}"
}

if [[ $# -lt 2 ]]; then
  usage
fi

subcmd="$1"
shift
case "$subcmd" in
  backup)
    [[ $# -eq 2 ]] || usage
    cmd_backup "$1" "$2"
    ;;
  verify)
    [[ $# -eq 1 ]] || usage
    cmd_verify "$1"
    ;;
  restore)
    [[ $# -eq 2 ]] || usage
    cmd_restore "$1" "$2"
    ;;
  *)
    usage
    ;;
esac
