#!/usr/bin/env python3
"""Verify an offline distribution in a temporary runtime with PostgreSQL 16."""
import argparse
import importlib.util
import json
import os
import shlex
import shutil
import socket
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("package_offline", Path(__file__).with_name("package-offline.py"))
BUNDLE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUNDLE)


def extract(source, destination):
    with tarfile.open(source, mode="r|gz") as archive:
        total = 0
        for member in archive:
            prefix, sep, name = member.name.partition("/")
            if (not member.isfile() or prefix != "soldbench" or not sep
                    or (name != BUNDLE.MANIFEST and not BUNDLE.runtime_path(name))):
                raise ValueError("Invalid runtime archive member")
            total += member.size
            if total > BUNDLE.MAX_BYTES:
                raise ValueError("Runtime exceeds extraction limit")
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as content, target.open("xb") as output:
                shutil.copyfileobj(content, output)


def port_number():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def response(opener, origin, path):
    with opener.open(origin + path, timeout=2) as result:
        return result.read()


def ready(opener, origin, processes, worker="recent", seconds=15):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if any(process.poll() is not None for process in processes.values()):
            raise ValueError("API or query worker exited during runtime smoke")
        try:
            state = json.loads(response(opener, origin, "/ready"))
            if state["query_worker"] == worker:
                return
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(0.1)
    raise ValueError(f"Runtime did not report the expected worker state: {worker}")


def stop(process):
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=6)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def check_clients(run, root, opener, origin, processes, start):
    setup = json.loads(run("node", "scripts/developer-demo.mjs"))
    if setup.get("collector_enabled") is not False:
        raise ValueError("Developer demo did not assert offline mode")
    private = root / ".local/developer-demo.env"
    if private.stat().st_mode & 0o077:
        raise ValueError("Fixture credentials must remain private")
    credentials = {}
    for line in private.read_text().splitlines():
        key, value = line.split("=", 1)
        if key in {"SOLDBENCH_BASE_URL", "SOLDBENCH_API_KEY", "SOLDBENCH_KEYWORD"}:
            credentials[key], = shlex.split(value)
    if credentials.get("SOLDBENCH_BASE_URL") != origin + "/v1" or not credentials.get("SOLDBENCH_API_KEY"):
        raise ValueError("Invalid local developer fixture")
    example = ("python3", "developer/examples/sold.py", "--claim")
    rest = json.loads(run(*example, additions=credentials))
    if rest["n_price_verified"] != 8 or rest["credits_charged"] != 1:
        raise ValueError("REST fixture did not settle once on first delivery")
    authorization = {"Authorization": "Bearer " + credentials["SOLDBENCH_API_KEY"]}

    def get(path):
        request = urllib.request.Request(origin + path, headers=authorization)
        with opener.open(request, timeout=5) as reply:
            return json.load(reply)

    result_path = "/v1/sold/" + rest["query_id"]
    ledger_before = get("/v1/usage")["data"]
    debits = [line["delta"] for line in ledger_before["ledger"] if line["query_id"] == rest["query_id"]]
    if debits != [-1] or ledger_before["next_cursor"] is not None:
        raise ValueError("Expected exactly one debit in the synthetic owner's complete ledger")

    worker = processes.pop("worker")
    worker.kill()
    worker.wait(timeout=5)
    ready(opener, origin, processes, worker="stale", seconds=34)
    retained = get(result_path)
    if (retained["data"]["query_id"] != rest["query_id"]
            or retained["data"]["stats"]["median_cents"] != rest["median_cents"]
            or retained["meta"]["credits_charged"] != 0):
        raise ValueError("Delivered REST result was not retained during the worker outage")
    start("worker")
    ready(opener, origin, processes)

    api = processes.pop("api")
    api.kill()
    api.wait(timeout=5)
    if processes["worker"].poll() is not None:
        raise ValueError("The query worker exited during the API outage")
    start("api")
    ready(opener, origin, processes)
    replay = json.loads(run(*example, "--transport=curl", additions=credentials))
    if replay != {**rest, "credits_charged": 0}:
        raise ValueError("The restarted API did not replay the same result without a debit")
    headers = {**authorization,
               "Content-Type": "application/json", "Accept": "application/json, text/event-stream",
               "MCP-Protocol-Version": "2025-11-25"}

    def call(method, params=None):
        body = {"jsonrpc": "2.0", "id": 1, "method": method}
        if params is not None:
            body["params"] = params
        request = urllib.request.Request(origin + "/mcp", json.dumps(body).encode(), headers)
        with opener.open(request, timeout=5) as reply:
            raw = reply.read().decode()
            if reply.headers.get_content_type() == "text/event-stream":
                raw = next((line[5:].strip() for line in raw.splitlines() if line.startswith("data:")), "")
        message = json.loads(raw)
        if "result" not in message or message["result"].get("isError"):
            raise ValueError(f"MCP fixture command failed: {method}")
        return message["result"]

    tools = call("tools/list")
    if {tool["name"] for tool in tools["tools"]} != {"sold_search", "sold_stats"}:
        raise ValueError("Offline MCP tool surface differs from its contract")
    stats = call("tools/call", {"name": "sold_stats", "arguments": {"query_id": rest["query_id"]}})
    result = stats["structuredContent"]
    if (result["meta"]["credits_charged"] != 0
            or result["data"]["stats"]["median_cents"] != rest["median_cents"]
            or result["data"]["stats"]["n_price_verified"] != rest["n_price_verified"]):
        raise ValueError("MCP did not reuse delivered statistics free of charge")
    if get("/v1/usage")["data"] != ledger_before:
        raise ValueError("Outage recovery changed the synthetic owner's wallets or ledger")
    return {"verified_samples": rest["n_price_verified"], "initial_credits_charged": 1,
            "curl_replay_credits_charged": 0, "mcp_stats_credits_charged": 0,
            "worker_sigkill_retained_read": True, "api_sigkill_retained_worker": True,
            "ledger_unchanged_after_recovery": True}


def restore(run, root, environment, source_id, boot, shutdown):
    pg = Path(run("pg_config", "--bindir").strip())
    authority = environment["DATABASE_URL"]
    snapshot = root / "before-revocation.dump"
    checkpoint = root / "current-restrictions.json"
    timestamp = time.monotonic()
    run(str(pg / "pg_dump"), "--format=custom", "--file", str(snapshot), authority)
    revoke = """
import { CollectorStore } from '@soldbench/collector';
import { database } from '@soldbench/db';
const db = database(process.env.DATABASE_URL);
try {
  await new CollectorStore(db).revokeSource(process.argv[1], 'offline_release_restore_fixture');
} finally {
  await db.end();
}
"""
    run("node", "--input-type=module", "--eval", revoke, source_id)
    signed = json.loads(run("node", "scripts/privacy-recovery.mjs", "export", str(checkpoint)))
    if not signed.get("exported"):
        raise ValueError("Authoritative recovery checkpoint was not exported")
    shutdown()
    incident = time.monotonic()
    run(str(pg / "psql"), "--dbname", authority, "--set", "ON_ERROR_STOP=1", "--command",
        "CREATE DATABASE soldbench_rehearsal_restore")
    restored = urllib.parse.urlsplit(authority)._replace(path="/soldbench_rehearsal_restore").geturl()
    run(str(pg / "pg_restore"), "--exit-on-error", "--dbname", restored, str(snapshot))
    environment["DATABASE_URL"] = restored
    environment["PRIVACY_RESTORE_ISOLATED"] = "true"
    environment["PRIVACY_RECOVERY_MANIFEST_SHA256"] = signed["sha256"]
    replay = ["node", "scripts/privacy-recovery.mjs", "replay", str(checkpoint)]
    applied = json.loads(run(*replay))
    already = json.loads(run(*replay))
    if applied.get("sources_quarantined") != 1 or already.get("sources_quarantined") != 0:
        raise ValueError("Source revocation checkpoint did not replay once")
    inspect = ["node", "scripts/collector-report.mjs", f"--source={source_id}", "--check-media=8"]
    withheld = json.loads(run(*inspect))
    media = withheld["media"]
    if media["eligibleReferences"] != 0 or media["probe"]["verifiedObjects"] != 0:
        raise ValueError("Withdrawn primary images are still eligible in the restored database")
    cleanup = json.loads(run("node", "scripts/collector-maintenance.mjs"))
    if cleanup["cleanupProcessed"] != 1 or cleanup["cleanupPending"] != 0:
        raise ValueError("Restored source media cleanup did not finish")
    cleared = json.loads(run(*inspect))
    media_path = root / ".local/collector-media" / source_id
    if cleared["media"]["retainedReferences"] != 0 or any(media_path.glob("*.webp")):
        raise ValueError("Restored primary image references remain after cleanup")
    run(str(pg / "psql"), "--dbname", restored, "--set", "ON_ERROR_STOP=1", "--command",
        "DELETE FROM worker_heartbeats WHERE worker_kind='query'")
    boot()
    return {"backup_age_at_simulated_incident_ms": round((incident - timestamp) * 1000),
            "isolated_restore_to_ready_ms": round((time.monotonic() - incident) * 1000),
            "source_revocation_replays": applied["sources_quarantined"], "media_cleanup_completed": True,
            "production_recovery_objectives_verified": False}


def exercise(source, output, restore_backup=False, clients=False):
    original = BUNDLE.verify(source)
    with tempfile.TemporaryDirectory(prefix="sb-run-", dir="/tmp") as directory:
        workspace = Path(directory) / "soldbench"
        workspace.mkdir(mode=0o700)
        staged = Path(directory) / "runtime.tar.gz"
        shutil.copyfile(source, staged)
        if BUNDLE.verify(staged) != original:
            raise ValueError("Runtime archive changed before rehearsal")
        extract(staged, workspace)
        port = port_number()
        origin = f"http://127.0.0.1:{port}"
        environment = {
            "PATH": os.environ["PATH"], "HOME": os.environ["HOME"], "NODE_ENV": "development",
            "HOST": "127.0.0.1", "PORT": str(port), "APP_ORIGIN": origin, "DATA_MODE": "offline_fixture",
            "COLLECTOR_ENABLED": "false", "PAYMENT_FIXTURES": "false", "PAYMENTS_MODE": "offline",
            "DB_STARTUP_MODE": "verify", "NPM_CONFIG_USERCONFIG": "/dev/null",
            "LC_ALL": "C", "TMPDIR": directory,
        }
        with output.open("x", encoding="utf8") as log:
            def run(*command, additions=None):
                result = subprocess.run(command, cwd=workspace, env={**environment, **(additions or {})},
                                        text=True, capture_output=True, timeout=60)
                log.write(result.stdout + result.stderr)
                if result.returncode:
                    postgres_log = workspace / ".local/postgres/postgres.log"
                    if postgres_log.is_file():
                        log.write(postgres_log.read_text(encoding="utf8", errors="replace")[-16384:])
                    log.flush()
                    raise ValueError(f"{command[0]} exited {result.returncode}; inspect the rehearsal log")
                log.flush()
                return result.stdout

            run("npm", "ci", "--omit=dev", "--offline", "--no-audit", "--no-fund")
            run("node", "scripts/local-db.mjs", "start")
            processes = {}

            def shutdown():
                while processes:
                    _, process = processes.popitem()
                    stop(process)

            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

            def start(role):
                entries = {"api": ["apps/api/dist/server.js"], "worker": ["scripts/query-worker.mjs", "--watch"]}
                processes[role] = subprocess.Popen(
                    ["node", *entries[role]], cwd=workspace, env=environment, stdout=log, stderr=log,
                )

            def boot():
                start("api")
                start("worker")
                ready(opener, origin, processes)

            try:
                environment["DATABASE_URL"] = json.loads((workspace / ".local/database.json").read_text())["url"]
                migration = json.loads(run("node", "scripts/migrate.mjs"))
                boot()
                health = json.loads(response(opener, origin, "/health"))
                if health != {"status": "ok", "data_mode": "offline_fixture", "collector_enabled": False}:
                    raise ValueError("Runtime health did not assert offline configuration")
                for path in ("/", "/zh-CN", "/assets/soldbench.css", "/docs/en/quickstart", "/docs/zh-CN/quickstart"):
                    if not response(opener, origin, path):
                        raise ValueError(f"Empty runtime response for {path}")
                demo = json.loads(run("node", "scripts/collector-html-demo.mjs", "--http"))
                media_facts = (demo["pageCount"], demo["availablePrimaryImages"], demo["externalNetworkRequests"])
                if demo["status"] != "completed" or media_facts != (2, 8, 0):
                    raise ValueError("Runtime collector replay did not match the release fixture")
                evidence = {**original, "migrations": len(migration["applied"]), "loopback_http_requests": demo["localHttpRequests"],
                            "pages": media_facts[0], "primary_images": media_facts[1], "external_source_requests": media_facts[2],
                            "production_verified": False}
                if clients:
                    evidence["clients"] = check_clients(run, workspace, opener, origin, processes, start)
                if restore_backup:
                    evidence["restore"] = restore(run, workspace, environment, demo["sourceId"], boot, shutdown)
                return evidence
            finally:
                shutdown()
                run("node", "scripts/local-db.mjs", "stop")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--log", required=True, type=Path)
    parser.add_argument("--restore", action="store_true")
    parser.add_argument("--clients", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(exercise(args.archive, args.log, args.restore, args.clients)))
    except (ValueError, OSError, tarfile.TarError, subprocess.TimeoutExpired) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
