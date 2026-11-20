#!/usr/bin/env python3
"""Verify an offline distribution in a temporary runtime with PostgreSQL 16."""
import argparse
import importlib.util
import json
import os
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


def ready(opener, origin, processes):
    end = time.monotonic() + 15
    while time.monotonic() < end:
        if any(process.poll() is not None for process in processes):
            raise ValueError("API or query worker exited during runtime smoke")
        try:
            state = json.loads(response(opener, origin, "/ready"))
            if state["query_worker"] == "recent":
                return
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(0.1)
    raise ValueError("Runtime did not become ready")


def stop(process):
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=6)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


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


def exercise(source, output, restore_backup=False):
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
            def run(*command):
                result = subprocess.run(command, cwd=workspace, env=environment, text=True, capture_output=True,
                                        timeout=60)
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
            processes = []

            def shutdown():
                while processes:
                    stop(processes.pop())

            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

            def boot():
                for entry in ("apps/api/dist/server.js", "scripts/query-worker.mjs"):
                    args = ["node", entry] + (["--watch"] if entry.endswith("query-worker.mjs") else [])
                    processes.append(subprocess.Popen(args, cwd=workspace, env=environment, stdout=log, stderr=log))
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
    args = parser.parse_args()
    try:
        print(json.dumps(exercise(args.archive, args.log, args.restore)))
    except (ValueError, OSError, tarfile.TarError, subprocess.TimeoutExpired) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
