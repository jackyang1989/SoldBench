import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  CollectorStore,
  collectorHealth,
  FixtureTransport,
  fixtureResponse,
  OfflineCollectorWorker,
  provisionFixtureSource,
} from "@soldbench/collector";
import { database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import sharp from "sharp";

const db = database(process.env.DATABASE_URL);
before(() => migrate(db));
after(() => db.end());
async function setup(options = {}, start = "2026-11-17T23:59:45.000Z") {
  const source = await provisionFixtureSource(db, start, options),
    clock = { value: start },
    store = new CollectorStore(db, () => clock.value);
  const enqueue = () =>
    store.enqueue({ ...source, queryHash: "a".repeat(64), runKey: randomUUID(), asOf: clock.value });
  return { ...source, store, clock, enqueue };
}
async function budget(x, day, kind) {
  return (
    await db.query(
      "SELECT cap,used,reserved FROM source_daily_budget WHERE source_id=$1 AND day=$2 AND budget_kind=$3",
      [x.sourceId, day, kind],
    )
  ).rows[0];
}
test("100 concurrent UTC rollover enqueues initialize one day under fixed caps and never reset yesterday", async () => {
  const x = await setup({ dailyJobs: 1 });
  await x.enqueue();
  x.clock.value = "2026-11-18T00:00:00.000Z";
  const results = await Promise.allSettled(Array.from({ length: 100 }, () => x.enqueue()));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(
    results
      .filter((r) => r.status === "rejected")
      .every((r) => /daily_jobs_exhausted/.test(r.reason.message)),
  );
  assert.deepEqual(await budget(x, "2026-11-17", "jobs"), { cap: "1", used: "1", reserved: "0" });
  assert.deepEqual(await budget(x, "2026-11-18", "jobs"), { cap: "1", used: "1", reserved: "0" });
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM source_daily_budget WHERE source_id=$1", [x.sourceId]))
      .rows[0].n,
    6,
  );
});
test("responses and graceful undispatched cancellations settle against their original UTC budget day", async () => {
  for (const cancel of [false, true]) {
    const x = await setup({ dailyBytes: 1000, dailyPages: 2 }),
      job = await x.enqueue(),
      lease = await x.store.claim(x.sourceId, 300, job),
      dispatch = await x.store.reserve(lease, "page", 700, "page:start");
    await x.store.fixtureResponseIndex(lease, dispatch);
    x.clock.value = "2026-11-18T00:00:01.000Z";
    if (cancel) await x.store.cancelUndispatchedFixture(lease, dispatch);
    else await x.store.settle(lease, dispatch, 300, "b".repeat(64));
    assert.deepEqual(await budget(x, "2026-11-17", "bytes"), {
      cap: "1000",
      used: cancel ? "0" : "300",
      reserved: "0",
    });
    assert.equal(await budget(x, "2026-11-18", "bytes"), undefined);
    await x.store.reserve(lease, "page", 1000, "page:next");
    assert.deepEqual(await budget(x, "2026-11-18", "bytes"), { cap: "1000", used: "0", reserved: "1000" });
    await assert.rejects(x.store.reserve(lease, "page", 1, "page:other"), /dispatch_already_reserved/);
  }
});
test("unknown pre-midnight reservation is conservatively consumed on the original day before lease takeover", async () => {
  const x = await setup({ dailyBytes: 1000 }),
    job = await x.enqueue(),
    old = await x.store.claim(x.sourceId, 60, job);
  await x.store.reserve(old, "page", 700, "page:start");
  x.clock.value = "2026-11-18T00:00:46.000Z";
  const next = await x.store.claim(x.sourceId, 60, job);
  assert.notEqual(next.token, old.token);
  assert.deepEqual(await budget(x, "2026-11-17", "bytes"), { cap: "1000", used: "700", reserved: "0" });
  await x.store.reserve(next, "page", 1000, "page:start");
  assert.deepEqual(await budget(x, "2026-11-18", "bytes"), { cap: "1000", used: "0", reserved: "1000" });
  await assert.rejects(x.store.check(old), /lease_lost/);
});

test("terminal sweep settles lost lease budget once and preserves a live job without artifacts", async () => {
  const x = await setup({ dailyBytes: 1000, concurrency: 2 });
  const enqueue = (label, ttlSeconds) =>
    x.store.enqueue({
      sourceId: x.sourceId,
      configId: x.configId,
      queryHash: label.repeat(64),
      runKey: randomUUID(),
      asOf: x.clock.value,
      ttlSeconds,
    });
  const expired = await enqueue("a", 20);
  const lost = await x.store.claim(x.sourceId, 20, expired);
  const dispatch = await x.store.reserve(lost, "page", 700, "page:start");
  await x.store.fixtureResponseIndex(lost, dispatch);
  const notExpired = await enqueue("b", 300);
  const live = await x.store.claim(x.sourceId, 300, notExpired);
  x.clock.value = "2026-11-18T00:00:05.000Z";
  const sweeps = await Promise.all([
    x.store.settleUnclaimable(x.sourceId),
    x.store.settleUnclaimable(x.sourceId),
  ]);
  assert.equal(
    sweeps.reduce((n, result) => n + result.pagesClosed, 0),
    1,
  );
  assert.deepEqual(await budget(x, "2026-11-17", "bytes"), { cap: "1000", used: "700", reserved: "0" });
  const parent = await x.store.view(expired);
  assert.equal(parent.status, "failed");
  assert.equal(parent.lease_owner, null);
  assert.equal(parent.bytes_reserved, "0");
  assert.equal(parent.page_count, 0);
  await assert.rejects(x.store.check(lost), /lease_lost/);
  await x.store.check(live);
});
test("policy expires without preventing settlement of already dispatched bytes, and cannot be changed or deleted", async () => {
  const x = await setup({ budgetPolicyDays: 1 }, "2026-11-17T00:00:00.000Z");
  x.clock.value = "2026-11-17T23:59:50.000Z";
  const job = await x.enqueue(),
    lease = await x.store.claim(x.sourceId, 60, job),
    dispatch = await x.store.reserve(lease, "page", 1000, "page:start");
  await x.store.fixtureResponseIndex(lease, dispatch);
  x.clock.value = "2026-11-18T00:00:00.000Z";
  await assert.rejects(x.enqueue(), /source_budget_policy_unavailable/);
  await x.store.check(lease); // In-flight rights/lease remains valid; only new dispatch is blocked.
  await x.store.settle(lease, dispatch, 300, "c".repeat(64));
  await assert.rejects(
    x.store.reserve(lease, "image", 1000, "image:next"),
    /source_budget_policy_unavailable/,
  );
  assert.equal((await budget(x, "2026-11-17", "bytes")).used, "300");
  assert.equal(await budget(x, "2026-11-18", "jobs"), undefined);
  const r = await collectorHealth(db, x.sourceId, { now: x.clock.value });
  assert.equal(r.sourceStopped, true);
  assert.equal(r.dailyBudgetPolicy.status, "unavailable");
  await assert.rejects(
    db.query("UPDATE sources SET daily_budget_policy_hash=NULL WHERE id=$1", [x.sourceId]),
    /cannot be cleared or replaced/,
  );
  await assert.rejects(x.enqueue(), /source_budget_policy_unavailable/);
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM collector_jobs WHERE source_id=$1", [x.sourceId])).rows[0].n,
    1,
  );
  await assert.rejects(
    db.query("UPDATE collector_daily_budget_policies SET jobs_cap=10000 WHERE source_id=$1", [x.sourceId]),
    /cannot be changed/,
  );
  await assert.rejects(
    db.query("DELETE FROM collector_daily_budget_policies WHERE source_id=$1", [x.sourceId]),
    /cannot be changed/,
  );
});
test("legacy explicit-day budgets do not silently obtain renewal policy or carry unused budget forward", async () => {
  const base = await setup({ dailyJobs: 1 }),
    sourceId = randomUUID(),
    configId = randomUUID(),
    x = { ...base, sourceId, configId };
  // Real legacy shape: no policy binding ever existed. Do not detach an approved policy to simulate it.
  await db.query(
    "INSERT INTO sources(id,source_clearance_id,marketplace,access_method,collector_version,entrypoint_id,status) SELECT $1,source_clearance_id,marketplace,access_method,collector_version,entrypoint_id,status FROM sources WHERE id=$2",
    [sourceId, base.sourceId],
  );
  await db.query(
    "INSERT INTO collector_configs(id,source_id,collector_version,allowed_entrypoints,access_method,rate_cap,concurrency_cap,max_pages,max_bytes_per_job,enabled) SELECT $1,$2,collector_version,allowed_entrypoints,access_method,rate_cap,concurrency_cap,max_pages,max_bytes_per_job,enabled FROM collector_configs WHERE id=$3",
    [configId, sourceId, base.configId],
  );
  await db.query(
    "INSERT INTO source_daily_budget(source_id,day,budget_kind,cap) SELECT $1,day,budget_kind,cap FROM source_daily_budget WHERE source_id=$2",
    [sourceId, base.sourceId],
  );
  const enqueue = () =>
    x.store.enqueue({
      sourceId,
      configId,
      queryHash: "a".repeat(64),
      runKey: randomUUID(),
      asOf: x.clock.value,
    });
  await enqueue();
  x.clock.value = "2026-11-18T00:00:00.000Z";
  await assert.rejects(enqueue(), /collector_daily_jobs_exhausted/);
  assert.equal(await budget(x, "2026-11-18", "jobs"), undefined);
  assert.equal(
    (await collectorHealth(db, x.sourceId, { now: x.clock.value })).dailyBudgetPolicy.status,
    "legacy_explicit_days_only",
  );
});
test("policy cannot recreate a reduced explicit cap or accept a raised cap, and stop cannot initialize a new day", async () => {
  const x = await setup({ dailyJobs: 2 });
  await db.query("UPDATE source_daily_budget SET cap=1 WHERE source_id=$1 AND budget_kind='jobs'", [
    x.sourceId,
  ]);
  await x.enqueue();
  await assert.rejects(x.enqueue(), /daily_jobs_exhausted/);
  assert.equal((await budget(x, "2026-11-17", "jobs")).cap, "1");
  await db.query("UPDATE source_daily_budget SET cap=3 WHERE source_id=$1 AND budget_kind='jobs'", [
    x.sourceId,
  ]);
  await assert.rejects(x.enqueue(), /source_budget_policy_cap_exceeded/);
  x.clock.value = "2026-11-18T00:00:00.000Z";
  await x.store.stop(x.sourceId, "offline");
  await assert.rejects(x.enqueue(), /source_circuit_open/);
  assert.equal(await budget(x, "2026-11-18", "jobs"), undefined);
});

test("an unmarked pre-midnight reservation cannot dispatch against yesterday when today's cap is zero", async () => {
  const x = await setup(),
    job = await x.enqueue(),
    lease = await x.store.claim(x.sourceId, 120, job),
    dispatch = await x.store.reserve(lease, "page", 1000, "page:start");
  x.clock.value = "2026-11-18T00:00:00.000Z";
  await db.query(
    "INSERT INTO source_daily_budget(source_id,day,budget_kind,cap) VALUES($1,'2026-11-18','pages',0)",
    [x.sourceId],
  );
  await assert.rejects(x.store.fixtureResponseIndex(lease, dispatch), /collector_budget_day_changed/);
  await x.store.cancelUndispatchedFixture(lease, dispatch);
  assert.equal((await budget(x, "2026-11-17", "bytes")).reserved, "0");
  await assert.rejects(x.store.reserve(lease, "page", 1000, "page:start"), /daily_budget_exhausted/);
  assert.equal((await budget(x, "2026-11-18", "pages")).cap, "0");
});

test("a fully authorized image response crossing policy expiry still publishes and finishes the completed page", async () => {
  const x = await setup({ budgetPolicyDays: 1 }, "2026-11-17T00:00:00.000Z");
  x.clock.value = "2026-11-17T23:59:50.000Z";
  const job = await x.enqueue(),
    root = await mkdtemp(join(tmpdir(), "soldbench-budget-media-")),
    url = "https://images.example.test/expiry.png",
    page = {
      schema: "soldbench.synthetic-page.v1",
      synthetic: true,
      sourceId: x.sourceId,
      queryHash: "a".repeat(64),
      cursor: "start",
      nextCursor: null,
      asOf: x.clock.value,
      empty: false,
      records: [0, 1].map((i) => ({
        listingId: `expiry-listing-${i}`,
        title: "Synthetic expiry image",
        primaryImage: { role: "primary", url: i === 0 ? url : `${url}?second` },
        candidate: {
          sourceId: x.sourceId,
          eventKey: `expiry-event-${i}`,
          identityVerified: true,
          comparable: true,
          priceStatus: "verified_actual",
          format: "fixed_price",
          currency: "USD",
          itemCents: 1000,
          shippingCents: 0,
          shippingStatus: "verified_free_shipping",
          time: { precision: "instant", value: "2026-11-17T12:00:00Z" },
        },
      })),
    },
    bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: "blue" } })
      .png()
      .toBuffer(),
    transport = new FixtureTransport(
      new Map([
        ["page:start", [fixtureResponse(page)]],
        [`image:${url}`, [{ status: 200, contentType: "image/png", bytes }]],
        [`image:${url}?second`, [{ status: 200, contentType: "image/png", bytes }]],
      ]),
    ),
    original = transport.read.bind(transport);
  let imageRequests = 0;
  transport.read = async (...args) => {
    const response = await original(...args);
    if (args[0].startsWith("image:")) {
      imageRequests++;
      x.clock.value = "2026-11-18T00:00:00.000Z";
    }
    return response;
  };
  try {
    const worker = new OfflineCollectorWorker(x.store, transport, new PrivateMediaStore(root));
    assert.equal((await worker.runOne(x.sourceId, { jobId: job })).status, "completed");
    assert.equal(imageRequests, 1);
    assert.deepEqual(
      (
        await db.query(
          "SELECT state,count(*)::int n FROM listing_images WHERE source_id=$1 GROUP BY state ORDER BY state",
          [x.sourceId],
        )
      ).rows,
      [
        { state: "available", n: 1 },
        { state: "failed", n: 1 },
      ],
    );
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM collector_watermarks WHERE source_id=$1", [x.sourceId]))
        .rows[0].n,
      1,
    );
    await assert.rejects(x.enqueue(), /source_budget_policy_unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker cancels pre-dispatch midnight rollover without a failed attempt or transport and resumes the same page", async () => {
  const x = await setup(),
    job = await x.enqueue(),
    root = await mkdtemp(join(tmpdir(), "soldbench-budget-worker-")),
    page = {
      schema: "soldbench.synthetic-page.v1",
      synthetic: true,
      sourceId: x.sourceId,
      queryHash: "a".repeat(64),
      cursor: "start",
      nextCursor: null,
      asOf: x.clock.value,
      empty: true,
      records: [],
    },
    transport = new FixtureTransport(new Map([["page:start", [fixtureResponse(page)]]])),
    originalMarker = x.store.fixtureResponseIndex.bind(x.store);
  let calls = 0,
    once = true;
  const read = transport.read.bind(transport);
  transport.read = async (...args) => {
    calls++;
    return read(...args);
  };
  x.store.fixtureResponseIndex = async (...args) => {
    if (once) {
      once = false;
      x.clock.value = "2026-11-18T00:00:00.000Z";
    }
    return originalMarker(...args);
  };
  try {
    const worker = new OfflineCollectorWorker(x.store, transport, new PrivateMediaStore(root));
    assert.equal((await worker.runOne(x.sourceId, { jobId: job })).status, "retry");
    assert.equal(calls, 0);
    const state = await x.store.view(job);
    assert.equal(state.attempts, 0);
    assert.equal(state.request_count, 0);
    assert.equal((await budget(x, "2026-11-17", "bytes")).reserved, "0");
    x.clock.value = "2026-11-18T00:00:01.000Z";
    assert.equal((await worker.runOne(x.sourceId, { jobId: job })).status, "completed");
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
