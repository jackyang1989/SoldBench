import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import {
  CollectorStore,
  FixtureTransport,
  fixtureResponse,
  OfflineCollectorWorker,
} from "@soldbench/collector";
import { collectionQueryHash, normalizeQuery } from "@soldbench/core";
import { database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import sharp from "sharp";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL);
const roots = [];

before(() => migrate(db));
after(async () => {
  await db.end();
  await Promise.all(roots.map((p) => rm(p, { recursive: true, force: true })));
});

const DAY_MS = 86_400_000;

async function commitSyntheticSpan(
  x,
  {
    keyword,
    records,
    asOf,
    retentionDays = 30,
    completeness = "complete",
    spanWindowStart,
    spanWindowEnd,
    archiveRetentionUntil,
  },
) {
  const q = normalizeQuery(new URLSearchParams({ q: keyword }));
  const hash = collectionQueryHash(q);
  await db.query(
    "UPDATE source_clearances SET retention_days=$2 WHERE id=(SELECT source_clearance_id FROM sources WHERE id=$1)",
    [x.source.sourceId, retentionDays],
  );
  const store = new CollectorStore(db, x.now);
  const jobId = await store.enqueue({ ...x.source, queryHash: hash, runKey: randomUUID(), asOf });
  const frames = new Map();
  frames.set("page:start", [
    fixtureResponse({
      schema: "soldbench.synthetic-page.v1",
      synthetic: true,
      sourceId: x.source.sourceId,
      queryHash: hash,
      cursor: "start",
      nextCursor: null,
      asOf,
      empty: records.length === 0,
      records,
    }),
  ]);
  for (const r of records) {
    if (r.primaryImage?.url) {
      frames.set(`image:${r.primaryImage.url}`, [
        {
          status: 200,
          contentType: "image/png",
          bytes: await sharp({ create: { width: 10, height: 10, channels: 3, background: "blue" } })
            .png()
            .toBuffer(),
        },
      ]);
    }
  }
  const media = new PrivateMediaStore(roots[0]);
  const res = await new OfflineCollectorWorker(store, new FixtureTransport(frames), media).runOne(
    x.source.sourceId,
  );
  assert.equal(res.status, "completed");

  if (spanWindowStart && spanWindowEnd) {
    await db.query(
      `UPDATE archive_coverage_spans
       SET window_start=$2, window_end=$3, completeness=$4, retention_until=coalesce($5, retention_until)
       WHERE collector_run_id=(SELECT collector_run_id FROM collector_jobs WHERE id=$1)`,
      [jobId, spanWindowStart, spanWindowEnd, completeness, archiveRetentionUntil ?? null],
    );
  }
  return hash;
}

test("AT-063: archive coverage ledger rejects inflated windows, detects gaps, excludes multi-unit averages, guards legacy photos, binds cursors, and enforces revocation", async () => {
  const anchorIso = "2026-11-17T12:00:00.000Z";
  const anchorMs = Date.parse(anchorIso);
  const x = await createProductFixture(db, roots, {
    keyword: "Seed Default",
    clockValue: anchorIso,
    count: 10,
  });

  // Other user + API key for cross-owner cursor check
  const otherId = (
    await db.query(
      "INSERT INTO users(email,password_hash,status,email_verified_at) VALUES($1,'fixture','active',$2) RETURNING id",
      [`other-hist-${randomUUID()}@example.test`, anchorIso],
    )
  ).rows[0].id;
  const otherSecret = x.auth.crypto.token("sb_k_");
  await db.query(
    "INSERT INTO api_keys(user_id,name,key_hash,key_prefix,scopes) VALUES($1,'other',$2,'sb_k_h',$3)",
    [otherId, x.auth.crypto.hash("auth.api-key", otherSecret), ["sold:read"]],
  );
  const otherHeaders = { Authorization: `Bearer ${otherSecret}` };

  const targetQuery = "Archive Retro Console";
  const imageOldUrl = "https://images.example.test/legacy-expired.png";

  // Span A (older retained archive: [-70d .. -50d]), with 5 verified single sales + 1 formula title + 1 multi-unit row + 1 expired legacy image
  const spanAStart = new Date(anchorMs - 70 * DAY_MS).toISOString();
  const spanAEnd = new Date(anchorMs - 50 * DAY_MS).toISOString();
  const olderRecords = [
    ...Array.from({ length: 5 }, (_, i) => {
      const soldAt = new Date(anchorMs - (65 - i * 3) * DAY_MS).toISOString();
      const title = i === 0 ? '=HYPERLINK("https://bad.example.test")' : `Older Single ${i}`;
      return {
        listingId: `old-single-${i}`,
        title,
        ...(i === 0 ? { primaryImage: { role: "primary", url: imageOldUrl } } : {}),
        candidate: {
          sourceId: x.source.sourceId,
          eventKey: `old-event-${i}`,
          identityVerified: true,
          comparable: true,
          priceStatus: "verified_actual",
          format: "fixed_price",
          currency: "USD",
          itemCents: 4000 + i * 100,
          shippingCents: 0,
          shippingStatus: "verified_free_shipping",
          condition: "good",
          title,
          time: { precision: "instant", value: soldAt },
        },
      };
    }),
    // Multi-unit listing average row that MUST NOT contaminate single-sale price stats
    {
      listingId: "old-multi-unit-1",
      title: "Lot Average (Multi-Unit)",
      candidate: {
        sourceId: x.source.sourceId,
        eventKey: "old-multi-unit-event-1",
        identityVerified: true,
        comparable: true,
        priceStatus: "verified_actual",
        format: "fixed_price",
        currency: "USD",
        itemCents: 999900, // Extreme outlier value that would skew median if included!
        shippingCents: 0,
        shippingStatus: "verified_free_shipping",
        condition: "good",
        title: "Lot Average (Multi-Unit)",
        listingAggregationKind: "multi_unit_listing_average",
        time: { precision: "instant", value: new Date(anchorMs - 60 * DAY_MS).toISOString() },
      },
    },
  ];

  // Span B (recent uninterrupted 32d archive: [-32d .. anchor]), leaving a real 18-day gap [-50d .. -32d]!
  const spanBStart = new Date(anchorMs - 32 * DAY_MS).toISOString();
  const spanBEnd = anchorIso;
  const recentRecords = [
    ...Array.from({ length: 8 }, (_, i) => {
      const soldAt = new Date(anchorMs - (28 - i * 3) * DAY_MS).toISOString();
      return {
        listingId: `new-single-${i}`,
        title: `Recent Single ${i}`,
        candidate: {
          sourceId: x.source.sourceId,
          eventKey: `new-event-${i}`,
          identityVerified: true,
          comparable: true,
          priceStatus: "verified_actual",
          format: "fixed_price",
          currency: "USD",
          itemCents: 5000 + i * 100,
          shippingCents: 0,
          shippingStatus: "verified_free_shipping",
          condition: "good",
          title: `Recent Single ${i}`,
          time: { precision: "instant", value: soldAt },
        },
      };
    }),
    {
      listingId: "new-summary-only-1",
      title: "Listing Summary Only",
      candidate: {
        sourceId: x.source.sourceId,
        eventKey: "new-summary-event-1",
        identityVerified: true,
        comparable: true,
        priceStatus: "verified_actual",
        format: "fixed_price",
        currency: "USD",
        itemCents: 888800,
        shippingCents: 0,
        shippingStatus: "verified_free_shipping",
        condition: "good",
        title: "Listing Summary Only",
        listingAggregationKind: "listing_summary_only",
        time: { precision: "instant", value: new Date(anchorMs - 10 * DAY_MS).toISOString() },
      },
    },
  ];

  const archiveRetention = new Date(anchorMs + 180 * DAY_MS).toISOString();
  await db.query("UPDATE source_clearances SET expires_at=$2 WHERE id=$1", [
    x.source.clearanceId,
    archiveRetention,
  ]);

  const hash = await commitSyntheticSpan(x, {
    keyword: targetQuery,
    records: olderRecords,
    asOf: spanAEnd,
    retentionDays: 30,
    spanWindowStart: spanAStart,
    spanWindowEnd: spanAEnd,
    archiveRetentionUntil: archiveRetention,
  });
  await commitSyntheticSpan(x, {
    keyword: targetQuery,
    records: recentRecords,
    asOf: spanBEnd,
    retentionDays: 30,
    spanWindowStart: spanBStart,
    spanWindowEnd: spanBEnd,
    archiveRetentionUntil: archiveRetention,
  });

  // Mark legacy photo from Span A as expired
  await db.query(
    "UPDATE listing_images SET retention_until=$2 WHERE source_id=$1 AND sale_event_id=(SELECT id FROM sale_events WHERE source_id=$1 AND source_event_key='old-event-0')",
    [x.source.sourceId, new Date(anchorMs - DAY_MS).toISOString()],
  );

  // 1. Coverage check: real retained = 52 days (20 + 32), missing 18d gap, supported continuous windows = [30] ONLY (never 90/180/365/1095!)
  const covRes = await x.app.request(`/v1/history/coverage?q=${encodeURIComponent(targetQuery)}`, {
    headers: x.headers,
  });
  assert.equal(covRes.status, 200);
  const cov = (await covRes.json()).data;
  assert.equal(cov.query_hash, hash);
  assert.equal(cov.covered_spans.length, 2);
  assert.equal(cov.missing_gaps.length, 1);
  assert.equal(cov.actual_retained_days, 52);
  assert.deepEqual(cov.supported_history_windows, [30]);
  assert.equal(cov.excluded_multi_unit_rows, 2);

  // 2. Requesting 90 days or 365 days without allow_partial -> 422 unsupported_window (refuses to fabricate continuous coverage)
  const blockedRes = await x.app.request(`/v1/history?q=${encodeURIComponent(targetQuery)}&window_days=180`, {
    headers: x.headers,
  });
  assert.equal(blockedRes.status, 422);
  const blockedBody = await blockedRes.json();
  assert.equal(blockedBody.error.code, "unsupported_window");
  assert.equal(blockedBody.error.details.coverage_status, "partial");
  assert.ok(blockedBody.error.details.missing_gaps.length >= 1);

  // 3. Requesting 30 days (within continuous 32d Span B) succeeds with coverage_status='complete'
  const completeRes = await x.app.request(
    `/v1/history?q=${encodeURIComponent(targetQuery)}&window_days=30&granularity=week`,
    { headers: x.headers },
  );
  assert.equal(completeRes.status, 200);
  const complete = await completeRes.json();
  assert.equal(complete.meta.credits_charged, 0);
  assert.equal(complete.data.coverage_status, "complete");
  assert.equal(complete.data.missing_gaps.length, 0);
  assert.equal(complete.data.stats.n_price_verified, 8);
  assert.equal(complete.data.excluded_multi_unit_count, 1); // Only Span B summary-only row inside 30d window
  assert.ok(complete.data.stats.median_cents < 6000); // NOT contaminated by 888800!

  // 4. Explicit partial historical query spanning the [-70d .. anchor] range with daily buckets:
  //    - Verifies gap buckets report observation_coverage='missing' & median_cents=null (NEVER 0!)
  //    - Verifies both multi-unit rows excluded (total 13 single sales)
  //    - Verifies expired legacy photo returns state='expired', url=null without hiding sale
  const partialParams = new URLSearchParams({
    q: targetQuery,
    from_date: spanAStart,
    to_date: anchorIso,
    allow_partial: "true",
    granularity: "day",
    page_size: "6",
  });
  const partialRes = await x.app.request(`/v1/history?${partialParams}`, { headers: x.headers });
  assert.equal(partialRes.status, 200);
  const partial = (await partialRes.json()).data;
  assert.equal(partial.coverage_status, "partial");
  assert.equal(partial.missing_gaps.length, 1);
  assert.equal(partial.stats.n_price_verified, 13);
  assert.equal(partial.excluded_multi_unit_count, 2);

  const missingBuckets = partial.time_series.buckets.filter((b) => b.observation_coverage === "missing");
  assert.ok(missingBuckets.length >= 17);
  for (const b of missingBuckets) {
    assert.equal(b.sample_count, 0);
    assert.equal(b.median_cents, null);
    assert.equal(b.p25_cents, null);
  }

  // 5. Cursor pagination across pages (6 + 6 + 1 = 13), checking foreign-owner cursor rejection
  assert.equal(partial.items.length, 6);
  assert.ok(partial.next_cursor);
  const foreignCursorParams = new URLSearchParams(partialParams);
  foreignCursorParams.set("cursor", partial.next_cursor);
  const crossOwnerCursor = await x.app.request(`/v1/history?${foreignCursorParams}`, {
    headers: otherHeaders,
  });
  assert.equal(crossOwnerCursor.status, 400);

  const allItems = [...partial.items];
  let nextCursor = partial.next_cursor;
  while (nextCursor) {
    const nextParams = new URLSearchParams(partialParams);
    nextParams.set("cursor", nextCursor);
    const nextRes = await x.app.request(`/v1/history?${nextParams}`, { headers: x.headers });
    assert.equal(nextRes.status, 200);
    const nextData = (await nextRes.json()).data;
    allItems.push(...nextData.items);
    nextCursor = nextData.next_cursor;
  }
  assert.equal(allItems.length, 13);
  const expiredSale = allItems.find((i) => i.title === '=HYPERLINK("https://bad.example.test")');
  assert.ok(expiredSale, "Legacy sale with expired photo must remain present");
  assert.equal(expiredSale.primary_image.state, "expired");
  assert.equal(expiredSale.primary_image.url, null);

  // 6. Formula-safe CSV export (0 credits, private/no-store)
  const expCsvRes = await x.app.request("/v1/history/export", {
    method: "POST",
    headers: { ...x.headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      format: "csv",
      q: targetQuery,
      from_date: spanAStart,
      to_date: anchorIso,
      allow_partial: true,
    }),
  });
  assert.equal(expCsvRes.status, 200);
  assert.equal(expCsvRes.headers.get("Cache-Control"), "private, no-store");
  const csvText = await expCsvRes.text();
  assert.match(csvText, /"'=HYPERLINK/);
  assert.doesNotMatch(csvText, /999900|888800/);

  // 7. Source revocation immediately blocks both historical /v1/history/coverage & /v1/history
  await db.query("UPDATE sources SET status='revoked', permission_epoch=permission_epoch+1 WHERE id=$1", [
    x.source.sourceId,
  ]);
  const revokedCov = await x.app.request(`/v1/history/coverage?q=${encodeURIComponent(targetQuery)}`, {
    headers: x.headers,
  });
  assert.equal(revokedCov.status, 200);
  assert.equal((await revokedCov.json()).data.covered_spans.length, 0);

  const revokedHist = await x.app.request(
    `/v1/history?q=${encodeURIComponent(targetQuery)}&window_days=30&allow_partial=true`,
    { headers: x.headers },
  );
  assert.equal(revokedHist.status, 422);
  assert.equal((await revokedHist.json()).error.details.coverage_status, "none");
});
