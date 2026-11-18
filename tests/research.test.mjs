import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import { evaluateSnapshot } from "@soldbench/core";
import { database, migrate } from "@soldbench/db";
import { RequestAuditService, researchFields, safeCsvCell } from "@soldbench/query";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL),
  roots = [];
before(() => migrate(db));
after(async () => {
  await db.end();
  for (const r of roots) await rm(r, { recursive: true, force: true });
});
const setup = (options) => createProductFixture(db, roots, options);

async function policy(x, fields) {
  await db.query(
    "UPDATE source_clearances SET permitted_fields=jsonb_build_object('research',to_jsonb($2::text[])) WHERE id=(SELECT source_clearance_id FROM sources WHERE id=$1)",
    [x.source.sourceId, fields],
  );
}
const charges = async (x) =>
  (await db.query("SELECT count(*)::int n FROM billing_charges WHERE user_id=$1", [x.user])).rows[0].n;

test("legacy filter results cannot claim or bypass reuse while valid unfiltered history remains readable", async () => {
  const plain = await setup(),
    filtered = await setup({ filters: { condition: "good" } }),
    unclaimed = await setup({ claimed: false, filters: { condition: "good" } });
  await db.query("UPDATE query_results SET cleaner_version='1.0.0' WHERE query_id=ANY($1::uuid[])", [
    [plain.queryId, filtered.queryId, unclaimed.queryId],
  ]);
  assert.equal(
    (await plain.query.result(plain.identity, plain.queryId, randomUUID())).meta.credits_charged,
    0,
  );
  assert.equal((await plain.query.submit(plain.identity, plain.q)).queryId, plain.queryId);
  await assert.rejects(
    filtered.query.result(filtered.identity, filtered.queryId, randomUUID()),
    (e) => e.code === "state_conflict",
  );
  await assert.rejects(
    filtered.query.submit(filtered.identity, filtered.q),
    (e) => e.code === "source_unavailable" && e.details.retry_after === 600,
  );
  assert.equal(await charges(filtered), 1);
  await assert.rejects(
    unclaimed.query.result(unclaimed.identity, unclaimed.queryId, randomUUID(), true, randomUUID()),
    (e) => e.code === "state_conflict",
  );
  const rerun = await unclaimed.query.submit(unclaimed.identity, unclaimed.q);
  assert.notEqual(rerun.queryId, unclaimed.queryId);
  assert.equal((await unclaimed.query.submit(unclaimed.identity, unclaimed.q)).queryId, rerun.queryId);
  assert.equal((await unclaimed.query.workOnce("after-cleaner-upgrade")).status, "completed");
  const fresh = await unclaimed.query.result(
    unclaimed.identity,
    rerun.queryId,
    randomUUID(),
    true,
    randomUUID(),
  );
  assert.equal(fresh.meta.credits_charged, 1);
  const repeated = await unclaimed.query.submit(unclaimed.identity, unclaimed.q);
  assert.equal(repeated.queryId, rerun.queryId);
  assert.equal(
    (await unclaimed.query.result(unclaimed.identity, repeated.queryId, randomUUID(), true, randomUUID()))
      .meta.credits_charged,
    0,
  );
  assert.equal(await charges(unclaimed), 1);
});

test("complete diagnostics persist all candidate decisions, paginate by owner/snapshot and flag rather than delete outliers", async () => {
  const x = await setup(),
    seen = [];
  let cursor;
  do {
    const r = await x.research.diagnostics(x.identity, x.queryId, cursor, 7);
    seen.push(...r.items);
    cursor = r.next_cursor;
  } while (cursor);
  assert.equal(seen.length, 63);
  assert.equal(new Set(seen.map((r) => r.sale_event_id)).size, 63);
  assert.equal(seen.filter((r) => r.include_in_price_stats).length, 58);
  assert.equal(seen.filter((r) => r.outlier_candidate).length, 1);
  for (const reason of [
    "uncertain_identity",
    "outside_window",
    "hard_attribute_mismatch",
    "missing_shipping_evidence",
    "unverified_actual_price",
  ])
    assert.ok(seen.some((r) => r.primary_exclusion_reason === reason));
  const offer = seen.find((r) => r.sale_format === "best_offer");
  assert.equal(offer.displayed_price_cents, 1000);
  assert.equal(offer.include_in_price_stats, false);
  const first = await x.research.diagnostics(x.identity, x.queryId, undefined, 2),
    y = await setup();
  await assert.rejects(y.research.diagnostics(y.identity, y.queryId, first.next_cursor), /cursor/);
  assert.equal(await charges(x), 1);
});
test("detail returns explicit missing fields, matching current primary image and no raw/private evidence", async () => {
  const x = await setup(),
    event = x.events.find((r) => r.candidate.eventKey === "event-0"),
    r = await x.research.detail(x.identity, x.queryId, event.sale_event_id);
  assert.equal(r.fields.title.state, "present");
  assert.equal(r.fields.description.state, "missing");
  assert.equal(r.fields.attributes.state, "missing");
  assert.equal(r.fields.primary_image.value.state, "available");
  assert.match(r.fields.primary_image.value.url, /^\/v1\/media\//);
  assert.equal(r.fields.listing_url.state, "withheld");
  assert.equal(r.verification.evidence_type, "synthetic_test_marker");
  assert.doesNotMatch(
    JSON.stringify(r),
    /object_key|profileHash|recordIndex|images\.example\.test|source_url/,
  );
  const image = await x.app.request(r.fields.primary_image.value.url, { headers: x.headers });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/webp");
});
test("unclaimed and foreign snapshots deny detail, diagnostics and export before revealing any records", async () => {
  const x = await setup({ claimed: false }),
    event = x.events[0].sale_event_id,
    y = await setup();
  for (const work of [
    () => x.research.detail(x.identity, x.queryId, event),
    () => x.research.diagnostics(x.identity, x.queryId),
    () => x.research.export(x.identity, x.queryId, { format: "json", view: "authoritative" }),
  ])
    await assert.rejects(work(), (e) => e.code === "result_not_claimed");
  for (const work of [
    () => y.research.detail(y.identity, x.queryId, event),
    () => y.research.diagnostics(y.identity, x.queryId),
    () => y.research.export(y.identity, x.queryId, { format: "json", view: "authoritative" }),
  ])
    await assert.rejects(work(), (e) => e.code === "not_found");
  assert.equal(await charges(x), 0);
});
test("current field withdrawals apply across detail, result, diagnostics, calculation inputs, media and export", async () => {
  const x = await setup(),
    event = x.events.find((r) => r.candidate.eventKey === "event-0"),
    original = await x.research.detail(x.identity, x.queryId, event.sale_event_id);
  await policy(
    x,
    researchFields.filter((f) => !["title", "condition"].includes(f)),
  );
  const r = await x.research.detail(x.identity, x.queryId, event.sale_event_id);
  assert.equal(r.fields.title.state, "withheld");
  assert.equal(r.fields.condition.value, null);
  const result = await x.query.result(x.identity, x.queryId, randomUUID());
  assert.ok(result.data.comps.every((r) => r.title === undefined && r.condition_std === undefined));
  await policy(
    x,
    researchFields.filter((f) => !["price", "primary_image"].includes(f)),
  );
  assert.equal((await x.query.result(x.identity, x.queryId, randomUUID())).data.comps.length, 0);
  await assert.rejects(x.query.calculation(x.identity, x.queryId), (e) => e.code === "forbidden");
  await assert.rejects(
    x.research.export(x.identity, x.queryId, { format: "json", view: "authoritative" }),
    (e) => e.code === "forbidden",
  );
  assert.equal(
    (await x.app.request(original.fields.primary_image.value.url, { headers: x.headers })).status,
    404,
  );
  await policy(x, []);
  assert.equal((await x.research.diagnostics(x.identity, x.queryId)).withheld_count, 63);
  await assert.rejects(
    x.research.detail(x.identity, x.queryId, event.sale_event_id),
    (e) => e.code === "not_found",
  );
  assert.equal(await charges(x), 1);
});
test("authoritative and adjusted exports use all58 prices beyond limit5 and never mutate or recharge the snapshot", async () => {
  const x = await setup(),
    a = JSON.parse(
      (await x.research.export(x.identity, x.queryId, { format: "json", view: "authoritative" })).body,
    );
  assert.equal(a.items.length, 58);
  assert.equal(a.completeness.presentation_limit, 5);
  assert.equal(a.price_summary.n_price_verified, 58);
  assert.equal(a.user_modified, false);
  const b = JSON.parse(
    (
      await x.research.export(x.identity, x.queryId, {
        format: "json",
        view: "adjusted",
        excluded_sale_event_ids: [a.items[0].sale_event_id],
      })
    ).body,
  );
  assert.equal(b.items.length, 57);
  assert.equal(b.original_stats.n_price_verified, 58);
  assert.equal(b.user_modified, true);
  const empty = JSON.parse(
    (
      await x.research.export(x.identity, x.queryId, {
        format: "json",
        view: "adjusted",
        excluded_sale_event_ids: a.items.map((r) => r.sale_event_id),
      })
    ).body,
  );
  assert.equal(empty.price_summary.n_price_verified, 0);
  assert.equal(empty.price_summary.median_cents, null);
  assert.equal((await x.query.result(x.identity, x.queryId, randomUUID())).data.stats.n_price_verified, 58);
  assert.equal(await charges(x), 1);
  const csv = await x.research.export(x.identity, x.queryId, { format: "csv", view: "authoritative" });
  assert.ok(csv.body.includes("\"'=HYPERLINK("));
  assert.ok(csv.body.includes("metadata_json"));
  assert.doesNotMatch(csv.body, /object_key|source_url|images\.example/);
});
test("export validates JSON options, foreign exclusions and duplicate IDs, and HTTP downloads retain private headers", async () => {
  const x = await setup(),
    event = x.events.find((r) => r.candidate.eventKey === "event-0").sale_event_id;
  for (const body of [
    null,
    [],
    { format: "csv", view: "x" },
    { format: "json", view: "adjusted", excluded_sale_event_ids: [randomUUID()] },
    { format: "json", view: "adjusted", excluded_sale_event_ids: [event, event] },
    { format: "json", view: "authoritative", excluded_sale_event_ids: [event] },
  ])
    await assert.rejects(
      x.research.export(x.identity, x.queryId, body),
      (e) => e.code === "invalid_parameter",
    );
  const r = await x.app.request(`/v1/sold/${x.queryId}/export`, {
    method: "POST",
    headers: { ...x.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ format: "csv", view: "authoritative" }),
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("cache-control"), /private.*no-store/);
  assert.match(r.headers.get("content-disposition"), /attachment/);
  assert.match(r.headers.get("content-type"), /text\/csv/);
  assert.equal(await charges(x), 1);
});
test("request audit links real charge/ledger without secrets, records errors, filters/paginates and isolates owners", async () => {
  const x = await setup({ claimed: false });
  let r = await x.app.request(`/v1/sold/${x.queryId}/claim`, {
    method: "POST",
    headers: { ...x.headers, "Idempotency-Key": randomUUID() },
  });
  assert.equal(r.status, 200);
  const requestId = r.headers.get("x-request-id");
  await x.app.request(`/v1/sold/${x.queryId}`, { headers: x.headers });
  await x.app.request(`/v1/sold/${x.queryId}/comps/${randomUUID()}`, { headers: x.headers });
  const logs = await x.audit.list(x.identity, { size: 100 });
  assert.equal(logs.items.length, 3);
  const claim = logs.items.find((r) => r.request_id === requestId);
  assert.equal(claim.credits_charged, 1);
  assert.ok(claim.charge_id);
  assert.equal(claim.ledger_ids.length, 1);
  assert.ok(logs.items.some((r) => r.http_status === 404 && r.error_code === "not_found"));
  assert.equal(logs.items.filter((r) => r.credits_charged === 1).length, 1);
  assert.doesNotMatch(JSON.stringify(logs), /Authorization|sb_k_|research fixture|password|cookie|Synthetic/);
  const first = await x.audit.list(x.identity, { size: 1 }),
    next = await x.audit.list(x.identity, { size: 1, cursor: first.next_cursor });
  assert.notEqual(first.items[0].id, next.items[0].id);
  await assert.rejects(
    x.audit.list(x.identity, { cursor: first.next_cursor, operation: "sold_claim" }),
    /cursor/,
  );
  const y = await setup();
  await assert.rejects(y.audit.list(y.identity, { cursor: first.next_cursor }), /cursor/);
  const before = logs.items.length;
  r = await x.app.request("/v1/requests", { headers: x.headers });
  assert.equal(r.status, 200);
  assert.equal((await x.audit.list(x.identity, { size: 100 })).items.length, before);
  assert.equal((await x.audit.list(x.identity, { operation: "sold_claim" })).items.length, 1);
});
test("an audit outage cannot turn committed claim into failure or cause a second charge", async () => {
  const x = await setup({ claimed: false }),
    original = RequestAuditService.prototype.record,
    error = console.error;
  RequestAuditService.prototype.record = async () => {
    throw new Error("simulated audit outage");
  };
  console.error = () => {};
  try {
    const r = await x.app.request(`/v1/sold/${x.queryId}/claim`, {
      method: "POST",
      headers: { ...x.headers, "Idempotency-Key": randomUUID() },
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).meta.credits_charged, 1);
  } finally {
    RequestAuditService.prototype.record = original;
    console.error = error;
  }
  assert.equal(await charges(x), 1);
  assert.equal((await x.query.result(x.identity, x.queryId, randomUUID())).meta.credits_charged, 0);
});
test("source revocation immediately stops all research delivery while minimal owner audit remains readable", async () => {
  const x = await setup(),
    event = x.events[0].sale_event_id;
  await db.query(
    "UPDATE source_clearances SET status='revoked' WHERE id=(SELECT source_clearance_id FROM sources WHERE id=$1)",
    [x.source.sourceId],
  );
  for (const work of [
    () => x.research.detail(x.identity, x.queryId, event),
    () => x.research.diagnostics(x.identity, x.queryId),
    () => x.research.export(x.identity, x.queryId, { format: "json", view: "authoritative" }),
  ])
    await assert.rejects(work(), (e) => e.code === "forbidden");
  assert.deepEqual((await x.audit.list(x.identity)).items, []);
});
test("request audit is retained30 days, expires honestly and maintenance deletes only expired rows", async () => {
  const x = await setup();
  await x.audit.record(x.identity, {
    requestId: randomUUID(),
    operation: "sold_result",
    channel: "api",
    queryId: x.queryId,
    status: 200,
    durationMs: 1,
    creditsCharged: 0,
  });
  assert.equal((await x.audit.list(x.identity)).items.length, 1);
  x.clock.value = "2026-11-18T12:00:00.000Z";
  await x.audit.record(x.identity, {
    requestId: randomUUID(),
    operation: "sold_result",
    channel: "api",
    queryId: x.queryId,
    status: 200,
    durationMs: 1,
    creditsCharged: 0,
  });
  x.clock.value = "2026-12-17T12:00:00.000Z";
  assert.equal((await x.audit.list(x.identity)).items.length, 1);
  assert.ok((await x.audit.purgeExpired()) >= 1);
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM query_request_audit WHERE user_id=$1", [x.user])).rows[0].n,
    1,
  );
});

test("record decisions use exact unrounded IQR fences, preserve outliers and suppress low-sample flags", () => {
  const evaluate = (prices) =>
    evaluateSnapshot(
      prices.map((p, i) => ({
        sourceId: "synthetic",
        eventKey: String(i),
        identityVerified: true,
        comparable: true,
        priceStatus: "verified_actual",
        format: "fixed_price",
        currency: "USD",
        itemCents: p,
        shippingCents: 0,
        shippingStatus: "verified_free_shipping",
        time: { precision: "instant", value: "2026-11-17T12:00:00Z" },
      })),
      { sourceId: "synthetic", asOf: "2026-11-17T12:00:00Z", days: 90, basis: "item", limit: 200 },
    );
  assert.equal(
    evaluate([0, 0, 0, 0, 1, 1, 2, 3]).record_decisions.some((r) => r.outlierCandidate),
    false,
  );
  assert.equal(
    evaluate([0, 0, 0, 0, 1, 1, 2, 4]).record_decisions.filter((r) => r.outlierCandidate).length,
    1,
  );
  const same = evaluate([100, 100, 100, 100, 100, 100, 100, 101]);
  assert.equal(same.stats.n_price_verified, 8);
  assert.equal(same.record_decisions.filter((r) => r.outlierCandidate).length, 1);
  assert.equal(
    evaluate([1, 1, 1, 1, 1, 1, 100]).record_decisions.some((r) => r.outlierCandidate),
    false,
  );
  const max = Number.MAX_SAFE_INTEGER;
  assert.equal(
    evaluate([max - 4, max - 4, max - 4, max - 4, max - 4, max - 4, max - 4, max]).record_decisions.filter(
      (r) => r.outlierCandidate,
    ).length,
    1,
  );
});
test("actual research HTTP DTOs validate against the frozen OpenAPI and retained historical exports are labeled", async () => {
  const x = await setup(),
    event = x.events[0].sale_event_id,
    d = await x.app.request(`/v1/sold/${x.queryId}/comps/${event}`, { headers: x.headers }),
    e = JSON.parse(
      (await x.research.export(x.identity, x.queryId, { format: "json", view: "authoritative" })).body,
    ),
    a = await x.app.request("/v1/requests", { headers: x.headers }),
    samples = { CompDetailResponse: await d.json(), ResearchExport: e, RequestAuditResponse: await a.json() };
  execFileSync(
    "python3",
    [
      "-c",
      `import sys,json,yaml
from jsonschema import Draft202012Validator,FormatChecker
from referencing import Registry,Resource
s=yaml.safe_load(open('docs/openapi.yaml'))
u='urn:soldbench:research'
r=Registry().with_resource(u,Resource.from_contents({'$schema':'https://json-schema.org/draft/2020-12/schema',**s}))
for name,value in json.load(sys.stdin).items():
 Draft202012Validator({'$ref':u+'#/components/schemas/'+name},registry=r,format_checker=FormatChecker()).validate(value)
`,
    ],
    { input: JSON.stringify(samples), encoding: "utf8" },
  );
  x.clock.value = "2026-11-21T12:00:00.000Z";
  const history = JSON.parse(
    (await x.research.export(x.identity, x.queryId, { format: "json", view: "authoritative" })).body,
  );
  assert.equal(history.freshness_state, "expired");
  assert.equal(history.result_mode, "history");
  assert.equal(await charges(x), 1);
});

test("detail exposes only explicitly permitted stored canonical evidence fields and refuses unsafe listing links", async () => {
  const x = await setup(),
    event = x.events.find((r) => r.candidate.eventKey === "event-0"),
    snapshot = (
      await db.query("SELECT * FROM query_snapshot_records WHERE query_id=$1 AND sale_event_id=$2", [
        x.queryId,
        event.sale_event_id,
      ])
    ).rows[0],
    evidence = {
      schema: "soldbench.record-evidence.v1",
      profileHash: "f".repeat(64),
      recordIndex: 0,
      listingUrl: "https://market.example.test/item/owned-fixture",
      conditionId: "3000",
      conditionRaw: "Pre-Owned",
      priceRaw: "US $10",
      shippingRaw: "Free",
      soldDateRaw: "Nov17",
      sourceTimeZone: "UTC",
      attributes: { variant: "synthetic-variant" },
      fields: {
        listingUrl: "present",
        condition: "present",
        price: "present",
        shipping: "present",
        soldDate: "present",
        seller: "withheld",
        primaryImage: "present",
        attributes: "present",
      },
    };
  await db.query(
    "INSERT INTO listing_record_evidence(sale_event_id,listing_id,source_id,observation_id,profile_hash,record_index,evidence) VALUES($1,$2,$3,$4,$5,0,$6)",
    [
      snapshot.sale_event_id,
      snapshot.listing_id,
      snapshot.source_id,
      snapshot.observation_id,
      evidence.profileHash,
      JSON.stringify(evidence),
    ],
  );
  await policy(x, researchFields);
  let r = await x.research.detail(x.identity, x.queryId, event.sale_event_id);
  assert.deepEqual(r.fields.listing_url, { state: "present", value: evidence.listingUrl });
  assert.equal(r.fields.condition.value.source_condition_id, "3000");
  assert.equal(r.fields.attributes.value.variant, "synthetic-variant");
  evidence.listingUrl = "https://user:secret@market.example.test/item?token=secret";
  await db.query("UPDATE listing_record_evidence SET evidence=$2 WHERE sale_event_id=$1", [
    snapshot.sale_event_id,
    JSON.stringify(evidence),
  ]);
  r = await x.research.detail(x.identity, x.queryId, event.sale_event_id);
  assert.equal(r.fields.listing_url.state, "withheld");
  assert.doesNotMatch(JSON.stringify(r), /secret|token=/);
});
test("unauthorized query access cannot place another owner's resource or ledger IDs into request audit", async () => {
  const x = await setup(),
    y = await setup(),
    r = await x.app.request(`/v1/sold/${y.queryId}`, { headers: x.headers });
  assert.equal(r.status, 404);
  const log = (await x.audit.list(x.identity)).items[0];
  assert.equal(log.query_id, null);
  assert.equal(log.charge_id, null);
  assert.deepEqual(log.ledger_ids, []);
  await db.query(
    "UPDATE source_clearances SET effective_at='2026-11-18T12:00:00Z' WHERE id=(SELECT source_clearance_id FROM sources WHERE id=$1)",
    [x.source.sourceId],
  );
  await assert.rejects(x.research.diagnostics(x.identity, x.queryId), (e) => e.code === "forbidden");
});

test("CSV serialization neutralizes formula and control prefixes while preserving unknown as blank", () => {
  for (const prefix of [
    "=",
    "+",
    "-",
    "@",
    " ",
    "\t",
    "\r",
    "\n",
    String.fromCharCode(1),
    String.fromCharCode(127),
    "\uFEFF",
  ])
    assert.ok(safeCsvCell(`${prefix}=1+1`).startsWith("\"'"));
  assert.equal(safeCsvCell(null), '""');
  assert.equal(safeCsvCell(0), '"0"');
});

test("an unverified candidate cannot inherit comparable identity from a verified candidate reporting the same key", () => {
  const record = {
      sourceId: "synthetic",
      eventKey: "claimed-key",
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
    result = evaluateSnapshot([{ ...record, identityVerified: false }, record], {
      sourceId: "synthetic",
      asOf: "2026-11-17T12:00:00Z",
      days: 90,
      basis: "item",
      limit: 200,
    });
  assert.equal(result.stats.n_price_verified, 1);
  assert.equal(result.record_decisions[0].isComparable, false);
  assert.equal(result.record_decisions[0].includeInPriceStats, false);
  assert.equal(result.record_decisions[0].exclusionReasons[0], "uncertain_identity");
});
