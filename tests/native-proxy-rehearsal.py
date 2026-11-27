"""RC-01 with actual Caddy, API, Worker and native PostgreSQL 16 on loopback."""
import base64
import datetime
import json
import os
import secrets
import socket
import subprocess as sp
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
PG = Path(sp.check_output(["pg_config", "--bindir"], text=True).strip())
NODE = "node"
OPENER = build_opener(ProxyHandler({}))


def port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def request(target, host, path):
    try:
        with OPENER.open(Request(f"http://127.0.0.1:{target}{path}", headers={"Host": host}), timeout=2) as result:
            return result.status, result.read()
    except HTTPError as result:
        return result.code, result.read()
    except (TimeoutError, URLError, ConnectionResetError):
        return None, b""


def wait_for(condition, timeout=30):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if condition():
            return
        time.sleep(0.25)
    raise AssertionError("condition not observed")


def run(args, *, env=None, no_output=False):
    sp.run(args, cwd=ROOT, env=env, stdout=sp.DEVNULL if no_output else None, check=True)


def main(caddy):
    print(datetime.datetime.now(datetime.timezone.utc).isoformat(), flush=True)
    run([caddy, "version"])
    with tempfile.TemporaryDirectory(prefix="sb-proxy-", dir="/tmp") as raw:
        root = Path(raw)
        data = root / "pg"
        database_port, api_port, edge_port = port(), port(), port()
        log = root / "process.log"
        config = ROOT / "infra/Caddyfile"
        bundle = root / "auth.json"
        bundle.write_text(json.dumps({
            "version": "proxy",
            "tokenPepper": base64.b64encode(secrets.token_bytes(32)).decode(),
            "encryptionKey": base64.b64encode(secrets.token_bytes(32)).decode(),
        }))
        bundle.chmod(0o600)
        env = {
            "PATH": os.environ["PATH"],
            "NODE_ENV": "production",
            "HOST": "127.0.0.1",
            "PORT": str(api_port),
            "APP_ORIGIN": f"http://soldbench.test:{edge_port}",
            "SOLDBENCH_ISOLATED_DEPLOYMENT": "true",
            "AUTH_SECRETS_FILE": str(bundle),
            "AUTH_SECRETS_VERSION": "proxy",
            "MEDIA_ROOT": raw,
            "SOLD_SITE_ADDRESS": f"http://soldbench.test:{edge_port}",
            "SOLD_API_ADDRESS": f"http://api.soldbench.test:{edge_port}",
            "SOLD_EDGE_BIND": "127.0.0.1",
            "SOLD_UPSTREAM": f"127.0.0.1:{api_port}",
            "XDG_DATA_HOME": str(root / "caddy-data"),
            "XDG_CONFIG_HOME": str(root / "caddy-config"),
        }
        for role in ("bootstrap", "migrator", "runtime", "collector", "backup"):
            password = secrets.token_hex(32)
            secret = root / f"db-{role}"
            secret.write_text(password + "\n")
            secret.chmod(0o600)
            passfile = root / f"{role}.pgpass"
            passfile.write_text(f"127.0.0.1:{database_port}:postgres:soldbench_{role}:{password}\n")
            passfile.chmod(0o600)
        bootstrap_env = env | {
            "SOLDBENCH_SECRETS_DIR": raw,
            "PGHOST": "127.0.0.1",
            "PGPORT": str(database_port),
            "POSTGRES_USER": "soldbench_bootstrap",
            "POSTGRES_DB": "postgres",
        }
        database_url = f"postgresql://soldbench_{{role}}@127.0.0.1:{database_port}/postgres"
        run([PG / "initdb", "-D", data, "-U", "soldbench_bootstrap", "--auth=scram-sha-256",
             f"--pwfile={root / 'db-bootstrap'}", "--no-locale"], no_output=True)
        start_pg = [PG / "pg_ctl", "-D", data, "-l", str(root / "pg.log"), "-o",
                    f"-k {raw} -h 127.0.0.1 -p {database_port}", "-w", "start"]
        stop_pg = [PG / "pg_ctl", "-D", data, "-m", "fast", "-w", "stop"]
        run(start_pg, no_output=True)
        processes = []
        try:
            run(["/bin/sh", "infra/db/provision.sh"],
                env=bootstrap_env | {"PATH": f"{PG}{os.pathsep}{env['PATH']}"}, no_output=True)
            run([NODE, "scripts/deploy-db.mjs"],
                env=env | {"DATABASE_URL": database_url.format(role="migrator"), "DB_STARTUP_MODE": "migrate",
                           "PGPASSFILE": str(root / "migrator.pgpass")},
                no_output=True)
            runtime = env | {"DATABASE_URL": database_url.format(role="runtime"), "DB_STARTUP_MODE": "verify",
                             "PGPASSFILE": str(root / "runtime.pgpass")}
            denied = sp.run([PG / "psql", "-X", "--no-password", database_url.format(role="runtime"), "-Atqc", "SELECT 1"],
                            env=env | {"PGPASSWORD": "not-the-temporary-password"}, capture_output=True)
            assert denied.returncode != 0 and b"password authentication failed" in denied.stderr
            print("PASS: native PostgreSQL rejects incorrect role credentials; API and Worker use private PGPASSFILE")
            with log.open("w") as output:
                for cmd, process_env in (
                    ([NODE, "apps/api/dist/server.js"], runtime),
                    ([NODE, "scripts/query-worker.mjs", "--watch"], runtime),
                    ([caddy, "run", "--config", config, "--adapter", "caddyfile"], env),
                ):
                    processes.append(sp.Popen(cmd, cwd=ROOT, env=process_env, stdout=output, stderr=sp.STDOUT))
                wait_for(lambda: b'"query_worker":"recent"' in request(edge_port, "api.soldbench.test", "/ready")[1])
                assert b"SoldBench" in request(edge_port, "soldbench.test", "/")[1]
                assert request(edge_port, "api.soldbench.test", "/")[0] == 404
                status, data = request(edge_port, "api.soldbench.test", "/v1/categories")
                assert status == 200 and isinstance(json.loads(data)["data"], list)
                print("PASS: both Caddy host routes, API readiness and observed worker heartbeat")
                run(stop_pg, no_output=True)
                wait_for(lambda: request(edge_port, "api.soldbench.test", "/ready")[0] in (502, 503), timeout=20)
                run(start_pg, no_output=True)
                wait_for(lambda: b'"query_worker":"recent"' in request(edge_port, "api.soldbench.test", "/ready")[1])
                print("PASS: stopped PG produces readiness error and restarted PG recovers through Caddy")
        except Exception:
            if log.exists():
                print(log.read_text(), file=sys.stderr)
            raise
        finally:
            for process in reversed(processes):
                process.terminate()
                try:
                    process.wait(timeout=5)
                except sp.TimeoutExpired:
                    process.kill()
                    process.wait()
            sp.run(stop_pg, stdout=sp.DEVNULL, stderr=sp.DEVNULL)


if __name__ == "__main__":
    main(sys.argv[1])
