import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  CollectorStore,
  createFixtureArtifact,
  digest,
  fixtureResponse,
  loadFixtureArtifact,
  OfflineCollectorWorker,
  parseFixturePage,
  provisionFixtureSource,
} from "@soldbench/collector";
import { database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";

const db = database(process.env.DATABASE_URL),
  roots = [];
const fixed = "2026-11-16T12:00:00Z";
before(async () => migrate(db));
after(async () => {
  await db.end();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
async function setup(count = 2, options = {}) {
  const source = await provisionFixtureSource(db, fixed, { maxPages: 100, ...options }),
    store = new CollectorStore(db, () => fixed);
  const hash = digest("runtime-query"),
    jobId = await store.enqueue({ ...source, queryHash: hash, runKey: "runtime", asOf: fixed });
  const root = await mkdtemp(join(tmpdir(), "soldbench-worker-"));
  roots.push(root);
  const frames = new Map();
  for (let i = 0; i < count; i++) {
    const cursor = i === 0 ? "start" : `page-${i}`;
    frames.set(`page:${cursor}`, [
      fixtureResponse({
        schema: "soldbench.synthetic-page.v1",
        synthetic: true,
        sourceId: source.sourceId,
        queryHash: hash,
        cursor,
        nextCursor: i === count - 1 ? null : `page-${i + 1}`,
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
  }
  const artifact = createFixtureArtifact(
      { sourceId: source.sourceId, jobId, queryHash: hash, asOf: fixed },
      frames,
    ),
    path = join(root, "artifact.json");
  await writeFile(path, JSON.stringify(artifact), { mode: 0o600 });
  return { ...source, store, jobId, root, frames, artifact, path, hash };
}
function args(x, extra = []) {
  return [
    "--import",
    "./scripts/test-network.mjs",
    "scripts/collector-worker.mjs",
    `--fixture=${x.path}`,
    `--clock=${fixed}`,
    ...extra,
  ];
}
function env(x) {
  return { ...process.env, COLLECTOR_DEMO_DIR: x.root };
}
function run(x, extra = [], clock = fixed) {
  const values = args(x, extra).filter((v) => !v.startsWith("--clock="));
  values.push(`--clock=${clock}`);
  return JSON.parse(execFileSync(process.execPath, values, { encoding: "utf8", env: env(x) }));
}

test("two independent worker processes continue one bound artifact and status inspection does not refresh success time", async () => {
  const x = await setup();
  const first = run(x, ["--max-pages=1"]);
  assert.equal(first.status, "retry");
  assert.equal(first.pageCount, 1);
  assert.equal(first.failureAttempts, 0);
  assert.equal(
    (await db.query("SELECT * FROM collector_watermarks WHERE source_id=$1", [x.sourceId])).rowCount,
    0,
  );
  const second = run(x, [], "2026-11-16T12:00:02Z");
  assert.equal(second.status, "completed");
  assert.equal(second.fixtureResponses, 1);
  assert.equal(second.requestsReserved, 2);
  assert.equal(second.pageCount, 2);
  assert.notEqual(first.pid, second.pid);
  const heartbeat = await readFile(second.heartbeatPath, "utf8");
  const inspected = run(x, ["--status=true"], "2026-11-16T12:50:00Z");
  assert.equal(inspected.kind, "inspection");
  assert.equal(inspected.lastSuccessAt, second.lastSuccessAt);
  assert.equal(await readFile(second.heartbeatPath, "utf8"), heartbeat);
  assert.equal(
    (
      await db.query("SELECT count(*)::int n FROM collector_health_snapshots WHERE source_id=$1", [
        x.sourceId,
      ])
    ).rows[0].n,
    3,
  );
});

test("response attempt positions survive process restart after transient upstream failure", async () => {
  const x = await setup(1);
  const success = x.frames.get("page:start")[0];
  x.frames.set("page:start", [
    { status: 503, contentType: "application/json", bytes: Buffer.from("{}") },
    success,
  ]);
  x.artifact = createFixtureArtifact(
    { sourceId: x.sourceId, jobId: x.jobId, queryHash: x.hash, asOf: fixed },
    x.frames,
  );
  await writeFile(x.path, JSON.stringify(x.artifact));
  const first = run(x);
  assert.equal(first.status, "retry");
  assert.equal(first.failureAttempts, 1);
  const second = run(x, [], "2026-11-16T12:01:01Z");
  assert.equal(second.status, "completed");
  assert.equal(second.requestsReserved, 2);
  assert.equal(second.failureAttempts, 1);
  assert.deepEqual(
    (
      await db.query(
        "SELECT fixture_response_index FROM collector_dispatches WHERE job_id=$1 ORDER BY fixture_response_index",
        [x.jobId],
      )
    ).rows.map((r) => r.fixture_response_index),
    [0, 1],
  );
});

test("changing a bound artifact is rejected before another dispatch or evidence mutation", async () => {
  const x = await setup();
  run(x, ["--max-pages=1"]);
  const before = await x.store.view(x.jobId);
  x.artifact.frames[1].responses[0].bytesBase64 = Buffer.from(
    Buffer.from(x.artifact.frames[1].responses[0].bytesBase64, "base64")
      .toString()
      .replace("Synthetic 1", "Changed record"),
  ).toString("base64");
  await writeFile(x.path, JSON.stringify(x.artifact));
  assert.throws(
    () => run(x, [], "2026-11-16T12:00:02Z"),
    (error) => error.status === 1 && String(error.stderr).includes("fixture_artifact_changed"),
  );
  const after = await x.store.view(x.jobId);
  assert.equal(after.request_count, before.request_count);
  assert.equal(after.page_count, before.page_count);
});

test("targeted worker leaves earlier unrelated queued jobs alone", async () => {
  const x = await setup(1);
  const other = await x.store.enqueue({
    sourceId: x.sourceId,
    configId: x.configId,
    queryHash: x.hash,
    runKey: "unrelated",
    asOf: fixed,
  });
  await db.query("UPDATE collector_jobs SET created_at=created_at-interval '1 second' WHERE id=$1", [other]);
  assert.equal(run(x).jobId, x.jobId);
  assert.equal((await x.store.view(other)).status, "queued");
});

test("artifact validation rejects malformed inputs and cannot bind mismatched committed page evidence", async () => {
  const x = await setup(1);
  assert.throws(() => loadFixtureArtifact(Buffer.from(JSON.stringify({ ...x.artifact, synthetic: false }))));
  const duplicate = structuredClone(x.artifact);
  duplicate.frames.push(duplicate.frames[0]);
  assert.throws(() => loadFixtureArtifact(Buffer.from(JSON.stringify(duplicate))), /frame_invalid/);
  const bad = structuredClone(x.artifact);
  bad.frames[0].responses[0].bytesBase64 = "???";
  assert.throws(() => loadFixtureArtifact(Buffer.from(JSON.stringify(bad))), /bytes_invalid/);
  assert.throws(() => loadFixtureArtifact(Buffer.alloc(16 * 1024 * 1024 + 1)), /too_large/);
  const lease = await x.store.claim(x.sourceId),
    raw = x.frames.get("page:start")[0].bytes;
  const id = await x.store.reserve(lease, "page", 1024 * 1024, "page:start");
  await x.store.settle(lease, id, raw.length, digest(raw));
  await x.store.commitPage(
    lease,
    parseFixturePage(raw, { sourceId: x.sourceId, queryHash: x.hash, cursor: "start", asOf: fixed }),
    raw,
    id,
  );
  const changed = structuredClone(x.artifact);
  changed.frames[0].responses[0].bytesBase64 = Buffer.from(
    Buffer.from(changed.frames[0].responses[0].bytesBase64, "base64")
      .toString()
      .replace("Synthetic 0", "Mismatched record"),
  ).toString("base64");
  const loaded = loadFixtureArtifact(Buffer.from(JSON.stringify(changed)));
  await assert.rejects(
    x.store.bindFixtureArtifact({
      jobId: x.jobId,
      sourceId: x.sourceId,
      queryHash: x.hash,
      asOf: fixed,
      hash: loaded.hash,
      pageHashes: loaded.pageHashes,
    }),
    /committed_page_mismatch/,
  );
});

test("first artifact binding checks the job deadline and current source epoch", async () => {
  const x = await setup(1);
  const artifact = loadFixtureArtifact(Buffer.from(JSON.stringify(x.artifact)));
  const input = {
    jobId: x.jobId,
    sourceId: x.sourceId,
    queryHash: x.hash,
    asOf: fixed,
    hash: artifact.hash,
    pageHashes: artifact.pageHashes,
  };
  const future = new CollectorStore(db, () => "2026-11-16T13:00:00Z");
  await assert.rejects(future.bindFixtureArtifact(input), /fixture_artifact_job_inactive/);
  const version = async () =>
    (
      await db.query(
        "SELECT r.fixture_artifact_hash artifact,r.xmin::text revision FROM collector_runs r JOIN collector_jobs j ON j.collector_run_id=r.id WHERE j.id=$1",
        [x.jobId],
      )
    ).rows[0];
  assert.equal((await version()).artifact, null);
  await x.store.bindFixtureArtifact(input);
  const bound = await version();
  assert.equal(bound.artifact, artifact.hash);
  await future.bindFixtureArtifact(input);
  assert.deepEqual(await version(), bound);
  await db.query("UPDATE sources SET permission_epoch=permission_epoch+1 WHERE id=$1", [x.sourceId]);
  await assert.rejects(x.store.bindFixtureArtifact(input), /fixture_artifact_epoch_changed/);
  assert.deepEqual(await version(), bound);
  assert.equal((await x.store.view(x.jobId)).request_count, 0);
});

test("SIGTERM yields after committed work and a new process resumes without restarting pages", async () => {
  const x = await setup(30);
  const child = spawn(process.execPath, args(x), { env: env(x), stdio: ["ignore", "pipe", "pipe"] });
  let output = "",
    errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 5000;
  let stopped = false;
  while (Date.now() < deadline) {
    const job = await x.store.view(x.jobId);
    if (job.page_count >= 1 && job.status === "running") {
      child.kill("SIGTERM");
      stopped = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!stopped) child.kill("SIGKILL");
  assert.equal(stopped, true);
  const result = await exited;
  assert.equal(result.code, 0, errors);
  const report = JSON.parse(output);
  assert.equal(report.status, "retry");
  assert.equal(report.errorCode, "worker_shutdown");
  assert.equal(report.failureAttempts, 0);
  assert.ok(report.pageCount >= 1 && report.pageCount < 30);
  const resumed = run(x, [], "2026-11-16T12:00:02Z");
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.pageCount, 30);
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM sale_events WHERE source_id=$1", [x.sourceId])).rows[0].n,
    30,
  );
});

test("prepare-only demo creates a pending job that the independent worker can actually execute", async () => {
  const x = await setup();
  const prepared = JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "./scripts/test-network.mjs", "scripts/collector-demo.mjs", "--prepare-only"],
      { encoding: "utf8", env: env(x) },
    ),
  );
  assert.equal(prepared.status, "queued");
  assert.equal(prepared.networkRequests, 0);
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "./scripts/test-network.mjs",
        "scripts/collector-worker.mjs",
        `--fixture=${prepared.artifactPath}`,
      ],
      { encoding: "utf8", env: env(x) },
    ),
  );
  assert.equal(report.status, "completed");
  assert.equal(report.pageCount, 3);
  assert.equal(report.networkRequests, 0);
});

test("known shutdown before transport dispatch releases budgets without advancing the replay sequence", async () => {
  for (const boundary of ["reserve", "fixtureResponseIndex"]) {
    const x = await setup(1);
    x.frames
      .get("page:start")
      .unshift({ status: 503, contentType: "application/json", bytes: Buffer.from("{}") });
    const loaded = loadFixtureArtifact(
      Buffer.from(
        JSON.stringify(
          createFixtureArtifact(
            { sourceId: x.sourceId, jobId: x.jobId, queryHash: x.hash, asOf: fixed },
            x.frames,
          ),
        ),
      ),
    );
    const controller = new AbortController();
    class StoppingStore extends CollectorStore {
      async reserve(...values) {
        const result = await super.reserve(...values);
        if (boundary === "reserve") controller.abort();
        return result;
      }
      async fixtureResponseIndex(...values) {
        const result = await super.fixtureResponseIndex(...values);
        if (boundary === "fixtureResponseIndex") controller.abort();
        return result;
      }
    }
    const stopping = new StoppingStore(db, () => fixed),
      media = new PrivateMediaStore(join(x.root, "media"));
    await new OfflineCollectorWorker(stopping, loaded.transport, media).runOne(x.sourceId, {
      jobId: x.jobId,
      signal: controller.signal,
    });
    const paused = await x.store.view(x.jobId);
    assert.equal(paused.status, "retry");
    assert.equal(paused.error_code, "worker_shutdown");
    assert.equal(paused.request_count, 0);
    assert.equal(paused.bytes_used, "0");
    assert.equal(paused.bytes_reserved, "0");
    assert.equal(paused.attempts, 0);
    assert.equal(loaded.transport.calls.length, 0);
    const budgets = (
      await db.query(
        "SELECT budget_kind,used,reserved FROM source_daily_budget WHERE source_id=$1 AND budget_kind IN ('bytes','pages')",
        [x.sourceId],
      )
    ).rows;
    assert.ok(budgets.every((b) => b.used === "0" && b.reserved === "0"));
    assert.equal(
      (await db.query("SELECT used FROM collector_rate_windows WHERE source_id=$1", [x.sourceId])).rows[0]
        .used,
      0,
    );
    const next = new CollectorStore(db, () => "2026-11-16T12:00:02Z");
    await new OfflineCollectorWorker(next, loaded.transport, media).runOne(x.sourceId, { jobId: x.jobId });
    assert.equal((await x.store.view(x.jobId)).error_code, "upstream_unavailable");
    assert.equal((await x.store.view(x.jobId)).attempts, 1);
    const final = new CollectorStore(db, () => "2026-11-16T12:01:03Z");
    await new OfflineCollectorWorker(final, loaded.transport, media).runOne(x.sourceId, { jobId: x.jobId });
    assert.equal((await x.store.view(x.jobId)).status, "completed");
    const dispatches = (
      await db.query(
        "SELECT fixture_response_index,dispatched_at,actual_bytes FROM collector_dispatches WHERE job_id=$1 ORDER BY created_at,id",
        [x.jobId],
      )
    ).rows;
    assert.equal(dispatches.length, 3);
    assert.equal(dispatches[0].dispatched_at, null);
    assert.equal(dispatches[0].actual_bytes, "0");
    assert.deepEqual(
      dispatches.slice(1).map((d) => d.fixture_response_index),
      [0, 1],
    );
  }
});

test("an unclaimed duplicate process cannot overwrite the lease holder instance heartbeat", async () => {
  const x = await setup(1);
  const loaded = loadFixtureArtifact(Buffer.from(JSON.stringify(x.artifact)));
  await x.store.bindFixtureArtifact({
    jobId: x.jobId,
    sourceId: x.sourceId,
    queryHash: x.hash,
    asOf: fixed,
    hash: loaded.hash,
    pageHashes: loaded.pageHashes,
  });
  // The parent stands in for the lease holder, while a real child attempts the same job.
  const lease = await x.store.claim(x.sourceId, 60, x.jobId);
  assert.ok(lease);
  const holderHeartbeat = join(x.root, `collector-worker-${x.jobId}-${process.pid}.json`),
    holderState = JSON.stringify({ state: "running", pid: process.pid, jobId: x.jobId });
  await writeFile(holderHeartbeat, holderState);
  const duplicate = run(x);
  assert.equal(duplicate.claimed, false);
  assert.equal(duplicate.fixtureResponses, 0);
  assert.notEqual(duplicate.heartbeatPath, holderHeartbeat);
  assert.equal(JSON.parse(await readFile(duplicate.heartbeatPath, "utf8")).state, "not_claimed");
  assert.equal(await readFile(holderHeartbeat, "utf8"), holderState);
  assert.equal((await x.store.view(x.jobId)).lease_owner, lease.token);
});
