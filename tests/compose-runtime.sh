#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
project="soldbench-v1-$PPID-$$"
state="$(mktemp -d)"
export SOLDBENCH_SECRETS_DIR="$state/secrets"
export SOLDBENCH_ISOLATED_DEPLOYMENT=true SOLDBENCH_LIVE_GATE_ACKNOWLEDGED=false
export COLLECTOR_ENABLED=false DATA_MODE=offline_fixture PAYMENTS_MODE=offline PAYMENT_FIXTURES=false
export MAIL_TRANSPORT=offline APP_ORIGIN=http://soldbench.test AUTH_SECRETS_VERSION=initial
export SOLD_SITE_ADDRESS=http://soldbench.test SOLD_API_ADDRESS=http://api.soldbench.test
unset DOCKER_HOST
mkdir -m 0700 "$SOLDBENCH_SECRETS_DIR"

compose() {
  docker compose --project-name "$project" --env-file "$root/infra/.env.production.example" \
    -f "$root/infra/compose.prod.yaml" "$@"
}

cleanup() {
  local status=$?
  if (( status != 0 )); then
    compose ps -a >&2 || true
    compose logs --tail 60 >&2 || true
  fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$state"
}
trap cleanup EXIT

case "$(docker context inspect --format '{{.Endpoints.docker.Host}}')" in
  unix://*) ;;
  *) echo "Compose rehearsal requires a local Unix-socket Docker engine" >&2; exit 2 ;;
esac

python3 - "$SOLDBENCH_SECRETS_DIR" <<'PY'
import base64
import json
import os
import secrets
import sys
from pathlib import Path

directory = Path(sys.argv[1])
for role in ("bootstrap", "migrator", "runtime", "collector", "backup"):
    path = directory / f"db-{role}"
    path.write_text(secrets.token_hex(32))
    path.chmod(0o444)
path = directory / "auth-bundle.json"
path.write_text(json.dumps({
    "version": "initial",
    "tokenPepper": base64.b64encode(secrets.token_bytes(32)).decode(),
    "encryptionKey": base64.b64encode(secrets.token_bytes(32)).decode(),
}))
path.chmod(0o440)
if os.name == "posix" and os.getuid() == 0:
    os.chown(path, 1000, 1000)
PY
if [[ "$(uname -s)" == Linux && "$(id -u)" != 1000 && "$(id -u)" != 0 ]]; then
  sudo chown 1000:1000 "$SOLDBENCH_SECRETS_DIR/auth-bundle.json"
fi

compose up --detach --build --wait --wait-timeout 120 caddy query-worker
read_site() {
  compose exec -T caddy wget -qO- --header="Host: $1" "http://127.0.0.1$2"
}

read_site soldbench.test / | grep -F SoldBench >/dev/null
read_site api.soldbench.test /v1/categories | python3 -c 'import json,sys; assert isinstance(json.load(sys.stdin)["data"], list)'
if read_site api.soldbench.test / >/dev/null 2>&1; then
  echo "API host exposed site routes" >&2
  exit 1
fi
for _ in $(seq 1 30); do
  if read_site api.soldbench.test /ready | grep -q '"query_worker":"recent"'; then
    break
  fi
  sleep 1
done
read_site soldbench.test /ready | grep -q '"query_worker":"recent"'
read_site api.soldbench.test /ready | grep -q '"data_mode":"offline_fixture"'
test -z "$(compose port api 3000 2>/dev/null || true)"
test -z "$(compose port caddy 80 2>/dev/null || true)"
compose restart query-worker
read_site soldbench.test /ready | grep -q '"status":"ready"'
printf 'PASS: isolated Compose, both Caddy host paths, API readiness and current query worker heartbeat\n'
