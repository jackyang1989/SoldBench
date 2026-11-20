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


def exercise(source, output):
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
        }
        with output.open("x", encoding="utf8") as log:
            def run(*command):
                result = subprocess.run(command, cwd=workspace, env=environment, text=True, capture_output=True,
                                        timeout=60)
                log.write(result.stdout + result.stderr)
                log.flush()
                if result.returncode:
                    raise ValueError(f"{command[0]} exited {result.returncode}; inspect the rehearsal log")
                return result.stdout

            run("npm", "ci", "--omit=dev", "--offline", "--no-audit", "--no-fund")
            run("node", "scripts/local-db.mjs", "start")
            processes = []
            try:
                environment["DATABASE_URL"] = json.loads((workspace / ".local/database.json").read_text())["url"]
                migration = json.loads(run("node", "scripts/migrate.mjs"))
                for entry in ("apps/api/dist/server.js", "scripts/query-worker.mjs"):
                    args = ["node", entry] + (["--watch"] if entry.endswith("query-worker.mjs") else [])
                    processes.append(subprocess.Popen(args, cwd=workspace, env=environment, stdout=log, stderr=log))
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                ready(opener, origin, processes)
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
                return {**original, "migrations": len(migration["applied"]), "loopback_http_requests": demo["localHttpRequests"],
                        "pages": media_facts[0], "primary_images": media_facts[1], "external_source_requests": media_facts[2],
                        "production_verified": False}
            finally:
                for process in reversed(processes):
                    stop(process)
                run("node", "scripts/local-db.mjs", "stop")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--log", required=True, type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(exercise(args.archive, args.log)))
    except (ValueError, OSError, tarfile.TarError, subprocess.TimeoutExpired) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
