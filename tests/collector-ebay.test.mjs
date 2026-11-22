import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { brotliCompressSync, gzipSync } from "node:zlib";
import {
  auditEbayUsHtmlPage,
  buildEbayUsSoldSearchUrl,
  CollectorStore,
  createEbayUsSoldCardHtmlProfile,
  createEbayUsSoldSearchHtmlProfile,
  detectEbayUsSoldHtmlProfile,
  digest,
  EbayUsHttpTransport,
  FixtureTransport,
  mapStandardCondition,
  OfflineCollectorWorker,
  parseEbayUsCursorNumber,
  parseHtmlPage,
  provisionFixtureSource,
  TransportReadError,
} from "@soldbench/collector";
import { collectionQueryHash, normalizeQuery } from "@soldbench/core";
import { database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import sharp from "sharp";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL),
  roots = [],
  servers = [],
  fixed = "2026-11-22T09:00:00Z";

before(() => migrate(db));
after(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
  for (const root of roots) await rm(root, { recursive: true, force: true });
  await db.end();
});

async function makeRoot(prefix = "soldbench-ebay-") {
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

test("buildEbayUsSoldSearchUrl and parseEbayUsCursorNumber construct deterministic sold-only eBay US URLs", () => {
  assert.equal(parseEbayUsCursorNumber("start"), 1);
  assert.equal(parseEbayUsCursorNumber("page-3"), 3);
  for (const bad of ["", "page-0", "page-101", "random"]) {
    assert.throws(() => parseEbayUsCursorNumber(bad), /invalid_ebay_cursor/);
  }
  const q = normalizeQuery(
    new URLSearchParams({
      q: "RTX 4070 Super",
      sale_format: "auction",
      min_price_cents: "45050",
      max_price_cents: "79900",
    }),
  );
  const page1 = buildEbayUsSoldSearchUrl(q);
  assert.equal(page1.origin, "https://www.ebay.com");
  assert.equal(page1.pathname, "/sch/i.html");
  assert.equal(page1.searchParams.get("_nkw"), "RTX 4070 Super");
  assert.equal(page1.searchParams.get("LH_Sold"), "1");
  assert.equal(page1.searchParams.get("LH_Complete"), "1");
  assert.equal(page1.searchParams.get("_sop"), "13");
  assert.equal(page1.searchParams.get("_ipg"), "60");
  assert.equal(page1.searchParams.get("rt"), "nc");
  assert.equal(page1.searchParams.get("LH_Auction"), "1");
  assert.equal(page1.searchParams.get("_udlo"), "450.50");
  assert.equal(page1.searchParams.get("_udhi"), "799.00");
  assert.equal(page1.searchParams.get("_pgn"), null);

  const page2 = buildEbayUsSoldSearchUrl(q, { cursor: "page-2", itemsPerPage: 120 });
  assert.equal(page2.searchParams.get("_pgn"), "2");
  assert.equal(page2.searchParams.get("_ipg"), "120");
  assert.throws(() => buildEbayUsSoldSearchUrl(q, { origin: "https://evil.invalid" }), /invalid_ebay_origin/);
});

test("classic li.s-item parser handles ghost cards, ads, New Listing noise, strikethrough Best Offer, multi-currency, ranges, 1x/2x srcset, conditions, specifics and REWRITE_START cutoff", () => {
  assert.equal(mapStandardCondition("Pre-Owned"), null);
  assert.equal(mapStandardCondition("Open Box"), null);
  assert.equal(mapStandardCondition("Brand New"), null);
  assert.equal(mapStandardCondition("New with tags"), "new_with_tags");
  assert.equal(mapStandardCondition("Like New"), "like_new");
  assert.equal(mapStandardCondition("Good"), "good");
  assert.equal(mapStandardCondition("For parts or not working"), "defective");

  const profile = createEbayUsSoldSearchHtmlProfile();
  const binding = {
    sourceId: "00000000-0000-4000-8000-000000000010",
    queryHash: digest("classic-ebay-srp"),
    cursor: "start",
    asOf: fixed,
  };
  const html = Buffer.from(`<!doctype html><html><body>
    <h1 class="srp-controls__count-heading">1,520+ results for gpu<span class="clipped"> in computers</span></h1>
    <div class="srp-river-results">
      <ul class="srp-results">
        <li class="s-item s-item--pl-on-bottom">
          <div class="s-item__title"><span role="heading">Shop on eBay</span></div>
          <a class="s-item__link" href="https://ebay.com/itm/123456?hash=ghost">Link</a>
        </li>
        <li class="s-item s-item--sponsored">
          <div class="s-item__title"><span role="heading">Sponsored GPU</span></div>
        </li>
        <li class="s-item">
          <div class="s-item__image"><img srcset="https://i.ebayimg.com/images/g/a/s-l300.jpg 1x, https://i.ebayimg.com/images/g/a/s-l600.jpg 2x" src="https://i.ebayimg.com/images/g/a/s_1x2.gif"></div>
          <div class="s-item__info">
            <div class="s-item__caption"><span class="POSITIVE">Sold Nov 18, 2026</span></div>
            <a class="s-item__link" href="https://www.ebay.com/itm/NVIDIA-RTX-4070/395123456701?mkcid=16">
              <div class="s-item__title"><span role="heading"><span class="LIGHT_HIGHLIGHT">New Listing</span>NVIDIA RTX 4070 12GB<span class="clipped"> Opens in a new window or tab</span></span></div>
            </a>
            <div class="s-item__subtitle"><span class="SECONDARY_INFO">Pre-Owned</span></div>
            <span class="s-item__price">$520.00</span>
            <span class="s-item__shipping">+$12.50 shipping estimate</span>
            <dl class="s-item__attributes"><dt>Memory Size:</dt><dd>12 GB</dd><dt>Brand:</dt><dd>NVIDIA</dd><dt>Color:</dt><dd>Black</dd></dl>
          </div>
        </li>
        <li class="s-item">
          <div class="s-item__image"><img data-high-res-src="https://i.ebayimg.com/images/g/b/s-l960.webp" src="https://i.ebayimg.com/images/g/b/s-l64.gif"></div>
          <div class="s-item__info">
            <div class="s-item__caption"><span class="POSITIVE">Sold Nov 17, 2026</span></div>
            <a class="s-item__link" href="https://www.ebay.com/itm/395123456702"><div class="s-item__title"><span role="heading">ASUS RTX 4070 Auction</span></div></a>
            <div class="s-item__subtitle"><span class="SECONDARY_INFO">Good</span></div>
            <span class="s-item__price">$495.00</span>
            <span class="s-item__bids">18 bids</span>
            <span class="s-item__purchase-options">or Best Offer</span>
            <span class="s-item__shipping">Free local pickup</span>
          </div>
        </li>
        <li class="s-item">
          <div class="s-item__info">
            <div class="s-item__caption"><span class="POSITIVE">Sold Nov 16, 2026</span></div>
            <a class="s-item__link" href="https://www.ebay.com/itm/395123456703"><div class="s-item__title"><span role="heading">MSI RTX 4070 Offer</span></div></a>
            <div class="s-item__subtitle"><span class="SECONDARY_INFO">Open Box</span></div>
            <span class="s-item__price"><span class="STRIKETHROUGH">$580.00</span></span>
            <span class="s-item__shipping">Free 2-4 day shipping</span>
          </div>
        </li>
        <li class="s-item">
          <div class="s-item__info">
            <div class="s-item__caption"><span class="POSITIVE">Sold Nov 15, 2026</span></div>
            <a class="s-item__link" href="https://www.ebay.com/itm/395123456704"><div class="s-item__title"><span role="heading">Canada CAD Card</span></div></a>
            <span class="s-item__price">C $640.00</span>
            <span class="s-item__shipping">+C $20.00 shipping</span>
          </div>
        </li>
        <li class="s-item">
          <div class="s-item__info">
            <div class="s-item__caption"><span class="POSITIVE">Sold Nov 15, 2026</span></div>
            <a class="s-item__link" href="https://www.ebay.com/itm/395123456705"><div class="s-item__title"><span role="heading">Multi Variation Range</span></div></a>
            <span class="s-item__price">$19.99 to $49.99</span>
            <span class="s-item__shipping">+$5.00 shipping</span>
          </div>
        </li>
        <li class="srp-river-answer srp-river-answer--REWRITE_START"><span>Results matching fewer words</span></li>
        <li class="s-item">
          <div class="s-item__info">
            <div class="s-item__caption"><span class="POSITIVE">Sold Nov 10, 2026</span></div>
            <a class="s-item__link" href="https://www.ebay.com/itm/395123456799"><div class="s-item__title"><span role="heading">Low Relevance Rewritten Card</span></div></a>
            <span class="s-item__price">$10.00</span>
          </div>
        </li>
      </ul>
      <a class="pagination__next" href="https://www.ebay.com/sch/i.html?_nkw=gpu&amp;_pgn=2">Next</a>
    </div>
  </body></html>`);

  const audit = auditEbayUsHtmlPage(html, binding);
  assert.equal(audit.ok, true);
  assert.equal(audit.profileId, profile.id);
  const page = audit.page;
  assert.equal(page.records.length, 5);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(page.sourceReported, { count: 1520, unit: "listings", estimated: true });

  const [r0, r1, r2, r3, r4] = page.records;
  assert.equal(r0.title, "NVIDIA RTX 4070 12GB");
  assert.equal(r0.primaryImage.url, "https://i.ebayimg.com/images/g/a/s-l600.jpg");
  assert.equal(r0.candidate.condition, undefined);
  assert.equal(r0.recordEvidence.conditionRaw, "Pre-Owned");
  assert.equal(r0.candidate.shippingStatus, "observed");
  assert.equal(r0.candidate.shippingCents, 1250);
  assert.deepEqual(r0.recordEvidence.attributes, { vram_gb: "12", brand: "NVIDIA", colorway: "Black" });

  assert.equal(r1.primaryImage.url, "https://i.ebayimg.com/images/g/b/s-l960.webp");
  assert.equal(r1.candidate.format, "auction");
  assert.equal(r1.candidate.condition, "good");
  assert.equal(r1.candidate.shippingStatus, "unknown");
  assert.equal(r1.candidate.shippingCents, null);

  assert.equal(r2.candidate.format, "best_offer");
  assert.equal(r2.candidate.priceStatus, "displayed_only");
  assert.equal(r2.candidate.condition, undefined);
  assert.equal(r2.candidate.shippingStatus, "verified_free_shipping");

  assert.equal(r3.candidate.currency, "CAD");
  assert.equal(r3.candidate.itemCents, 64000);
  assert.equal(r3.candidate.shippingCents, 2000);

  assert.equal(r4.candidate.priceStatus, "unknown");
  assert.equal(r4.candidate.itemCents, null);
  assert.deepEqual(audit.summary.currencies, ["CAD", "USD"]);
});

test("li.s-card 2025/2026 layout auto-detects, extracts strong attributes and ingests end-to-end into REST sold stats", async () => {
  const params = new URLSearchParams({
    q: "RTX 4070",
    category: "gpu_hardware",
    brand: "NVIDIA",
    attr_vram_gb: "12",
    limit: "5",
  });
  const q = normalizeQuery(params);
  const queryHash = collectionQueryHash(q);
  const source = await provisionFixtureSource(db, fixed, { searchSummaries: true });
  const cardProfile = createEbayUsSoldCardHtmlProfile();
  const cards = Array.from({ length: 10 }, (_, i) => {
    const id = `39590000000${i}`;
    const vram = i === 9 ? "8 GB" : "12 GB";
    const price = `$${480 + i * 10}.00`;
    return `
      <li class="s-card">
        <div class="s-card__media"><a class="s-card__link" href="https://www.ebay.com/itm/${id}"><img class="s-card__image" src="https://i.ebayimg.com/images/g/card-${i}/s-l500.png"></a></div>
        <div class="s-card__details">
          <div class="s-card__caption"><span class="su-styled-text positive default">Sold Nov 19, 2026</span></div>
          <a class="s-card__link" href="https://www.ebay.com/itm/RTX-4070-${i}/${id}?hash=dup">
            <div class="s-card__title"><span class="su-styled-text">NVIDIA RTX 4070 Card ${i}</span></div>
          </a>
          <div class="s-card__subtitle"><span class="su-styled-text secondary default">Good</span></div>
          <span class="s-card__price">${price}</span>
          ${i === 8 ? '<span class="s-card__purchase-options">Best offer accepted</span>' : ""}
          <span class="s-card__shipping">Free shipping</span>
          <span class="s-card__attribute-text">Category: gpu_hardware</span>
          <span class="s-card__attribute-text">Brand: NVIDIA</span>
          <span class="s-card__attribute-text">Memory Size: ${vram}</span>
        </div>
      </li>`;
  }).join("\n");
  const rawHtml = Buffer.from(`<!doctype html><html><body>
    <h1 class="srp-controls__count-heading">42 results for RTX 4070</h1>
    <div class="srp-river-results"><ul class="srp-results">${cards}</ul></div>
  </body></html>`);

  assert.equal(detectEbayUsSoldHtmlProfile(rawHtml).id, cardProfile.id);
  const store = new CollectorStore(db, () => fixed, { htmlProfile: cardProfile });
  const jobId = await store.enqueue({ ...source, queryHash, runKey: "ebay-scard-ingest", asOf: fixed });
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "navy" } })
    .png()
    .toBuffer();
  const frames = new Map([
    ["page:start", [{ status: 200, contentType: "text/html; charset=utf-8", bytes: rawHtml }]],
    ...Array.from({ length: 10 }, (_, i) => [
      `image:https://i.ebayimg.com/images/g/card-${i}/s-l500.png`,
      [{ status: 200, contentType: "image/png", bytes: png }],
    ]),
  ]);
  const media = new PrivateMediaStore(await makeRoot("soldbench-ebay-card-"));
  const worker = new OfflineCollectorWorker(store, new FixtureTransport(frames), media);
  assert.equal((await worker.runOne(source.sourceId, { jobId })).status, "completed");

  const customer = await createProductFixture(db, roots, {
    count: 1,
    prepareQuery: false,
    clockValue: fixed,
  });
  const submit = await customer.app.request(`/v1/sold?${params}`, { headers: customer.headers });
  assert.equal(submit.status, 202);
  const { query_id: qid } = (await submit.json()).data;
  assert.equal((await customer.query.workOnce("ebay-scard-query")).status, "completed");
  const claim = await customer.app.request(`/v1/sold/${qid}/claim`, {
    method: "POST",
    headers: { ...customer.headers, "Idempotency-Key": "ebay-scard-claim-1" },
  });
  assert.equal(claim.status, 200);
  const { data } = await claim.json();
  assert.equal(data.stats.n_observed, 10);
  assert.equal(data.stats.n_price_verified, 8);
  assert.equal(data.stats.median_cents, 51500);
  const diagnostics = await customer.research.diagnostics(customer.identity, qid);
  const mismatched = diagnostics.items.find((row) => row.title === "NVIDIA RTX 4070 Card 9");
  assert.equal(mismatched.primary_exclusion_reason, "hard_attribute_mismatch");
  assert.equal(mismatched.include_in_price_stats, false);
});

test("envelope mode accepts realistic >1.5 MiB and >15,000-node HTML while root_attributes still enforces 1 MiB and 12,000 nodes", async () => {
  const paddingScript = `<script>var payload = "${"x".repeat(1600000)}";</script>`;
  const hiddenSvgs = Array.from({ length: 16000 }, () => "<svg></svg>").join("");
  const largeEnvelope = Buffer.from(`<!doctype html><html><head>${paddingScript}</head><body>
    ${hiddenSvgs}
    <div class="srp-river-results"><ul class="srp-results">
      <li class="s-item">
        <div class="s-item__info">
          <div class="s-item__caption"><span class="POSITIVE">Sold Nov 20, 2026</span></div>
          <a class="s-item__link" href="https://www.ebay.com/itm/395199999901"><div class="s-item__title"><span role="heading">Large Page Console</span></div></a>
          <span class="s-item__price">$199.00</span>
          <span class="s-item__shipping">Free shipping</span>
        </div>
      </li>
    </ul></div>
  </body></html>`);
  assert.ok(largeEnvelope.byteLength > 1.5 * 1024 * 1024);

  const ebayProfile = createEbayUsSoldSearchHtmlProfile();
  const source = await provisionFixtureSource(db, fixed);
  const store = new CollectorStore(db, () => fixed, { htmlProfile: ebayProfile });
  const queryHash = collectionQueryHash(normalizeQuery(new URLSearchParams({ q: "Large Page Console" })));
  const jobId = await store.enqueue({ ...source, queryHash, runKey: "large-envelope", asOf: fixed });
  const worker = new OfflineCollectorWorker(
    store,
    new FixtureTransport(
      new Map([
        ["page:start", [{ status: 200, contentType: "text/html; charset=utf-8", bytes: largeEnvelope }]],
      ]),
    ),
    new PrivateMediaStore(await makeRoot("soldbench-ebay-large-")),
  );
  assert.equal((await worker.runOne(source.sourceId, { jobId })).status, "completed");

  const rootProfile = JSON.parse(
    await readFile(new URL("./fixtures/html/profile.json", import.meta.url), "utf8"),
  );
  const template = await readFile(new URL("./fixtures/html/search.html", import.meta.url), "utf8");
  const rootBinding = {
    sourceId: source.sourceId,
    queryHash,
    cursor: "start",
    asOf: fixed,
  };
  const boundTemplate = template.replaceAll("SOURCE_ID", source.sourceId).replaceAll("QUERY_HASH", queryHash);
  const overBytesRoot = Buffer.from(boundTemplate.replace("</head>", `${paddingScript}</head>`));
  assert.throws(() => parseHtmlPage(overBytesRoot, rootBinding, rootProfile), /html_page_too_large/);
  const overNodesRoot = Buffer.from(
    boundTemplate.replace("</body>", `${"<span></span>".repeat(12500)}</body>`),
  );
  assert.throws(() => parseHtmlPage(overNodesRoot, rootBinding, rootProfile), /html_node_budget_exceeded/);
});

test("eBay splashui/Pardon Our Interruption triggers circuit breaker without false-positiving on matching product titles", async () => {
  const ebayProfile = createEbayUsSoldSearchHtmlProfile();
  for (const challengeBody of [
    `<html><head><title>Pardon Our Interruption...</title></head><body><h1>Checking your browser before you access eBay</h1></body></html>`,
    `<html><body><div id="splashui-challenge"><form action="/splashui/challenge?ap=1"></form></div></body></html>`,
  ]) {
    const source = await provisionFixtureSource(db, fixed);
    const store = new CollectorStore(db, () => fixed, { htmlProfile: ebayProfile });
    const jobId = await store.enqueue({
      ...source,
      queryHash: digest(`challenge:${challengeBody}`),
      runKey: `challenge-${Math.random()}`,
      asOf: fixed,
    });
    const worker = new OfflineCollectorWorker(
      store,
      new FixtureTransport(
        new Map([
          [
            "page:start",
            [{ status: 200, contentType: "text/html; charset=utf-8", bytes: Buffer.from(challengeBody) }],
          ],
        ]),
      ),
      new PrivateMediaStore(await makeRoot("soldbench-ebay-challenge-")),
    );
    assert.equal((await worker.runOne(source.sourceId, { jobId })).status, "failed");
    assert.equal((await store.view(jobId)).error_code, "source_access_refused");
  }

  const benignSource = await provisionFixtureSource(db, fixed);
  const benignStore = new CollectorStore(db, () => fixed, { htmlProfile: ebayProfile });
  const benignJobId = await benignStore.enqueue({
    ...benignSource,
    queryHash: digest("benign-pardon"),
    runKey: "benign-pardon",
    asOf: fixed,
  });
  const benignHtml =
    Buffer.from(`<!doctype html><html><head><title>pardon our interruption vinyl | eBay</title></head><body>
    <div class="srp-river-results"><ul class="srp-results">
      <li class="s-item">
        <div class="s-item__info">
          <div class="s-item__caption"><span class="POSITIVE">Sold Nov 19, 2026</span></div>
          <a class="s-item__link" href="https://www.ebay.com/itm/395100000011"><div class="s-item__title"><span role="heading">Pardon Our Interruption Limited Vinyl LP</span></div></a>
          <span class="s-item__price">$29.99</span>
        </div>
      </li>
    </ul></div>
  </body></html>`);
  const benignWorker = new OfflineCollectorWorker(
    benignStore,
    new FixtureTransport(
      new Map([
        ["page:start", [{ status: 200, contentType: "text/html; charset=utf-8", bytes: benignHtml }]],
      ]),
    ),
    new PrivateMediaStore(await makeRoot("soldbench-ebay-benign-")),
  );
  assert.equal(
    (await benignWorker.runOne(benignSource.sourceId, { jobId: benignJobId })).status,
    "completed",
  );
});

test("EbayUsHttpTransport enforces origin allowlists, bounded gzip/br decompression, zip-bomb defense, pacing, Retry-After and challenge redirect handling", async () => {
  const query = normalizeQuery(new URLSearchParams({ q: "Game Boy Color" }));
  assert.throws(
    () => new EbayUsHttpTransport({ query, origin: "http://127.0.0.1:8080" }),
    /ebay_origin_not_allowed/,
  );
  assert.throws(
    () => new EbayUsHttpTransport({ query, origin: "https://example.invalid" }),
    /ebay_origin_not_allowed/,
  );

  const sleepCalls = [];
  let nowMs = 1_700_000_000_000;
  let hops = 0;
  const origin = await startMockServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.url.includes("zipbomb")) {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      res.end(gzipSync(Buffer.alloc(4096, 65)));
      return;
    }
    if (req.url.includes("rate")) {
      res.writeHead(429, { "content-type": "text/html", "retry-after": "7" });
      res.end("slow down");
      return;
    }
    if (req.url.includes("challenge-redir")) {
      res.writeHead(302, { location: "https://www.ebay.com/splashui/challenge?ap=1" });
      res.end();
      return;
    }
    if (req.url.includes("ext-redir")) {
      res.writeHead(302, { location: "https://evil.invalid/steal" });
      res.end();
      return;
    }
    if (url.searchParams.get("_pgn") === "2") {
      res.writeHead(302, { location: "/sch/i.html?_nkw=redirected" });
      res.end();
      return;
    }
    if (url.searchParams.get("_nkw") === "redirected") {
      hops++;
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "br" });
      res.end(brotliCompressSync(Buffer.from("<html>redirect-ok</html>")));
      return;
    }
    if (req.url.startsWith("/images/")) {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from("png-bytes"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
    res.end(gzipSync(Buffer.from("<html>gzip-ok</html>")));
  });

  const transport = new EbayUsHttpTransport({
    query,
    origin,
    allowLoopbackTestOrigin: true,
    imageOriginOverride: origin,
    minIntervalMs: 1200,
    maxPageBytes: 2048,
    clock: () => nowMs,
    sleep: async (ms) => {
      sleepCalls.push(ms);
      nowMs += ms;
    },
  });

  const first = await transport.read("page:start");
  assert.equal(first.status, 200);
  assert.equal(Buffer.from(first.bytes).toString(), "<html>gzip-ok</html>");
  assert.deepEqual(sleepCalls, []);

  nowMs += 200;
  const second = await transport.read("page:page-2");
  assert.equal(second.status, 200);
  assert.equal(Buffer.from(second.bytes).toString(), "<html>redirect-ok</html>");
  assert.equal(hops, 1);
  assert.deepEqual(sleepCalls, [1000]);

  const img = await transport.read("image:https://i.ebayimg.com/images/test.png");
  assert.equal(img.status, 200);
  assert.equal(Buffer.from(img.bytes).toString(), "png-bytes");

  const zipBomb = new EbayUsHttpTransport({
    query: normalizeQuery(new URLSearchParams({ q: "zipbomb" })),
    origin,
    allowLoopbackTestOrigin: true,
    minIntervalMs: 0,
    maxPageBytes: 512,
  });
  await assert.rejects(
    zipBomb.read("page:start"),
    (err) => err instanceof TransportReadError && err.message === "response_exceeds_budget",
  );

  const limited = new EbayUsHttpTransport({
    query: normalizeQuery(new URLSearchParams({ q: "rate" })),
    origin,
    allowLoopbackTestOrigin: true,
    minIntervalMs: 0,
  });
  const r429 = await limited.read("page:start");
  assert.equal(r429.status, 429);
  assert.equal(r429.retryAfterSeconds, 7);

  const challenged = new EbayUsHttpTransport({
    query: normalizeQuery(new URLSearchParams({ q: "challenge-redir" })),
    origin,
    allowLoopbackTestOrigin: true,
    minIntervalMs: 0,
  });
  const cRes = await challenged.read("page:start");
  assert.equal(cRes.status, 403);
  assert.equal(Buffer.from(cRes.bytes).toString(), "ebay_challenge_redirect");

  const external = new EbayUsHttpTransport({
    query: normalizeQuery(new URLSearchParams({ q: "ext-redir" })),
    origin,
    allowLoopbackTestOrigin: true,
    minIntervalMs: 0,
  });
  await assert.rejects(external.read("page:start"), /http_redirect_rejected/);
});

test("collector-ebay-intake CLI inspects and ingests raw multi-page eBay HTML with local PG query stats while refusing unopted live fetch", async () => {
  const dir = await makeRoot("soldbench-ebay-cli-");
  const imagesDir = join(dir, "images");
  const spoolDir = join(dir, "spool");
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "teal" } })
    .png()
    .toBuffer();

  const makePage = (offset, nextHref) =>
    `<!doctype html><html><body>
      ${offset === 0 ? '<h1 class="srp-controls__count-heading">150+ results for Steam Deck</h1>' : ""}
      <div class="srp-river-results"><ul class="srp-results">
        ${Array.from({ length: 5 }, (_, j) => {
          const i = offset + j;
          return `
            <li class="s-item">
              <div class="s-item__image"><img class="s-item__image-img" src="https://i.ebayimg.com/images/g/sd-${i}/s-l500.png"></div>
              <div class="s-item__info">
                <div class="s-item__caption"><span class="POSITIVE">Sold Nov ${15 + j}, 2026</span></div>
                <a class="s-item__link" href="https://www.ebay.com/itm/39600000000${i}"><div class="s-item__title"><span role="heading">Steam Deck OLED ${i}</span></div></a>
                <span class="s-item__price">$${420 + i * 10}.00</span>
                <span class="s-item__shipping">Free shipping</span>
              </div>
            </li>`;
        }).join("\n")}
      </ul>${nextHref ? `<a class="pagination__next" href="${nextHref}">Next</a>` : ""}</div>
    </body></html>`;

  const p1 = join(dir, "page1.html");
  const p2 = join(dir, "page2.html");
  await writeFile(p1, makePage(0, "https://www.ebay.com/sch/i.html?_nkw=Steam+Deck&_pgn=2"));
  // Simulate capped multi-page capture where page 2 still advertises page 3.
  await writeFile(p2, makePage(5, "https://www.ebay.com/sch/i.html?_nkw=Steam+Deck&_pgn=3"));

  await rm(imagesDir, { recursive: true, force: true });
  execFileSync("mkdir", ["-p", imagesDir]);
  for (let i = 0; i < 10; i++) await writeFile(join(imagesDir, `39600000000${i}.png`), png);

  const inspectOut = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "./scripts/test-network.mjs",
        "scripts/collector-ebay-intake.mjs",
        "--mode=inspect",
        "--q=Steam Deck",
        `--page=${p1}`,
        `--page=${p2}`,
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(inspectOut.ok, true);
  assert.equal(inspectOut.externalNetworkRequests, 0);
  assert.equal(inspectOut.pageCount, 2);
  assert.equal(inspectOut.truncatedPagination, true);
  assert.equal(inspectOut.nextCursor, "page-3");
  assert.equal(inspectOut.stats.n_observed, 10);
  assert.equal(inspectOut.stats.n_price_verified, 10);
  assert.equal(inspectOut.stats.median_cents, 46500);

  const ingestOut = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "./scripts/test-network.mjs",
        "scripts/collector-ebay-intake.mjs",
        "--mode=ingest",
        "--q=Steam Deck",
        `--page=${p1}`,
        `--page=${p2}`,
        `--images-dir=${imagesDir}`,
        `--spool=${spoolDir}`,
        `--as-of=${fixed}`,
      ],
      { encoding: "utf8", env: { ...process.env, COLLECTOR_DEMO_DIR: spoolDir } },
    ),
  );
  assert.equal(ingestOut.ok, true);
  assert.equal(ingestOut.status, "completed");
  assert.equal(ingestOut.pageCount, 2);
  assert.equal(ingestOut.truncatedPagination, true);
  assert.equal(ingestOut.nextCursor, "page-3");
  assert.equal(ingestOut.recordEvidenceCount, 10);
  assert.equal(ingestOut.availablePrimaryImages, 10);
  assert.equal(ingestOut.stats.median_cents, 46500);
  assert.equal(ingestOut.externalNetworkRequests, 0);

  const customer = await createProductFixture(db, roots, {
    count: 1,
    prepareQuery: false,
    clockValue: fixed,
  });
  const submit = await customer.app.request(`/v1/sold?q=${encodeURIComponent("Steam Deck")}&limit=5`, {
    headers: customer.headers,
  });
  assert.equal(submit.status, 202);
  const { query_id: qid } = (await submit.json()).data;
  assert.equal((await customer.query.workOnce("ebay-cli-ingest-query")).status, "completed");
  const claim = await customer.app.request(`/v1/sold/${qid}/claim`, {
    method: "POST",
    headers: { ...customer.headers, "Idempotency-Key": "ebay-cli-ingest-claim" },
  });
  assert.equal(claim.status, 200);
  const claimedBody = await claim.json();
  assert.equal(claimedBody.data.stats.n_observed, 10);
  assert.equal(claimedBody.data.stats.median_cents, 46500);

  let unoptedRejected = false;
  try {
    execFileSync(
      process.execPath,
      [
        "--import",
        "./scripts/test-network.mjs",
        "scripts/collector-ebay-intake.mjs",
        "--mode=fetch",
        "--q=Steam Deck",
        `--out=${join(dir, "fetch-out")}`,
      ],
      { encoding: "utf8", stdio: "pipe" },
    );
  } catch (error) {
    assert.match(String(error.stderr), /live_fetch_explicit_opt_in_required/);
    unoptedRejected = true;
  }
  assert.equal(unoptedRejected, true);
});
