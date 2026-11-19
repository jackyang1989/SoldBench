import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertLocalDatabaseUrl } from "@soldbench/db";

test("offline tools validate the PG-effective target, not the URL display host", () => {
  for (const url of ["postgresql://localhost/demo", "postgresql://127.0.0.1/demo", "postgresql://[::1]/demo"])
    assert.doesNotThrow(() => assertLocalDatabaseUrl(url));
  assert.doesNotThrow(() =>
    assertLocalDatabaseUrl("postgresql://localhost/demo?host=%2Ftmp%2Fapproved&port=55439", [
      "/tmp/approved",
    ]),
  );
  for (const url of [
    "postgresql://localhost/demo?host=remote.example.test",
    "postgresql://localhost/demo?host=localhost,remote.example.test",
    "postgresql://localhost/demo?hostaddr=8.8.8.8",
    "postgresql://localhost/demo?service=remote",
    "postgresql://localhost/demo?host=localhost&host=remote.example.test",
    "postgresql://localhost/demo?host=%2Ftmp%2Funapproved",
    "postgresql://localhost/demo?sslkey=%2Fprivate%2Fsecret",
    "postgresql://remote.example.test/demo",
    "https://localhost/demo",
  ])
    assert.throws(() => assertLocalDatabaseUrl(url, ["/tmp/approved"]));
  const old = process.env.PGHOST;
  try {
    process.env.PGHOST = "remote.example.test";
    assert.throws(() => assertLocalDatabaseUrl("postgresql:///demo"));
  } finally {
    if (old === undefined) delete process.env.PGHOST;
    else process.env.PGHOST = old;
  }
});

test("offline entrypoints reject a nonlocal effective PG target before any connection", () => {
  const endpoints = ["apps/api/dist/server.js", "scripts/query-worker.mjs", "scripts/migrate.mjs"];
  for (const entry of endpoints) {
    const result = spawnSync(process.execPath, ["--import", "./scripts/test-network.mjs", entry], {
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://localhost/soldbench?host=remote.example.test",
        PAYMENT_FIXTURES: "false",
      },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 1, `${entry} ${result.error ?? ""}`);
    assert.match(result.stderr, /database_target_must_be_local/);
    assert.doesNotMatch(result.stderr, /ENOTFOUND|ECONNREFUSED|forbidden_network/);
    assert.equal(result.stdout, "");
  }
});

test("migration CLI can initialize and reuse the authorized test socket database", () => {
  const run = () =>
    spawnSync(process.execPath, ["--import", "./scripts/test-network.mjs", "scripts/migrate.mjs"], {
      encoding: "utf8",
      timeout: 10000,
    });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.ok(JSON.parse(first.stdout).applied.length >= 22);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout).applied, []);
});
