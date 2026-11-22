import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  CollectorStore,
  createEbayUsSoldCardHtmlProfile,
  EbayUsBrowserTransport,
  EbayUsHttpTransport,
  FixtureTransport,
  hasEbayDetailAccessBlock,
  OfflineCollectorWorker,
  parseEbayUsItemDetailHtml,
  parseHtmlPage,
  provisionFixtureSource,
  TransportReadError,
} from "@soldbench/collector";
import { collectionQueryHash, normalizeQuery } from "@soldbench/core";
import { database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import sharp from "sharp";
import { createProductFixture } from "./helpers/product.mjs";

const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browserBinary = process.env.SOLDBENCH_BROWSER_BINARY ?? (existsSync(macChrome) ? macChrome : undefined);

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

async function makeRoot(prefix = "soldbench-ebay-detail-") {
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

test("parseEbayUsItemDetailHtml extracts structured Item Specifics, categories and sanitized detail notes across all 6 launch categories", () => {
  const cases = [
    {
      listingId: "395100000001",
      crumb: "CCG Individual Cards",
      body: `<dl class="ux-labels-values">
        <dt>Card Name</dt><dd>Charizard</dd>
        <dt>Professional Grader</dt><dd>PSA</dd>
        <dt>Grade</dt><dd>9</dd>
        <dt>Card Number</dt><dd>4/102</dd>
        <dt>Set</dt><dd>Base Set</dd>
        <dt>Language</dt><dd>English</dd>
      </dl>`,
      expectedCategory: "cards_graded",
      expectedAttrs: {
        category: "cards_graded",
        model: "Charizard",
        grading_company: "PSA",
        grade: "9",
        card_number: "4/102",
        set: "Base Set",
        language: "English",
      },
    },
    {
      listingId: "395100000002",
      crumb: "Graphics/Video Cards",
      body: `<div class="ux-labels-values"><span class="ux-labels-values__labels">Brand<span class="clipped">:</span></span><span class="ux-labels-values__values">NVIDIA</span></div>
        <div class="ux-labels-values"><span class="ux-labels-values__labels">Chipset/GPU Model</span><span class="ux-labels-values__values">RTX 4070</span></div>
        <div class="ux-labels-values"><span class="ux-labels-values__labels">Memory Size</span><span class="ux-labels-values__values">12 GB</span></div>
        <div class="ux-labels-values"><span class="ux-labels-values__labels">Variant</span><span class="ux-labels-values__values">Founders Edition</span></div>`,
      expectedCategory: "gpu_hardware",
      expectedAttrs: {
        category: "gpu_hardware",
        brand: "NVIDIA",
        chipset: "RTX 4070",
        vram_gb: "12",
        variant: "Founders Edition",
      },
    },
    {
      listingId: "395100000003",
      crumb: "Athletic Shoes",
      body: `<div class="ux-labels-values"><span class="ux-labels-values__labels">Brand</span><span class="ux-labels-values__values">Nike</span></div>
        <div class="ux-labels-values"><span class="ux-labels-values__labels">Model</span><span class="ux-labels-values__values">Dunk Low</span></div>
        <div class="ux-labels-values"><span class="ux-labels-values__labels">US Shoe Size</span><span class="ux-labels-values__values">10</span></div>
        <div class="ux-labels-values"><span class="ux-labels-values__labels">Colorway</span><span class="ux-labels-values__values">Black/White</span></div>`,
      expectedCategory: "sneakers",
      expectedAttrs: {
        category: "sneakers",
        brand: "Nike",
        model: "Dunk Low",
        size: "10",
        colorway: "Black/White",
      },
    },
    {
      listingId: "395100000004",
      crumb: "Wristwatches",
      body: `<dl class="ux-labels-values">
        <dt>Watch Brand</dt><dd>Rolex</dd>
        <dt>Reference Number</dt><dd>126610LN</dd>
        <dt>Year Manufactured</dt><dd>2022</dd>
        <dt>With Original Box/Packaging</dt><dd>Yes</dd>
        <dt>With Papers</dt><dd>Yes</dd>
      </dl>`,
      expectedCategory: "watches",
      expectedAttrs: {
        category: "watches",
        brand: "Rolex",
        reference: "126610LN",
        year: "2022",
        box: "Yes",
        papers: "Yes",
      },
    },
    {
      listingId: "395100000005",
      crumb: "Video Games &amp; Consoles",
      legacyTable: true,
      body: `<tr><td class="attrLabels">Brand</td><td>Nintendo</td><td class="attrLabels">Platform</td><td>Nintendo Switch</td></tr>
        <tr><td class="attrLabels">Region Code</td><td>NTSC-U/C</td><td class="attrLabels">Completeness</td><td>CIB</td></tr>`,
      expectedCategory: "video_games",
      expectedAttrs: {
        category: "video_games",
        brand: "Nintendo",
        platform: "Nintendo Switch",
        region: "NTSC-U/C",
        completeness: "CIB",
      },
    },
    {
      listingId: "395100000006",
      crumb: "Collectibles",
      body: `<dl class="ux-labels-values">
        <dt>Series</dt><dd>Star Wars UCS</dd>
        <dt>Number</dt><dd>75192</dd>
        <dt>Completeness</dt><dd>Sealed</dd>
      </dl>`,
      expectedCategory: "collectibles",
      expectedAttrs: {
        category: "collectibles",
        series: "Star Wars UCS",
        number: "75192",
        completeness: "Sealed",
      },
    },
  ];

  for (const c of cases) {
    const html = Buffer.from(`<!doctype html><html><head>
      <link rel="canonical" href="https://www.ebay.com/itm/Item-Slug/${c.listingId}?hash=ignored">
    </head><body>
      <nav class="breadcrumbs"><a>Home</a><a>${c.crumb}</a></nav>
      <div class="x-item-title"><h1>Listing ${c.listingId}</h1></div>
      <div data-testid="x-item-condition-atf"><span class="ux-textspans" data-condition-id="3000">Good<span class="clipped"> condition</span></span></div>
      <div class="x-item-condition-desc"><span class="ux-textspans">Minor corner wear.<script>alert(1)</script></span></div>
      <div class="ux-layout-section--itemId"><span class="ux-textspans--BOLD">${c.listingId}</span></div>
      ${
        c.legacyTable
          ? `<div class="itemAttr"><table>${c.body}</table></div>`
          : `<div class="ux-layout-section--itemSpecifics">${c.body}</div>`
      }
      <div class="d-item-description">Authentic item verified.<script>fetch('https://evil.invalid')</script></div>
      <div class="d-statusmessage">This listing was sold</div>
    </body></html>`);

    const parsed = parseEbayUsItemDetailHtml(html, { listingId: c.listingId });
    assert.equal(parsed.listingId, c.listingId);
    assert.equal(parsed.canonicalUrl, `https://www.ebay.com/itm/${c.listingId}`);
    assert.equal(parsed.category, c.expectedCategory);
    assert.deepEqual(parsed.attributes, c.expectedAttrs);
    assert.equal(parsed.conditionRaw, "Good");
    assert.equal(parsed.conditionStandard, "good");
    assert.equal(parsed.conditionId, "3000");
    assert.equal(parsed.defects, "Minor corner wear.");
    assert.equal(parsed.description, "Authentic item verified.");
    assert.equal(parsed.soldStatus, "sold");
    assert.equal(parsed.bestOfferAccepted, false);
  }

  // Ungraded card must never be misclassified as cards_graded.
  const ungradedCard = Buffer.from(`<!doctype html><html><head>
    <link rel="canonical" href="https://www.ebay.com/itm/395100000099">
  </head><body>
    <nav class="breadcrumbs"><a>Home</a><a>CCG Individual Cards</a></nav>
    <div class="ux-layout-section--itemSpecifics"><dl class="ux-labels-values"><dt>Card Name</dt><dd>Charizard</dd></dl></div>
  </body></html>`);
  const parsedUngraded = parseEbayUsItemDetailHtml(ungradedCard, { listingId: "395100000099" });
  assert.equal(parsedUngraded.category, null);
  assert.equal(parsedUngraded.attributes.category, undefined);

  // Listing ID mismatch rejects fail-closed.
  assert.throws(
    () => parseEbayUsItemDetailHtml(ungradedCard, { listingId: "395100000098" }),
    /detail_listing_id_mismatch/,
  );

  // Challenge page triggers access block.
  const challengeDetail = Buffer.from(
    `<!doctype html><html><head><title>Pardon Our Interruption...</title></head><body><div id="splashui-challenge"></div></body></html>`,
  );
  assert.equal(hasEbayDetailAccessBlock(challengeDetail), true);
});

test("real search-to-detail enrichment closes missing strong-attribute gaps and drives accurate REST comps, research drawer, exports and revocation", async () => {
  const params = new URLSearchParams({
    q: "Charizard Base Set",
    category: "cards_graded",
    attr_grading_company: "PSA",
    attr_grade: "9",
    limit: "5",
  });
  const q = normalizeQuery(params);
  const queryHash = collectionQueryHash(q);
  const cardProfile = createEbayUsSoldCardHtmlProfile();
  const source = await provisionFixtureSource(db, fixed, { searchSummaries: true });
  const store = new CollectorStore(db, () => fixed, { htmlProfile: cardProfile });
  const jobId = await store.enqueue({
    ...source,
    queryHash,
    runKey: "search-then-detail-charizard",
    asOf: fixed,
  });

  // 10 realistic s-card search results WITHOUT Item Specifics on the search page itself.
  const prices = [31000, 32000, 33000, 34000, 36000, 37000, 38000, 39000, 45000, 29000];
  const cardsHtml = Array.from({ length: 10 }, (_, i) => {
    const id = `39580000000${i}`;
    return `
      <li class="s-card">
        <div class="s-card__media"><a class="s-card__link" href="https://www.ebay.com/itm/${id}"><img class="s-card__image" src="https://i.ebayimg.com/images/g/ch-${i}/s-l500.png"></a></div>
        <div class="s-card__details">
          <div class="s-card__caption"><span class="su-styled-text positive default">Sold Nov 20, 2026</span></div>
          <a class="s-card__link" href="https://www.ebay.com/itm/Charizard-${i}/${id}?hash=s${i}">
            <div class="s-card__title"><span class="su-styled-text">Charizard Base Set Holo #${i}</span></div>
          </a>
          <span class="s-card__price">${i === 8 ? '<span class="STRIKETHROUGH">$450.00</span>' : `$${(prices[i] / 100).toFixed(2)}`}</span>
          ${i === 8 ? '<span class="s-card__purchase-options">Best offer accepted</span>' : ""}
          <span class="s-card__shipping">Free shipping</span>
        </div>
      </li>`;
  }).join("\n");
  const searchHtml = Buffer.from(`<!doctype html><html><body>
    <h1 class="srp-controls__count-heading">120+ results for Charizard Base Set</h1>
    <div class="srp-river-results"><ul class="srp-results">${cardsHtml}</ul></div>
  </body></html>`);

  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "orange" } })
    .png()
    .toBuffer();
  const frames = new Map([
    ["page:start", [{ status: 200, contentType: "text/html; charset=utf-8", bytes: searchHtml }]],
    ...Array.from({ length: 10 }, (_, i) => [
      `image:https://i.ebayimg.com/images/g/ch-${i}/s-l500.png`,
      [{ status: 200, contentType: "image/png", bytes: png }],
    ]),
  ]);
  const worker = new OfflineCollectorWorker(
    store,
    new FixtureTransport(frames),
    new PrivateMediaStore(await makeRoot("soldbench-charizard-")),
  );
  assert.equal((await worker.runOne(source.sourceId, { jobId })).status, "completed");

  // Step A: Before detail enrichment, strong-attribute query MUST return 0 verified samples (never guess title).
  const customer = await createProductFixture(db, roots, {
    count: 1,
    prepareQuery: false,
    clockValue: fixed,
  });
  const preRes = await customer.app.request(`/v1/sold?${params}`, { headers: customer.headers });
  assert.equal(preRes.status, 202);
  const { query_id: preQueryId } = (await preRes.json()).data;
  assert.equal((await customer.query.workOnce("pre-detail-check")).status, "completed");
  const preRead = await customer.app.request(`/v1/sold/${preQueryId}`, { headers: customer.headers });
  assert.equal(preRead.status, 200);
  const preBody = await preRead.json();
  assert.equal(preBody.data.stats.n_observed, 10);
  assert.equal(preBody.data.stats.n_price_verified, 0);
  assert.equal(preBody.data.stats.median_cents, null);
  assert.equal(preBody.meta.credits_charged, 0);

  // Step B: Enrich each record from its real /itm/<id> detail HTML (0..7 = PSA 9, 8 = PSA 9 Best Offer, 9 = PSA 8).
  for (let i = 0; i < 10; i++) {
    const id = `39580000000${i}`;
    const grade = i === 9 ? "8" : "9";
    const detailHtml = Buffer.from(`<!doctype html><html><head>
      <link rel="canonical" href="https://www.ebay.com/itm/${id}">
    </head><body>
      <nav class="breadcrumbs"><a>Collectibles</a><a>CCG Individual Cards</a></nav>
      <div class="ux-layout-section--itemId"><span class="ux-textspans--BOLD">${id}</span></div>
      <div data-testid="x-item-condition-atf"><span class="ux-textspans">Like New</span></div>
      <div class="x-item-condition-desc"><span class="ux-textspans">Light holo hairline on back #${i}.</span></div>
      <div class="ux-layout-section--itemSpecifics">
        <dl class="ux-labels-values">
          <dt>Card Name</dt><dd>Charizard</dd>
          <dt>Professional Grader</dt><dd>PSA</dd>
          <dt>Grade</dt><dd>${grade}</dd>
        </dl>
      </div>
      <div class="d-item-description">PSA slabbed Charizard ${i} genuine case.</div>
    </body></html>`);
    const parsedDetail = parseEbayUsItemDetailHtml(detailHtml, { listingId: id });
    const enrichResult = await store.enrichRecordEvidence({
      sourceId: source.sourceId,
      jobId,
      listingId: id,
      detail: parsedDetail,
    });
    assert.equal(enrichResult.updated, 1);
  }

  // Conflicting enrichment must fail closed rather than silently overwrite.
  await assert.rejects(
    store.enrichRecordEvidence({
      sourceId: source.sourceId,
      jobId,
      listingId: "395800000000",
      detail: {
        listingId: "395800000000",
        canonicalUrl: "https://www.ebay.com/itm/395800000000",
        category: "cards_graded",
        attributes: { category: "cards_graded", grading_company: "PSA", grade: "10" },
        conditionId: null,
        conditionRaw: null,
        conditionStandard: null,
        description: null,
        defects: null,
        primaryImageUrl: null,
        soldStatus: "sold",
        bestOfferAccepted: false,
      },
    }),
    /detail_attribute_conflict/,
  );

  // Step C: Query again with distinct presentation limit (bypasses 10-minute dedupe while sharing collectionQueryHash).
  const enrichedParams = new URLSearchParams(params);
  enrichedParams.set("limit", "6");
  const postRes = await customer.app.request(`/v1/sold?${enrichedParams}`, { headers: customer.headers });
  assert.equal(postRes.status, 202);
  const { query_id: postQueryId } = (await postRes.json()).data;
  assert.equal((await customer.query.workOnce("post-detail-check")).status, "completed");
  const claim = await customer.app.request(`/v1/sold/${postQueryId}/claim`, {
    method: "POST",
    headers: { ...customer.headers, "Idempotency-Key": "charizard-enriched-claim-1" },
  });
  assert.equal(claim.status, 200);
  const { data } = await claim.json();
  // Sorted verified PSA 9 prices (indices 0..7): 31000, 32000, 33000, 34000, 36000, 37000, 38000, 39000 -> median = 35000.
  assert.equal(data.stats.n_observed, 10);
  assert.equal(data.stats.n_comparable, 9);
  assert.equal(data.stats.n_price_verified, 8);
  assert.equal(data.stats.median_cents, 35000);
  assert.equal(data.comps.length, 6);

  const diagnostics = await customer.research.diagnostics(customer.identity, postQueryId);
  const psa8 = diagnostics.items.find((r) => r.title === "Charizard Base Set Holo #9");
  assert.equal(psa8.primary_exclusion_reason, "hard_attribute_mismatch");
  const bestOfferRow = diagnostics.items.find((r) => r.title === "Charizard Base Set Holo #8");
  assert.equal(bestOfferRow.primary_exclusion_reason, "unverified_actual_price");

  const firstIncluded = diagnostics.items.find((r) => r.include_in_price_stats);
  const drawer = await customer.research.detail(customer.identity, postQueryId, firstIncluded.sale_event_id);
  assert.equal(drawer.fields.condition.value.standard, "like_new");
  assert.equal(drawer.fields.attributes.value.grading_company, "PSA");
  assert.equal(drawer.fields.attributes.value.grade, "9");
  assert.match(drawer.fields.description.value, /PSA slabbed Charizard/);
  assert.match(drawer.fields.defects.value, /Light holo hairline/);

  const exported = await customer.research.export(customer.identity, postQueryId, {
    format: "json",
    view: "authoritative",
  });
  assert.equal(JSON.parse(exported.body).items.length, 8);

  // Revocation blocks both enrichment and research delivery immediately.
  await store.revokeSource(source.sourceId, "test_revoked");
  await assert.rejects(
    store.enrichRecordEvidence({
      sourceId: source.sourceId,
      jobId,
      listingId: "395800000000",
      detail: {
        listingId: "395800000000",
        canonicalUrl: "https://www.ebay.com/itm/395800000000",
        category: "cards_graded",
        attributes: {},
        conditionId: null,
        conditionRaw: null,
        conditionStandard: null,
        description: null,
        defects: null,
        primaryImageUrl: null,
        soldStatus: "sold",
        bestOfferAccepted: false,
      },
    }),
    /source_rights_unavailable/,
  );
  await assert.rejects(
    customer.research.detail(customer.identity, postQueryId, firstIncluded.sale_event_id),
    (err) => err?.code === "source_unavailable" || err?.code === "forbidden",
  );
});

test("EbayUsBrowserTransport captures JS-rendered DOM via real local Chrome while blocking trackers and challenge redirects", {
  skip: !browserBinary,
}, async () => {
  const query = normalizeQuery(new URLSearchParams({ q: "Hydrated GPU" }));
  assert.throws(
    () =>
      new EbayUsBrowserTransport({ query, origin: "http://127.0.0.1:8080", executablePath: browserBinary }),
    /ebay_origin_not_allowed/,
  );
  assert.throws(
    () =>
      new EbayUsBrowserTransport({ query, origin: "https://evil.invalid", executablePath: browserBinary }),
    /ebay_origin_not_allowed/,
  );

  const origin = await startMockServer((req, res) => {
    if (req.url.includes("redirect-challenge")) {
      res.writeHead(302, { location: "https://www.ebay.com/splashui/challenge?ap=1" });
      res.end();
      return;
    }
    if (req.url.startsWith("/itm/395900000077")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head>
          <link rel="canonical" href="https://www.ebay.com/itm/395900000077">
        </head><body>
          <div id="detail-root"></div>
          <script>
            fetch("https://tracker.invalid/beacon").catch(() => {});
            setTimeout(() => {
              document.getElementById("detail-root").innerHTML =
                '<nav class="breadcrumbs"><a>Video Cards</a></nav>' +
                '<div class="ux-layout-section--itemId"><span class="ux-textspans--BOLD">395900000077</span></div>' +
                '<div class="ux-layout-section--itemSpecifics"><dl class="ux-labels-values"><dt>Brand</dt><dd>NVIDIA</dd><dt>Memory Size</dt><dd>16 GB</dd></dl></div>' +
                '<div class="d-item-description">Hydrated GPU detail body</div>';
            }, 30);
          </script>
        </body></html>`);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><body>
        <div id="app"></div>
        <script>
          fetch("https://tracker.invalid/srp-beacon").catch(() => {});
          setTimeout(() => {
            document.getElementById("app").innerHTML =
              '<h1 class="srp-controls__count-heading">15 results for Hydrated GPU</h1>' +
              '<div class="srp-river-results"><ul class="srp-results">' +
              '<li class="s-card"><div class="s-card__details">' +
              '<div class="s-card__caption"><span class="su-styled-text positive">Sold Nov 21, 2026</span></div>' +
              '<a class="s-card__link" href="https://www.ebay.com/itm/395900000077"><div class="s-card__title"><span class="su-styled-text">NVIDIA RTX 4080 Super</span></div></a>' +
              '<span class="s-card__price">$950.00</span>' +
              '<span class="s-card__shipping">Free shipping</span>' +
              '</div></li></ul></div>';
          }, 30);
        </script>
      </body></html>`);
  });

  const browserTransport = new EbayUsBrowserTransport({
    query,
    executablePath: browserBinary,
    origin,
    allowLoopbackTestOrigin: true,
    minIntervalMs: 0,
    waitForSelector: "div.srp-river-results li.s-card, div.ux-layout-section--itemSpecifics",
  });

  const pageRes = await browserTransport.read("page:start");
  assert.equal(pageRes.status, 200);
  assert.ok(browserTransport.blockedRequests >= 1);
  const parsedSearch = parseHtmlPage(
    pageRes.bytes,
    {
      sourceId: "00000000-0000-4000-8000-000000000022",
      queryHash: collectionQueryHash(query),
      cursor: "start",
      asOf: fixed,
    },
    createEbayUsSoldCardHtmlProfile(),
  );
  assert.equal(parsedSearch.records.length, 1);
  assert.equal(parsedSearch.records[0].listingId, "395900000077");
  assert.equal(parsedSearch.records[0].candidate.itemCents, 95000);

  const detailRes = await browserTransport.read("detail:395900000077");
  assert.equal(detailRes.status, 200);
  const parsedDetail = parseEbayUsItemDetailHtml(detailRes.bytes, { listingId: "395900000077" });
  assert.deepEqual(parsedDetail.attributes, {
    brand: "NVIDIA",
    vram_gb: "16",
    category: "video_cards" in parsedDetail ? "" : "gpu_hardware",
  });
  assert.equal(parsedDetail.description, "Hydrated GPU detail body");

  const challengeTransport = new EbayUsBrowserTransport({
    query: normalizeQuery(new URLSearchParams({ q: "redirect-challenge" })),
    executablePath: browserBinary,
    origin,
    allowLoopbackTestOrigin: true,
    minIntervalMs: 0,
  });
  const challengeRes = await challengeTransport.read("page:start");
  assert.equal(challengeRes.status, 403);
  assert.equal(Buffer.from(challengeRes.bytes).toString(), "ebay_challenge_redirect");

  const tightBudgetTransport = new EbayUsBrowserTransport({
    query,
    executablePath: browserBinary,
    origin,
    allowLoopbackTestOrigin: true,
    minIntervalMs: 0,
    maxPageBytes: 64,
  });
  await assert.rejects(
    tightBudgetTransport.read("page:start"),
    (err) => err instanceof TransportReadError && err.message === "response_exceeds_budget",
  );
});

test("EbayUsHttpTransport detail:<listingId> and CLI collector:ebay-intake --details-dir ingest end-to-end into REST strong-attribute query", async () => {
  const dir = await makeRoot("soldbench-cli-details-");
  const detailsDir = join(dir, "details");
  const spoolDir = join(dir, "spool");
  await mkdir(detailsDir, { recursive: true });

  const searchPath = join(dir, "srp.html");
  const listingIds = Array.from({ length: 8 }, (_, i) => `39670000000${i}`);
  const searchHtml = `<!doctype html><html><body>
    <h1 class="srp-controls__count-heading">8 results for Nike Dunk Low</h1>
    <div class="srp-river-results"><ul class="srp-results">
      ${listingIds
        .map(
          (id, i) => `
          <li class="s-card">
            <div class="s-card__details">
              <div class="s-card__caption"><span class="su-styled-text positive">Sold Nov 21, 2026</span></div>
              <a class="s-card__link" href="https://www.ebay.com/itm/${id}"><div class="s-card__title"><span class="su-styled-text">Nike Dunk Low Panda ${i}</span></div></a>
              <span class="s-card__price">$${110 + i * 5}.00</span>
              <span class="s-card__shipping">Free shipping</span>
            </div>
          </li>`,
        )
        .join("\n")}
    </ul></div>
  </body></html>`;
  await writeFile(searchPath, searchHtml);

  const detailHtmlFor = (id, i) =>
    `<!doctype html><html><head><link rel="canonical" href="https://www.ebay.com/itm/${id}"></head><body>
      <nav class="breadcrumbs"><a>Clothing</a><a>Athletic Shoes</a></nav>
      <div class="ux-layout-section--itemId"><span class="ux-textspans--BOLD">${id}</span></div>
      <div data-testid="x-item-condition-atf"><span class="ux-textspans">New with box</span></div>
      <div class="ux-layout-section--itemSpecifics"><dl class="ux-labels-values">
        <dt>Brand</dt><dd>Nike</dd>
        <dt>Model</dt><dd>Dunk Low</dd>
        <dt>US Shoe Size</dt><dd>10</dd>
        <dt>Colorway</dt><dd>Black/White</dd>
      </dl></div>
      <div class="d-item-description">Deadstock Dunk Low pair #${i}</div>
    </body></html>`;

  for (const [i, id] of listingIds.entries()) {
    await writeFile(join(detailsDir, `${id}.html`), detailHtmlFor(id, i));
  }

  // Test HTTP transport fetching detail:<listingId> cleanly via gzipped loopback mock.
  const mockOrigin = await startMockServer((req, res) => {
    const m = /^\/itm\/(\d+)$/.exec(req.url);
    if (!m?.[1]) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
    res.end(gzipSync(Buffer.from(detailHtmlFor(m[1], 0))));
  });
  const httpTransport = new EbayUsHttpTransport({
    query: normalizeQuery(new URLSearchParams({ q: "Nike Dunk Low" })),
    origin: mockOrigin,
    allowLoopbackTestOrigin: true,
    minIntervalMs: 0,
  });
  const detailHttp = await httpTransport.read(`detail:${listingIds[0]}`);
  assert.equal(detailHttp.status, 200);
  const parsedHttpDetail = parseEbayUsItemDetailHtml(detailHttp.bytes, { listingId: listingIds[0] });
  assert.equal(parsedHttpDetail.attributes.category, "sneakers");
  assert.equal(parsedHttpDetail.attributes.size, "10");

  // Run CLI --mode=ingest --details-dir=...
  const cliReport = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "./scripts/test-network.mjs",
        "scripts/collector-ebay-intake.mjs",
        "--mode=ingest",
        "--q=Nike Dunk Low",
        "--category=sneakers",
        "--brand=Nike",
        "--condition=new_with_tags",
        "--attr-size=10",
        "--attr-colorway=Black/White",
        `--page=${searchPath}`,
        `--details-dir=${detailsDir}`,
        `--spool=${spoolDir}`,
        `--as-of=${fixed}`,
      ],
      { encoding: "utf8", env: { ...process.env, COLLECTOR_DEMO_DIR: spoolDir } },
    ),
  );
  assert.equal(cliReport.ok, true);
  assert.equal(cliReport.enrichedDetails, 8);
  assert.equal(cliReport.recordEvidenceCount, 8);

  // Verify the strong-attribute REST query works against the ingested + detail-enriched snapshot.
  const customer = await createProductFixture(db, roots, {
    count: 1,
    prepareQuery: false,
    clockValue: fixed,
  });
  const queryStr = new URLSearchParams({
    q: "Nike Dunk Low",
    limit: "5",
    category: "sneakers",
    brand: "Nike",
    condition: "new_with_tags",
    attr_size: "10",
    attr_colorway: "Black/White",
  });
  const submit = await customer.app.request(`/v1/sold?${queryStr}`, { headers: customer.headers });
  assert.equal(submit.status, 202);
  const { query_id: qid } = (await submit.json()).data;
  assert.equal((await customer.query.workOnce("cli-details-query")).status, "completed");
  const claim = await customer.app.request(`/v1/sold/${qid}/claim`, {
    method: "POST",
    headers: { ...customer.headers, "Idempotency-Key": "cli-details-claim-1" },
  });
  assert.equal(claim.status, 200);
  const body = await claim.json();
  // Prices: 11000..14500 -> median = (12500 + 13000) / 2 = 12750.
  assert.equal(body.data.stats.n_price_verified, 8);
  assert.equal(body.data.stats.median_cents, 12750);
  const diag = await customer.research.diagnostics(customer.identity, qid);
  const drawer = await customer.research.detail(customer.identity, qid, diag.items[0].sale_event_id);
  assert.equal(drawer.fields.attributes.value.category, "sneakers");
  assert.equal(drawer.fields.attributes.value.size, "10");
  assert.equal(drawer.fields.condition.value.standard, "new_with_tags");
  assert.match(drawer.fields.description.value, /Deadstock Dunk Low pair/);
});
