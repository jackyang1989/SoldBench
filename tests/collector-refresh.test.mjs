import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  CollectorRefresh,
  CollectorStore,
  collectorHealth,
  collectorRunEvidence,
  FixtureTransport,
  fixtureResponse,
  OfflineCollectorWorker,
  provisionFixtureSource,
} from "@soldbench/collector";
import { database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import sharp from "sharp";

const db = database(process.env.DATABASE_URL),
  roots = [];
before(() => migrate(db));
after(async () => {
  await db.end();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
async function setup(options = {}, instant = "2026-11-17T12:00:00.000Z") {
  const clock = { value: instant },
    source = await provisionFixtureSource(db, clock.value, options),
    store = new CollectorStore(db, () => clock.value),
    refresh = new CollectorRefresh(store),
    root = await mkdtemp(join(tmpdir(), "soldbench-refresh-"));
  roots.push(root);
  const input = {
    ...source,
    query: new URLSearchParams({ q: "Game Boy Color" }),
    key: randomUUID(),
    intervalSeconds: 60,
    maxLagSeconds: 120,
  };
  return { clock, ...source, store, refresh, root, input };
}
const step = (x, seconds) => {
  x.clock.value = new Date(Date.parse(x.clock.value) + seconds * 1000).toISOString();
};
async function occurrences(x) {
  return (
    await db.query("SELECT * FROM collector_refresh_occurrences WHERE source_id=$1 ORDER BY scheduled_for", [
      x.sourceId,
    ])
  ).rows;
}
async function complete(x, id, records = [], responses = []) {
  const job = await x.store.view(id),
    p = {
      schema: "soldbench.synthetic-page.v1",
      synthetic: true,
      sourceId: x.sourceId,
      queryHash: job.query_hash,
      cursor: "start",
      nextCursor: null,
      asOf: job.as_of.toISOString(),
      empty: records.length === 0,
      records,
    };
  return new OfflineCollectorWorker(
    x.store,
    new FixtureTransport(new Map([["page:start", [fixtureResponse(p)]], ...responses])),
    new PrivateMediaStore(x.root),
  ).runOne(x.sourceId, { jobId: id });
}

test("concurrent identical plans and occurrence dispatch create one frozen plan/job and consume job budget once", async () => {
  const x = await setup(),
    ids = await Promise.all(Array.from({ length: 20 }, () => x.refresh.create(x.input)));
  assert.equal(new Set(ids).size, 1);
  await Promise.all(Array.from({ length: 20 }, () => x.refresh.materialize(x.sourceId)));
  const results = await Promise.all(Array.from({ length: 20 }, () => x.refresh.dispatchNext(x.sourceId)));
  assert.equal(results.filter(Boolean).length, 1);
  const rows = await occurrences(x);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "enqueued");
  assert.equal(
    (
      await db.query("SELECT used FROM source_daily_budget WHERE source_id=$1 AND budget_kind='jobs'", [
        x.sourceId,
      ])
    ).rows[0].used,
    "1",
  );
  assert.equal((await complete(x, rows[0].job_id)).status, "completed");
});
test("frozen planned slots include missing/late cycles, bounded materialization never drops a slot and retirement preserves history", async () => {
  const x = await setup(),
    plan = await x.refresh.create({ ...x.input, maxLagSeconds: 30 });
  step(x, 185);
  const a = await x.refresh.materialize(x.sourceId, 2);
  assert.deepEqual(a, { materialized: 2, more: true });
  assert.equal((await x.refresh.materialize(x.sourceId, 2)).more, false);
  const rows = await occurrences(x);
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((r) => r.status),
    ["missed", "missed", "missed", "planned"],
  );
  await x.refresh.retire(x.sourceId, plan);
  await x.refresh.dispatchNext(x.sourceId);
  assert.equal((await occurrences(x))[3].failure_reason, "plan_retired");
  await assert.rejects(
    db.query("UPDATE collector_refresh_plans SET interval_seconds=120 WHERE id=$1", [plan]),
    /frozen refresh plan/,
  );
  await assert.rejects(
    db.query("DELETE FROM collector_refresh_occurrences WHERE plan_id=$1", [plan]),
    /cannot be deleted/,
  );
  step(x, 300);
  assert.equal((await x.refresh.materialize(x.sourceId)).materialized, 0);
});
test("a committed job followed by lost connection is recovered after lease expiry without reusing budget", async () => {
  const x = await setup();
  await x.refresh.create(x.input);
  await x.refresh.materialize(x.sourceId);
  const original = x.store.enqueue.bind(x.store);
  let once = true;
  x.store.enqueue = async (input) => {
    const id = await original(input);
    if (once) {
      once = false;
      throw new Error("connection_lost_after_commit");
    }
    return id;
  };
  await assert.rejects(x.refresh.dispatchNext(x.sourceId), /connection_lost/);
  assert.equal((await occurrences(x))[0].status, "dispatching");
  step(x, 121);
  assert.equal(await x.refresh.settleOverdue(x.sourceId), 0);
  const r = await x.refresh.dispatchNext(x.sourceId);
  assert.equal(r.recovered, true);
  assert.equal((await occurrences(x))[0].status, "enqueued");
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM collector_jobs WHERE source_id=$1", [x.sourceId])).rows[0].n,
    1,
  );
});

test("expired unclaimed slots close while a source is paused, including concurrent settlement", async () => {
  const x = await setup();
  await x.refresh.create({ ...x.input, maxLagSeconds: 30 });
  await x.refresh.materialize(x.sourceId);
  await x.store.stop(x.sourceId, "scheduled_pause");
  step(x, 29);
  assert.equal(await x.refresh.settleOverdue(x.sourceId), 0);
  step(x, 1);
  const settled = await Promise.all(Array.from({ length: 8 }, () => x.refresh.settleOverdue(x.sourceId)));
  assert.equal(
    settled.reduce((sum, count) => sum + count, 0),
    1,
  );
  const [missed] = await occurrences(x);
  assert.equal(missed.status, "missed");
  assert.equal(missed.failure_reason, "scheduler_late");
  assert.equal(missed.job_id, null);
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM collector_jobs WHERE source_id=$1", [x.sourceId])).rows[0].n,
    0,
  );
});
test("unapproved config mutation without changing updated_at is rejected both by scheduled enqueue and existing lease", async () => {
  const x = await setup();
  await x.refresh.create(x.input);
  await x.refresh.materialize(x.sourceId);
  await db.query("UPDATE collector_configs SET rate_cap=rate_cap+1 WHERE id=$1", [x.configId]);
  const r = await x.refresh.dispatchNext(x.sourceId);
  assert.equal(r.status, "blocked");
  assert.equal(r.reason, "collector_config_or_permission_changed");
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM collector_jobs WHERE source_id=$1", [x.sourceId])).rows[0].n,
    0,
  );
  const y = await setup();
  await y.refresh.create(y.input);
  await y.refresh.materialize(y.sourceId);
  const enq = await y.refresh.dispatchNext(y.sourceId),
    lease = await y.store.claim(y.sourceId);
  await db.query("UPDATE collector_configs SET max_pages=max_pages+1 WHERE id=$1", [y.configId]);
  await assert.rejects(y.store.check(lease), /config_or_permission_changed/);
  assert.ok(enq.jobId);
});
test("retirement or deadline crossed between planning claim and enqueue prevents new jobs", async () => {
  for (const mode of ["retire", "deadline"]) {
    const x = await setup(),
      id = await x.refresh.create({ ...x.input, maxLagSeconds: 30 });
    await x.refresh.materialize(x.sourceId);
    const original = x.store.enqueue.bind(x.store);
    x.store.enqueue = async (input) => {
      if (mode === "retire") await x.refresh.retire(x.sourceId, id);
      else step(x, 31);
      return original(input);
    };
    assert.equal((await x.refresh.dispatchNext(x.sourceId)).status, "blocked");
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM collector_jobs WHERE source_id=$1", [x.sourceId])).rows[0]
        .n,
      0,
    );
  }
});
test("source stop and daily job budget failures remain visible planned failures, with no collector bypass", async () => {
  const x = await setup({ dailyJobs: 1 });
  await x.refresh.create(x.input);
  await x.refresh.materialize(x.sourceId);
  assert.ok((await x.refresh.dispatchNext(x.sourceId)).jobId);
  step(x, 60);
  await x.refresh.materialize(x.sourceId);
  assert.equal((await x.refresh.dispatchNext(x.sourceId)).reason, "collector_daily_jobs_exhausted");
  step(x, 60);
  await x.refresh.materialize(x.sourceId);
  await x.store.stop(x.sourceId, "offline");
  assert.equal((await x.refresh.dispatchNext(x.sourceId)).reason, "source_circuit_open");
  assert.deepEqual(
    (await occurrences(x)).map((r) => r.status),
    ["enqueued", "blocked", "blocked"],
  );
});

test("schedule health counts unmaterialized and failed slots and separates execution from on-time execution", async () => {
  const x = await setup(),
    plan = await x.refresh.create({ ...x.input, maxLagSeconds: 30 }),
    report = () =>
      collectorHealth(db, x.sourceId, {
        now: x.clock.value,
        from: x.input.startAt ?? "2026-11-17T12:00:00Z",
      });
  let r = await report();
  assert.deepEqual(r.scheduleExecutionRate, { numerator: 0, denominator: 1, ratio: 0 });
  assert.equal(r.refresh.unmaterialized, 1);
  await x.refresh.materialize(x.sourceId);
  const first = await x.refresh.dispatchNext(x.sourceId);
  assert.equal((await report()).scheduleExecutionRate.numerator, 0);
  step(x, 31);
  await complete(x, first.jobId);
  r = await report();
  assert.deepEqual(r.scheduleExecutionRate, { numerator: 1, denominator: 1, ratio: 1 });
  assert.deepEqual(r.scheduleOnTimeRate, { numerator: 0, denominator: 1, ratio: 0 });
  step(x, 89);
  r = await report();
  assert.equal(r.refresh.planned, 3);
  assert.equal(r.refresh.materialized, 1);
  assert.equal(r.refresh.unmaterialized, 2);
  await x.refresh.materialize(x.sourceId);
  await x.store.stop(x.sourceId, "offline");
  await x.refresh.dispatchNext(x.sourceId);
  r = await report();
  assert.deepEqual(r.scheduleExecutionRate, { numerator: 1, denominator: 3, ratio: 1 / 3 });
  assert.equal(r.refresh.unmaterialized, 0);
  assert.deepEqual(r.refresh.states, [
    { status: "blocked", n: 1 },
    { status: "enqueued", n: 1 },
    { status: "missed", n: 1 },
  ]);
  // Retiring at the same clock instant must preserve the slot already materialized at that instant.
  await x.refresh.retire(x.sourceId, plan);
  r = await report();
  assert.equal(r.refresh.planned, 3);
  step(x, 300);
  assert.equal((await report()).refresh.planned, 3);
});

test("independent refresh CLI creates, cycles, replays and retires without fetching or hiding missing cycles", async () => {
  const x = await setup(),
    run = (args) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--import",
            "./scripts/test-network.mjs",
            "scripts/collector-refresh.mjs",
            `--source=${x.sourceId}`,
            `--clock=${x.clock.value}`,
            ...args,
          ],
          { encoding: "utf8", env: process.env },
        ),
      );
  const args = [
      "--action=create",
      `--config=${x.configId}`,
      "--query=q=Game+Boy+Color",
      `--key=${x.input.key}`,
      "--interval=60",
      "--lag=30",
    ],
    a = run(args);
  assert.equal(run(args).planId, a.planId);
  assert.equal(a.mode, "offline_fixture");
  assert.equal(a.networkRequests, 0);
  assert.equal(a.onlineVerified, false);
  const cycle = run([]);
  assert.equal(cycle.dispatch.length, 1);
  assert.equal(run([]).dispatch.length, 0);
  assert.equal((await x.store.view(cycle.dispatch[0].jobId)).status, "queued");
  step(x, 125);
  const late = run([]);
  assert.equal(late.planned.materialized, 2);
  assert.equal(late.dispatch.length, 1);
  assert.equal(run(["--action=retire", `--plan=${a.planId}`]).retired, true);
  step(x, 120);
  assert.equal(run([]).planned.materialized, 0);
  assert.equal((await collectorHealth(db, x.sourceId, { now: x.clock.value })).refresh.planned, 3);
});

test("continuous evidence retains empty UTC days, missed work and actual cross-midnight dispatch", async () => {
  const x = await setup();
  x.clock.value = "2026-11-17T23:59:00.000Z";
  const plan = await x.refresh.create({ ...x.input, maxLagSeconds: 30 });
  await x.refresh.materialize(x.sourceId);
  const { jobId } = await x.refresh.dispatchNext(x.sourceId);
  step(x, 61);
  assert.equal((await complete(x, jobId)).status, "completed");
  await x.refresh.retire(x.sourceId, plan);
  x.clock.value = "2026-11-19T00:15:00.000Z";
  const r = await collectorHealth(db, x.sourceId, { dailyDays: 14, now: x.clock.value });
  assert.equal(r.daily.from, "2026-11-05T00:00:00.000Z");
  assert.equal(r.daily.until, "2026-11-19T00:00:00.000Z");
  assert.equal(r.daily.days.length, 14);
  assert.ok(r.daily.days.slice(0, -2).every((day) => day.planned === 0 && day.pageAttempts === 0));
  const [scheduled, dispatched] = r.daily.days.slice(-2);
  assert.deepEqual(
    [
      scheduled.day,
      scheduled.planned,
      scheduled.started,
      scheduled.onTime,
      scheduled.completed,
      scheduled.pageAttempts,
    ],
    ["2026-11-17", 1, 1, 0, 1, 0],
  );
  assert.deepEqual(
    [
      dispatched.day,
      dispatched.planned,
      dispatched.unmaterialized,
      dispatched.completed,
      dispatched.pageAttempts,
    ],
    ["2026-11-18", 1, 1, 0, 1],
  );
  assert.deepEqual(
    [scheduled.firstPageDispatched, scheduled.firstPageDispatchedOnTime, dispatched.firstPageDispatched],
    [1, 0, 0],
  );
  const cli = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "./scripts/test-network.mjs",
        "scripts/collector-report.mjs",
        `--source=${x.sourceId}`,
        `--clock=${x.clock.value}`,
        "--daily-days=7",
      ],
      { encoding: "utf8" },
    ),
  );
  assert.deepEqual(cli.daily.days, r.daily.days.slice(-7));
  assert.equal(cli.onlineVerified, false);
  assert.equal(cli.measuredCostCents, null);
  assert.equal(cli.networkRequests, 0);
});

test("health separates a timely lease and reservation from late first-page dispatch", async () => {
  const x = await setup();
  await x.refresh.create({ ...x.input, maxLagSeconds: 30 });
  await x.refresh.materialize(x.sourceId);
  const { jobId } = await x.refresh.dispatchNext(x.sourceId);
  const lease = await x.store.claim(x.sourceId, 120, jobId);
  assert.ok(lease);
  const id = await x.store.reserve(lease, "page", 1024, "page:start");
  const from = x.clock.value;
  const read = (now = x.clock.value) => collectorHealth(db, x.sourceId, { from, now });
  const before = await read();
  assert.deepEqual(before.scheduleExecutionRate, { numerator: 1, denominator: 1, ratio: 1 });
  assert.deepEqual(before.scheduleOnTimeRate, { numerator: 1, denominator: 1, ratio: 1 });
  assert.deepEqual(before.scheduleFirstPageDispatchRate, { numerator: 0, denominator: 1, ratio: 0 });
  assert.deepEqual(before.scheduleOnTimeFirstPageDispatchRate, { numerator: 0, denominator: 1, ratio: 0 });
  assert.equal(before.refresh.claimedWithoutPageDispatch, 1);
  assert.equal(before.dispatches.reserved, 1);
  step(x, 31);
  assert.equal(await x.store.fixtureResponseIndex(lease, id), 0);
  const after = await read();
  assert.deepEqual(after.scheduleFirstPageDispatchRate, { numerator: 1, denominator: 1, ratio: 1 });
  assert.deepEqual(after.scheduleOnTimeFirstPageDispatchRate, { numerator: 0, denominator: 1, ratio: 0 });
  assert.equal(after.refresh.claimedWithoutPageDispatch, 0);
  assert.equal(after.pageSemanticCompletion.numerator, 0);
  assert.equal((await read(from)).scheduleFirstPageDispatchRate.numerator, 0);
});

test("read-only evidence connects slots, cross-day dispatch and primary media without hiding missed work", async () => {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const at = (seconds) => new Date(midnight.getTime() + seconds * 1000).toISOString();
  const from = at(-2 * 86_400).slice(0, 10);
  const until = at(0).slice(0, 10);
  const x = await setup({}, at(-86_460));
  const plan = await x.refresh.create({ ...x.input, maxLagSeconds: 30 });
  await x.refresh.materialize(x.sourceId);
  const { jobId } = await x.refresh.dispatchNext(x.sourceId);
  step(x, 61);
  const url = "https://images.example.test/audited-primary.png";
  const image = await sharp({ create: { width: 10, height: 10, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  const record = {
    listingId: "fixture-evidence-listing",
    title: "Fixture evidence listing",
    candidate: {
      sourceId: x.sourceId,
      eventKey: "fixture-evidence-event",
      identityVerified: true,
      comparable: true,
      priceStatus: "verified_actual",
      format: "fixed_price",
      currency: "USD",
      itemCents: 1000,
      shippingCents: 0,
      shippingStatus: "verified_free_shipping",
      time: { precision: "instant", value: at(-86_500) },
    },
    primaryImage: { role: "primary", url },
  };
  const withoutPhoto = (key) => ({
    ...record,
    listingId: `fixture-evidence-${key}`,
    candidate: { ...record.candidate, eventKey: `fixture-evidence-${key}` },
    primaryImage: undefined,
  });
  assert.equal(
    (
      await complete(
        x,
        jobId,
        [record, withoutPhoto("missing"), withoutPhoto("untracked")],
        [[`image:${url}`, [{ status: 200, contentType: "image/png", bytes: image }]]],
      )
    ).status,
    "completed",
  );
  // Reproduce an observation persisted by the collector before image metadata existed.
  const removed = await db.query(
    `DELETE FROM listing_images i USING sold_listings l
       WHERE i.source_id=$1 AND l.id=i.listing_id AND l.external_listing_id='fixture-evidence-untracked'`,
    [x.sourceId],
  );
  assert.equal(removed.rowCount, 1);
  await x.refresh.retire(x.sourceId, plan);
  const waiting = await x.refresh.create({
    ...x.input,
    key: randomUUID(),
    query: new URLSearchParams({ q: "Queued fixture" }),
  });
  await x.refresh.materialize(x.sourceId);
  const second = await x.refresh.dispatchNext(x.sourceId);
  assert.ok(await x.store.claim(x.sourceId, 60, second.jobId));
  await x.refresh.retire(x.sourceId, waiting);
  step(x, 1);
  const missing = await x.refresh.create({
    ...x.input,
    key: randomUUID(),
    query: new URLSearchParams({ q: "Never materialized" }),
  });
  await x.refresh.retire(x.sourceId, missing);
  const other = await setup({}, at(-86_400));
  await other.refresh.create(other.input);
  await other.refresh.materialize(other.sourceId);
  const evidence = await collectorRunEvidence(db, x.sourceId, from, until);
  assert.equal(evidence.slots.length, 4);
  const [late, blocked, claimed, missed] = evidence.slots;
  assert.equal(late.scheduled_at, at(-86_460));
  assert.equal(late.deadline_at, at(-86_430));
  assert.equal(late.first_page_request_at.toISOString(), at(-86_399));
  assert.equal(late.page_started_on_time, false);
  assert.equal(late.completed_with_page_evidence, true);
  assert.deepEqual([late.page_attempts, late.image_attempts, late.committed_pages], [1, 1, 1]);
  assert.equal(late.primary_image_observations, 3);
  assert.deepEqual(late.primary_image_states_at_snapshot, { available: 1, missing: 1, untracked: 1 });
  assert.equal(late.bytes.unconfirmed, "0");
  assert.ok(BigInt(late.bytes.settled) > BigInt(image.length));
  assert.equal(blocked.scheduled_at, at(-86_400));
  assert.equal(blocked.occurrence.state, "blocked");
  assert.equal(blocked.occurrence.failure_reason, "plan_retired");
  assert.equal(missed.scheduled_at, at(-86_398));
  assert.equal(missed.plan_id, missing);
  assert.equal(missed.occurrence, null);
  assert.equal(missed.job, null);
  assert.equal(claimed.job.id, second.jobId);
  assert.equal(claimed.job.claimed_at.toISOString(), at(-86_399));
  assert.equal(claimed.first_page_request_at, null);
  assert.equal(claimed.page_started_on_time, null);
  assert.equal(claimed.completed_with_page_evidence, false);
  assert.equal(claimed.primary_image_observations, 0);
  assert.ok(!JSON.stringify(evidence).includes(url));
  assert.equal(evidence.externalNetworkRequests, 0);
  assert.equal(evidence.onlineVerified, false);
  assert.equal((await occurrences(x)).length, 3);
  const run = (flags = [], env = process.env) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ["--import", "./scripts/test-network.mjs", "scripts/collector-evidence.mjs", ...flags],
        { encoding: "utf8", env, stdio: "pipe" },
      ),
    );
  const scope = [`--source=${x.sourceId}`, `--from=${from}`, `--until=${until}`];
  const cli = run(scope);
  assert.deepEqual(cli.slots, JSON.parse(JSON.stringify(evidence.slots)));
  const archive = join(x.root, "evidence.json");
  const published = run([...scope, `--output=${archive}`]);
  const bytes = await readFile(archive);
  assert.equal(published.slots, 4);
  assert.equal((await stat(archive)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(bytes).slots, cli.slots);
  assert.throws(() => run([...scope, `--output=${archive}`]), /EEXIST/);
  assert.deepEqual(await readFile(archive), bytes);
  const verification = [`--verify=${archive}`, `--expect-sha256=${published.sha256}`];
  const noDb = { ...process.env, DATABASE_URL: "postgresql://outside.invalid/denied" };
  assert.equal(run([...scope, ...verification], noDb).verified, true);
  assert.throws(
    () => run([`--source=${other.sourceId}`, ...scope.slice(1), ...verification], noDb),
    /collector_evidence_scope_mismatch/,
  );
  assert.throws(
    () => run([scope[0], `--from=${at(-3 * 86_400).slice(0, 10)}`, scope[2], ...verification], noDb),
    /collector_evidence_scope_mismatch/,
  );
  const alias = join(x.root, "alias.json");
  await symlink(archive, alias);
  assert.throws(() => run([...scope, `--verify=${alias}`, verification[1]], noDb), /ELOOP/);
  await appendFile(archive, "\n");
  assert.throws(() => run([...scope, ...verification], noDb), /collector_evidence_digest_mismatch/);
  await assert.rejects(collectorRunEvidence(db, x.sourceId, from, at(86_400).slice(0, 10)), /not_closed/);
  await assert.rejects(
    collectorRunEvidence(db, x.sourceId, "2026-02-30", until),
    /invalid_collector_evidence_day/,
  );
  await assert.rejects(collectorRunEvidence(db, randomUUID(), from, until), /source_unavailable/);
});

test("a full 120-query schedule records all 1680 slots after a thirteen-day outage", async (t) => {
  const x = await setup({ dailyJobs: 120 });
  const first = Date.parse("2026-11-18T00:00:00.000Z");
  const day = 86_400_000;
  const slot = 8 * 3_600_000;
  const clockAt = (offset) => new Date(first + offset).toISOString();
  for (let i = 0; i < 120; i++) {
    await x.refresh.create({
      ...x.input,
      query: new URLSearchParams({ q: `Synthetic campaign model ${i + 1}` }),
      key: `synthetic-campaign-model-${i + 1}`,
      startAt: clockAt((i % 3) * slot),
      intervalSeconds: day / 1000,
    });
  }
  for (let block = 0; block < 3; block++) {
    x.clock.value = clockAt(block * slot);
    assert.deepEqual(await x.refresh.materialize(x.sourceId), { materialized: 40, more: false });
    for (let i = 0; i < 40; i++) {
      const next = await x.refresh.dispatchNext(x.sourceId);
      assert.ok(next?.jobId);
      assert.equal((await complete(x, next.jobId)).status, "completed");
    }
    assert.equal(await x.refresh.dispatchNext(x.sourceId), null);
  }
  x.clock.value = clockAt(14 * day - 1);
  assert.deepEqual(await x.refresh.materialize(x.sourceId), { materialized: 1000, more: true });
  assert.deepEqual(await x.refresh.materialize(x.sourceId), { materialized: 560, more: false });
  assert.deepEqual(await x.refresh.materialize(x.sourceId), { materialized: 0, more: false });
  assert.equal(await x.refresh.dispatchNext(x.sourceId), null);
  const evidence = await collectorHealth(db, x.sourceId, { now: clockAt(14 * day), dailyDays: 14 });
  assert.equal(evidence.onlineVerified, false);
  assert.equal(evidence.networkRequests, 0);
  assert.equal(evidence.daily.days.length, 14);
  const [observed, ...outage] = evidence.daily.days;
  assert.deepEqual(
    [observed.planned, observed.materialized, observed.onTime, observed.completed, observed.pageAttempts],
    [120, 120, 120, 120, 120],
  );
  for (const missed of outage)
    assert.deepEqual(
      [missed.planned, missed.materialized, missed.stoppedOccurrences, missed.started, missed.pageAttempts],
      [120, 120, 120, 0, 0],
    );
  assert.equal(observed.firstPageDispatchedOnTime, 120);
  assert.ok(outage.every((day) => day.firstPageDispatched === 0 && day.claimedWithoutPageDispatch === 0));
  t.diagnostic(JSON.stringify({ mode: "offline_fixture", planned: 1680, completed: 120, missed: 1560 }));
});

test("refresh lease cannot be reused for a different run key, TTL or source", async () => {
  for (const field of ["runKey", "ttlSeconds", "sourceId"]) {
    const x = await setup(),
      other = await setup();
    await x.refresh.create(x.input);
    await x.refresh.materialize(x.sourceId);
    const original = x.store.enqueue.bind(x.store);
    x.store.enqueue = (input) =>
      original({
        ...input,
        [field]: field === "runKey" ? "arbitrary-job" : field === "ttlSeconds" ? 60 : other.sourceId,
      });
    const result = await x.refresh.dispatchNext(x.sourceId);
    assert.equal(result.status, "blocked");
    assert.equal(
      (
        await db.query("SELECT count(*)::int n FROM collector_jobs WHERE source_id=ANY($1)", [
          [x.sourceId, other.sourceId],
        ])
      ).rows[0].n,
      0,
    );
  }
});

test("future plan has no due slots and retirement cannot erase materialized history", async () => {
  const x = await setup(),
    start = "2026-11-17T12:01:00.000Z",
    id = await x.refresh.create({ ...x.input, startAt: start });
  let r = await collectorHealth(db, x.sourceId, { now: x.clock.value });
  assert.equal(r.refresh.planned, 0);
  assert.equal(r.scheduleExecutionRate.ratio, null);
  assert.equal((await x.refresh.materialize(x.sourceId)).materialized, 0);
  step(x, 60);
  await x.refresh.materialize(x.sourceId);
  await assert.rejects(
    db.query("UPDATE collector_refresh_plans SET retired_at=$2 WHERE id=$1", [id, start]),
    /cannot remove historical slots/,
  );
  await x.refresh.retire(x.sourceId, id);
  r = await collectorHealth(db, x.sourceId, { now: x.clock.value });
  assert.equal(r.refresh.planned, 1);
  assert.equal(r.refresh.materialized, 1);
  await assert.rejects(
    x.refresh.create({ ...x.input, key: randomUUID(), startAt: start }),
    /overlaps_history/,
  );
  const replacement = await x.refresh.create({ ...x.input, key: randomUUID() });
  assert.equal(
    (
      await db.query("SELECT start_at FROM collector_refresh_plans WHERE id=$1", [replacement])
    ).rows[0].start_at.toISOString(),
    "2026-11-17T12:01:00.001Z",
  );
  assert.equal((await x.refresh.materialize(x.sourceId)).materialized, 0);
});
