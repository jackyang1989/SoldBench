#!/usr/bin/env python3
"""Verify an offline distribution in a temporary runtime with PostgreSQL 16."""
import argparse
import hashlib
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
    snapshot_before = get(result_path)["data"]
    first_comp = snapshot_before["comps"][0]
    image_path = first_comp["primary_image"]["url"]
    if not isinstance(image_path, str) or not image_path.startswith("/v1/media/"):
        raise ValueError("The delivered synthetic fixture has no primary image")

    def image_digest():
        request = urllib.request.Request(origin + image_path, headers=authorization)
        with opener.open(request, timeout=5) as reply:
            if reply.headers.get_content_type() != "image/webp" or "no-store" not in reply.headers.get("Cache-Control", ""):
                raise ValueError("Primary image response is not private WebP")
            body = reply.read(5 * 1024 * 1024 + 1)
        if not body or len(body) > 5 * 1024 * 1024:
            raise ValueError("Invalid primary image response size")
        return hashlib.sha256(body).hexdigest()

    image_before = image_digest()
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
    for script in (("sh", "developer/examples/sold.sh"), ("node", "developer/examples/sold.ts")):
        replay = json.loads(run(*script, "--claim", additions=credentials))
        if replay != {**rest, "credits_charged": 0}:
            raise ValueError(f"{script[1]} did not replay the same result without a debit")
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
    def verify_restored(revoked_source):
        if first_comp["source_id"] == revoked_source:
            raise ValueError("The retained fixture must use the other approved source")
        result = get(result_path)
        if (result["data"] != snapshot_before or result["meta"]["credits_charged"] != 0
                or get("/v1/usage")["data"] != ledger_before or image_digest() != image_before):
            raise ValueError("The restored database changed authorized evidence, image bytes or ledger")

    return {
        "verified_samples": rest["n_price_verified"], "initial_credits_charged": 1,
        "curl_replay_credits_charged": 0, "typescript_replay_credits_charged": 0,
        "mcp_stats_credits_charged": 0, "primary_image_http_verified": True,
        "worker_sigkill_retained_read": True, "api_sigkill_retained_worker": True,
        "ledger_unchanged_after_recovery": True,
    }, verify_restored


def collector_recovery_probe(run, root):
    if not (root / "scripts/collector-evidence-file.mjs").is_file():
        return None
    prepare = """
import { CollectorRefresh, CollectorStore, FixtureTransport, fixtureResponse,
         OfflineCollectorWorker, provisionFixtureSource } from '@soldbench/collector';
import { database } from '@soldbench/db';
import { PrivateMediaStore } from '@soldbench/media';
const db = database(process.env.DATABASE_URL);
try {
  const { rows: [{ day }] } = await db.query("SELECT date_trunc('day', now(), 'UTC') AS day");
  const at = offset => new Date(day.getTime() + offset * 1000).toISOString();
  let clock = at(-86460);
  const source = await provisionFixtureSource(db, clock);
  const store = new CollectorStore(db, () => clock);
  const refresh = new CollectorRefresh(store);
  const plan = await refresh.create({ ...source, query: new URLSearchParams({ q: 'Synthetic recovery probe' }),
    key: 'rehearsal-schedule-evidence', intervalSeconds: 60, maxLagSeconds: 30 });
  await refresh.materialize(source.sourceId);
  const { jobId } = await refresh.dispatchNext(source.sourceId);
  const job = await store.view(jobId);
  clock = at(-86399);
  const page = fixtureResponse({ schema: 'soldbench.synthetic-page.v1', synthetic: true,
    sourceId: source.sourceId, queryHash: job.query_hash, asOf: job.as_of.toISOString(),
    cursor: 'start', nextCursor: null, empty: true, records: [] });
  const worker = new OfflineCollectorWorker(store,
    new FixtureTransport(new Map([['page:start', [page]]])), new PrivateMediaStore('.local/collector-media'));
  if ((await worker.runOne(source.sourceId, { jobId })).status !== 'completed')
    throw new Error('collector_recovery_fixture_not_completed');
  await refresh.retire(source.sourceId, plan);
  console.log(JSON.stringify({ source: source.sourceId, from: at(-172800).slice(0, 10), until: at(0).slice(0, 10) }));
} finally {
  await db.end();
}
"""
    scope = json.loads(run("node", "--input-type=module", "--eval", prepare))
    command = ("node", "scripts/collector-evidence.mjs", *(f"--{key}={value}" for key, value in scope.items()))
    archive_path = root / ".local/collector-recovery-evidence.json"
    export = json.loads(run(*command, f"--output={archive_path}"))
    before = json.loads(archive_path.read_bytes())
    slots = before["slots"]
    if (export["slots"] != 2 or len(slots) != 2 or not slots[0]["completed_with_page_evidence"]
            or slots[0]["committed_pages"] != 1 or slots[0]["page_attempts"] != 1
            or slots[0]["page_started_on_time"] is not False or slots[1]["occurrence"] is not None):
        raise ValueError("Collector evidence did not retain the missed and cross-day slots")

    def verify_restored():
        verified = json.loads(run(*command, f"--verify={archive_path}", f"--expect-sha256={export['sha256']}"))
        after = json.loads(run(*command))
        baseline = {key: value for key, value in before.items() if key != "captured_at"}
        after.pop("captured_at")
        if not verified["verified"] or baseline != after:
            raise ValueError("Restored collector evidence differs from the archived observations")
        return {"slots": 2, "completed": 1, "missed": 1, "archive_digest_verified": True}

    return verify_restored


def prepare_spool_retention_probe(run, root, demo):
    spool = root / ".local"
    script = "scripts/collector-spool-cleanup.mjs"
    if not (root / script).is_file():
        raise ValueError("The runtime archive does not contain the collector spool maintenance command")
    fixture = json.loads(run("node", "scripts/collector-html-demo.mjs"))
    if (fixture["sourceId"] == demo["sourceId"] or fixture["status"] != "completed"
            or fixture["pageCount"] != 2 or fixture["externalNetworkRequests"] != 0):
        raise ValueError("Unexpected fixture for the spool retention rehearsal")
    expired_path = Path(fixture["artifactPath"])
    other_path = Path(demo["artifactPath"])
    expired_bytes = expired_path.read_bytes()
    other_bytes = other_path.read_bytes()
    command = ("node", script, f"--source={fixture['sourceId']}", f"--spool={spool}")
    audit = json.loads(run(*command, "--audit-retention"))
    if audit["retention"]["currentEvidence"] != {"files": 1, "bytes": str(len(expired_bytes))}:
        raise ValueError("The spool retention fixture is missing current response evidence")
    expire = """
import { database } from '@soldbench/db';
const db = database(process.env.DATABASE_URL);
try {
  const marked = await db.query(
    "UPDATE source_observations SET retention_until=clock_timestamp() WHERE source_id=$1",
    [process.argv[1]],
  );
  if (marked.rowCount !== 2) throw new Error('collector_spool_expiry_fixture_pages_mismatch');
} finally {
  await db.end();
}
"""
    run("node", "--input-type=module", "--eval", expire, fixture["sourceId"])

    def verify_restored():
        restored = json.loads(run(*command, "--audit-retention"))
        if (restored["retention"]["expiredEvidence"] != {"files": 1, "bytes": str(len(expired_bytes))}
                or expired_path.read_bytes() != expired_bytes or other_path.read_bytes() != other_bytes):
            raise ValueError("Restore did not preserve the response packs and their database expiry evidence")
        removed = json.loads(run(*command, "--prune-expired"))
        repeated = json.loads(run(*command, "--prune-expired"))
        if (removed["pruneExpiredOnly"] is not True or removed["removed"] != 1
                or repeated["removed"] != 0 or expired_path.exists() or other_path.read_bytes() != other_bytes):
            raise ValueError("Restored response pack cleanup did not respect the expired source boundary")
        return {"expired_response_packages_removed": 1, "repeat_removed": 0, "other_source_preserved": True}

    return verify_restored


def restore(run, root, environment, source_id, boot, shutdown, verify_restored=None, verify_spool=None):
    pg = Path(run("pg_config", "--bindir").strip())
    authority = environment["DATABASE_URL"]
    snapshot = root / "before-revocation.dump"
    checkpoint = root / "current-restrictions.json"
    older = root / "previous-restrictions.json"
    old_export = json.loads(run("node", "scripts/privacy-recovery.mjs", "export", str(older)))
    audit = root / "scripts/billing-audit.mjs"
    before_billing = json.loads(run("node", "scripts/billing-audit.mjs")) if audit.is_file() else None
    verify_collector = collector_recovery_probe(run, root)
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
    if not signed.get("exported") or not old_export.get("exported") or signed["sha256"] == old_export["sha256"]:
        raise ValueError("Expected distinct authoritative and previous signed checkpoints")
    shutdown()
    incident = time.monotonic()
    run(str(pg / "psql"), "--dbname", authority, "--set", "ON_ERROR_STOP=1", "--command",
        "CREATE DATABASE soldbench_rehearsal_restore")
    restored = urllib.parse.urlsplit(authority)._replace(path="/soldbench_rehearsal_restore").geturl()
    run(str(pg / "pg_restore"), "--exit-on-error", "--dbname", restored, str(snapshot))
    environment["DATABASE_URL"] = restored
    environment["PRIVACY_RESTORE_ISOLATED"] = "true"
    environment["PRIVACY_RECOVERY_MANIFEST_SHA256"] = signed["sha256"]
    replay = ["node", "scripts/privacy-recovery.mjs", "replay"]
    run(*replay, str(older), expected_error="privacy_recovery_checkpoint_digest_mismatch")
    applied = json.loads(run(*replay, str(checkpoint)))
    already = json.loads(run(*replay, str(checkpoint)))
    if applied.get("sources_quarantined") != 1 or already.get("sources_quarantined") != 0:
        raise ValueError("Source revocation checkpoint did not replay once")
    spool_retention = verify_spool() if verify_spool is not None else None
    inspect = ["node", "scripts/collector-report.mjs", f"--source={source_id}", "--check-media=8"]
    withheld = json.loads(run(*inspect))
    media = withheld["media"]
    if media["eligibleReferences"] != 0 or media["probe"]["verifiedObjects"] != 0:
        raise ValueError("Withdrawn primary images are still eligible in the restored database")
    cleanup = json.loads(run("node", "scripts/collector-maintenance.mjs", "--require-clear"))
    if cleanup["cleanupProcessed"] != 1 or cleanup["cleanupPending"] != 0:
        raise ValueError("Restored source media cleanup did not finish")
    spool_removed = None
    if (root / "scripts/collector-spool-cleanup.mjs").is_file():
        spool = root / ".local"
        purged = json.loads(run("node", "scripts/collector-spool-cleanup.mjs",
                                f"--source={source_id}", f"--spool={spool}"))
        spool_removed = purged["removed"]
        if spool_removed != 1 or purged["unverified"] != 0:
            raise ValueError("Restored source response package cleanup did not finish")
    cleared = json.loads(run(*inspect))
    media_path = root / ".local/collector-media" / source_id
    if cleared["media"]["retainedReferences"] != 0 or any(media_path.glob("*.webp")):
        raise ValueError("Restored primary image references remain after cleanup")
    if before_billing is not None:
        after_billing = json.loads(run("node", "scripts/billing-audit.mjs",
                                       f"--expect-sha256={before_billing['financial_sha256']}"))
        if after_billing != {**before_billing, "expected_snapshot_matches": True}:
            raise ValueError("Restore changed billing integrity or financial facts")
    collector_evidence = verify_collector() if verify_collector is not None else None
    run(str(pg / "psql"), "--dbname", restored, "--set", "ON_ERROR_STOP=1", "--command",
        "DELETE FROM worker_heartbeats WHERE worker_kind='query'")
    boot()
    ready_elapsed = round((time.monotonic() - incident) * 1000)
    if verify_restored is not None:
        verify_restored(source_id)
    return {
        "backup_age_at_simulated_incident_ms": round((incident - timestamp) * 1000),
        "isolated_restore_to_ready_ms": ready_elapsed,
        "old_signed_checkpoint_rejected": True,
        "source_revocation_replays": applied["sources_quarantined"], "media_cleanup_completed": True,
        "billing_integrity_verified": True if before_billing is not None else None,
        "collector_evidence": collector_evidence,
        "response_packages_removed": spool_removed,
        "spool_retention": spool_retention,
        "authorized_snapshot_verified_after_restore": True if verify_restored is not None else None,
        "production_recovery_objectives_verified": False,
    }


def exercise(source, output, restore_backup=False, clients=False, require_spool_retention=False):
    if require_spool_retention and not restore_backup:
        raise ValueError("Spool retention verification requires the restore rehearsal")
    original = BUNDLE.verify(source)
    if clients and original["schema"] != BUNDLE.SCHEMA:
        raise ValueError("Use the original client rehearsal for a v1 runtime archive")
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
            def run(*command, additions=None, expected_error=None):
                result = subprocess.run(command, cwd=workspace, env={**environment, **(additions or {})},
                                        text=True, capture_output=True, timeout=60)
                log.write(result.stdout + result.stderr)
                log.flush()
                if expected_error is not None:
                    if not result.returncode or expected_error not in result.stderr:
                        raise ValueError(f"Expected rehearsal rejection {expected_error}; inspect the rehearsal log")
                    return result.stdout
                if result.returncode:
                    postgres_log = workspace / ".local/postgres/postgres.log"
                    if postgres_log.is_file():
                        log.write(postgres_log.read_text(encoding="utf8", errors="replace")[-16384:])
                    log.flush()
                    raise ValueError(f"{command[0]} exited {result.returncode}; inspect the rehearsal log")
                return result.stdout

            run("npm", "ci", "--omit=dev", "--offline", "--no-audit", "--no-fund")
            processes = {}
            postgres_pid = workspace / ".local/postgres/data/postmaster.pid"

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
                run("node", "scripts/local-db.mjs", "start")
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
                verify_restored = None
                if clients:
                    evidence["clients"], verify_restored = check_clients(
                        run, workspace, opener, origin, processes, start,
                    )
                if restore_backup:
                    verify_spool = prepare_spool_retention_probe(run, workspace, demo) if require_spool_retention else None
                    evidence["restore"] = restore(
                        run, workspace, environment, demo["sourceId"], boot, shutdown, verify_restored, verify_spool,
                    )
                return evidence
            finally:
                try:
                    shutdown()
                finally:
                    if postgres_pid.exists():
                        run("node", "scripts/local-db.mjs", "stop")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--log", required=True, type=Path)
    parser.add_argument("--restore", action="store_true")
    parser.add_argument("--clients", action="store_true")
    parser.add_argument("--require-spool-retention", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(exercise(args.archive, args.log, args.restore, args.clients, args.require_spool_retention)))
    except (ValueError, OSError, tarfile.TarError, subprocess.TimeoutExpired) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
