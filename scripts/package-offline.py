#!/usr/bin/env python3
"""Build or verify a checksummed, loopback-only SoldBench runtime archive."""
import argparse
import gzip
import hashlib
import io
import json
import os
import re
import subprocess
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = "soldbench.offline-runtime.v1"
MANIFEST = "runtime-manifest.json"
MAX_BYTES = 32 * 1024 * 1024
OPERATOR_SCRIPTS = """
collector-demo collector-fixture-file collector-handoff collector-html-demo collector-intake
collector-launcher collector-maintenance collector-refresh collector-report collector-supervisor
collector-worker dev local-db migrate offline-mail payment-fixture payment-reconcile privacy-recovery
public-fixture query-worker
""".split()
FIXED_FILES = (
    "package.json", "package-lock.json", "apps/web/src/site.css", "apps/web/src/site.js",
    "tests/fixtures/html/profile.json", "tests/fixtures/html/search.html", "v14_gameboy_58_verified.json",
    "scripts/package-offline.py", *(f"scripts/{name}.mjs" for name in OPERATOR_SCRIPTS),
)


def sha(value):
    return hashlib.sha256(value).hexdigest()


def runtime_path(name):
    return (name in FIXED_FILES or
            re.fullmatch(r"(?:apps|packages)/[a-z-]+/(?:package\.json|dist/[a-z][a-z0-9-]*\.(?:js|d\.ts))", name) or
            name == "apps/api/dist/developer/assets.json" or
            re.fullmatch(r"packages/db/migrations/[0-9]{4}_[a-z0-9_]+\.sql", name))


def clean_revision():
    def git(*args):
        return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()

    if git("status", "--porcelain", "--untracked-files=no"):
        raise ValueError("Commit the tracked runtime candidate before packaging it")
    return git("rev-parse", "HEAD")


def inventory():
    files = {ROOT / name for name in FIXED_FILES}
    for workspace in ("apps", "packages"):
        for package in sorted((ROOT / workspace).glob("*/package.json")):
            files.add(package)
            dist = package.parent / "dist"
            if not (dist / "index.js").is_file():
                raise ValueError(f"Build {package.parent.relative_to(ROOT)} before packaging")
            files.update(file for file in dist.glob("*.js"))
            files.update(file for file in dist.glob("*.d.ts"))
    files.add(ROOT / "apps/api/dist/developer/assets.json")
    migrations = sorted((ROOT / "packages/db/migrations").glob("[0-9][0-9][0-9][0-9]_*.sql"))
    if not migrations:
        raise ValueError("Missing runtime migrations")
    files.update(migrations)
    total = 0
    for path in sorted(files):
        if not path.is_file() or not path.resolve().is_relative_to(ROOT) or path.resolve() != path:
            raise ValueError(f"Invalid runtime input: {path.relative_to(ROOT)}")
        size = path.stat().st_size
        total += size
        if total > MAX_BYTES:
            raise ValueError("Runtime archive exceeds its size limit")
        yield path.relative_to(ROOT).as_posix(), path.read_bytes()


def pack(output):
    revision = clean_revision()
    recorded = {}
    with tempfile.NamedTemporaryFile(prefix=".soldbench-runtime-", dir=output.parent) as staging:
        with gzip.GzipFile(filename="", mode="wb", fileobj=staging, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|") as archive:
                def add(name, data):
                    info = tarfile.TarInfo(f"soldbench/{name}")
                    info.mode = 0o644
                    info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))

                for name, data in inventory():
                    add(name, data)
                    recorded[name] = {"sha256": sha(data), "bytes": len(data)}
                manifest = {"schema": SCHEMA, "revision": revision, "mode": "offline_fixture",
                            "collector_enabled": False, "payments_mode": "offline", "files": recorded}
                add(MANIFEST, (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode())
        staging.flush()
        os.fsync(staging.fileno())
        verify(Path(staging.name))
        if clean_revision() != revision:
            raise ValueError("Repository changed while packaging")
        os.link(staging.name, output)


def verify(path):
    found = {}
    manifest = None
    total = 0
    if not path.is_file() or path.stat().st_size > MAX_BYTES:
        raise ValueError("Invalid runtime archive")
    with tarfile.open(path, mode="r|gz") as archive:
        for member in archive:
            prefix, sep, name = member.name.partition("/")
            if (prefix != "soldbench" or not sep or (name != MANIFEST and not runtime_path(name))
                    or not member.isfile()
                    or name in found or (name == MANIFEST and manifest is not None)):
                raise ValueError("Unexpected or duplicate archive member")
            total += member.size
            if total > MAX_BYTES or len(found) > 2000:
                raise ValueError("Runtime archive exceeds its contents limit")
            with archive.extractfile(member) as handle:
                data = handle.read()
            if name == MANIFEST:
                manifest = json.loads(data)
            else:
                found[name] = {"sha256": sha(data), "bytes": len(data)}
    if (not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA
            or manifest.get("mode") != "offline_fixture" or manifest.get("collector_enabled") is not False
            or manifest.get("payments_mode") != "offline" or manifest.get("files") != found
            or not isinstance(manifest.get("revision"), str)
            or not re.fullmatch(r"[0-9a-f]{40}", manifest["revision"])
            or not set(FIXED_FILES).issubset(found)
            or not {"apps/api/dist/server.js", "apps/api/dist/developer/assets.json",
                    "packages/db/dist/index.js", "packages/db/migrations/0001_baseline.sql"}.issubset(found)):
        raise ValueError("Runtime manifest mismatch")
    with path.open("rb") as handle:
        digest = hashlib.sha256()
        for block in iter(lambda: handle.read(1024 * 128), b""):
            digest.update(block)
    return {"mode": "offline_fixture", "revision": manifest["revision"],
            "files": len(found), "sha256": digest.hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("pack", "verify"))
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    try:
        if args.action == "pack":
            pack(args.archive.absolute())
        print(json.dumps(verify(args.archive)))
    except (ValueError, OSError, tarfile.TarError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
