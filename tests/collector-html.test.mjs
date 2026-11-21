import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  CollectorStore,
  createEbayUsSoldSearchHtmlProfile,
  createFixtureArtifact,
  digest,
  FixtureTransport,
  fixtureResponse,
  loadFixtureArtifact,
  OfflineCollectorWorker,
  parseFixturePage,
  parseHtmlMoney,
  parseHtmlPage,
  parseNaturalSoldDate,
  provisionFixtureSource,
  validateHtmlProfile,
} from "@soldbench/collector";
import { canonicalJson, collectionQueryHash, evaluate, normalizeQuery } from "@soldbench/core";
import { database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { PublicResults } from "@soldbench/query";
import sharp from "sharp";
import { createProductFixture } from "./helpers/product.mjs";

const profile = JSON.parse(readFileSync(new URL("./fixtures/html/profile.json", import.meta.url))),
  template = readFileSync(new URL("./fixtures/html/search.html", import.meta.url), "utf8"),
  fixed = "2026-11-16T12:00:00Z",
  db = database(process.env.DATABASE_URL),
  roots = [];
before(async () => migrate(db));
after(async () => {
  await db.end();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
async function setup(custom = profile, queryHash = digest("synthetic-html-query"), publicAggregates = false) {
  const source = await provisionFixtureSource(db, fixed, { publicAggregates }),
    store = new CollectorStore(db, () => fixed, { htmlProfile: custom }),
    binding = {
      sourceId: source.sourceId,
      queryHash,
      cursor: "start",
      asOf: fixed,
    },
    jobId = await store.enqueue({ ...source, queryHash: binding.queryHash, runKey: "html-run", asOf: fixed }),
    root = await mkdtemp(join(tmpdir(), "soldbench-html-"));
  roots.push(root);
  const raw = Buffer.from(
    template.replaceAll("SOURCE_ID", source.sourceId).replaceAll("QUERY_HASH", binding.queryHash),
  );
  return { ...source, store, binding, jobId, root, raw, media: new PrivateMediaStore(join(root, "media")) };
}
const response = (raw) => ({ status: 200, contentType: "text/html; charset=utf-8", bytes: raw });
const detailProfile = {
  ...profile,
  revision: 2,
  fields: {
    ...profile.fields,
    conditionStandard: { selector: "span.condition", attribute: "data-standard" },
    description: { selector: "p.description" },
    defects: { selector: "p.defects" },
  },
};
function runner(x, raw = x.raw) {
  return new OfflineCollectorWorker(
    x.store,
    new FixtureTransport(new Map([["page:start", [response(raw)]]])),
    x.media,
  );
}

test("HTML text parser preserves sold evidence, actual price, withheld seller and correctly bound lazy primary image", async () => {
  const x = await setup(),
    page = parseHtmlPage(x.raw, x.binding, profile),
    row = page.records[0];
  assert.equal(page.records.length, 1);
  assert.equal(row.title, "Nintendo Switch OLED & controller");
  assert.equal(row.candidate.itemCents, 27550);
  assert.equal(row.candidate.priceStatus, "verified_actual");
  assert.equal(row.candidate.sellerRef, undefined);
  assert.equal(row.recordEvidence.fields.seller, "withheld");
  assert.equal(row.recordEvidence.attributes.model, "OLED");
  assert.equal(row.primaryImage.url, "https://images.example.test/primary-large.png");
  assert.equal(globalThis.__soldbench_script_executed, undefined);
  assert.equal(row.recordEvidence.profileHash, digest(canonicalJson(validateHtmlProfile(profile))));
});

test("real offline ingest and REST use same-event strong evidence for price, diagnostics, detail and export", async () => {
  const params = new URLSearchParams({
      q: "Nintendo Switch OLED",
      category: "video_games",
      brand: "Nintendo",
      model: "OLED",
      condition: "good",
      attr_region: "US",
      limit: "2",
    }),
    x = await setup(detailProfile, collectionQueryHash(normalizeQuery(params))),
    customer = await createProductFixture(db, roots, { count: 1, prepareQuery: false, clockValue: fixed }),
    html = x.raw
      .toString()
      .replace(/<article class="record" data-kind="sold-record"[\s\S]*?<\/article>/, (base) =>
        Array.from({ length: 11 }, (_, i) =>
          base
            .replaceAll("synthetic-listing-1", `synthetic-listing-${i}`)
            .replaceAll("synthetic-event-1", `synthetic-event-${i}`)
            .replace("Nintendo Switch OLED &amp; controller", `Synthetic match ${i}`)
            .replace('<span class="condition"', '<span class="condition" data-standard="good"')
            .replace(
              '<span class="attribute" data-name="model">OLED</span>',
              `<span class="attribute" data-name="model">${i === 8 || i === 10 ? "Lite" : "OLED"}</span>
              <span class="attribute" data-name="category">video_games</span>
              <span class="attribute" data-name="brand">Nintendo</span>
              ${i < 9 ? '<span class="attribute" data-name="region">US</span>' : ""}
              <p class="description">Case included<script>hidden executable text</script></p>
              <p class="defects">Small scratch on case</p>`,
            ),
        ).join(""),
      );
  assert.equal((await runner(x, Buffer.from(html)).runOne(x.sourceId)).status, "completed");
  const start = await customer.app.request(`/v1/sold?${params}`, { headers: customer.headers });
  assert.equal(start.status, 202);
  const { query_id: id } = (await start.json()).data;
  assert.equal((await customer.query.workOnce("strong-evidence")).status, "completed");
  const claim = await customer.app.request(`/v1/sold/${id}/claim`, {
    method: "POST",
    headers: { ...customer.headers, "Idempotency-Key": "strong-evidence-request-1" },
  });
  assert.equal(claim.status, 200);
  const { data, meta } = await claim.json();
  assert.equal(data.stats.n_observed, 11);
  assert.equal(data.stats.n_price_verified, 8);
  assert.equal(data.stats.median_cents, 27550);
  assert.equal(data.comps.length, 2);
  assert.equal(meta.credits_charged, 1);
  const diagnostics = await customer.research.diagnostics(customer.identity, id);
  for (const [i, reason] of [
    [8, "hard_attribute_mismatch"],
    [9, "missing_strong_attribute_evidence"],
    [10, "hard_attribute_mismatch"],
  ]) {
    const row = diagnostics.items.find((r) => r.title === `Synthetic match ${i}`);
    assert.equal(row.primary_exclusion_reason, reason);
    assert.equal(row.include_in_price_stats, false);
  }
  const eventId = diagnostics.items.find((r) => r.include_in_price_stats).sale_event_id;
  const detail = await customer.research.detail(customer.identity, id, eventId);
  assert.deepEqual(detail.fields.description, { state: "present", value: "Case included" });
  assert.deepEqual(detail.fields.defects, { state: "present", value: "Small scratch on case" });
  assert.equal(detail.fields.condition.value.standard, "good");
  assert.equal(detail.fields.condition.value.source_label, "Pre-Owned");
  const result = await customer.research.export(customer.identity, id, {
    format: "json",
    view: "authoritative",
  });
  assert.equal(JSON.parse(result.body).items.length, 8);
  await db.query(
    "UPDATE source_clearances SET permitted_fields=jsonb_set(permitted_fields,'{research}',(permitted_fields->'research') - 'description' - 'defects') WHERE id=(SELECT source_clearance_id FROM sources WHERE id=$1)",
    [x.sourceId],
  );
  const withdrawn = await customer.research.detail(customer.identity, id, eventId);
  assert.deepEqual(withdrawn.fields.description, { state: "withheld", value: null });
  assert.deepEqual(withdrawn.fields.defects, { state: "withheld", value: null });
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM billing_charges WHERE user_id=$1", [customer.user])).rows[0]
      .n,
    1,
  );
});

test("detail and attribute readers reject nonstandard condition, ambiguous fields and nested records", async () => {
  const x = await setup(detailProfile),
    html = x.raw.toString();
  assert.throws(
    () =>
      parseHtmlPage(
        Buffer.from(html.replace('data-condition-id="synthetic-preowned"', 'data-standard="used"')),
        x.binding,
        detailProfile,
      ),
    /html_standard_condition_invalid/,
  );
  assert.throws(
    () =>
      parseHtmlPage(
        Buffer.from(
          html.replace(
            '<h2 class="title">',
            '<p class="description">One</p><p class="description">Two</p><h2 class="title">',
          ),
        ),
        x.binding,
        detailProfile,
      ),
    /html_field_ambiguous/,
  );
  assert.throws(
    () =>
      parseHtmlPage(
        Buffer.from(
          html.replace(
            '<h2 class="title">',
            '<article class="record" data-kind="advertisement"><p class="description">Other item</p><span class="attribute" data-name="brand">Other</span></article><h2 class="title">',
          ),
        ),
        x.binding,
        detailProfile,
      ),
    /html_nested_record/,
  );
});

test("a repeated listing cannot borrow matching attributes from an earlier observation", async () => {
  const params = new URLSearchParams({ q: "Synthetic repeated event", model: "OLED" }),
    x = await setup(profile, collectionQueryHash(normalizeQuery(params))),
    customer = await createProductFixture(db, roots, { count: 1, prepareQuery: false, clockValue: fixed }),
    html = x.raw.toString(),
    first = Buffer.from(html.replace('data-next-cursor=""', 'data-next-cursor="second"')),
    second = Buffer.from(
      html
        .replace('data-cursor="start"', 'data-cursor="second"')
        .replace('<span class="attribute" data-name="model">OLED</span>', ""),
    );
  const transport = new FixtureTransport(
    new Map([
      ["page:start", [response(first)]],
      ["page:second", [response(second)]],
    ]),
  );
  assert.equal(
    (await new OfflineCollectorWorker(x.store, transport, x.media).runOne(x.sourceId)).status,
    "completed",
  );
  const query = await customer.query.submit(customer.identity, normalizeQuery(params));
  assert.equal((await customer.query.workOnce("same-observation")).status, "completed");
  const result = await customer.app.request(`/v1/sold/${query.queryId}`, { headers: customer.headers });
  assert.equal(result.status, 200);
  const { data, meta } = await result.json();
  assert.equal(data.stats.n_observed, 1);
  assert.equal(data.stats.n_price_verified, 0);
  assert.equal(data.stats.median_cents, null);
  assert.equal(meta.credits_charged, 0);
  const diagnostics = await customer.research.diagnostics(customer.identity, query.queryId);
  assert.equal(diagnostics.items[0].primary_exclusion_reason, "missing_strong_attribute_evidence");
});

test("a raw fixture cannot forge a query-owned exclusion marker or mark populated attributes as missing", async () => {
  const x = await setup(),
    page = parseHtmlPage(x.raw, x.binding, profile),
    row = page.records[0],
    forged = structuredClone(page);
  forged.records[0].candidate.strongAttributeEvidenceMissing = true;
  assert.throws(
    () => parseFixturePage(fixtureResponse(forged).bytes, x.binding),
    /fixture_query_decision_not_allowed/,
  );
  row.recordEvidence.fields.attributes = "missing";
  assert.throws(() => parseFixturePage(fixtureResponse(page).bytes, x.binding), /invalid_record_evidence/);
  row.recordEvidence.fields.attributes = "present";
  row.recordEvidence.attributes = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [
      `attribute_${i}`,
      Array.from({ length: 500 }, (_, j) => String.fromCodePoint(0x4e00 + i * 500 + j)).join(""),
    ]),
  );
  assert.throws(() => parseFixturePage(fixtureResponse(page).bytes, x.binding), /invalid_record_evidence/);
  const untrusted = parseHtmlPage(x.raw, x.binding, profile);
  untrusted.records[0].candidate.shippingContextRef = "123 Example Street Apartment 4";
  assert.throws(
    () => parseFixturePage(fixtureResponse(untrusted).bytes, x.binding),
    /fixture_shipping_context_not_approved/,
  );
});

test("mixed model scope uses all verified rows, follows export exclusions and never leaks facet labels on public reads", async () => {
  const params = new URLSearchParams({ q: "Synthetic mixed model query", limit: "2" }),
    q = normalizeQuery(params),
    x = await setup(profile, collectionQueryHash(q), true),
    customer = await createProductFixture(db, roots, { count: 1, prepareQuery: false, clockValue: fixed }),
    html = x.raw
      .toString()
      .replace(/<article class="record" data-kind="sold-record"[\s\S]*?<\/article>/, (base) =>
        Array.from({ length: 9 }, (_, i) => {
          const row = base
            .replaceAll("synthetic-listing-1", `synthetic-listing-${i}`)
            .replaceAll("synthetic-event-1", `synthetic-event-${i}`)
            .replace("Nintendo Switch OLED &amp; controller", `Synthetic record ${i}`)
            .replace(
              'data-name="model">OLED',
              `data-name="model">${i < 7 ? "Synthetic A" : i === 7 ? "Synthetic B" : "Synthetic C"}`,
            );
          return i === 8
            ? row.replace("fixed_price", "best_offer").replace("actual_paid", "displayed_only")
            : row;
        }).join(""),
      );
  assert.equal((await runner(x, Buffer.from(html)).runOne(x.sourceId)).status, "completed");
  const { queryId: id } = await customer.query.submit(customer.identity, q);
  assert.equal((await customer.query.workOnce("mixed-model-sample")).status, "completed");
  const result = await customer.app.request(`/v1/sold/${id}/claim`, {
    method: "POST",
    headers: { ...customer.headers, "Idempotency-Key": "mixed-model-fixture-claim" },
  });
  assert.equal(result.status, 200);
  const { data, meta } = await result.json(),
    scope = data.quality.comparison_scope;
  assert.equal(data.comps.length, 2);
  assert.equal(data.stats.n_price_verified, 8);
  assert.equal(meta.credits_charged, 1);
  assert.equal(scope.status, "mixed_models");
  assert.deepEqual(scope.model_options, [
    { model: "Synthetic A", price_input_count: 7 },
    { model: "Synthetic B", price_input_count: 1 },
  ]);
  assert.ok(data.quality.warnings.some((warning) => warning.code === "mixed_models"));
  const authoritative = await customer.research.export(customer.identity, id, {
    format: "json",
    view: "authoritative",
  });
  assert.deepEqual(JSON.parse(authoritative.body).comparison_scope, scope);
  const diagnostics = await customer.research.diagnostics(customer.identity, id),
    selected = diagnostics.items.find((r) => r.title === "Synthetic record 7").sale_event_id;
  const narrowed = await customer.research.export(customer.identity, id, {
    format: "json",
    view: "adjusted",
    excluded_sale_event_ids: [selected],
  });
  assert.equal(JSON.parse(narrowed.body).comparison_scope.status, "single_model_label_observed");
  assert.equal(JSON.parse(narrowed.body).price_summary.median_cents, null);
  const csv = await customer.research.export(customer.identity, id, { format: "csv", view: "authoritative" });
  assert.match(csv.body, /comparison_scope.*mixed_models/);
  const publicResults = new PublicResults(customer.query),
    visitor = customer.auth.crypto.token("sb_vis_");
  await publicResults.publishFixture(id);
  const publicView = (await publicResults.anonymous(q, visitor, "127.0.0.1")).view;
  assert.equal(publicView.quality.comparison_scope, undefined);
  assert.ok(publicView.quality.warnings.some((warning) => warning.code === "mixed_models"));
  assert.doesNotMatch(JSON.stringify(publicView), /Synthetic [ABC]/);
  await db.query(
    "UPDATE source_clearances SET permitted_fields=jsonb_set(permitted_fields,'{research}',(permitted_fields->'research') - 'attributes') WHERE id=(SELECT source_clearance_id FROM sources WHERE id=$1)",
    [x.sourceId],
  );
  const reread = await customer.app.request(`/v1/sold/${id}`, { headers: customer.headers });
  const history = await reread.json();
  assert.equal(history.data.quality.comparison_scope, undefined);
  assert.ok(!history.data.quality.warnings.some((warning) => warning.code === "mixed_models"));
  assert.equal(history.meta.credits_charged, 0);
  const publicAfter = (await publicResults.anonymous(q, visitor, "127.0.0.1")).view;
  assert.ok(!publicAfter.quality.warnings.some((warning) => warning.code === "mixed_models"));
});

test("first-page match counts, observed shipping contexts and seller aggregates are bound and permissioned independently", async () => {
  const params = new URLSearchParams({ q: "Synthetic grouped shipping", limit: "2" }),
    q = normalizeQuery(params),
    shippingProfile = {
      ...profile,
      revision: 3,
      allowSyntheticSeller: true,
      shippingContexts: ["us-domestic-a", "us-domestic-b"],
      fields: {
        ...profile.fields,
        shippingContextRef: { selector: "span.shipping", attribute: "data-context-ref" },
      },
    },
    x = await setup(shippingProfile, collectionQueryHash(q)),
    customer = await createProductFixture(db, roots, { count: 1, prepareQuery: false, clockValue: fixed }),
    html = x.raw.toString(),
    first = html
      .replace('data-next-cursor=""', 'data-next-cursor="second"')
      .replace(
        "data-as-of=",
        'data-reported-count="42000" data-reported-unit="listings" data-reported-estimated="true" data-as-of=',
      )
      .replace(/<article class="record" data-kind="sold-record"[\s\S]*?<\/article>/, (base) =>
        Array.from({ length: 10 }, (_, i) => {
          const row = base
            .replaceAll("synthetic-listing-1", `synthetic-listing-${i}`)
            .replaceAll("synthetic-event-1", `synthetic-event-${i}`)
            .replace("synthetic-seller-hidden", i < 8 ? "synthetic-seller-one" : "synthetic-seller-two");
          if (i === 9) return row.replace(/data-ref="[^"]+"/, "");
          const withContext = row.replace(
            'class="shipping"',
            `class="shipping" data-context-ref="us-domestic-${i < 8 ? "a" : "b"}"`,
          );
          return i < 8
            ? withContext.replace(
                'data-evidence="verified_free_shipping">Free shipping',
                'data-evidence="observed">$10.00',
              )
            : withContext;
        }).join(""),
      ),
    second = html
      .replace('data-cursor="start"', 'data-cursor="second"')
      .replace(
        "data-as-of=",
        'data-reported-count="999" data-reported-unit="events" data-reported-estimated="false" data-as-of=',
      )
      .replace(/<article[\s\S]*<\/article>/, '<p class="empty" data-confirmed="true"></p>');
  const transport = new FixtureTransport(
    new Map([
      ["page:start", [response(Buffer.from(first))]],
      ["page:second", [response(Buffer.from(second))]],
    ]),
  );
  assert.equal(
    (await new OfflineCollectorWorker(x.store, transport, x.media).runOne(x.sourceId)).status,
    "completed",
  );
  const updatePolicy = (additional) =>
    db.query(
      "UPDATE source_clearances SET permitted_fields=jsonb_set(permitted_fields,'{research}',to_jsonb($2::text[])) WHERE id=(SELECT source_clearance_id FROM sources WHERE id=$1)",
      [x.sourceId, ["identity", "price", ...additional]],
    );
  await updatePolicy(["shipping", "sold_date", "source_match_count", "shipping_context", "seller_aggregate"]);
  const { queryId: id } = await customer.query.submit(customer.identity, q);
  assert.equal((await customer.query.workOnce("shipping-context")).status, "completed");
  const result = await customer.query.result(
      customer.identity,
      id,
      "context-claim",
      true,
      "context-claim-key-1",
    ),
    stats = result.data.supplemental_stats;
  assert.equal(stats.sample_count, 10);
  assert.deepEqual(stats.source_reported_match_count, {
    count: 42000,
    unit: "listings",
    estimated: true,
    as_of: new Date(fixed).toISOString(),
    marketplace: "ebay_us",
  });
  assert.deepEqual(stats.shipping_summary, {
    groups: [
      {
        context_ref: "us-domestic-a",
        known_count: 8,
        mean_shipping_cents: 1000,
        free_count: 0,
        free_share: 0,
      },
      {
        context_ref: "us-domestic-b",
        known_count: 1,
        mean_shipping_cents: null,
        free_count: 1,
        free_share: 1,
      },
    ],
    unknown_or_withheld_count: 1,
    mixed_contexts: true,
  });
  assert.deepEqual(stats.seller_summary, {
    distinct_count: 2,
    identified_count: 9,
    unknown_or_withheld_count: 1,
  });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-seller-(one|two)/);
  assert.equal(result.data.quality.coverage.ratio, null);
  assert.equal(result.meta.credits_charged, 1);
  await updatePolicy(["shipping", "sold_date", "shipping_context", "seller_aggregate"]);
  let reread = (await customer.query.result(customer.identity, id, "without-source-count")).data
    .supplemental_stats;
  assert.equal(reread.source_reported_match_count, null);
  assert.equal(reread.shipping_summary.groups.length, 2);
  assert.equal(reread.seller_summary.distinct_count, 2);
  await db.query("UPDATE query_results SET parser_versions=$2 WHERE query_id=$1", [
    id,
    JSON.stringify({ [x.sourceId]: "offline-page-1.3.0" }),
  ]);
  const legacy = await customer.query.result(customer.identity, id, "legacy-shipping-snapshot");
  assert.deepEqual(legacy.data.supplemental_stats.shipping_summary, {
    groups: [],
    mixed_contexts: false,
    unknown_or_withheld_count: 10,
  });
  await db.query("UPDATE query_results SET parser_versions=$2 WHERE query_id=$1", [
    id,
    JSON.stringify(result.meta.parser_versions),
  ]);
  await updatePolicy(["sold_date", "shipping_context"]);
  const withheld = await customer.query.result(customer.identity, id, "withdrawn-research");
  reread = withheld.data.supplemental_stats;
  assert.deepEqual(reread.shipping_summary, {
    groups: [],
    mixed_contexts: false,
    unknown_or_withheld_count: 10,
  });
  assert.deepEqual(reread.seller_summary, {
    distinct_count: null,
    identified_count: 0,
    unknown_or_withheld_count: 10,
  });
  assert.equal(withheld.meta.credits_charged, 0);
  assert.throws(
    () =>
      parseHtmlPage(
        Buffer.from(
          first.replaceAll('data-context-ref="us-domestic-a"', 'data-context-ref="unknown-context"'),
        ),
        x.binding,
        shippingProfile,
      ),
    /html_shipping_context_unknown/,
  );
});

test("money conversion uses exact declared separators and rejects ranges, ambiguous grouping and unsafe amounts", () => {
  for (const [text, currency, decimal, grouping, cents] of [
    ["US $1,234.56", "USD", ".", ",", 123456],
    ["1.234,56 €", "EUR", ",", ".", 123456],
    ["1\u202f234,5 EUR", "EUR", ",", " ", 123450],
    ["$0.00", "USD", ".", ",", 0],
  ])
    assert.equal(parseHtmlMoney(text, currency, decimal, grouping), cents);
  for (const text of ["$10 to $20", "$12,34.56", "-$5.00", "$1.234", "$1e3", "£10", "$90071992547409.92"])
    assert.throws(() => parseHtmlMoney(text, "USD", ".", ","), /html_money_invalid/);
});

test("unknown accepted offer, shipping, event identity and ended date never become verified facts", async () => {
  const x = await setup(),
    raw = Buffer.from(
      x.raw
        .toString()
        .replace("fixed_price", "best_offer")
        .replace("actual_paid", "displayed_only")
        .replace("independent_event", "listing_only")
        .replace("verified_free_shipping", "unknown")
        .replace('data-semantic="sold"', 'data-semantic="ended"'),
    ),
    row = parseHtmlPage(raw, x.binding, profile).records[0];
  assert.equal(row.candidate.priceStatus, "displayed_only");
  assert.equal(row.candidate.itemCents, 27550);
  assert.equal(row.candidate.eventKey, null);
  assert.equal(row.candidate.identityVerified, false);
  assert.equal(row.candidate.shippingCents, null);
  assert.deepEqual(row.candidate.time, { precision: "unknown" });
  assert.equal((await runner(x, raw).runOne(x.sourceId)).status, "completed");
  const inputs = await x.store.candidates(x.jobId);
  assert.equal(
    evaluate(inputs, {
      sourceId: x.sourceId,
      asOf: fixed,
      days: 90,
      basis: "item_plus_observed_shipping",
      limit: 200,
    }).stats.n_price_verified,
    0,
  );
});

test("HTML page raw hash, observation/event metadata and generated primary image persist atomically", async () => {
  const x = await setup(),
    image = await sharp({ create: { width: 12, height: 12, channels: 3, background: "blue" } })
      .png()
      .toBuffer(),
    transport = new FixtureTransport(
      new Map([
        ["page:start", [response(x.raw)]],
        [
          "image:https://images.example.test/primary-large.png",
          [{ status: 200, contentType: "image/png", bytes: image }],
        ],
      ]),
    ),
    worker = new OfflineCollectorWorker(x.store, transport, x.media);
  assert.equal((await worker.runOne(x.sourceId)).status, "completed");
  const page = (await db.query("SELECT * FROM collector_pages WHERE job_id=$1", [x.jobId])).rows[0];
  assert.equal(page.raw_hash, digest(x.raw));
  assert.notEqual(page.raw_hash, digest(JSON.stringify(page.payload)));
  const evidence = (
    await db.query("SELECT * FROM listing_record_evidence WHERE observation_id=$1", [page.observation_id])
  ).rows[0];
  assert.equal(evidence.evidence.conditionRaw, "Pre-Owned");
  assert.equal(evidence.evidence.listingUrl, "https://market.example.test/item/synthetic-listing-1");
  assert.equal(evidence.evidence.fields.seller, "withheld");
  const img = (await db.query("SELECT * FROM listing_images WHERE observation_id=$1", [page.observation_id]))
    .rows[0];
  assert.equal(img.state, "available");
  assert.equal(img.sale_event_id, evidence.sale_event_id);
  assert.equal((await sharp(await worker.readImageInternal(img.id)).metadata()).format, "webp");
  await assert.rejects(
    db.query("UPDATE listing_record_evidence SET listing_id=$2 WHERE sale_event_id=$1", [
      evidence.sale_event_id,
      "00000000-0000-0000-0000-000000000001",
    ]),
    /foreign key/,
  );
});

test("HTML structural drift, ambiguous fields, image mismatches and unsafe URLs quarantine without a watermark", async () => {
  for (const change of [
    (s) => s.replace('class="title"', 'class="renamed-title"'),
    (s) => s.replace("</h2>", "</h2><h2 class=title>Ambiguous</h2>"),
    (s) => s.replace('data-kind="sold-record"', 'data-kind="unknown"'),
    (s) => s.replace('data-role="primary"', 'data-role="advertisement"'),
    (s) => s.replace('data-listing-id="synthetic-listing-1" src=', 'data-listing-id="wrong-listing" src='),
    (s) => s.replaceAll("https://images.example.test/primary", "https://unapproved.invalid/primary"),
    (s) => s.replace('data-next-cursor=""', ""),
    (s) => s.replace('data-evidence="actual_paid"', 'data-evidence="guessed_price"'),
  ]) {
    const x = await setup();
    assert.equal(
      (await runner(x, Buffer.from(change(x.raw.toString()))).runOne(x.sourceId)).status,
      "failed",
    );
    assert.equal(
      (await db.query("SELECT reason FROM collector_quarantines WHERE job_id=$1", [x.jobId])).rows[0].reason,
      "page_structure_invalid",
    );
    assert.equal(
      (await db.query("SELECT * FROM collector_watermarks WHERE source_id=$1", [x.sourceId])).rowCount,
      0,
    );
  }
});

test("explicit empty marker is required and source-reported totals keep their unit without altering statistics", async () => {
  const x = await setup();
  const empty = Buffer.from(
    `<main data-sb-schema="soldbench.synthetic-html.v1" data-source-id="${x.sourceId}" data-query-hash="${x.binding.queryHash}" data-cursor="start" data-next-cursor="" data-as-of="${fixed}"><p class="empty" data-confirmed="true">No sold records</p></main>`,
  );
  assert.equal(parseHtmlPage(empty, x.binding, profile).empty, true);
  assert.throws(
    () =>
      parseHtmlPage(Buffer.from(empty.toString().replace('data-confirmed="true"', "")), x.binding, profile),
    /html_empty_not_confirmed/,
  );
  const withCount = Buffer.from(
      x.raw
        .toString()
        .replace(
          'data-next-cursor=""',
          'data-next-cursor="" data-reported-count="210000" data-reported-unit="listings" data-reported-estimated="true"',
        ),
    ),
    page = parseHtmlPage(withCount, x.binding, profile);
  assert.deepEqual(page.sourceReported, { count: 210000, unit: "listings", estimated: true });
  assert.equal(page.records.length, 1);
});

test("profile is frozen per run, changed profile cannot claim or bind an artifact, and parser itself cannot mutate it", async () => {
  const x = await setup(),
    changed = { ...profile, revision: 2 },
    other = new CollectorStore(db, () => fixed, { htmlProfile: changed });
  await assert.rejects(other.claim(x.sourceId), /collector_profile_mismatch/);
  await assert.rejects(
    other.bindFixtureArtifact({
      jobId: x.jobId,
      sourceId: x.sourceId,
      queryHash: x.binding.queryHash,
      asOf: fixed,
      hash: digest("changed"),
      pageHashes: new Map(),
    }),
    /collector_profile_mismatch/,
  );
  assert.throws(() => {
    x.store.htmlProfile.fields.title.selector = "h3.title";
  }, TypeError);
  const artifact = createFixtureArtifact(
    {
      jobId: x.jobId,
      sourceId: x.sourceId,
      queryHash: x.binding.queryHash,
      asOf: fixed,
      htmlProfile: profile,
    },
    new Map([["page:start", [response(x.raw)]]]),
  );
  const loaded = loadFixtureArtifact(Buffer.from(JSON.stringify(artifact)));
  assert.equal(loaded.pageHashes.get("start").has(digest(x.raw)), true);
});

test("HTML response artifact runs through a new CLI process with profile binding and original HTML evidence", async () => {
  const x = await setup(),
    artifact = createFixtureArtifact(
      {
        jobId: x.jobId,
        sourceId: x.sourceId,
        queryHash: x.binding.queryHash,
        asOf: fixed,
        htmlProfile: profile,
      },
      new Map([["page:start", [response(x.raw)]]]),
    ),
    path = join(x.root, "artifact.json");
  await writeFile(path, JSON.stringify(artifact));
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "./scripts/test-network.mjs",
        "scripts/collector-worker.mjs",
        `--fixture=${path}`,
        `--clock=${fixed}`,
      ],
      { encoding: "utf8", env: { ...process.env, COLLECTOR_DEMO_DIR: x.root } },
    ),
  );
  assert.equal(report.status, "completed");
  assert.equal(report.networkRequests, 0);
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM listing_record_evidence WHERE source_id=$1", [x.sourceId]))
      .rows[0].n,
    1,
  );
});

test("legitimate challenge or sign-in text never acts as a source access refusal, but explicit access markers do", async () => {
  const x = await setup(),
    valid = Buffer.from(
      x.raw
        .toString()
        .replace("Nintendo Switch OLED &amp; controller", "Pokemon Gym Challenge Sign In Coin")
        .replace("<body>", "<body><nav>Sign in</nav><script>var challenge = true;</script>"),
    );
  assert.equal((await runner(x, valid).runOne(x.sourceId)).status, "completed");
  for (const marker of [
    '<section class="access-wall">Verification required</section>',
    '<form class="access-login"></form>',
  ]) {
    const y = await setup();
    assert.equal(
      (await runner(y, Buffer.from(`<html><body>${marker}</body></html>`)).runOne(y.sourceId)).status,
      "failed",
    );
    assert.equal((await y.store.view(y.jobId)).error_code, "source_access_refused");
    assert.equal((await db.query("SELECT * FROM collector_pages WHERE job_id=$1", [y.jobId])).rowCount, 0);
  }
});

test("invalid selector configurations are rejected before a run or circuit mutation", async () => {
  for (const change of [
    { root: "[" },
    { accessBlocks: ["["] },
    { fields: { ...profile.fields, title: { selector: "[" } } },
  ]) {
    const invalid = { ...profile, ...change };
    assert.throws(() => validateHtmlProfile(invalid), /invalid_html_profile/);
    assert.throws(
      () => new CollectorStore(db, () => fixed, { htmlProfile: invalid }),
      /invalid_html_profile/,
    );
  }
});

test("persisted HTML candidates retain titles for downstream result sorting", async () => {
  const x = await setup();
  await runner(x).runOne(x.sourceId);
  const inputs = await x.store.candidates(x.jobId);
  assert.equal(inputs[0].title, "Nintendo Switch OLED & controller");
  const second = { ...inputs[0], eventKey: "synthetic-second", title: "Apple controller", itemCents: 20000 };
  const result = evaluate([...inputs, second], {
    sourceId: x.sourceId,
    asOf: fixed,
    days: 90,
    basis: "item",
    limit: 200,
    presentationSort: "title_asc",
  });
  assert.deepEqual(
    result.comps.map((r) => r.eventKey),
    ["synthetic-second", "synthetic-event-1"],
  );
});

test("one-command HTML demo proves two real HTML pages, eight bound generated primary images and an eligible median", async () => {
  const x = await setup();
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "./scripts/test-network.mjs", "scripts/collector-html-demo.mjs"],
      { encoding: "utf8", env: { ...process.env, COLLECTOR_DEMO_DIR: x.root } },
    ),
  );
  assert.equal(report.status, "completed");
  assert.equal(report.pageCount, 2);
  assert.equal(report.recordEvidenceCount, 8);
  assert.equal(report.availablePrimaryImages, 8);
  assert.equal(report.stats.n_price_verified, 8);
  assert.equal(report.stats.median_cents, 27400);
  assert.equal(report.networkRequests, 0);
  assert.equal(report.sourceVerified, false);
});

test("HTML and main-image work resumes across two separate processes without replaying committed pages", async () => {
  const x = await setup(),
    env = { ...process.env, COLLECTOR_DEMO_DIR: x.root };
  const prepared = JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "./scripts/test-network.mjs", "scripts/collector-html-demo.mjs", "--prepare-only"],
      { encoding: "utf8", env },
    ),
  );
  const base = [
    "--import",
    "./scripts/test-network.mjs",
    "scripts/collector-worker.mjs",
    `--fixture=${prepared.artifactPath}`,
  ];
  const first = JSON.parse(
    execFileSync(process.execPath, [...base, "--max-pages=1"], { encoding: "utf8", env }),
  );
  assert.equal(first.status, "retry");
  assert.equal(first.pageCount, 1);
  const job = await x.store.view(prepared.jobId),
    resumeClock = new Date(job.available_at.getTime() + 1).toISOString();
  const second = JSON.parse(
    execFileSync(process.execPath, [...base, `--clock=${resumeClock}`], { encoding: "utf8", env }),
  );
  assert.equal(second.status, "completed");
  assert.equal(second.pageCount, 2);
  assert.equal(second.requestsReserved, 10);
  assert.notEqual(first.pid, second.pid);
  const actual = (
    await db.query(
      "SELECT (SELECT count(*) FROM sale_events WHERE source_id=$1)::int n,(SELECT count(*) FROM listing_images WHERE source_id=$1 AND state='available')::int images",
      [job.source_id],
    )
  ).rows[0];
  assert.deepEqual(actual, { n: 8, images: 8 });
});

test("envelope-bound eBay US sold search DOM profile parses natural dates, canonical item links, best-offer exclusions, pagination and images while failing closed on drift or challenge pages", async () => {
  assert.equal(parseNaturalSoldDate("Sold  Nov 15, 2026"), "2026-11-15");
  assert.equal(parseNaturalSoldDate("Sold on Feb 28, 2026"), "2026-02-28");
  assert.equal(parseNaturalSoldDate("Sold Feb 29, 2026"), null);
  assert.equal(parseNaturalSoldDate("Ended Nov 15, 2026"), null);

  const ebayProfile = createEbayUsSoldSearchHtmlProfile();
  const queryHash = collectionQueryHash(normalizeQuery(new URLSearchParams({ q: "Nintendo Switch OLED" })));
  const x = await setup(ebayProfile, queryHash);
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: "green" } })
    .png()
    .toBuffer();

  const itemsHtml = Array.from({ length: 9 }, (_, i) => {
    const itemId = `23581234560${i}`;
    const isBestOffer = i === 8;
    const isAuction = i === 1;
    const freeShip = i % 2 === 0;
    const price = isBestOffer ? "$399.99" : `$${260 + i * 5}.00`;
    return `
      <li class="s-item">
        <div class="s-item__image-wrapper">
          <img class="s-item__image-img" src="https://i.ebayimg.com/images/g/placeholder/s-l64.gif" alt="placeholder">
          <img class="s-item__image-img" data-src="https://i.ebayimg.com/images/g/item-${i}/s-l500.png" alt="Nintendo Switch OLED ${i}">
        </div>
        <div class="s-item__info">
          <div class="s-item__caption">
            <span class="s-item__caption-label">Sold</span>
            <span class="s-item__caption-date">Sold  Nov 15, 2026</span>
          </div>
          <a class="s-item__link" href="https://www.ebay.com/itm/Nintendo-Switch-OLED-${i}/${itemId}?hash=item${i}&amp;_trkparms=ispr%3D1">
            <div class="s-item__title">Nintendo Switch OLED Console Bundle ${i}</div>
          </a>
          <div class="s-item__subtitle"><span class="SECONDARY_INFO">Pre-Owned</span></div>
          <div class="s-item__details">
            <span class="s-item__price">${price}</span>
            ${isBestOffer ? '<span class="s-item__price-evidence">strikethrough</span>' : ""}
            <span class="s-item__purchase-options">${
              isBestOffer ? "Best offer accepted" : isAuction ? "14 bids" : "Buy It Now"
            }</span>
            <span class="s-item__shipping">${freeShip ? "Free 2-4 day shipping" : "+$8.50 shipping"}</span>
            <span class="s-item__specific" data-name="model">OLED</span>
          </div>
        </div>
      </li>`;
  }).join("\n");

  const page1Html = Buffer.from(`<!doctype html><html><body>
    <h1 class="srp-controls__count-heading">1,240+ results for Nintendo Switch OLED</h1>
    <div class="srp-river-results">
      <ul class="srp-results">
        <li class="s-item s-item--sponsored">
          <div class="s-item__title">Sponsored Ad Item Should Be Ignored</div>
        </li>
        ${itemsHtml}
      </ul>
      <a class="pagination__next" href="https://www.ebay.com/sch/i.html?_nkw=Nintendo+Switch+OLED&amp;LH_Sold=1&amp;_pgn=2">Next</a>
    </div>
  </body></html>`);

  const page2Html = Buffer.from(`<!doctype html><html><body>
    <div class="srp-river-results">
      <div class="srp-save-null-search">No exact matches found</div>
    </div>
  </body></html>`);

  const parsedPage1 = parseHtmlPage(page1Html, x.binding, ebayProfile);
  assert.equal(parsedPage1.records.length, 9);
  assert.equal(parsedPage1.nextCursor, "page-2");
  assert.deepEqual(parsedPage1.sourceReported, { count: 1240, unit: "listings", estimated: true });
  assert.equal(parsedPage1.records[0].listingId, "235812345600");
  assert.equal(parsedPage1.records[0].recordEvidence.listingUrl, "https://www.ebay.com/itm/235812345600");
  assert.equal(parsedPage1.records[0].candidate.condition, "good");
  assert.equal(parsedPage1.records[0].candidate.format, "fixed_price");
  assert.equal(parsedPage1.records[0].candidate.priceStatus, "verified_actual");
  assert.equal(parsedPage1.records[0].candidate.shippingStatus, "verified_free_shipping");
  assert.equal(parsedPage1.records[1].candidate.format, "auction");
  assert.equal(parsedPage1.records[1].candidate.shippingStatus, "observed");
  assert.equal(parsedPage1.records[1].candidate.shippingCents, 850);
  assert.equal(parsedPage1.records[8].candidate.format, "best_offer");
  assert.equal(parsedPage1.records[8].candidate.priceStatus, "displayed_only");

  const frames = new Map([
    ["page:start", [response(page1Html)]],
    ["page:page-2", [response(page2Html)]],
    ...Array.from({ length: 9 }, (_, i) => [
      `image:https://i.ebayimg.com/images/g/item-${i}/s-l500.png`,
      [{ status: 200, contentType: "image/png", bytes: png }],
    ]),
  ]);
  const worker = new OfflineCollectorWorker(x.store, new FixtureTransport(frames), x.media);
  assert.equal((await worker.runOne(x.sourceId)).status, "completed");

  const candidates = await x.store.candidates(x.jobId);
  const evaluated = evaluate(candidates, {
    sourceId: x.sourceId,
    asOf: fixed,
    days: 90,
    basis: "item_plus_observed_shipping",
    limit: 200,
  });
  assert.equal(evaluated.stats.n_observed, 9);
  assert.equal(evaluated.stats.n_comparable, 9);
  assert.equal(evaluated.stats.n_price_verified, 8);
  assert.ok(evaluated.stats.median_cents !== null);

  // Interruption / CAPTCHA challenge triggers source_access_refused circuit breaker.
  const challengeSetup = await setup(ebayProfile, digest("ebay-challenge-query"));
  const challengeHtml = Buffer.from(
    `<!doctype html><html><body><div class="pgHeading">Pardon Our Interruption</div><form id="captcha_form"></form></body></html>`,
  );
  assert.equal(
    (await runner(challengeSetup, challengeHtml).runOne(challengeSetup.sourceId)).status,
    "failed",
  );
  assert.equal((await challengeSetup.store.view(challengeSetup.jobId)).error_code, "source_access_refused");

  // Structural drift (e.g. missing price class or unconfirmed empty DOM) quarantines the page fail-closed.
  const driftSetup = await setup(ebayProfile, digest("ebay-drift-query"));
  const driftHtml = Buffer.from(
    page1Html.toString().replaceAll('class="s-item__price"', 'class="s-item__price-renamed"'),
  );
  assert.equal((await runner(driftSetup, driftHtml).runOne(driftSetup.sourceId)).status, "failed");
  assert.equal(
    (await db.query("SELECT reason FROM collector_quarantines WHERE job_id=$1", [driftSetup.jobId])).rows[0]
      .reason,
    "page_structure_invalid",
  );
});
