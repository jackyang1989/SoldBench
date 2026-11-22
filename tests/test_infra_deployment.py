import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote
import yaml

ROOT = Path(__file__).resolve().parents[1]
INFRA = ROOT / "infra"


class InfraDeploymentTests(unittest.TestCase):
    def test_compose_prod_topology_enforces_isolation_and_safe_defaults(self):
        compose = yaml.safe_load((INFRA / "compose.prod.yaml").read_text())
        self.assertIn("services", compose)
        self.assertIn("networks", compose)

        networks = compose["networks"]
        self.assertTrue(networks["internal"].get("internal") is True)
        self.assertIn("edge", networks)
        self.assertIn("collector_egress", networks)

        services = compose["services"]
        expected_services = {
            "postgres",
            "redis",
            "migrate",
            "api",
            "query-worker",
            "collector-supervisor",
            "caddy",
        }
        self.assertEqual(set(services.keys()), expected_services)

        # Network isolation: only collector-supervisor uses collector_egress; collector-supervisor never joins edge.
        for name, svc in services.items():
            svc_nets = set(svc.get("networks", []))
            if name == "collector-supervisor":
                self.assertEqual(svc_nets, {"internal", "collector_egress"})
                self.assertNotIn("edge", svc_nets)
            elif name == "caddy":
                self.assertEqual(svc_nets, {"edge"})
                self.assertNotIn("internal", svc_nets)
            elif name == "api":
                self.assertEqual(svc_nets, {"edge", "internal"})
                self.assertNotIn("collector_egress", svc_nets)
            else:
                self.assertEqual(svc_nets, {"internal"})
                self.assertNotIn("edge", svc_nets)
                self.assertNotIn("collector_egress", svc_nets)

        # Hardening and <=60s stop grace period on runtime services.
        for name in ("api", "query-worker", "collector-supervisor", "caddy"):
            svc = services[name]
            self.assertTrue(svc.get("read_only") is True, f"{name} must run read_only")
            self.assertIn("no-new-privileges:true", svc.get("security_opt", []))
            self.assertEqual(svc.get("cap_drop"), ["ALL"])
            grace = int(str(svc.get("stop_grace_period", "60s")).rstrip("s"))
            self.assertLessEqual(grace, 60)

        # Collector must receive zero auth, payment, or encryption secrets and keep offline defaults.
        collector_env = services["collector-supervisor"]["environment"]
        forbidden_secrets = (
            "STRIPE",
            "PAYPAL",
            "SESSION",
            "SOURCE_URL_ENCRYPTION_KEY",
            "MIGRATION_DATABASE_URL",
        )
        for key in collector_env:
            for secret in forbidden_secrets:
                self.assertNotIn(secret, key)
        self.assertIn("false", str(collector_env["COLLECTOR_ENABLED"]))
        self.assertIn("offline_fixture", str(collector_env["DATA_MODE"]))
        self.assertEqual(collector_env["PAYMENTS_MODE"], "offline")
        self.assertEqual(collector_env["DB_STARTUP_MODE"], "verify")

        api_env = services["api"]["environment"]
        self.assertIn("false", str(api_env["COLLECTOR_ENABLED"]))
        self.assertIn("offline_fixture", str(api_env["DATA_MODE"]))
        self.assertIn("offline", str(api_env["PAYMENTS_MODE"]))
        self.assertEqual(api_env["DB_STARTUP_MODE"], "verify")

    def test_dockerfiles_pin_node_non_root_and_no_third_party_scrapers(self):
        runtime_df = (INFRA / "Dockerfile.runtime").read_text()
        collector_df = (INFRA / "Dockerfile.collector").read_text()
        for name, text in (("Dockerfile.runtime", runtime_df), ("Dockerfile.collector", collector_df)):
            self.assertIn("FROM node:22.23.3-slim", text, name)
            self.assertIn("USER node", text, name)
            self.assertIn("STOPSIGNAL SIGTERM", text, name)
            self.assertIn("COLLECTOR_ENABLED=false", text, name)
            self.assertIn("DATA_MODE=offline_fixture", text, name)
            for banned in ("apify", "scrapingbee", "brightdata", "oxylabs", "zyte", "zenrows"):
                self.assertNotIn(banned, text.lower())
        self.assertIn("INSTALL_CHROMIUM=0", collector_df)
        self.assertIn("HEALTHCHECK", runtime_df)

    def test_caddyfile_and_prod_env_template_preserve_target_boundaries(self):
        caddy = (INFRA / "Caddyfile").read_text()
        self.assertIn("soldbench.com", caddy)
        self.assertIn("api.soldbench.com", caddy)
        self.assertIn("support@soldbench.com", caddy)
        self.assertIn("reverse_proxy api:3000", caddy)
        self.assertIn("Strict-Transport-Security", caddy)
        self.assertIn("X-Content-Type-Options", caddy)

        env_tpl = (INFRA / ".env.production.example").read_text()
        self.assertIn("COLLECTOR_ENABLED=false", env_tpl)
        self.assertIn("DATA_MODE=offline_fixture", env_tpl)
        self.assertIn("PAYMENTS_MODE=offline", env_tpl)
        self.assertIn("DB_STARTUP_MODE=verify", env_tpl)
        self.assertIn("MIGRATION_DATABASE_URL=", env_tpl)
        self.assertIn("COLLECTOR_DATABASE_URL=", env_tpl)
        self.assertIsNone(re.search(r"sk_(live|test)_[0-9a-zA-Z]{16,}", env_tpl))

    def test_backup_restore_script_syntax_and_live_pg16_tamper_detection(self):
        script = INFRA / "backup-restore.sh"
        self.assertTrue(os.access(script, os.X_OK), "infra/backup-restore.sh must be executable")
        subprocess.run(["bash", "-n", str(script)], check=True)

        pg_bindir = subprocess.check_output(["pg_config", "--bindir"], text=True).strip()
        initdb = Path(pg_bindir) / "initdb"
        pg_ctl = Path(pg_bindir) / "pg_ctl"
        createdb = Path(pg_bindir) / "createdb"
        psql = Path(pg_bindir) / "psql"
        if not all(p.is_file() for p in (initdb, pg_ctl, createdb, psql)):
            self.skipTest("PostgreSQL 16 binaries not present")

        with tempfile.TemporaryDirectory(prefix="soldbench-pg-bak-") as tmp:
            tmp_path = Path(tmp)
            data_dir = tmp_path / "pgdata"
            sock_dir = tmp_path / "pgsock"
            backup_dir = tmp_path / "backup_out"
            sock_dir.mkdir(mode=0o700)
            subprocess.run(
                [
                    str(initdb),
                    "-D",
                    str(data_dir),
                    "--username=soldbench",
                    "--auth-local=trust",
                    "--encoding=UTF8",
                    "--no-locale",
                ],
                check=True,
                capture_output=True,
            )
            subprocess.run(
                [
                    str(pg_ctl),
                    "-D",
                    str(data_dir),
                    "-l",
                    str(tmp_path / "pg.log"),
                    "-o",
                    f"-k {sock_dir} -h '' -p 55499",
                    "-w",
                    "start",
                ],
                check=True,
                capture_output=True,
            )
            try:
                base_flags = ["-h", str(sock_dir), "-p", "55499", "-U", "soldbench"]
                subprocess.run([str(createdb), *base_flags, "src_db"], check=True, capture_output=True)
                subprocess.run([str(createdb), *base_flags, "dst_db"], check=True, capture_output=True)

                host_q = quote(str(sock_dir), safe="")
                src_url = f"postgresql://soldbench@localhost/src_db?host={host_q}&port=55499"
                dst_url = f"postgresql://soldbench@localhost/dst_db?host={host_q}&port=55499"

                subprocess.run(
                    [
                        str(psql),
                        *base_flags,
                        "-d",
                        "src_db",
                        "-v",
                        "ON_ERROR_STOP=1",
                        "-c",
                        "CREATE TABLE soldbench_migrations(id text PRIMARY KEY); "
                        "INSERT INTO soldbench_migrations VALUES ('0001'),('0002'); "
                        "CREATE TABLE infra_probe(id int PRIMARY KEY, note text NOT NULL); "
                        "INSERT INTO infra_probe VALUES (1, 'pg16-verified-ok');",
                    ],
                    check=True,
                    capture_output=True,
                )

                bak = subprocess.run(
                    [str(script), "backup", src_url, str(backup_dir)],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                meta = json.loads(bak.stdout)
                self.assertEqual(meta["schema"], "soldbench.pg-backup.v1")
                self.assertEqual(meta["migrations"], 2)
                self.assertTrue((backup_dir / "backup.dump.sha256").is_file())

                # Must refuse to overwrite existing backup directory.
                overwrite = subprocess.run(
                    [str(script), "backup", src_url, str(backup_dir)],
                    capture_output=True,
                    text=True,
                )
                self.assertNotEqual(overwrite.returncode, 0)

                ver = subprocess.run(
                    [str(script), "verify", str(backup_dir)],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(json.loads(ver.stdout)["sha256"], meta["sha256"])

                # Verify fail-closed on dump tampering.
                tampered_dir = tmp_path / "tampered"
                shutil.copytree(backup_dir, tampered_dir)
                dump_bytes = (tampered_dir / "backup.dump").read_bytes()
                (tampered_dir / "backup.dump").write_bytes(dump_bytes[:-1] + bytes([dump_bytes[-1] ^ 0xFF]))
                tampered = subprocess.run(
                    [str(script), "verify", str(tampered_dir)],
                    capture_output=True,
                    text=True,
                )
                self.assertNotEqual(tampered.returncode, 0)
                self.assertIn("backup_checksum_mismatch", tampered.stderr)

                # Restore untouched dump into fresh isolated dst_db and assert exact row parity.
                rest = subprocess.run(
                    [str(script), "restore", str(backup_dir), dst_url],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                self.assertTrue(json.loads(rest.stdout)["ok"])
                rows = subprocess.check_output(
                    [str(psql), *base_flags, "-d", "dst_db", "-Atqc", "SELECT note FROM infra_probe WHERE id=1"],
                    text=True,
                ).strip()
                self.assertEqual(rows, "pg16-verified-ok")
            finally:
                subprocess.run(
                    [str(pg_ctl), "-D", str(data_dir), "-m", "fast", "-w", "stop"],
                    capture_output=True,
                )
