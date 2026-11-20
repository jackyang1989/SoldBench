import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import {
  CollectorStore,
  createFixtureArtifact,
  LoopbackHttpTransport,
  loadFixtureArtifact,
  OfflineCollectorWorker,
  provisionFixtureSource,
} from "@soldbench/collector";
import { collectionQueryHash, evaluate, normalizeQuery } from "@soldbench/core";
import { assertLocalDatabaseUrl, database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { loadConfig } from "@soldbench/shared";
import { load } from "cheerio/slim";
import sharp from "sharp";
import { intakeFixture } from "./collector-intake.mjs";
import { localDatabaseUrl } from "./local-db.mjs";

const flags = new Set(process.argv.slice(2));
if (
  flags.size !== process.argv.length - 2 ||
  [...flags].some((arg) => !["--prepare-only", "--http", "--research"].includes(arg)) ||
  (flags.has("--prepare-only") && flags.has("--http"))
)
  throw new Error("invalid_html_demo_argument");
const research = flags.has("--research"),
  keyword = research ? "Nintendo Switch" : "Nintendo Switch OLED",
  rowsPerPage = research ? 9 : 4;
const config = loadConfig(process.env);
const url = process.env.DATABASE_URL ?? localDatabaseUrl();
assertLocalDatabaseUrl(url, [
  resolve(".local/postgres/socket"),
  ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
]);
const db = database(url),
  directory = resolve(process.env.COLLECTOR_DEMO_DIR ?? ".local");
let server,
  localHttpRequests = 0;
try {
  await migrate(db);
  const now = (await db.query("SELECT clock_timestamp() t")).rows[0].t.toISOString(),
    source = await provisionFixtureSource(db, now, {
      publicAggregates: process.env.PUBLIC_FIXTURE_AGGREGATES === "true",
      searchSummaries: research,
    }),
    profile = JSON.parse(readFileSync(new URL("../tests/fixtures/html/profile.json", import.meta.url))),
    template = readFileSync(new URL("../tests/fixtures/html/search.html", import.meta.url), "utf8"),
    configuredProfile = research
      ? {
          ...profile,
          revision: 2,
          allowSyntheticSeller: true,
          shippingContexts: ["fixture-domestic", "fixture-regional"],
          fields: {
            ...profile.fields,
            conditionStandard: { selector: "span.condition", attribute: "data-standard" },
            shippingContextRef: { selector: "span.shipping", attribute: "data-context-ref" },
            description: { selector: "p.description" },
            defects: { selector: "p.defects" },
          },
        }
      : profile,
    store = new CollectorStore(db, undefined, { htmlProfile: configuredProfile }),
    queryHash = collectionQueryHash(normalizeQuery(new URLSearchParams({ q: keyword }))),
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
    if (research && page === 0)
      root.attr({
        "data-reported-count": "42000",
        "data-reported-unit": "listings",
        "data-reported-estimated": "true",
      });
    for (let i = page * rowsPerPage; i < (page + 1) * rowsPerPage; i++) {
      const row = prototype.clone(),
        listing = `html-listing-${i}`,
        event = `html-event-${i}`,
        imageUrl = `https://images.example.test/html-primary-${i}.png`,
        model = research && i >= 8 ? "Lite" : "OLED",
        cents = (model === "Lite" ? 15050 : 27050) + i * 100;
      row.find("span.identity").attr({ "data-listing-id": listing, "data-event-key": event });
      row.find("h2.title").text(`Synthetic Nintendo Switch ${model} ${i}`);
      row.find("span.price").text(`US $${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`);
      if (research) {
        row.find('span.attribute[data-name="model"]').text(model);
        row.find("span.condition").attr("data-standard", "good");
        row.find("span.shipping").attr("data-context-ref", i < 8 ? "fixture-domestic" : "fixture-regional");
        if (i >= 8) row.find("span.shipping").attr("data-evidence", "observed").text("$8.50");
        row.find("span.seller").attr("data-ref", `synthetic-merchant-${i % 4}`);
        row.append('<p class="description">Synthetic evidence includes the console and charger.</p>');
        row.append('<p class="defects">Synthetic light wear on the case.</p>');
        if (i >= 16) {
          row.find("span.format").text("best_offer");
          row.find("span.price").attr("data-evidence", "displayed_only");
        }
      }
      row.find("time.sold-date").attr("datetime", new Date(Date.parse(now) - 86400000).toISOString());
      row.find("a.listing-link").attr("href", `https://market.example.test/item/${listing}`);
      row
        .find("img.primary")
        .removeAttr("srcset")
        .attr({ "data-listing-id": listing, "data-event-key": event, "data-src": imageUrl });
      root.append(row);
      const bytes = await sharp({
        create: {
          width: 12,
          height: 12,
          channels: 3,
          background: { r: 20 + i * (research ? 12 : 20), g: 80, b: 150 },
        },
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
      { sourceId: source.sourceId, jobId, queryHash, asOf: now, htmlProfile: configuredProfile },
      frames,
    ),
    loaded = loadFixtureArtifact(Buffer.from(JSON.stringify(artifact)));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const artifactPath = await intakeFixture(db, directory, source.sourceId, loaded);
  let transport = loaded.transport;
  if (flags.has("--http")) {
    const responses = new Map(),
      routes = [];
    for (const [key, values] of frames) {
      const path = `/fixture/${routes.length}`;
      responses.set(path, values[0]);
      routes.push({ key, path });
    }
    server = createServer((req, res) => {
      localHttpRequests++;
      const response = responses.get(req.url);
      if (!response) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(response.status, {
        "content-type": response.contentType,
        "content-length": response.bytes.byteLength,
      });
      res.end(response.bytes);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    transport = new LoopbackHttpTransport({ origin: `http://127.0.0.1:${server.address().port}`, routes });
  }
  if (!flags.has("--prepare-only"))
    await new OfflineCollectorWorker(
      store,
      transport,
      new PrivateMediaStore(resolve(config.mediaRoot)),
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
    scenario: research ? "research" : "quickstart",
    query: keyword,
    sourceVerified: false,
    sourceId: source.sourceId,
    networkRequests: localHttpRequests,
    externalNetworkRequests: 0,
    localHttpRequests,
    transport: transport.mode,
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
  if (!flags.has("--prepare-only") && job.status !== "completed") process.exitCode = 1;
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await db.end();
}
