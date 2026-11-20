import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("package_offline", ROOT / "scripts/package-offline.py")
BUNDLE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUNDLE)


class RuntimePackageTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "runtime.tar.gz"
        self.files = dict.fromkeys((
            *BUNDLE.FIXED_FILES, "apps/api/dist/server.js", "apps/api/dist/developer/assets.json",
            "packages/db/dist/index.js", "packages/db/migrations/0001_baseline.sql", "packages/shared/dist/i18n.js",
        ), b"synthetic")
        self.manifest = {
            "schema": BUNDLE.SCHEMA, "mode": "offline_fixture", "revision": "a" * 40,
            "collector_enabled": False, "payments_mode": "offline",
            "files": {name: {"sha256": BUNDLE.sha(data), "bytes": len(data)} for name, data in self.files.items()},
        }

    def bundle(self, extra=None):
        with tarfile.open(self.path, "w:gz") as archive:
            for name, data in (*self.files.items(), (BUNDLE.MANIFEST, json.dumps(self.manifest).encode())):
                info = tarfile.TarInfo(f"soldbench/{name}")
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
            if extra:
                archive.addfile(extra)

    def test_verifies_runtime_then_detects_changed_bytes(self):
        self.bundle()
        result = BUNDLE.verify(self.path)
        self.assertEqual(result["files"], len(self.files))
        self.assertEqual(result["sha256"], BUNDLE.sha(self.path.read_bytes()))
        self.files["apps/web/src/site.js"] = b"changed"
        self.bundle()
        with self.assertRaisesRegex(ValueError, "manifest mismatch"):
            BUNDLE.verify(self.path)

    def test_rejects_extra_duplicate_and_nonregular_archive_members(self):
        symlink = tarfile.TarInfo("soldbench/apps/web/src/site.js")
        symlink.type = tarfile.SYMTYPE
        symlink.linkname = "site.css"
        for member in (tarfile.TarInfo("soldbench/.env"), tarfile.TarInfo("soldbench/package.json"), symlink):
            with self.subTest(member=member.name):
                self.bundle(member)
                with self.assertRaisesRegex(ValueError, "Unexpected or duplicate"):
                    BUNDLE.verify(self.path)

    def test_rejects_a_manifest_that_claims_the_collector_is_enabled(self):
        self.manifest["collector_enabled"] = True
        self.bundle()
        with self.assertRaisesRegex(ValueError, "manifest mismatch"):
            BUNDLE.verify(self.path)


if __name__ == "__main__":
    unittest.main()
