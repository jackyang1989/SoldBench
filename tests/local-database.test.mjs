import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { assertLocalDatabaseUrl, database, prepareDatabase } from "@soldbench/db";

const execute = promisify(execFile);

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

test("migration CLI can initialize and reuse the authorized test socket database", async () => {
  const db = database(process.env.DATABASE_URL);
  try {
    await assert.rejects(prepareDatabase(db, "verify"), /database_schema_not_initialized/);
  } finally {
    await db.end();
  }
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

test("verify startup rejects missing, changed and unknown schema versions without rewriting them", async () => {
  const db = database(process.env.DATABASE_URL);
  const client = await db.connect();
  try {
    await prepareDatabase(db, "verify");
    for (const [sql, expected] of [
      ["DELETE FROM soldbench_migrations WHERE name='0001_baseline.sql'", /Missing database migration/],
      [
        "UPDATE soldbench_migrations SET sha256='changed' WHERE name='0001_baseline.sql'",
        /Applied migration changed/,
      ],
      [
        "INSERT INTO soldbench_migrations(name,sha256) VALUES('9999_future.sql','test')",
        /database_schema_newer_or_unknown/,
      ],
    ]) {
      await client.query("BEGIN");
      await client.query(sql);
      await assert.rejects(prepareDatabase(client, "verify"), expected);
      await client.query("ROLLBACK");
    }
    await prepareDatabase(db, "verify");
  } finally {
    client.release();
    await db.end();
  }
});

test("API, query worker and collector start with a runtime-only role while migration lease is held", async () => {
  const root = await mkdtemp(join(tmpdir(), "soldbench-runtime-role-"));
  const originProbe = createServer();
  await new Promise((resolve, reject) => originProbe.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = originProbe.address().port;
  await new Promise((resolve) => originProbe.close(resolve));
  const db = database(process.env.DATABASE_URL);
  const privileged = await db.connect();
  const runtimeURL = new URL(process.env.DATABASE_URL);
  runtimeURL.username = "soldbench_runtime_test";
  const runtime = database(runtimeURL.toString());
  const original = {
    ...process.env,
    PORT: String(port),
    APP_ORIGIN: `http://127.0.0.1:${port}`,
    LOCAL_STATE_ROOT: root,
    COLLECTOR_DEMO_DIR: root,
    MEDIA_ROOT: join(root, "media"),
  };
  const role = { ...original, DATABASE_URL: runtimeURL.toString(), DB_STARTUP_MODE: "verify" };
  const args = (file, ...argv) => ["--import", "./scripts/test-network.mjs", file, ...argv];
  const run = (env, file, ...argv) => execute(process.execPath, args(file, ...argv), { env, timeout: 6000 });
  let api;
  try {
    await privileged.query("CREATE ROLE soldbench_runtime_test LOGIN");
    await privileged.query("GRANT USAGE ON SCHEMA public TO soldbench_runtime_test");
    await privileged.query(
      "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO soldbench_runtime_test",
    );
    await privileged.query("GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO soldbench_runtime_test");
    await privileged.query("REVOKE INSERT,UPDATE,DELETE ON soldbench_migrations FROM soldbench_runtime_test");
    await assert.rejects(
      runtime.query("CREATE TABLE public.runtime_ddl_forbidden(id int)"),
      /permission denied/,
    );
    await assert.rejects(runtime.query("DELETE FROM soldbench_migrations"), /permission denied/);
    const demo = JSON.parse(
      (await run(original, "scripts/collector-html-demo.mjs", "--prepare-only")).stdout,
    );
    await privileged.query("SELECT pg_advisory_lock(hashtext('soldbench:migrations'))");
    api = spawn(process.execPath, args("apps/api/dist/server.js"), { env: role, stdio: "pipe" });
    let errorOutput = "";
    api.stderr.on("data", (chunk) => {
      errorOutput += chunk;
    });
    const deadline = performance.now() + 5000;
    let ready;
    while (performance.now() < deadline && api.exitCode === null) {
      ready = await fetch(`${role.APP_ORIGIN}/ready`, { signal: AbortSignal.timeout(500) }).catch(() => null);
      if (ready?.status === 200) break;
      await setTimeout(40);
    }
    assert.equal(ready?.status, 200, errorOutput);
    await run(role, "scripts/query-worker.mjs", "--once");
    const collector = await run(
      role,
      "scripts/collector-supervisor.mjs",
      `--source=${demo.sourceId}`,
      `--spool=${root}`,
    );
    assert.equal(JSON.parse(collector.stdout).cycles[0].status, "completed");
    assert.equal((await (await fetch(`${role.APP_ORIGIN}/ready`)).json()).query_worker, "recent");
    assert.equal(
      (
        await runtime.query(
          "SELECT count(*)::int AS total FROM listing_images WHERE source_id=$1 AND state='available'",
          [demo.sourceId],
        )
      ).rows[0].total,
      8,
    );
  } finally {
    if (api?.exitCode === null && api.signalCode === null) {
      const closed = new Promise((resolve) => api.once("close", resolve));
      api.kill("SIGTERM");
      await closed;
    }
    await privileged.query("SELECT pg_advisory_unlock(hashtext('soldbench:migrations'))");
    privileged.release();
    await runtime.end();
    await db.end();
    await rm(root, { force: true, recursive: true });
  }
});
