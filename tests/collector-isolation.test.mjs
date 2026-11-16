import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  CollectorStore,
  createFixtureArtifact,
  digest,
  fixtureResponse,
  provisionFixtureSource,
} from "@soldbench/collector";
import { database, migrate } from "@soldbench/db";
import { workerEnvironment } from "../scripts/collector-launcher.mjs";

const db = database(process.env.DATABASE_URL),
  roots = [],
  children = [],
  fixed = "2026-11-16T12:00:00Z";
before(async () => migrate(db));
async function waitFor(check, limit = 5000) {
  const end = performance.now() + limit;
  while (performance.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("test_process_deadline");
}
function start(script, args = [], env = {}) {
  const child = spawn(process.execPath, ["--import", "./scripts/test-network.mjs", script, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const state = { child, output: "", errors: "" };
  child.stdout.on("data", (v) => {
    state.output += v;
  });
  child.stderr.on("data", (v) => {
    state.errors += v;
  });
  state.exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return state;
}
after(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await db.end();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
async function root() {
  const value = await mkdtemp(join(tmpdir(), "soldbench-isolation-"));
  roots.push(value);
  return value;
}
async function preparedDemo(directory) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "./scripts/test-network.mjs", "scripts/collector-html-demo.mjs", "--prepare-only"],
      { encoding: "utf8", env: { ...process.env, COLLECTOR_DEMO_DIR: directory } },
    ),
  );
}

test("collector child environment excludes application credentials and Node preloads", () => {
  const environment = workerEnvironment({
    DATABASE_URL: "postgresql://localhost/fixture",
    COLLECTOR_DEMO_DIR: "/tmp/fixture",
    PATH: "/usr/bin",
    NODE_OPTIONS: "--import=untrusted",
    NODE_PATH: "untrusted",
    STRIPE_SECRET_KEY: "never-pass",
    SESSION_SECRET: "never-pass",
    COMPSNIPER_API_KEY: "never-pass",
    COLLECTOR_ENABLED: "true",
    DATA_MODE: "live",
  });
  assert.deepEqual(
    Object.keys(environment).sort(),
    ["COLLECTOR_DEMO_DIR", "COLLECTOR_ENABLED", "DATABASE_URL", "DATA_MODE", "PATH", "PAYMENTS_MODE"].sort(),
  );
  assert.equal(environment.COLLECTOR_ENABLED, "false");
  assert.equal(environment.DATA_MODE, "offline_fixture");
});

test("bounded launcher executes an owned worker and reports its actual final cycle", async () => {
  const directory = await root(),
    prepared = await preparedDemo(directory),
    run = start(
      "scripts/collector-launcher.mjs",
      [`--fixture=${prepared.artifactPath}`, "--max-ms=5000", "--grace-ms=200", "--heap-mb=128"],
      { COLLECTOR_DEMO_DIR: directory },
    ),
    outcome = await run.exited;
  assert.equal(outcome.code, 0, run.errors);
  const report = JSON.parse(run.output);
  assert.equal(report.workerExited, true);
  assert.equal(report.timedOut, false);
  assert.equal(report.cycle.status, "completed");
  assert.equal(report.cycle.pageCount, 2);
  assert.equal(report.limits.v8HeapMb, 128);
  assert.throws(() => process.kill(report.workerPid, 0), /ESRCH/);
});

test("watchdog kills a stalled child after a bounded grace interval without consuming a queued job", async () => {
  const directory = await root(),
    prepared = await preparedDemo(directory),
    blocker = await db.connect();
  await blocker.query("SELECT pg_advisory_lock(hashtext('soldbench:migrations'))");
  try {
    const run = start(
        "scripts/collector-launcher.mjs",
        [`--fixture=${prepared.artifactPath}`, "--max-ms=300", "--grace-ms=100"],
        { COLLECTOR_DEMO_DIR: directory },
      ),
      result = await run.exited;
    assert.equal(result.code, 124, run.errors);
    const report = JSON.parse(run.output);
    assert.equal(report.timedOut, true);
    assert.equal(report.workerExited, true);
    assert.ok(report.elapsedMs < 3000);
    assert.throws(() => process.kill(report.workerPid, 0), /ESRCH/);
    assert.equal((await new CollectorStore(db).view(prepared.jobId)).status, "queued");
  } finally {
    await blocker.query("SELECT pg_advisory_unlock(hashtext('soldbench:migrations'))");
    blocker.release();
  }
});

test("parent termination propagates to a stalled child and waits for child exit", async () => {
  const directory = await root(),
    prepared = await preparedDemo(directory),
    blocker = await db.connect();
  await blocker.query("SELECT pg_advisory_lock(hashtext('soldbench:migrations'))");
  try {
    const run = start(
      "scripts/collector-launcher.mjs",
      [`--fixture=${prepared.artifactPath}`, "--max-ms=5000", "--grace-ms=100"],
      { COLLECTOR_DEMO_DIR: directory },
    );
    await waitFor(
      async () =>
        (
          await db.query(
            "SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND application_name='soldbench' AND query LIKE '%soldbench:migrations%' AND pid<>pg_backend_pid()",
          )
        ).rowCount > 0,
    );
    run.child.kill("SIGTERM");
    assert.equal((await run.exited).code, 143, run.errors);
    const report = JSON.parse(run.output);
    assert.equal(report.interrupted, "SIGTERM");
    assert.equal(report.workerExited, true);
    assert.throws(() => process.kill(report.workerPid, 0), /ESRCH/);
  } finally {
    await blocker.query("SELECT pg_advisory_unlock(hashtext('soldbench:migrations'))");
    blocker.release();
  }
});

test("killing an active collector preserves a live API and recovery conservatively settles unknown dispatch budget", async () => {
  const source = await provisionFixtureSource(db, fixed),
    store = new CollectorStore(db, () => fixed),
    queryHash = digest("isolation-query"),
    jobId = await store.enqueue({ ...source, queryHash, runKey: "isolation", asOf: fixed }),
    directory = await root(),
    frames = new Map();
  for (let i = 0; i < 3; i++)
    frames.set(`page:${i ? `page-${i}` : "start"}`, [
      fixtureResponse({
        schema: "soldbench.synthetic-page.v1",
        synthetic: true,
        sourceId: source.sourceId,
        queryHash,
        cursor: i ? `page-${i}` : "start",
        nextCursor: i === 2 ? null : `page-${i + 1}`,
        asOf: fixed,
        empty: false,
        records: [
          {
            listingId: `listing-${i}`,
            title: `Synthetic ${i}`,
            candidate: {
              sourceId: source.sourceId,
              eventKey: `event-${i}`,
              identityVerified: true,
              comparable: true,
              priceStatus: "verified_actual",
              format: "fixed_price",
              currency: "USD",
              itemCents: 1000,
              shippingCents: 0,
              shippingStatus: "verified_free_shipping",
              time: { precision: "instant", value: "2026-11-15T12:00:00Z" },
            },
          },
        ],
      }),
    ]);
  const artifact = createFixtureArtifact(
      { sourceId: source.sourceId, jobId, queryHash, asOf: fixed },
      frames,
    ),
    path = join(directory, "artifact.json");
  await writeFile(path, JSON.stringify(artifact));
  const api = start("tests/fixtures/process/api-server.mjs");
  const ready = await waitFor(() => {
      try {
        return JSON.parse(api.output);
      } catch {
        return null;
      }
    }),
    base = `http://127.0.0.1:${ready.port}`;
  const healthy = async () => {
    for (const endpoint of ["/health", "/ready"]) {
      const r = await fetch(base + endpoint, { signal: AbortSignal.timeout(2000) });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).data_mode, "offline_fixture");
    }
    const r = await fetch(`${base}/v1/sold?q=synthetic`, { signal: AbortSignal.timeout(2000) });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error.code, "unauthenticated");
  };
  await healthy();
  const blocker = await db.connect();
  await blocker.query("SELECT pg_advisory_lock(789003)");
  await db.query(
    "CREATE FUNCTION collector_isolation_block() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='page' AND NEW.state='settled' AND EXISTS(SELECT 1 FROM collector_pages p WHERE p.job_id=NEW.job_id) THEN PERFORM pg_advisory_xact_lock(789003); END IF; RETURN NEW; END $$",
  );
  await db.query(
    "CREATE TRIGGER collector_isolation_block BEFORE UPDATE ON collector_dispatches FOR EACH ROW EXECUTE FUNCTION collector_isolation_block()",
  );
  try {
    const collector = start("scripts/collector-worker.mjs", [`--fixture=${path}`, `--clock=${fixed}`], {
      COLLECTOR_DEMO_DIR: directory,
    });
    await waitFor(async () => {
      const job = await store.view(jobId);
      return job.page_count === 1 && job.bytes_reserved !== "0";
    });
    await healthy();
    collector.child.kill("SIGKILL");
    assert.equal((await collector.exited).signal, "SIGKILL");
    await healthy();
    assert.equal(
      (await db.query("SELECT * FROM collector_watermarks WHERE source_id=$1", [source.sourceId])).rowCount,
      0,
    );
  } finally {
    await blocker.query("SELECT pg_advisory_unlock(789003)");
    blocker.release();
    await db.query("DROP TRIGGER collector_isolation_block ON collector_dispatches");
    await db.query("DROP FUNCTION collector_isolation_block()");
  }
  const resumed = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "./scripts/test-network.mjs",
        "scripts/collector-worker.mjs",
        `--fixture=${path}`,
        "--clock=2026-11-16T12:01:01Z",
      ],
      { encoding: "utf8", env: { ...process.env, COLLECTOR_DEMO_DIR: directory } },
    ),
  );
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.pageCount, 3);
  assert.equal(resumed.requestsReserved, 4);
  const run = (
    await db.query("SELECT bytes_unconfirmed FROM collector_runs WHERE id=$1", [
      (await store.view(jobId)).collector_run_id,
    ])
  ).rows[0];
  assert.equal(run.bytes_unconfirmed, String(1024 * 1024));
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM sale_events WHERE source_id=$1", [source.sourceId])).rows[0]
      .n,
    3,
  );
  await healthy();
  api.child.kill("SIGTERM");
  assert.equal((await api.exited).code, 0);
});
