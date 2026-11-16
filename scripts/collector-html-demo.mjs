import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CollectorStore,
  createFixtureArtifact,
  digest,
  loadFixtureArtifact,
  OfflineCollectorWorker,
  provisionFixtureSource,
} from "@soldbench/collector";
import { evaluate } from "@soldbench/core";
import { assertLocalDatabaseUrl, database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { loadConfig } from "@soldbench/shared";
import { load } from "cheerio/slim";
import sharp from "sharp";
import { localDatabaseUrl } from "./local-db.mjs";

if (process.argv.slice(2).some((arg) => arg !== "--prepare-only") || process.argv.slice(2).length > 1)
  throw new Error("invalid_html_demo_argument");
loadConfig(process.env);
const url = process.env.DATABASE_URL ?? localDatabaseUrl();
assertLocalDatabaseUrl(url, [
  resolve(".local/postgres/socket"),
  ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
]);
const db = database(url),
  directory = resolve(process.env.COLLECTOR_DEMO_DIR ?? ".local");
try {
  await migrate(db);
  const now = (await db.query("SELECT clock_timestamp() t")).rows[0].t.toISOString(),
    source = await provisionFixtureSource(db, now),
    profile = JSON.parse(readFileSync(new URL("../tests/fixtures/html/profile.json", import.meta.url))),
    template = readFileSync(new URL("../tests/fixtures/html/search.html", import.meta.url), "utf8"),
    store = new CollectorStore(db, undefined, { htmlProfile: profile }),
    queryHash = digest("synthetic-html-demo"),
    jobId = await store.enqueue({ ...source, queryHash, runKey: "html-demo", asOf: now }),
    frames = new Map();
  for (let page = 0; page < 2; page++) {
    const $ = load(template),
      root = $(profile.root),
      prototype = root.find("article.record[data-kind=sold-record]").first().clone();
    root.empty().attr({
      "data-source-id": source.sourceId,
      "data-query-hash": queryHash,
      "data-cursor": page ? "second" : "start",
      "data-next-cursor": page ? "" : "second",
      "data-as-of": now,
    });
    for (let i = page * 4; i < page * 4 + 4; i++) {
      const row = prototype.clone(),
        listing = `html-listing-${i}`,
        event = `html-event-${i}`,
        imageUrl = `https://images.example.test/html-primary-${i}.png`,
        cents = 27050 + i * 100;
      row.find("span.identity").attr({ "data-listing-id": listing, "data-event-key": event });
      row.find("h2.title").text(`Synthetic Nintendo Switch OLED ${i}`);
      row.find("span.price").text(`US $${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`);
      row.find("time.sold-date").attr("datetime", new Date(Date.parse(now) - 86400000).toISOString());
      row.find("a.listing-link").attr("href", `https://market.example.test/item/${listing}`);
      row
        .find("img.primary")
        .removeAttr("srcset")
        .attr({ "data-listing-id": listing, "data-event-key": event, "data-src": imageUrl });
      root.append(row);
      const bytes = await sharp({
        create: { width: 12, height: 12, channels: 3, background: { r: 20 + i * 20, g: 80, b: 150 } },
      })
        .png()
        .toBuffer();
      frames.set(`image:${imageUrl}`, [{ status: 200, contentType: "image/png", bytes }]);
    }
    frames.set(`page:${page ? "second" : "start"}`, [
      { status: 200, contentType: "text/html; charset=utf-8", bytes: Buffer.from($.html()) },
    ]);
  }
  const artifact = createFixtureArtifact(
      { sourceId: source.sourceId, jobId, queryHash, asOf: now, htmlProfile: profile },
      frames,
    ),
    loaded = loadFixtureArtifact(Buffer.from(JSON.stringify(artifact)));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const artifactPath = join(directory, `collector-html-fixture-${jobId}.json`);
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  await store.bindFixtureArtifact({
    jobId,
    sourceId: source.sourceId,
    queryHash,
    asOf: now,
    hash: loaded.hash,
    pageHashes: loaded.pageHashes,
  });
  if (!process.argv.includes("--prepare-only"))
    await new OfflineCollectorWorker(
      store,
      loaded.transport,
      new PrivateMediaStore(join(directory, "collector-media")),
    ).runOne(source.sourceId, { jobId });
  const job = await store.view(jobId),
    counts = (
      await db.query(
        "SELECT (SELECT count(*) FROM listing_record_evidence WHERE source_id=$1)::int AS records,(SELECT count(*) FROM listing_images WHERE source_id=$1 AND state='available')::int AS images",
        [source.sourceId],
      )
    ).rows[0],
    stats =
      job.status === "completed"
        ? evaluate(await store.candidates(jobId), {
            sourceId: source.sourceId,
            asOf: now,
            days: 90,
            basis: "item_plus_observed_shipping",
            limit: 200,
          }).stats
        : null;
  const report = {
    mode: "offline_fixture",
    sourceVerified: false,
    networkRequests: 0,
    jobId,
    status: job.status,
    pageCount: job.page_count,
    recordEvidenceCount: counts.records,
    availablePrimaryImages: counts.images,
    stats,
    artifactPath,
    parserProfileHash: store.profileHash,
  };
  writeFileSync(join(directory, "collector-html-demo-report.json"), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(JSON.stringify(report));
  if (!process.argv.includes("--prepare-only") && job.status !== "completed") process.exitCode = 1;
} finally {
  await db.end();
}
