import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import {
  CollectorStore,
  collectorHealth,
  createEbayUsSoldCardHtmlProfile,
  createFixtureArtifact,
  FixtureTransport,
  loadFixtureArtifact,
  OfflineCollectorWorker,
  parseEbayCorpusCsv,
  parseEbayCorpusJson,
  provisionFixtureSource,
  runEbayUsCorpusCycle,
} from "@soldbench/collector";
import { collectionQueryHash, normalizeQuery } from "@soldbench/core";
import { database, migrate, transaction } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import sharp from "sharp";
import { telemetry } from "../apps/api/src/ops-telemetry.ts";
import { createProductFixture } from "./helpers/product.mjs";

const execFileAsync = promisify(execFile);
const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browserBinary = process.env.SOLDBENCH_BROWSER_BINARY ?? (existsSync(macChrome) ? macChrome : undefined);

const db = database(process.env.DATABASE_URL),
  roots = [],
  servers = [],
  fixed = "2026-11-22T10:00:00Z";

before(() => migrate(db));
after(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
  for (const root of roots) await rm(root, { recursive: true, force: true });
  await db.end();
});

async function makeRoot(prefix = "soldbench-daemon-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function startMockServer(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("collector_detail_jobs lifecycle handles queue, stale lease recovery, 429 backoff, conflicts, 403 stop, revocation and telemetry", async () => {
  let clock = fixed;
  const mediaRoot = await makeRoot("soldbench-detailq-media-");
  const cardProfile = createEbayUsSoldCardHtmlProfile();
  const source = await provisionFixtureSource(db, clock, { searchSummaries: true });
  const store = new CollectorStore(db, () => clock, { htmlProfile: cardProfile });
  const query = normalizeQuery(new URLSearchParams({ q: "NVIDIA RTX 4070", limit: "5" }));
  const queryHash = collectionQueryHash(query);
  const jobId = await store.enqueue({
    ...source,
    queryHash,
    runKey: "detail-queue-lifecycle-1",
    asOf: clock,
  });

  const ids = ["397100000001", "397100000002", "397100000003"];
  const searchHtml = Buffer.from(`<!doctype html><html><body>
    <h1 class="srp-controls__count-heading">3 results for NVIDIA RTX 4070</h1>
    <div class="srp-river-results"><ul class="srp-results">
      ${ids
        .map(
          (id, idx) => `
        <li class="s-card">
          <div class="s-card__details">
            <div class="s-card__caption"><span class="su-styled-text positive">Sold Nov 21, 2026</span></div>
            <a class="s-card__link" href="https://www.ebay.com/itm/${id}"><div class="s-card__title"><span class="su-styled-text">NVIDIA RTX 4070 Card #${idx}</span></div></a>
            ${idx === 2 ? '<span class="s-card__specific">Brand: NVIDIA</span>' : ""}
            <span class="s-card__price">$${520 + idx * 10}.00</span>
            <span class="s-card__shipping">Free shipping</span>
          </div>
        </li>`,
        )
        .join("\n")}
    </ul></div>
  </body></html>`);

  const detail1Html =
    Buffer.from(`<!doctype html><html><head><link rel="canonical" href="https://www.ebay.com/itm/397100000001"></head><body>
    <nav class="breadcrumbs"><a>Video Cards</a></nav>
    <div class="ux-layout-section--itemId"><span class="ux-textspans--BOLD">397100000001</span></div>
    <div data-testid="x-item-condition-atf"><span class="ux-textspans">Like New</span></div>
    <div class="x-item-condition-desc"><span class="ux-textspans">Original box included.</span></div>
    <div class="ux-layout-section--itemSpecifics"><dl class="ux-labels-values">
      <dt>Brand</dt><dd>NVIDIA</dd><dt>Memory Size</dt><dd>12 GB</dd>
    </dl></div>
    <div class="d-item-description">Clean Founders Edition RTX 4070.</div>
  </body></html>`);

  const detail3ConflictHtml =
    Buffer.from(`<!doctype html><html><head><link rel="canonical" href="https://www.ebay.com/itm/397100000003"></head><body>
    <nav class="breadcrumbs"><a>Video Cards</a></nav>
    <div class="ux-layout-section--itemId"><span class="ux-textspans--BOLD">397100000003</span></div>
    <div class="ux-layout-section--itemSpecifics"><dl class="ux-labels-values">
      <dt>Brand</dt><dd>AMD</dd><dt>Memory Size</dt><dd>12 GB</dd>
    </dl></div>
    <div class="d-item-description">Conflicting brand row.</div>
  </body></html>`);

  const detail2BlockHtml = Buffer.from(
    '<!doctype html><html><body><div id="splashui-challenge">Verify human</div></body></html>',
  );

  const frames = new Map([
    ["page:start", [{ status: 200, contentType: "text/html; charset=utf-8", bytes: searchHtml }]],
    ["detail:397100000001", [{ status: 200, contentType: "text/html; charset=utf-8", bytes: detail1Html }]],
    [
      "detail:397100000002",
      [
        { status: 429, contentType: "text/html", bytes: Buffer.from("rate limited"), retryAfterSeconds: 120 },
        { status: 200, contentType: "text/html; charset=utf-8", bytes: detail2BlockHtml },
      ],
    ],
    [
      "detail:397100000003",
      [{ status: 200, contentType: "text/html; charset=utf-8", bytes: detail3ConflictHtml }],
    ],
  ]);
  const worker = new OfflineCollectorWorker(
    store,
    new FixtureTransport(frames),
    new PrivateMediaStore(mediaRoot),
  );
  assert.equal((await worker.runOne(source.sourceId, { jobId })).status, "completed");

  const enq1 = await store.enqueuePendingDetails({ sourceId: source.sourceId, jobId, maxDetails: 10 });
  assert.deepEqual(enq1, { enqueued: 3, externalListingIds: ids });
  assert.deepEqual(await store.enqueuePendingDetails({ sourceId: source.sourceId, jobId, maxDetails: 10 }), {
    enqueued: 0,
    externalListingIds: [],
  });

  // Simulate a crashed detail worker with an expired lease and reserved dispatch budget.
  const crashedLease = await store.claimDetail(source.sourceId, 60, jobId);
  assert.equal(crashedLease.externalListingId, "397100000001");
  await store.reserve(crashedLease, "detail", 4096, "detail:397100000001");
  await db.query("UPDATE collector_detail_jobs SET lease_until=$2 WHERE id=$1", [
    crashedLease.detailTaskId,
    "2026-11-22T09:50:00Z",
  ]);

  // First runDetails recovers crashed task #1 (completes) and hits 429 Retry-After on #2 (defers + backs off).
  const pass1 = await worker.runDetails(source.sourceId, { parentJobId: jobId, maxTasks: 10 });
  assert.equal(pass1.length, 2);
  assert.deepEqual(pass1[0].listingId, "397100000001");
  assert.equal(pass1[0].status, "completed");
  assert.equal(pass1[1].listingId, "397100000002");
  assert.equal(pass1[1].status, "retry");
  assert.equal(await store.claimDetail(source.sourceId, 60, jobId), null);

  // Advance clock past 120s backoff -> #3 (available_at=10:00Z) fails with detail_attribute_conflict, #2 (10:02Z) trips source_access_refused.
  clock = "2026-11-22T10:05:00Z";
  const pass2 = await worker.runDetails(source.sourceId, { parentJobId: jobId, maxTasks: 10 });
  assert.equal(pass2.length, 2);
  assert.equal(pass2[0].listingId, "397100000003");
  assert.equal(pass2[0].status, "failed");
  assert.equal(pass2[1].listingId, "397100000002");
  assert.equal(pass2[1].status, "failed");

  const rows = (
    await db.query(
      "SELECT external_listing_id, status, failure_reason, enriched_fields FROM collector_detail_jobs WHERE source_id=$1 ORDER BY external_listing_id",
      [source.sourceId],
    )
  ).rows;
  assert.equal(rows[0].status, "completed");
  assert.deepEqual(rows[0].enriched_fields.attributesAdded.sort(), ["brand", "category", "vram_gb"]);
  assert.equal(rows[1].failure_reason, "source_access_refused");
  assert.equal(rows[2].failure_reason, "detail_attribute_conflict");

  const detailDispatches = (
    await db.query(
      "SELECT state, count(*)::int n FROM collector_dispatches WHERE source_id=$1 AND kind='detail' GROUP BY state ORDER BY state",
      [source.sourceId],
    )
  ).rows;
  assert.equal(detailDispatches.find((r) => r.state === "abandoned")?.n, 1);
  assert.equal(detailDispatches.find((r) => r.state === "settled")?.n >= 3, true);

  const health = await collectorHealth(db, source.sourceId, { now: clock });
  assert.equal(health.circuit, "open");
  assert.equal(health.details.find((d) => d.status === "completed")?.n, 1);
  assert.equal(health.details.find((d) => d.status === "failed")?.n, 2);
  const dailyHealth = await collectorHealth(db, source.sourceId, {
    now: "2026-11-23T00:00:00Z",
    dailyDays: 7,
  });
  assert.equal(dailyHealth.daily.days.at(-1).day, "2026-11-22");
  assert.equal(dailyHealth.daily.days.at(-1).detailAttempts >= 3, true);

  const ops = await transaction(db, (c) =>
    telemetry(c, new Date(clock), "collector", { days: 7, limit: 20, source: source.sourceId }),
  );
  assert.equal(ops.sections[5].key, "collector_run_evidence");
  assert.equal(ops.sections[6].key, "collector_details");
  const detailOpsIdx = Object.fromEntries(
    ops.sections[6].columns.map((col, idx) => [col, ops.sections[6].rows[0][idx]]),
  );
  assert.equal(detailOpsIdx.details_completed, 1);
  assert.equal(detailOpsIdx.details_failed, 2);
  assert.equal(detailOpsIdx.details_attempts >= 3, true);

  // Source revocation immediately blocks detail queueing.
  const revSource = await provisionFixtureSource(db, clock, { searchSummaries: true });
  const revStore = new CollectorStore(db, () => clock, { htmlProfile: cardProfile });
  const revJobId = await revStore.enqueue({
    ...revSource,
    queryHash,
    runKey: "detail-revoke-check",
    asOf: clock,
  });
  const revWorker = new OfflineCollectorWorker(
    revStore,
    new FixtureTransport(frames),
    new PrivateMediaStore(mediaRoot),
  );
  assert.equal((await revWorker.runOne(revSource.sourceId, { jobId: revJobId })).status, "completed");
  await revStore.revokeSource(revSource.sourceId, "test_revoked");
  await assert.rejects(
    revStore.enqueuePendingDetails({ sourceId: revSource.sourceId, jobId: revJobId }),
    /source_rights_unavailable/,
  );
});

test("collector-supervisor.mjs drives pages and details lanes across isolated worker subprocesses", async () => {
  const workDir = await makeRoot("soldbench-sup-details-");
  const spoolDir = join(workDir, "spool");
  const mediaRoot = join(workDir, "media");
  await mkdir(spoolDir, { recursive: true, mode: 0o700 });
  await mkdir(mediaRoot, { recursive: true, mode: 0o700 });

  const cardProfile = createEbayUsSoldCardHtmlProfile();
  const nowRow = (await db.query("SELECT clock_timestamp() t")).rows[0].t;
  const asOf = new Date(nowRow.getTime() - 60000).toISOString();
  const source = await provisionFixtureSource(db, asOf, { searchSummaries: true });
  const store = new CollectorStore(db, undefined, { htmlProfile: cardProfile });
  const query = normalizeQuery(new URLSearchParams({ q: "Seiko SKX007", limit: "5" }));
  const queryHash = collectionQueryHash(query);
  const jobId = await store.enqueue({
    ...source,
    queryHash,
    runKey: `sup-3lane-${Date.now()}`,
    asOf,
  });

  const ids = ["397200000001", "397200000002"];
  const searchHtml = Buffer.from(`<!doctype html><html><body>
    <h1 class="srp-controls__count-heading">2 results for Seiko SKX007</h1>
    <div class="srp-river-results"><ul class="srp-results">
      ${ids
        .map(
          (id, i) => `
        <li class="s-card">
          <div class="s-card__details">
            <div class="s-card__caption"><span class="su-styled-text positive">Sold Nov 21, 2026</span></div>
            <a class="s-card__link" href="https://www.ebay.com/itm/${id}"><div class="s-card__title"><span class="su-styled-text">Seiko SKX007 Diver #${i}</span></div></a>
            <span class="s-card__price">$${310 + i * 20}.00</span>
            <span class="s-card__shipping">Free shipping</span>
          </div>
        </li>`,
        )
        .join("\n")}
    </ul></div>
  </body></html>`);

  const detailHtmlFor = (id, ref) =>
    Buffer.from(`<!doctype html><html><head><link rel="canonical" href="https://www.ebay.com/itm/${id}"></head><body>
      <nav class="breadcrumbs"><a>Wristwatches</a></nav>
      <div class="ux-layout-section--itemId"><span class="ux-textspans--BOLD">${id}</span></div>
      <div data-testid="x-item-condition-atf"><span class="ux-textspans">Like New</span></div>
      <div class="ux-layout-section--itemSpecifics"><dl class="ux-labels-values">
        <dt>Watch Brand</dt><dd>Seiko</dd><dt>Reference Number</dt><dd>${ref}</dd>
      </dl></div>
      <div class="d-item-description">Supervised detail ${ref}.</div>
    </body></html>`);

  const frames = new Map([
    ["page:start", [{ status: 200, contentType: "text/html; charset=utf-8", bytes: searchHtml }]],
    [
      "detail:397200000001",
      [
        {
          status: 200,
          contentType: "text/html; charset=utf-8",
          bytes: detailHtmlFor("397200000001", "SKX007K2"),
        },
      ],
    ],
    [
      "detail:397200000002",
      [
        {
          status: 200,
          contentType: "text/html; charset=utf-8",
          bytes: detailHtmlFor("397200000002", "SKX007J1"),
        },
      ],
    ],
  ]);
  const artifact = createFixtureArtifact(
    { sourceId: source.sourceId, jobId, queryHash, asOf, htmlProfile: cardProfile },
    frames,
  );
  const artifactJson = `${JSON.stringify(artifact)}\n`;
  const loaded = loadFixtureArtifact(Buffer.from(artifactJson));
  const artifactPath = join(spoolDir, `collector-html-fixture-${jobId}.json`);
  await writeFile(`${artifactPath}.tmp`, artifactJson, { mode: 0o600, flag: "wx" });
  await rename(`${artifactPath}.tmp`, artifactPath);
  await store.bindFixtureArtifact({
    jobId,
    sourceId: source.sourceId,
    queryHash,
    asOf,
    hash: loaded.hash,
    pageHashes: loaded.pageHashes,
  });

  const supEnv = {
    ...process.env,
    COLLECTOR_DEMO_DIR: spoolDir,
    MEDIA_ROOT: mediaRoot,
  };

  // Cycle 1: supervisor completes pages lane.
  const { stdout: cycle1Out } = await execFileAsync(
    process.execPath,
    ["scripts/collector-supervisor.mjs", `--source=${source.sourceId}`, `--spool=${spoolDir}`],
    { env: supEnv, encoding: "utf8" },
  );
  const cycle1 = JSON.parse(cycle1Out);
  assert.equal(cycle1.cycles[0].lane, "pages");
  assert.equal(cycle1.cycles[0].status, "completed");

  // Enqueue pending details, then run Cycle 2: supervisor dispatches details lane via --detail-only=true.
  const enqueued = await store.enqueuePendingDetails({ sourceId: source.sourceId, jobId, maxDetails: 10 });
  assert.equal(enqueued.enqueued, 2);

  const { stdout: cycle2Out } = await execFileAsync(
    process.execPath,
    ["scripts/collector-supervisor.mjs", `--source=${source.sourceId}`, `--spool=${spoolDir}`],
    { env: supEnv, encoding: "utf8" },
  );
  const cycle2 = JSON.parse(cycle2Out);
  const detailCycle = cycle2.cycles.find((c) => c.lane === "details");
  assert.ok(detailCycle);
  assert.equal(detailCycle.claimed, true);
  assert.equal(detailCycle.detailResults.length, 2);
  assert.ok(detailCycle.detailResults.every((r) => r.status === "completed"));

  const enriched = (
    await db.query("SELECT evidence FROM listing_record_evidence WHERE source_id=$1 ORDER BY record_index", [
      source.sourceId,
    ])
  ).rows;
  assert.equal(enriched[0].evidence.attributes.category, "watches");
  assert.equal(enriched[0].evidence.attributes.reference, "SKX007K2");
  assert.equal(enriched[1].evidence.attributes.reference, "SKX007J1");
  assert.equal(enriched[0].evidence.conditionStandard, "like_new");
  assert.equal(enriched[0].evidence.description, "Supervised detail SKX007K2.");
});

test("parseEbayCorpusCsv, runEbayUsCorpusCycle and collector:ebay-daemon drive multi-category HTTP + Chrome auto fallback into REST and halt on 403", async () => {
  const realCsv = await readFile("step0/corpus.csv", "utf8");
  const csvTargets = parseEbayCorpusCsv(realCsv);
  assert.equal(csvTargets.length, 120);
  assert.equal(new Set(csvTargets.map((t) => t.group)).size, 6);

  const dir = await makeRoot("soldbench-ebay-daemon-");
  const outDir = join(dir, "out");
  const spoolDir = join(dir, "spool");
  const mediaRoot = join(dir, "media");
  const corpusJsonPath = join(dir, "corpus.json");
  await mkdir(mediaRoot, { recursive: true, mode: 0o700 });

  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "royalblue" } })
    .png()
    .toBuffer();

  const watchIds = Array.from({ length: 8 }, (_, i) => `39730000000${i}`);
  const gpuIds = Array.from({ length: 8 }, (_, i) => `39740000000${i}`);

  const origin = await startMockServer((req, res) => {
    const reqUrl = new URL(req.url, "http://127.0.0.1");
    if (reqUrl.pathname === "/images/g/watch.png" || reqUrl.pathname === "/images/g/gpu.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(png);
      return;
    }
    if (reqUrl.pathname === "/sch/i.html") {
      const nkw = reqUrl.searchParams.get("_nkw") ?? "";
      if (nkw.includes("Block403")) {
        res.writeHead(403, { "content-type": "text/html; charset=utf-8" });
        res.end(
          '<!doctype html><html><title>Error Page | eBay</title><body><div id="splashui-challenge">Blocked</div></body></html>',
        );
        return;
      }
      if (nkw.includes("Rolex Submariner")) {
        // Classic li.s-item SSR layout without reference/condition on SRP
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body>
          <div class="srp-controls__count-heading">8 results for Rolex Submariner</div>
          <div class="srp-river-results"><ul class="srp-results">
            ${watchIds
              .map(
                (id, i) => `
              <li class="s-item">
                <div class="s-item__image-wrapper"><img class="s-item__image-img" src="https://i.ebayimg.com/images/g/watch.png"></div>
                <div class="s-item__info">
                  <div class="s-item__caption"><span class="POSITIVE">Sold Nov 21, 2026</span></div>
                  <a class="s-item__link" href="https://www.ebay.com/itm/${id}"><div class="s-item__title">Rolex Submariner Watch #${i}</div></a>
                  <span class="s-item__price">$${9000 + i * 100}.00</span>
                  <span class="s-item__shipping">Free shipping</span>
                </div>
              </li>`,
              )
              .join("\n")}
          </ul></div>
        </body></html>`);
        return;
      }
      if (nkw.includes("RTX 4070 Super")) {
        const cardRows = gpuIds
          .map(
            (id, i) =>
              `<li class="s-card">` +
              `<div class="s-card__media"><img class="s-card__image" src="https://i.ebayimg.com/images/g/gpu.png"></div>` +
              `<div class="s-card__details">` +
              `<div class="s-card__caption"><span class="su-styled-text positive">Sold Nov 21, 2026</span></div>` +
              `<a class="s-card__link" href="https://www.ebay.com/itm/${id}"><div class="s-card__title"><span class="su-styled-text">NVIDIA RTX 4070 Super #${i}</span></div></a>` +
              `<span class="s-card__price">$${550 + i * 10}.00</span>` +
              `<span class="s-card__shipping">Free shipping</span>` +
              `</div></li>`,
          )
          .join("");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        if (browserBinary) {
          // Serve empty root shell until Chrome hydrates the DOM -> triggers "auto" HTTP->Chrome fallback.
          res.end(`<!doctype html><html><body><div id="app"></div><script>
            document.getElementById("app").innerHTML =
              '<h1 class="srp-controls__count-heading">8 results for RTX 4070 Super</h1>' +
              '<div class="srp-river-results"><ul class="srp-results">${cardRows}</ul></div>';
          </script></body></html>`);
        } else {
          res.end(`<!doctype html><html><body>
            <h1 class="srp-controls__count-heading">8 results for RTX 4070 Super</h1>
            <div class="srp-river-results"><ul class="srp-results">${cardRows}</ul></div>
          </body></html>`);
        }
        return;
      }
    }
    const itemMatch = /^\/itm\/(\d+)$/.exec(reqUrl.pathname);
    if (itemMatch?.[1]) {
      const id = itemMatch[1];
      const isWatch = watchIds.includes(id);
      const html = isWatch
        ? `<!doctype html><html><head><link rel="canonical" href="https://www.ebay.com/itm/${id}"></head><body>
            <nav class="breadcrumbs"><a>Wristwatches</a></nav>
            <div class="ux-layout-section--itemId"><span class="ux-textspans--BOLD">${id}</span></div>
            <div data-testid="x-item-condition-atf"><span class="ux-textspans">Like New</span></div>
            <div class="ux-layout-section--itemSpecifics"><dl class="ux-labels-values">
              <dt>Brand</dt><dd>Rolex</dd><dt>Reference Number</dt><dd>116610LN</dd>
            </dl></div>
            <div class="d-item-description">Submariner full kit ${id}.</div>
          </body></html>`
        : `<!doctype html><html><head><link rel="canonical" href="https://www.ebay.com/itm/${id}"></head><body>
            <nav class="breadcrumbs"><a>Graphics/Video Cards</a></nav>
            <div class="ux-layout-section--itemId"><span class="ux-textspans--BOLD">${id}</span></div>
            <div data-testid="x-item-condition-atf"><span class="ux-textspans">Like New</span></div>
            <div class="ux-layout-section--itemSpecifics"><dl class="ux-labels-values">
              <dt>Brand</dt><dd>NVIDIA</dd><dt>Memory Size</dt><dd>12 GB</dd>
            </dl></div>
            <div class="d-item-description">Hydrated RTX 4070 Super ${id}.</div>
          </body></html>`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
      res.end(gzipSync(Buffer.from(html)));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await writeFile(
    corpusJsonPath,
    JSON.stringify({
      targets: [
        {
          id: "watch-sub",
          group: "watches",
          q: "Rolex Submariner",
          category: "watches",
          brand: "Rolex",
          condition: "like_new",
          attributes: { reference: "116610LN" },
        },
        {
          id: "gpu-4070s",
          group: "gpu_hardware",
          q: "RTX 4070 Super",
          category: "gpu_hardware",
          brand: "NVIDIA",
          attributes: { vram_gb: "12" },
        },
      ],
    }),
  );

  // CLI must refuse without explicit --allow-live-fetch=true.
  await assert.rejects(
    execFileAsync(process.execPath, ["scripts/collector-ebay-daemon.mjs", `--corpus=${corpusJsonPath}`], {
      encoding: "utf8",
    }),
    /live_fetch_explicit_opt_in_required/,
  );

  const daemonEnv = {
    ...process.env,
    MEDIA_ROOT: mediaRoot,
    COLLECTOR_DEMO_DIR: spoolDir,
    ...(browserBinary ? { SOLDBENCH_BROWSER_BINARY: browserBinary } : {}),
  };

  const { stdout: daemonStdout } = await execFileAsync(
    process.execPath,
    [
      "--import",
      "./scripts/test-network.mjs",
      "scripts/collector-ebay-daemon.mjs",
      "--allow-live-fetch=true",
      `--corpus=${corpusJsonPath}`,
      `--origin=${origin}`,
      `--image-origin-override=${origin}`,
      "--allow-loopback-test-origin=true",
      "--transport=auto",
      "--min-interval-ms=0",
      "--max-details=10",
      `--out=${outDir}`,
      `--spool=${spoolDir}`,
      `--as-of=${fixed}`,
    ],
    { encoding: "utf8", env: daemonEnv },
  );
  const report = JSON.parse(daemonStdout);
  assert.equal(report.ok, true);
  assert.equal(report.completedTargets, 2);
  assert.equal(report.circuitTripped, false);
  assert.equal(report.detailsCompleted, 16);
  if (browserBinary) assert.ok(report.browserFallbacks >= 1);

  const jsonlLines = (await readFile(join(outDir, "stability-cycles.jsonl"), "utf8")).trim().split("\n");
  assert.equal(jsonlLines.length, 1);
  assert.equal(JSON.parse(jsonlLines[0]).schema, "soldbench.ebay-daemon-cycle.v1");

  // Query REST API directly against daemon-ingested watch snapshot & verify drawer/images.
  const customer = await createProductFixture(db, roots, {
    count: 1,
    prepareQuery: false,
    clockValue: fixed,
  });
  const watchParams = new URLSearchParams({
    q: "Rolex Submariner",
    category: "watches",
    brand: "Rolex",
    condition: "like_new",
    attr_reference: "116610LN",
    limit: "5",
  });
  const submit = await customer.app.request(`/v1/sold?${watchParams}`, { headers: customer.headers });
  assert.equal(submit.status, 202);
  const { query_id: qid } = (await submit.json()).data;
  assert.equal((await customer.query.workOnce("daemon-watch-query")).status, "completed");
  const claim = await customer.app.request(`/v1/sold/${qid}/claim`, {
    method: "POST",
    headers: { ...customer.headers, "Idempotency-Key": "daemon-watch-claim-1" },
  });
  assert.equal(claim.status, 200);
  const body = await claim.json();
  // 8000+? No: 9000..9700 USD -> median = 935000 cents.
  assert.equal(body.data.stats.n_price_verified, 8);
  assert.equal(body.data.stats.median_cents, 935000);

  const diag = await customer.research.diagnostics(customer.identity, qid);
  const drawer = await customer.research.detail(customer.identity, qid, diag.items[0].sale_event_id);
  assert.equal(drawer.fields.condition.value.standard, "like_new");
  assert.equal(drawer.fields.attributes.value.reference, "116610LN");
  assert.match(drawer.fields.description.value, /Submariner full kit/);

  // HTTP 403 block must trip circuit immediately and never fall back to Chrome or hit subsequent targets.
  const blockTargets = parseEbayCorpusJson(
    JSON.stringify([
      { id: "block-target", q: "Block403" },
      { id: "never-reached", q: "Rolex Submariner" },
    ]),
  );
  const haltReport = await runEbayUsCorpusCycle({
    db,
    targets: blockTargets,
    transport: "auto",
    origin,
    imageOriginOverride: origin,
    allowLoopbackTestOrigin: true,
    browserExecutablePath: browserBinary,
    minIntervalMs: 0,
    mediaRoot,
    spoolDir,
    asOf: fixed,
  });
  assert.equal(haltReport.circuitTripped, true);
  assert.equal(haltReport.stopReason, "source_access_refused");
  assert.equal(haltReport.targetsAttempted, 1);
  assert.equal(haltReport.browserFallbacks, 0);
});
