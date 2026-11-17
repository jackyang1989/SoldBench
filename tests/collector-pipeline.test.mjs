import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  COLLECTOR_VERSION,
  CollectorStore,
  digest,
  FixtureTransport,
  fixtureResponse,
  OfflineCollectorWorker,
  PARSER_VERSION,
  parseFixturePage,
  provisionFixtureSource,
} from "@soldbench/collector";
import { evaluate } from "@soldbench/core";
import { database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import sharp from "sharp";

const db = database(process.env.DATABASE_URL);
let clock = "2026-11-16T12:00:00Z";
const roots = [];
before(async () => {
  await migrate(db);
});
after(async () => {
  await db.end();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
async function setup(options = {}, startClock = "2026-11-16T12:00:00Z") {
  clock = startClock;
  const source = await provisionFixtureSource(db, clock, options),
    store = new CollectorStore(db, () => clock);
  const root = await mkdtemp(join(tmpdir(), "soldbench-pipeline-"));
  roots.push(root);
  const media = new PrivateMediaStore(root);
  const queryHash = digest("synthetic-query");
  const input = { ...source, queryHash, runKey: "run-1", asOf: clock };
  const jobId = await store.enqueue(input);
  return { ...source, store, media, root, input, jobId, queryHash };
}
function candidate(sourceId, index, changes = {}) {
  return {
    sourceId,
    eventKey: `event-${index}`,
    identityVerified: true,
    comparable: true,
    priceStatus: "verified_actual",
    format: "fixed_price",
    currency: "USD",
    itemCents: 1000,
    shippingCents: 0,
    shippingStatus: "verified_free_shipping",
    time: { precision: "instant", value: "2026-11-15T12:00:00Z" },
    ...changes,
  };
}
function page(x, records, cursor = "start", nextCursor = null) {
  return {
    schema: "soldbench.synthetic-page.v1",
    synthetic: true,
    sourceId: x.sourceId,
    queryHash: x.queryHash,
    cursor,
    nextCursor,
    asOf: x.input.asOf,
    empty: records.length === 0,
    records,
  };
}
function listing(x, i, changes = {}) {
  return {
    listingId: `listing-${i}`,
    title: `Synthetic listing ${i}`,
    candidate: candidate(x.sourceId, i),
    ...changes,
  };
}
const frames = (entries) => new FixtureTransport(new Map(entries));
const worker = (x, transport) => new OfflineCollectorWorker(x.store, transport, x.media);

test("PG collector replays golden pages, persists provenance, de-duplicates and stores/reads real image bytes", async () => {
  const x = await setup();
  const fixture = JSON.parse(readFileSync(new URL("../v14_gameboy_58_verified.json", import.meta.url)));
  // Re-create the run with its explicitly frozen oracle timestamp.
  await x.store.cancel(x.jobId);
  x.input = { ...x.input, runKey: "golden", asOf: fixture.as_of };
  x.jobId = await x.store.enqueue(x.input);
  const records = fixture.candidate_records.map((r, i) => ({
    listingId: r.listing_id ?? `listing-${r.sale_event_id}`,
    title: r.title ?? `Synthetic ${i}`,
    candidate: {
      sourceId: x.sourceId,
      eventKey: r.sale_event_id,
      identityVerified: true,
      comparable: r.is_comparable,
      priceStatus: r.sale_price_status,
      format: r.sale_format,
      currency: r.currency ?? "XXX",
      itemCents: r.item_price_cents ?? null,
      shippingCents: r.observed_shipping_cents ?? null,
      shippingStatus: r.observed_shipping_status,
      time: { precision: "instant", value: r.sold_at },
    },
  }));
  const imageUrl = "https://images.example.test/fixture.png";
  records[0].primaryImage = { role: "primary", url: imageUrl };
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "blue" } })
    .png()
    .toBuffer();
  const transport = frames([
    ["page:start", [fixtureResponse(page(x, records.slice(0, 50), "start", "second"))]],
    ["page:second", [fixtureResponse(page(x, records.slice(50, 100), "second", "third"))]],
    ["page:third", [fixtureResponse(page(x, records.slice(100), "third", null))]],
    [`image:${imageUrl}`, [{ status: 200, contentType: "image/png", bytes: png }]],
  ]);
  const runner = worker(x, transport);
  assert.equal((await runner.runOne(x.sourceId)).status, "completed");
  const result = evaluate(await x.store.candidates(x.jobId), {
    sourceId: x.sourceId,
    asOf: fixture.as_of,
    days: 90,
    basis: "item_plus_observed_shipping",
    limit: 50,
  });
  assert.deepEqual(result.stats, fixture.expected_stats);
  assert.deepEqual(result.quality, fixture.expected_quality);
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM sale_events WHERE source_id=$1", [x.sourceId])).rows[0].n,
    121,
  );
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM collector_pages WHERE job_id=$1", [x.jobId])).rows[0].n,
    3,
  );
  const image = (
    await db.query("SELECT * FROM listing_images WHERE source_id=$1 AND state='available'", [x.sourceId])
  ).rows[0];
  assert.equal((await sharp(await runner.readImageInternal(image.id)).metadata()).format, "webp");
  assert.equal((await stat(join(x.root, image.object_key))).mode & 0o777, 0o600);
  assert.equal(
    (
      await db.query("SELECT data_as_of FROM collector_watermarks WHERE source_id=$1", [x.sourceId])
    ).rows[0].data_as_of.toISOString(),
    new Date(fixture.as_of).toISOString(),
  );
  await x.store.revokeSource(x.sourceId, "test_revoked");
  await assert.rejects(runner.readImageInternal(image.id), /image_unavailable/);
  await runner.drainMediaCleanup();
  await assert.rejects(x.media.get(image.object_key));
});

test("enqueue, lease and budgets remain atomic under concurrent dispatch attempts", async () => {
  const x = await setup({ concurrency: 1, dailyPages: 1 });
  const same = await Promise.all(Array.from({ length: 20 }, () => x.store.enqueue(x.input)));
  assert.ok(same.every((id) => id === x.jobId));
  await assert.rejects(x.store.enqueue({ ...x.input, asOf: "2026-11-15T12:00:00Z" }), /idempotency_conflict/);
  const claims = await Promise.all(Array.from({ length: 20 }, () => x.store.claim(x.sourceId)));
  assert.equal(claims.filter(Boolean).length, 1);
  const lease = claims.find(Boolean);
  const reservations = await Promise.allSettled(
    Array.from({ length: 100 }, () => x.store.reserve(lease, "page", 1024)),
  );
  assert.equal(reservations.filter((r) => r.status === "fulfilled").length, 1);
  const id = reservations.find((r) => r.status === "fulfilled").value;
  await x.store.settle(lease, id, 100);
  await x.store.settle(lease, id, 100);
  await assert.rejects(x.store.settle(lease, id, 101), /settlement_conflict/);
  await assert.rejects(x.store.reserve(lease, "page", 1024), /daily_budget_exhausted/);
  const budget = (
    await db.query("SELECT * FROM source_daily_budget WHERE source_id=$1 AND budget_kind='pages'", [
      x.sourceId,
    ])
  ).rows[0];
  assert.equal(budget.reserved, "0");
  assert.equal(budget.used, "1");
});

test("expired worker reservations are conservatively consumed, lease takeover rejects stale publication", async () => {
  const x = await setup({ concurrency: 1 });
  const old = await x.store.claim(x.sourceId, 1);
  await x.store.reserve(old, "page", 1024);
  clock = "2026-11-16T12:00:02Z";
  const fresh = await x.store.claim(x.sourceId);
  assert.notEqual(old.token, fresh.token);
  const recreated = new CollectorStore(db, () => clock);
  await assert.rejects(recreated.reserve(old, "page", 1), /lease_lost/);
  const row = await recreated.view(x.jobId);
  assert.equal(row.bytes_used, "1024");
  assert.equal(row.bytes_reserved, "0");
  assert.equal(
    (await db.query("SELECT state FROM collector_dispatches WHERE job_id=$1", [x.jobId])).rows[0].state,
    "abandoned",
  );
  const p = page(x, [listing(x, 0)]),
    raw = fixtureResponse(p).bytes,
    id = await recreated.reserve(fresh, "page", 1024 * 1024);
  await recreated.settle(fresh, id, raw.length, digest(raw));
  await recreated.commitPage(fresh, p, raw, id);
  await recreated.finish(fresh);
  assert.equal((await recreated.view(x.jobId)).status, "completed");
});

test("429 observes retry-after and a subsequent worker resumes the same job without advancing prematurely", async () => {
  const x = await setup();
  const transport = frames([
    [
      "page:start",
      [
        { status: 429, contentType: "application/json", bytes: Buffer.from("{}"), retryAfterSeconds: 120 },
        fixtureResponse(page(x, [listing(x, 0)])),
      ],
    ],
  ]);
  assert.equal((await worker(x, transport).runOne(x.sourceId)).status, "retry");
  assert.equal(await worker(x, transport).runOne(x.sourceId), null);
  assert.equal(
    (await db.query("SELECT * FROM collector_watermarks WHERE source_id=$1", [x.sourceId])).rowCount,
    0,
  );
  clock = "2026-11-16T12:02:00Z";
  assert.equal((await worker(x, transport).runOne(x.sourceId)).status, "completed");
  assert.equal((await x.store.view(x.jobId)).request_count, 2);
});

test("401/403/login challenges persistently stop all source dispatches including oversized responses", async () => {
  for (const response of [
    { status: 401, contentType: "text/html", bytes: Buffer.alloc(1024 * 1024 + 1) },
    { status: 403, contentType: "text/html", bytes: Buffer.from("blocked") },
    { status: 200, contentType: "text/html", bytes: Buffer.from("Verify you are human") },
  ]) {
    const x = await setup();
    const transport = frames([["page:start", [response]]]);
    assert.equal((await worker(x, transport).runOne(x.sourceId)).status, "failed");
    await assert.rejects(new CollectorStore(db, () => clock).claim(x.sourceId), /circuit_open/);
    assert.equal(transport.calls.length, 1);
    assert.equal(
      (await db.query("SELECT * FROM collector_watermarks WHERE source_id=$1", [x.sourceId])).rowCount,
      0,
    );
  }
});

test("failed second page preserves committed evidence and resumes checkpoint without duplicating sales", async () => {
  const x = await setup();
  const first = listing(x, 0);
  const transport = frames([
    ["page:start", [fixtureResponse(page(x, [first], "start", "second"))]],
    [
      "page:second",
      [
        { status: 503, contentType: "application/json", bytes: Buffer.from("{}") },
        fixtureResponse(page(x, [first, listing(x, 1)], "second", null)),
      ],
    ],
  ]);
  assert.equal((await worker(x, transport).runOne(x.sourceId)).status, "retry");
  assert.equal((await x.store.view(x.jobId)).cursor, "second");
  assert.equal(
    (await db.query("SELECT * FROM collector_watermarks WHERE source_id=$1", [x.sourceId])).rowCount,
    0,
  );
  clock = "2026-11-16T12:01:00Z";
  assert.equal((await worker(x, transport).runOne(x.sourceId)).status, "completed");
  assert.equal(transport.calls.filter((x) => x === "page:start").length, 1);
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM sale_events WHERE source_id=$1", [x.sourceId])).rows[0].n,
    2,
  );
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM sale_event_evidence WHERE source_id=$1", [x.sourceId]))
      .rows[0].n,
    3,
  );
});

test("event conflict and pagination loops roll back the failing page and never publish a complete watermark", async () => {
  for (const conflict of [true, false]) {
    const x = await setup();
    const second = conflict
      ? listing(x, 0, { candidate: candidate(x.sourceId, 0, { itemCents: 2000 }) })
      : listing(x, 1);
    const transport = frames([
      ["page:start", [fixtureResponse(page(x, [listing(x, 0)], "start", "next"))]],
      ["page:next", [fixtureResponse(page(x, [second], "next", conflict ? null : "start"))]],
    ]);
    assert.equal((await worker(x, transport).runOne(x.sourceId)).status, "failed");
    assert.equal((await db.query("SELECT * FROM collector_pages WHERE job_id=$1", [x.jobId])).rowCount, 1);
    assert.equal(
      (await db.query("SELECT * FROM collector_watermarks WHERE source_id=$1", [x.sourceId])).rowCount,
      0,
    );
    assert.match(
      (await x.store.view(x.jobId)).error_code,
      conflict ? /event_identity_conflict/ : /pagination_loop/,
    );
  }
});

test("cancelled, revoked and configuration-changed workers cannot reserve or publish", async () => {
  for (const change of ["cancel", "epoch", "config", "network"]) {
    const x = await setup();
    const lease = await x.store.claim(x.sourceId);
    if (change === "cancel") await x.store.cancel(x.jobId);
    if (change === "epoch")
      await db.query("UPDATE sources SET permission_epoch=permission_epoch+1 WHERE id=$1", [x.sourceId]);
    if (change === "config")
      await db.query("UPDATE collector_configs SET updated_at=updated_at+interval '1 second' WHERE id=$1", [
        x.configId,
      ]);
    if (change === "network")
      await db.query("UPDATE sources SET access_method='approved_http' WHERE id=$1", [x.sourceId]);
    await assert.rejects(x.store.reserve(lease, "page", 100));
  }
});

test("private media objects reject traversal, symlinks and corruption; synthetic parser rejects false empty pages", async () => {
  const x = await setup();
  await assert.rejects(x.media.get("../secret"));
  const object = await x.media.put(x.sourceId, Buffer.from("fixture"));
  assert.deepEqual(await x.media.get(object.key), Buffer.from("fixture"));
  const fakeHash = "b".repeat(64);
  await symlink(join(x.root, object.key), join(x.root, x.sourceId, `${fakeHash}.webp`));
  await assert.rejects(x.media.get(`${x.sourceId}/${fakeHash}.webp`));
  assert.throws(
    () =>
      parseFixturePage(fixtureResponse({ ...page(x, []), empty: false }).bytes, {
        sourceId: x.sourceId,
        queryHash: x.queryHash,
        cursor: "start",
        asOf: clock,
      }),
    /binding_or_shape/,
  );
});

test("uncertain observations can be replayed across runs without inventing verified sales", async () => {
  const x = await setup();
  const uncertain = listing(x, 0, {
    candidate: candidate(x.sourceId, 0, { eventKey: null, identityVerified: false }),
  });
  const transport = frames([["page:start", [fixtureResponse(page(x, [uncertain]))]]]);
  assert.equal((await worker(x, transport).runOne(x.sourceId)).status, "completed");
  const second = await x.store.enqueue({ ...x.input, runKey: "run-2" });
  assert.equal((await worker(x, transport).runOne(x.sourceId)).status, "completed");
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM sale_events WHERE source_id=$1", [x.sourceId])).rows[0].n,
    1,
  );
  const result = evaluate(await x.store.candidates(second), {
    sourceId: x.sourceId,
    asOf: clock,
    days: 90,
    basis: "item",
    limit: 50,
  });
  assert.equal(result.stats.n_price_verified, 0);
  assert.equal(result.stats.n_comparable, 0);
  assert.equal(result.stats.n_observed, 1);
});

test("normal empty evidence succeeds, but a mutated page cannot commit against its raw-response digest", async () => {
  const x = await setup();
  assert.equal(
    (await worker(x, frames([["page:start", [fixtureResponse(page(x, []))]]])).runOne(x.sourceId)).status,
    "completed",
  );
  assert.deepEqual(await x.store.candidates(x.jobId), []);
  const y = await setup();
  const lease = await y.store.claim(y.sourceId),
    p = page(y, [listing(y, 0)]),
    raw = fixtureResponse(p).bytes;
  const id = await y.store.reserve(lease, "page", 1024 * 1024);
  await y.store.settle(lease, id, raw.length, digest(raw));
  await assert.rejects(y.store.commitPage(lease, { ...p, records: [] }, raw, id), /payload_mismatch/);
  assert.equal((await db.query("SELECT * FROM collector_pages WHERE job_id=$1", [y.jobId])).rowCount, 0);
});

test("the executable collector demo runs against the isolated database with no network", async () => {
  const { execFileSync } = await import("node:child_process");
  const x = await setup();
  const output = execFileSync(
    process.execPath,
    ["--import", "./scripts/test-network.mjs", "scripts/collector-demo.mjs"],
    { encoding: "utf8", env: { ...process.env, COLLECTOR_DEMO_DIR: x.root } },
  );
  const report = JSON.parse(output);
  assert.equal(report.status, "completed");
  assert.equal(report.pageCount, 3);
  assert.equal(report.networkRequests, 0);
  assert.equal(report.stats.n_observed, 121);
  assert.equal(report.stats.n_price_verified, 58);
  assert.equal(report.imageFormat, "webp");
});

test("later observations can add their own primary image evidence without creating another sale", async () => {
  const x = await setup();
  const one = "https://images.example.test/first.png",
    two = "https://images.example.test/later.png";
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "green" } })
    .png()
    .toBuffer();
  const transport = frames([
    [
      "page:start",
      [
        fixtureResponse(
          page(x, [listing(x, 0, { primaryImage: { role: "primary", url: one } })], "start", "next"),
        ),
      ],
    ],
    [
      "page:next",
      [
        fixtureResponse(
          page(x, [listing(x, 0, { primaryImage: { role: "primary", url: two } })], "next", null),
        ),
      ],
    ],
    [`image:${one}`, [{ status: 200, contentType: "image/png", bytes: png }]],
    [`image:${two}`, [{ status: 200, contentType: "image/png", bytes: png }]],
  ]);
  assert.equal((await worker(x, transport).runOne(x.sourceId)).status, "completed");
  const images = await db.query("SELECT i.* FROM listing_images i WHERE source_id=$1 AND state='available'", [
    x.sourceId,
  ]);
  assert.equal(images.rowCount, 2);
  assert.notEqual(images.rows[0].observation_id, images.rows[1].observation_id);
  assert.equal(images.rows[0].sale_event_id, images.rows[1].sale_event_id);
  assert.equal(
    evaluate(await x.store.candidates(x.jobId), {
      sourceId: x.sourceId,
      asOf: clock,
      days: 90,
      basis: "item",
      limit: 50,
    }).stats.n_observed,
    1,
  );
  await assert.rejects(
    db.query("UPDATE listing_images SET observation_id=$2 WHERE id=$1", [
      images.rows[0].id,
      "00000000-0000-0000-0000-000000000001",
    ]),
  );
});

test("collection outage preserves still-permitted cached evidence; revocation denies it and replays cleanup", async () => {
  const x = await setup(),
    url = "https://images.example.test/cache.png";
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  const first = worker(
    x,
    frames([
      ["page:start", [fixtureResponse(page(x, [listing(x, 0, { primaryImage: { role: "primary", url } })]))]],
      [`image:${url}`, [{ status: 200, contentType: "image/png", bytes: png }]],
    ]),
  );
  assert.equal((await first.runOne(x.sourceId)).status, "completed");
  const image = (
    await db.query("SELECT id FROM listing_images WHERE source_id=$1 AND state='available'", [x.sourceId])
  ).rows[0];
  await x.store.enqueue({ ...x.input, runKey: "upstream-outage" });
  assert.equal(
    (
      await worker(
        x,
        frames([["page:start", [{ status: 403, contentType: "text/html", bytes: Buffer.from("blocked") }]]]),
      ).runOne(x.sourceId)
    ).status,
    "failed",
  );
  assert.ok((await first.readImageInternal(image.id)).length > 0);
  assert.equal((await x.store.candidates(x.jobId)).length, 1);
  await x.store.revokeSource(x.sourceId, "fixture_permission_revoked");
  await assert.rejects(first.readImageInternal(image.id), /image_unavailable/);
  await assert.rejects(x.store.candidates(x.jobId), /rights_unavailable/);
  assert.equal(await first.drainMediaCleanup(), 1);
  assert.equal(await first.drainMediaCleanup(), 0);
  assert.equal(
    (await db.query("SELECT object_key FROM listing_images WHERE id=$1", [image.id])).rows[0].object_key,
    null,
  );
});

test("rate windows are shared across jobs", async () => {
  const x = await setup({ rateCap: 1, concurrency: 2 });
  await x.store.enqueue({ ...x.input, runKey: "parallel" });
  const a = await x.store.claim(x.sourceId, 120),
    b = await x.store.claim(x.sourceId, 120);
  const results = await Promise.allSettled([
    x.store.reserve(a, "page", 100),
    x.store.reserve(b, "page", 100),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(results.find((r) => r.status === "rejected").reason.message, /rate_limited/);
  const loser = results[0].status === "rejected" ? a : b;
  clock = "2026-11-16T12:01:00Z";
  await x.store.reserve(loser, "page", 100);
  assert.ok(
    (await db.query("SELECT used FROM collector_rate_windows WHERE source_id=$1", [x.sourceId])).rows.every(
      (r) => r.used === 1,
    ),
  );
});

test("reservations settle against their original UTC day; new-day budgets are not fabricated", async () => {
  const x = await setup({}, "2026-11-16T23:59:30Z"),
    lease = await x.store.claim(x.sourceId, 120);
  const id = await x.store.reserve(lease, "page", 1000);
  clock = "2026-11-17T00:00:00Z";
  await x.store.settle(lease, id, 123);
  const old = (
    await db.query(
      "SELECT used,reserved FROM source_daily_budget WHERE source_id=$1 AND day='2026-11-16' AND budget_kind='bytes'",
      [x.sourceId],
    )
  ).rows[0];
  assert.equal(old.used, "123");
  assert.equal(old.reserved, "0");
  await assert.rejects(x.store.reserve(lease, "page", 1000), /daily_budget_exhausted/);
  assert.equal(
    (
      await db.query("SELECT * FROM source_daily_budget WHERE source_id=$1 AND day='2026-11-17'", [
        x.sourceId,
      ])
    ).rowCount,
    0,
  );
});

test("healthy rate-limited pagination can renew leases without exhausting the failure retry budget", async () => {
  const x = await setup({ rateCap: 1 });
  const values = [];
  for (let i = 0; i < 5; i++) {
    const cursor = i === 0 ? "start" : `p${i}`;
    values.push([
      `page:${cursor}`,
      [fixtureResponse(page(x, [listing(x, i)], cursor, i === 4 ? null : `p${i + 1}`))],
    ]);
  }
  const transport = frames(values);
  for (let i = 0; i < 5; i++) {
    clock = new Date(Date.parse("2026-11-16T12:00:00Z") + i * 61000).toISOString();
    assert.equal((await worker(x, transport).runOne(x.sourceId)).status, i === 4 ? "completed" : "retry");
  }
  const job = await x.store.view(x.jobId);
  assert.equal(job.attempts, 0);
  assert.equal(job.lease_count, 5);
  assert.equal(job.page_count, 5);
  assert.equal(transport.calls.length, 5);
});

test("same-listing independent events in the same page keep their own primary images", async () => {
  const x = await setup();
  const red = "https://images.example.test/red.png",
    blue = "https://images.example.test/blue.png";
  const a = listing(x, 0, { listingId: "shared-listing", primaryImage: { role: "primary", url: red } }),
    b = listing(x, 1, { listingId: "shared-listing", primaryImage: { role: "primary", url: blue } });
  const png = async (background) =>
    sharp({ create: { width: 3, height: 3, channels: 3, background } })
      .png()
      .toBuffer();
  const transport = frames([
    ["page:start", [fixtureResponse(page(x, [a, b]))]],
    [`image:${red}`, [{ status: 200, contentType: "image/png", bytes: await png("red") }]],
    [`image:${blue}`, [{ status: 200, contentType: "image/png", bytes: await png("blue") }]],
  ]);
  const runner = worker(x, transport);
  assert.equal((await runner.runOne(x.sourceId)).status, "completed");
  const images = await db.query(
    "SELECT i.id,i.content_hash,e.source_event_key FROM listing_images i JOIN sale_events e ON e.id=i.sale_event_id WHERE i.source_id=$1 ORDER BY e.source_event_key",
    [x.sourceId],
  );
  assert.equal(images.rowCount, 2);
  assert.notEqual(images.rows[0].content_hash, images.rows[1].content_hash);
  const redPixel = await sharp(await runner.readImageInternal(images.rows[0].id))
      .raw()
      .toBuffer(),
    bluePixel = await sharp(await runner.readImageInternal(images.rows[1].id))
      .raw()
      .toBuffer();
  assert.ok(redPixel[0] > redPixel[2]);
  assert.ok(bluePixel[2] > bluePixel[0]);
});

test("revocation failure rolls back stop, epoch, budgets and cleanup event as one transaction", async () => {
  const x = await setup(),
    lease = await x.store.claim(x.sourceId);
  await x.store.reserve(lease, "page", 1000);
  await db.query(
    "CREATE FUNCTION collector_revoke_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='collector.media_cleanup' THEN RAISE EXCEPTION 'injected_cleanup_failure'; END IF; RETURN NEW; END $$",
  );
  await db.query(
    "CREATE TRIGGER collector_revoke_fault BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION collector_revoke_fault()",
  );
  try {
    await assert.rejects(x.store.revokeSource(x.sourceId, "test"), /injected_cleanup_failure/);
  } finally {
    await db.query("DROP TRIGGER collector_revoke_fault ON outbox");
    await db.query("DROP FUNCTION collector_revoke_fault()");
  }
  assert.equal((await x.store.view(x.jobId)).status, "running");
  const source = (await db.query("SELECT status,permission_epoch FROM sources WHERE id=$1", [x.sourceId]))
    .rows[0];
  assert.equal(source.status, "active");
  assert.equal(source.permission_epoch, "1");
  assert.equal(
    (await db.query("SELECT * FROM collector_circuits WHERE source_id=$1", [x.sourceId])).rowCount,
    0,
  );
  assert.equal((await x.store.view(x.jobId)).bytes_reserved, "1000");
  await x.store.revokeSource(x.sourceId, "test");
  assert.equal((await x.store.view(x.jobId)).status, "failed");
  assert.equal((await x.store.view(x.jobId)).bytes_reserved, "0");
});

test("revocation cleanup also deletes a privately written object that never obtained a DB link", async () => {
  const x = await setup();
  const orphan = await x.media.put(x.sourceId, Buffer.from("orphaned-fixture-bytes"));
  await x.store.revokeSource(x.sourceId, "test");
  const runner = worker(x, frames([]));
  await runner.drainMediaCleanup();
  await assert.rejects(x.media.get(orphan.key));
});

test("snapshot assembly selects latest per-event metadata without inventing price conflicts", async () => {
  for (const changes of [{ sellerRef: "approved-seller" }, { comparable: false }]) {
    const x = await setup();
    const transport = frames([
      ["page:start", [fixtureResponse(page(x, [listing(x, 0)], "start", "second"))]],
      [
        "page:second",
        [
          fixtureResponse(
            page(x, [listing(x, 0, { candidate: candidate(x.sourceId, 0, changes) })], "second", null),
          ),
        ],
      ],
    ]);
    assert.equal((await worker(x, transport).runOne(x.sourceId)).status, "completed");
    const rows = await x.store.candidates(x.jobId);
    assert.equal(rows.length, 1);
    for (const [key, value] of Object.entries(changes)) assert.equal(rows[0][key], value);
    const result = evaluate(rows, { sourceId: x.sourceId, asOf: clock, days: 90, basis: "item", limit: 50 });
    assert.deepEqual(result.diagnostics.conflicting_event_keys, []);
    assert.equal(result.stats.n_price_verified, changes.comparable === false ? 0 : 1);
  }
});

test("source revocation waits for private publication, then cleanup removes the newly written file", async () => {
  const x = await setup(),
    url = "https://images.example.test/race.png";
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  let enter, release;
  const entered = new Promise((resolve) => {
      enter = resolve;
    }),
    resume = new Promise((resolve) => {
      release = resolve;
    });
  class PausedStore extends PrivateMediaStore {
    async put(sourceId, bytes) {
      enter();
      await resume;
      return super.put(sourceId, bytes);
    }
  }
  const paused = new PausedStore(x.root),
    runner = new OfflineCollectorWorker(
      x.store,
      frames([
        [
          "page:start",
          [fixtureResponse(page(x, [listing(x, 0, { primaryImage: { role: "primary", url } })]))],
        ],
        [`image:${url}`, [{ status: 200, contentType: "image/png", bytes: png }]],
      ]),
      paused,
    );
  const running = runner.runOne(x.sourceId);
  await entered;
  const revoke = x.store.revokeSource(x.sourceId, "race");
  assert.equal(
    await Promise.race([
      revoke.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 30)),
    ]),
    false,
  );
  release();
  await Promise.all([running, revoke]);
  await runner.drainMediaCleanup();
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(join(x.root, x.sourceId)), []);
});

test("an identical unknown candidate on two different pages is one uncertain candidate with valid primary evidence", async () => {
  const x = await setup(),
    url = "https://images.example.test/unknown.png";
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } })
    .png()
    .toBuffer();
  const record = listing(x, 0, {
    candidate: candidate(x.sourceId, 0, { eventKey: null, identityVerified: false }),
    primaryImage: { role: "primary", url },
  });
  const transport = frames([
    ["page:start", [fixtureResponse(page(x, [record], "start", "second"))]],
    ["page:second", [fixtureResponse(page(x, [record], "second", null))]],
    [`image:${url}`, [{ status: 200, contentType: "image/png", bytes: png }]],
  ]);
  assert.equal((await worker(x, transport).runOne(x.sourceId)).status, "completed");
  const rows = await x.store.candidates(x.jobId);
  assert.equal(rows.length, 1);
  assert.equal(
    evaluate(rows, { sourceId: x.sourceId, asOf: clock, days: 90, basis: "item", limit: 50 }).stats
      .n_observed,
    1,
  );
  assert.equal(
    (await db.query("SELECT * FROM listing_images WHERE source_id=$1 AND state='available'", [x.sourceId]))
      .rowCount,
    2,
  );
  assert.equal((await db.query("SELECT * FROM sale_events WHERE source_id=$1", [x.sourceId])).rowCount, 1);
});

test("retention maintenance preserves a shared valid object, expires old references and collects aged orphans", async () => {
  const x = await setup(),
    url = "https://images.example.test/shared.png";
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "green" } })
    .png()
    .toBuffer();
  const transport = frames([
    ["page:start", [fixtureResponse(page(x, [listing(x, 0, { primaryImage: { role: "primary", url } })]))]],
    [`image:${url}`, [{ status: 200, contentType: "image/png", bytes: png }]],
  ]);
  const runner = worker(x, transport);
  assert.equal((await runner.runOne(x.sourceId)).status, "completed");
  const first = (
    await db.query("SELECT * FROM listing_images WHERE source_id=$1 AND state='available'", [x.sourceId])
  ).rows[0];
  clock = "2026-11-16T12:30:00Z";
  await x.store.enqueue({ ...x.input, runKey: "later" });
  assert.equal((await runner.runOne(x.sourceId)).status, "completed");
  const other = (
    await db.query("SELECT * FROM listing_images WHERE source_id=$1 AND id<>$2 AND state='available'", [
      x.sourceId,
      first.id,
    ])
  ).rows[0];
  assert.equal(first.object_key, other.object_key);
  clock = "2026-11-17T12:00:01Z";
  assert.equal((await runner.runMaintenance(x.sourceId)).expired, 1);
  await assert.rejects(runner.readImageInternal(first.id));
  assert.ok((await runner.readImageInternal(other.id)).length > 0);
  clock = "2026-11-17T12:31:00Z";
  assert.equal((await runner.runMaintenance(x.sourceId)).expired, 1);
  await assert.rejects(x.media.get(first.object_key));
  const orphan = await x.media.put(x.sourceId, Buffer.from("old-orphan"));
  const { utimes } = await import("node:fs/promises");
  await utimes(join(x.root, orphan.key), new Date("2026-11-16T00:00:00Z"), new Date("2026-11-16T00:00:00Z"));
  clock = "2026-11-18T12:00:00Z";
  assert.equal((await runner.runMaintenance(x.sourceId)).orphans, 1);
  await assert.rejects(x.media.get(orphan.key));
});

test("an invalid maintenance/read clock cannot extend image visibility or delete valid objects", async () => {
  const x = await setup(),
    url = "https://images.example.test/clock.png";
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } })
    .png()
    .toBuffer();
  const runner = worker(
    x,
    frames([
      ["page:start", [fixtureResponse(page(x, [listing(x, 0, { primaryImage: { role: "primary", url } })]))]],
      [`image:${url}`, [{ status: 200, contentType: "image/png", bytes: png }]],
    ]),
  );
  assert.equal((await runner.runOne(x.sourceId)).status, "completed");
  const image = (
    await db.query("SELECT id,object_key FROM listing_images WHERE source_id=$1 AND state='available'", [
      x.sourceId,
    ])
  ).rows[0];
  clock = "invalid-clock";
  await assert.rejects(runner.readImageInternal(image.id), /invalid_utc_instant/);
  await assert.rejects(runner.runMaintenance(x.sourceId), /invalid_utc_instant/);
  assert.ok((await x.media.get(image.object_key)).length > 0);
});

test("malformed successful pages quarantine bounded metadata and atomically stop every queued source job", async () => {
  for (const malformed of ["json", "html", "shape", "binding", "candidate", "encoding"]) {
    const x = await setup(),
      queued = await x.store.enqueue({ ...x.input, runKey: "queued", queryHash: digest("other-query") });
    let bytes = Buffer.from('{"secret":"do-not-store-raw-token"'),
      contentType = "application/json";
    if (malformed === "html") {
      bytes = Buffer.from("<html>unrecognized source error do-not-store-raw-token</html>");
      contentType = "text/html";
    }
    if (["shape", "binding", "candidate"].includes(malformed)) {
      const body = page(x, [listing(x, 1)]);
      if (malformed === "shape") delete body.records;
      if (malformed === "binding") body.queryHash = digest("wrong-query");
      if (malformed === "candidate") body.records[0].candidate.itemCents = -1;
      bytes = Buffer.from(JSON.stringify(body));
    }
    if (malformed === "encoding") bytes = Buffer.from([0xff, 0xfe, 0xfd]);
    const transport = frames([["page:start", [{ status: 200, contentType, bytes }]]]);
    assert.equal((await worker(x, transport).runOne(x.sourceId)).status, "failed");
    assert.equal((await x.store.view(queued)).status, "failed");
    assert.equal(transport.calls.length, 1);
    const incident = (await db.query("SELECT * FROM collector_quarantines WHERE source_id=$1", [x.sourceId]))
      .rows[0];
    assert.equal(incident.raw_hash, digest(bytes));
    assert.equal(Number(incident.byte_length), bytes.length);
    assert.equal(
      incident.reason,
      malformed === "html" ? "page_content_type_invalid" : "page_structure_invalid",
    );
    assert.equal(incident.affected_event_id, null);
    assert.equal(JSON.stringify(incident).includes("do-not-store-raw-token"), false);
    assert.equal((await db.query("SELECT * FROM collector_pages WHERE job_id=$1", [x.jobId])).rowCount, 0);
    assert.equal(
      (await db.query("SELECT * FROM collector_watermarks WHERE source_id=$1", [x.sourceId])).rowCount,
      0,
    );
    const notification = (
      await db.query("SELECT payload FROM outbox WHERE event_key=$1", [
        `collector-quarantine:${incident.dispatch_id}`,
      ])
    ).rows[0].payload;
    assert.equal(notification.incidentId, incident.id);
    assert.equal(JSON.stringify(notification).includes("do-not-store-raw-token"), false);
    await assert.rejects(x.store.claim(x.sourceId), /source_circuit_open/);
  }
});

test("a structure drift preserves valid previous evidence while a later event conflict blocks affected cached inputs", async () => {
  const x = await setup();
  await worker(x, frames([["page:start", [fixtureResponse(page(x, [listing(x, 0)]))]]])).runOne(x.sourceId);
  const prior = (await db.query("SELECT * FROM collector_watermarks WHERE source_id=$1", [x.sourceId]))
    .rows[0];
  const second = await x.store.enqueue({ ...x.input, runKey: "conflict" });
  const changed = listing(x, 0, { candidate: candidate(x.sourceId, 0, { itemCents: 9000 }) });
  await worker(x, frames([["page:start", [fixtureResponse(page(x, [changed]))]]])).runOne(x.sourceId);
  const incident = (await db.query("SELECT * FROM collector_quarantines WHERE job_id=$1", [second])).rows[0];
  assert.equal(incident.reason, "event_identity_conflict");
  assert.ok(incident.affected_event_id);
  await assert.rejects(x.store.candidates(x.jobId), /collector_evidence_quarantined/);
  assert.equal(
    (await db.query("SELECT item_price_cents FROM sale_events WHERE id=$1", [incident.affected_event_id]))
      .rows[0].item_price_cents,
    "1000",
  );
  const after = (await db.query("SELECT * FROM collector_watermarks WHERE source_id=$1", [x.sourceId]))
    .rows[0];
  assert.deepEqual(after, prior);
  const y = await setup();
  await worker(y, frames([["page:start", [fixtureResponse(page(y, [listing(y, 0)]))]]])).runOne(y.sourceId);
  await y.store.enqueue({ ...y.input, runKey: "drift" });
  await worker(
    y,
    frames([
      ["page:start", [{ status: 200, contentType: "application/json", bytes: Buffer.from("invalid json") }]],
    ]),
  ).runOne(y.sourceId);
  assert.equal((await y.store.candidates(y.jobId)).length, 1);
});

test("quarantine rejects cross-job, mismatched bytes, unconsumed dispatches and old leases", async () => {
  const x = await setup(),
    lease = await x.store.claim(x.sourceId),
    raw = Buffer.from("invalid json");
  const dispatch = await x.store.reserve(lease, "page", 1024);
  await assert.rejects(
    x.store.quarantinePage(lease, dispatch, raw, "page_structure_invalid"),
    /quarantine_dispatch_mismatch/,
  );
  await x.store.settle(lease, dispatch, raw.length, digest(raw));
  await assert.rejects(
    x.store.quarantinePage(lease, dispatch, Buffer.from("changed"), "page_structure_invalid"),
    /quarantine_dispatch_mismatch/,
  );
  const y = await setup();
  const otherLease = await y.store.claim(y.sourceId);
  await assert.rejects(
    y.store.quarantinePage(otherLease, dispatch, raw, "page_structure_invalid"),
    /quarantine_dispatch_mismatch/,
  );
  clock = "2026-11-16T12:01:01Z";
  await assert.rejects(
    x.store.quarantinePage(lease, dispatch, raw, "page_structure_invalid"),
    /collector_lease_lost/,
  );
  assert.equal(
    (
      await db.query("SELECT * FROM collector_quarantines WHERE source_id=ANY($1::uuid[])", [
        [x.sourceId, y.sourceId],
      ])
    ).rowCount,
    0,
  );
});

test("quarantine outbox failure rolls back incident, circuit and other job mutations", async () => {
  const x = await setup(),
    queued = await x.store.enqueue({ ...x.input, runKey: "other", queryHash: digest("other") });
  const lease = await x.store.claim(x.sourceId, 60, x.jobId),
    raw = Buffer.from("invalid json"),
    dispatch = await x.store.reserve(lease, "page", 1024);
  await x.store.settle(lease, dispatch, raw.length, digest(raw));
  await db.query(
    "CREATE FUNCTION collector_quarantine_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='collector.evidence_quarantined' THEN RAISE EXCEPTION 'injected_quarantine_failure'; END IF; RETURN NEW; END $$",
  );
  await db.query(
    "CREATE TRIGGER collector_quarantine_fault BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION collector_quarantine_fault()",
  );
  try {
    await assert.rejects(
      x.store.quarantinePage(lease, dispatch, raw, "page_structure_invalid"),
      /injected_quarantine_failure/,
    );
    assert.equal(
      (await db.query("SELECT * FROM collector_quarantines WHERE job_id=$1", [x.jobId])).rowCount,
      0,
    );
    assert.equal(
      (await db.query("SELECT * FROM collector_circuits WHERE source_id=$1", [x.sourceId])).rowCount,
      0,
    );
    assert.equal((await x.store.view(queued)).status, "queued");
    assert.equal((await x.store.view(x.jobId)).status, "running");
  } finally {
    await db.query("DROP TRIGGER collector_quarantine_fault ON outbox");
    await db.query("DROP FUNCTION collector_quarantine_fault()");
  }
  await x.store.quarantinePage(lease, dispatch, raw, "page_structure_invalid");
  assert.equal((await x.store.view(queued)).status, "failed");
});

test("conflicting events first seen within one page quarantine without referencing rolled back event IDs", async () => {
  for (const uncertain of [false, true]) {
    const x = await setup(),
      changes = uncertain
        ? { eventKey: null, identityVerified: false, observationKey: digest("same-uncertain-evidence") }
        : {},
      first = listing(x, 0, { candidate: candidate(x.sourceId, 0, changes) }),
      second = listing(x, 0, { candidate: candidate(x.sourceId, 0, { ...changes, itemCents: 9000 }) });
    const result = await worker(
      x,
      frames([["page:start", [fixtureResponse(page(x, [first, second]))]]]),
    ).runOne(x.sourceId);
    assert.equal(result.status, "failed");
    const incident = (await db.query("SELECT * FROM collector_quarantines WHERE job_id=$1", [x.jobId]))
      .rows[0];
    assert.equal(incident.reason, "page_event_conflict");
    assert.equal(incident.affected_event_id, null);
    assert.equal((await db.query("SELECT * FROM sale_events WHERE source_id=$1", [x.sourceId])).rowCount, 0);
    assert.equal((await db.query("SELECT * FROM collector_pages WHERE job_id=$1", [x.jobId])).rowCount, 0);
    assert.equal(
      (await db.query("SELECT * FROM collector_circuits WHERE source_id=$1 AND status='open'", [x.sourceId]))
        .rowCount,
      1,
    );
  }
});

test("inconsistent persistence semantics and invalid dates are classified before SQL as quarantined bad pages", async () => {
  const cases = [
    { shippingStatus: "unknown", shippingCents: 1 },
    { shippingStatus: "observed", shippingCents: null },
    { shippingStatus: "verified_free_shipping", shippingCents: 10 },
    {
      shippingStatus: "unknown",
      shippingCents: null,
      currency: "EUR",
      usdConversion: { itemCents: 1000, shippingCents: 1, evidenceRef: "synthetic" },
    },
    {
      shippingStatus: "verified_free_shipping",
      shippingCents: 0,
      currency: "EUR",
      usdConversion: { itemCents: 1000, shippingCents: 2, evidenceRef: "synthetic" },
    },
    { priceStatus: "verified_actual", itemCents: null },
    { time: { precision: "instant", value: "invalid-time" } },
    { time: { precision: "instant", value: "0000-01-01T00:00:00Z" } },
    { eventKey: "long-event-key".repeat(500) },
    { time: { precision: "day", value: "2026-02-30", timeZone: null } },
  ];
  for (const changes of cases) {
    const x = await setup();
    const body = page(x, [listing(x, 0, { candidate: candidate(x.sourceId, 0, changes) })]);
    await worker(x, frames([["page:start", [fixtureResponse(body)]]])).runOne(x.sourceId);
    assert.equal(
      (await db.query("SELECT reason FROM collector_quarantines WHERE job_id=$1", [x.jobId])).rows[0].reason,
      "page_structure_invalid",
    );
    assert.equal((await x.store.view(x.jobId)).error_code, "page_structure_invalid");
    await assert.rejects(x.store.claim(x.sourceId), /source_circuit_open/);
  }
  for (const text of ["embedded\u0000nul", "unpaired\ud800surrogate"]) {
    const x = await setup(),
      body = page(x, [listing(x, 0)]);
    body.extra = { [text]: text };
    await worker(x, frames([["page:start", [fixtureResponse(body)]]])).runOne(x.sourceId);
    assert.equal(
      (await db.query("SELECT reason FROM collector_quarantines WHERE job_id=$1", [x.jobId])).rows[0].reason,
      "page_structure_invalid",
    );
  }
});

test("non-USD verified free shipping is deterministic zero while missing item FX remains unknown and excluded", async () => {
  const x = await setup();
  const body = page(x, [listing(x, 0, { candidate: candidate(x.sourceId, 0, { currency: "EUR" }) })]);
  const result = await worker(x, frames([["page:start", [fixtureResponse(body)]]])).runOne(x.sourceId);
  assert.equal(result.status, "completed");
  const stored = (
    await db.query(
      "SELECT item_price_cents,item_price_usd_cents,observed_shipping_cents,shipping_usd_cents,fx_rate_source FROM sale_events WHERE source_id=$1",
      [x.sourceId],
    )
  ).rows[0];
  assert.deepEqual(stored, {
    item_price_cents: "1000",
    item_price_usd_cents: null,
    observed_shipping_cents: "0",
    shipping_usd_cents: "0",
    fx_rate_source: null,
  });
  const inputs = await x.store.candidates(x.jobId);
  assert.equal(inputs[0].usdConversion, undefined);
  const calculated = evaluate(inputs, {
    sourceId: x.sourceId,
    asOf: x.input.asOf,
    days: 90,
    basis: "item_plus_observed_shipping",
    limit: 200,
  });
  assert.equal(calculated.stats.n_price_verified, 0);
  assert.deepEqual(calculated.diagnostics.price_exclusions, [
    { eventKey: "event-0", reason: "missing_fx_evidence" },
  ]);
  assert.equal(
    (await db.query("SELECT * FROM collector_quarantines WHERE source_id=$1", [x.sourceId])).rowCount,
    0,
  );
});

test("worker upgrades cannot silently mix collector or parser versions into a frozen run", async () => {
  for (const column of ["collector_version", "parser_version"]) {
    const x = await setup(),
      job = await x.store.view(x.jobId);
    await db.query(`UPDATE collector_runs SET ${column}='older-test-build' WHERE id=$1`, [
      job.collector_run_id,
    ]);
    await assert.rejects(x.store.claim(x.sourceId), /collector_version_mismatch/);
    assert.equal((await x.store.view(x.jobId)).status, "queued");
    await db.query(`UPDATE collector_runs SET ${column}=$2 WHERE id=$1`, [
      job.collector_run_id,
      column === "collector_version" ? COLLECTOR_VERSION : PARSER_VERSION,
    ]);
    const lease = await x.store.claim(x.sourceId);
    await db.query(`UPDATE collector_runs SET ${column}='older-test-build' WHERE id=$1`, [
      job.collector_run_id,
    ]);
    await assert.rejects(x.store.reserve(lease, "page", 1024), /collector_version_mismatch/);
    assert.equal((await x.store.view(x.jobId)).request_count, 0);
  }
});
