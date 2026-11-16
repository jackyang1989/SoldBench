import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CollectorStore,
  digest,
  FixtureTransport,
  fixtureResponse,
  OfflineCollectorWorker,
  provisionFixtureSource,
} from "@soldbench/collector";
import { candidateFromJson, evaluate, normalizeQuery, queryHash } from "@soldbench/core";
import { assertLocalDatabaseUrl, database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { loadConfig } from "@soldbench/shared";
import sharp from "sharp";
import { localDatabaseUrl } from "./local-db.mjs";

loadConfig(process.env);
const url = process.env.DATABASE_URL ?? localDatabaseUrl();
assertLocalDatabaseUrl(url, [
  resolve(".local/postgres/socket"),
  ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
]);
const demoDir = process.env.COLLECTOR_DEMO_DIR ?? ".local";
const db = database(url);
try {
  const version = (await db.query("SHOW server_version")).rows[0].server_version;
  if (!version.startsWith("16.")) throw new Error("PostgreSQL 16 is required");
  await migrate(db);
  const raw = readFileSync(new URL("../v14_gameboy_58_verified.json", import.meta.url));
  if (digest(raw) !== "d59be9da67aa558d3cb494ec06d9918fd185afc3ec3b4daa31c0f6a7b244ae78")
    throw new Error("original_fixture_changed");
  const fixture = JSON.parse(raw);
  const source = await provisionFixtureSource(db, new Date().toISOString());
  const store = new CollectorStore(db),
    media = new PrivateMediaStore(resolve(demoDir, "collector-media"));
  const hash = queryHash(normalizeQuery(new URLSearchParams({ q: "Game Boy Color" })));
  const jobId = await store.enqueue({
    ...source,
    queryHash: hash,
    runKey: "golden-demo",
    asOf: fixture.as_of,
  });
  const records = fixture.candidate_records.map((row, i) => ({
    listingId: row.listing_id ?? `fixture-${row.sale_event_id}`,
    title: row.title ?? `Synthetic record ${i}`,
    candidate: candidateFromJson({
      sourceId: source.sourceId,
      eventKey: row.sale_event_id,
      identityVerified: true,
      comparable: row.is_comparable,
      priceStatus: row.sale_price_status,
      format: row.sale_format,
      currency: row.currency ?? "XXX",
      itemCents: row.item_price_cents ?? null,
      shippingCents: row.observed_shipping_cents ?? null,
      shippingStatus: row.observed_shipping_status,
      time: { precision: "instant", value: row.sold_at },
    }),
  }));
  const imageUrl = "https://images.example.test/synthetic-primary.png";
  records[0].primaryImage = { role: "primary", url: imageUrl };
  const png = await sharp({ create: { width: 24, height: 16, channels: 3, background: "#5b4acb" } })
    .png()
    .toBuffer();
  const frames = new Map();
  for (let i = 0; i < 3; i++) {
    const cursor = i === 0 ? "start" : `page-${i}`;
    frames.set(`page:${cursor}`, [
      fixtureResponse({
        schema: "soldbench.synthetic-page.v1",
        synthetic: true,
        sourceId: source.sourceId,
        queryHash: hash,
        cursor,
        nextCursor: i < 2 ? `page-${i + 1}` : null,
        asOf: fixture.as_of,
        empty: false,
        records: records.slice(i * 50, (i + 1) * 50),
      }),
    ]);
  }
  frames.set(`image:${imageUrl}`, [{ status: 200, contentType: "image/png", bytes: png }]);
  const transport = new FixtureTransport(frames),
    runner = new OfflineCollectorWorker(store, transport, media);
  const completed = await runner.runOne(source.sourceId);
  if (completed?.status !== "completed")
    throw new Error(`fixture_collection_failed:${(await store.view(jobId)).error_code}`);
  const result = evaluate(await store.candidates(jobId), {
    sourceId: source.sourceId,
    asOf: fixture.as_of,
    days: 90,
    basis: "item_plus_observed_shipping",
    limit: 50,
  });
  if (JSON.stringify(result.stats) !== JSON.stringify(fixture.expected_stats)) {
    for (const key of Object.keys(fixture.expected_stats))
      if (result.stats[key] !== fixture.expected_stats[key]) throw new Error(`golden_stat_mismatch:${key}`);
  }
  const image = (
    await db.query("SELECT id,object_key FROM listing_images WHERE source_id=$1 AND state='available'", [
      source.sourceId,
    ])
  ).rows[0];
  if (!image) throw new Error("synthetic_primary_image_missing");
  const bytes = await runner.readImageInternal(image.id);
  const report = {
    mode: "offline_fixture",
    sourceApproval: "NOT_CLEARED",
    networkRequests: 0,
    jobId,
    status: completed.status,
    pageCount: (await store.view(jobId)).page_count,
    fixtureResponses: transport.calls.length,
    imageFormat: (await sharp(bytes).metadata()).format,
    imageBytes: bytes.length,
    stats: result.stats,
    stageVerdict: "NOT_ISSUED",
  };
  mkdirSync(demoDir, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(demoDir, "collector-demo-report.json"), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await db.end();
}
