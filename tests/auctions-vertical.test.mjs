import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createApp } from "@soldbench/api";
import { provisionFixtureSource } from "@soldbench/collector";
import { auctionCanonicalHash, evaluateAuctionLots } from "@soldbench/core";
import { database, migrate } from "@soldbench/db";
import { AuctionsVerticalService } from "@soldbench/query";
import { loadConfig } from "@soldbench/shared";
import sharp from "sharp";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL);
const roots = [];

before(() => migrate(db));
after(async () => {
  await db.end();
  await Promise.all(roots.map((p) => rm(p, { recursive: true, force: true })));
});

test("AT-071 pure auction evaluator isolates hammer_only vs total_with_premium and never zero-fills unknown buyer's premium", () => {
  const lots = Array.from({ length: 8 }, (_, i) => ({
    id: `00000000-0000-0000-0000-00000000010${i}`,
    auctionHouse: "goldin_us",
    sessionCode: "GOLDIN-2026-11",
    sessionName: "November Elite",
    lotNumber: `${100 + i}`,
    eventKey: `lot-${i}`,
    title: `1986 Fleer Michael Jordan #57 Lot #${i}`,
    gradingCompany: "PSA",
    gradeValue: "10",
    certNumber: `8888000${i}`,
    currency: "USD",
    hammerMinor: 100000 + i * 10000,
    buyersPremiumStatus: i === 7 ? "unknown" : "known",
    buyersPremiumBps: i === 7 ? null : 2000,
    buyersPremiumMinor: i === 7 ? null : (100000 + i * 10000) * 0.2,
    totalWithPremiumMinor: i === 7 ? null : (100000 + i * 10000) * 1.2,
    taxIncluded: false,
    saleStatus: "sold",
    soldAt: "2026-11-16T22:00:00.000Z",
    comparable: true,
    primaryImagePath: null,
    mediaStatus: "missing",
  }));

  // Under total_with_premium, the lot with unknown buyer's premium is EXCLUDED (never zero-filled) -> 7 verified (<8 -> null median!)
  const allIn = evaluateAuctionLots(lots, { priceBasis: "total_with_premium", expectedCurrency: "USD" });
  assert.equal(allIn.excluded_counts.unknown_buyers_premium, 1);
  assert.equal(allIn.stats.n_price_verified, 7);
  assert.equal(allIn.stats.median_cents, null);
  const unknownLot = allIn.lots.find((l) => l.lot_number === "107");
  assert.equal(unknownLot?.buyers_premium_minor, null);
  assert.equal(unknownLot?.total_with_premium_minor, null);
  assert.equal(unknownLot?.included_in_stats, false);

  // Under hammer_only, all 8 have known hammer_minor -> median comes cleanly from hammer_minor only
  const hammer = evaluateAuctionLots(lots, { priceBasis: "hammer_only", expectedCurrency: "USD" });
  assert.equal(hammer.stats.n_price_verified, 8);
  assert.equal(hammer.stats.median_cents, 135000);
});

test("AT-071 PG16 auction vertical traces sessions/lots/certs, rejects mixed basis & deferred houses, serves lot images, and revokes independently", async () => {
  const x = await createProductFixture(db, roots, { count: 10, limit: 10 });
  const aucSvc = new AuctionsVerticalService(x.query);
  const app = createApp(loadConfig({}), db, { auth: x.auth, query: x.query, auctionsVertical: aucSvc });

  const housesRes = await app.request("/v1/auctions/houses");
  assert.equal(housesRes.status, 200);
  const houses = (await housesRes.json()).data;
  assert.equal(houses.find((h) => h.house_id === "goldin_us")?.selection_status, "selected_first_auction");
  assert.equal(houses.find((h) => h.house_id === "fanatics_collect")?.selection_status, "deferred_candidate");

  // Deferred candidate fails closed with 422
  assert.equal(
    (await app.request("/v1/auctions/fanatics_collect/lots?q=Jordan", { headers: x.headers })).status,
    422,
  );
  // Mixed basis request rejected with 400
  assert.equal(
    (await app.request("/v1/auctions/goldin_us/lots?q=Jordan&price_basis=mixed", { headers: x.headers }))
      .status,
    400,
  );

  // Provision independent goldin_us source & session
  const goldinSource = await provisionFixtureSource(db, x.now(), { retentionDays: 7 });
  await db.query("UPDATE sources SET marketplace='goldin_us' WHERE id=$1", [goldinSource.sourceId]);
  const session = await aucSvc.upsertSession({
    house: "goldin_us",
    sessionCode: "GOLDIN-NOV-2026",
    sessionName: "Goldin Elite Nov 2026",
    currency: "USD",
    taxSemantics: "sales_tax_excluded_at_checkout",
    closedAt: "2026-11-16T23:00:00.000Z",
  });

  const pngBytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: "gold" } })
    .png()
    .toBuffer();
  const retentionUntil = "2026-11-25T00:00:00.000Z";

  let lot0Id;
  for (let i = 0; i < 9; i++) {
    const hammerMinor = 200000 + i * 20000;
    const isUnknownPremium = i === 8;
    const inserted = await aucSvc.ingestLot({
      house: "goldin_us",
      sessionId: session.id,
      sourceId: goldinSource.sourceId,
      lotNumber: `LOT-${100 + i}`,
      eventKey: `goldin-evt-${i}`,
      queryKeyword: "1986 Fleer Jordan",
      title: `1986 Fleer Michael Jordan #57 PSA 10 Lot ${i}`,
      gradingCompany: "PSA",
      gradeValue: "10",
      certNumber: `7777000${i}`,
      currency: "USD",
      hammerMinor,
      buyersPremiumStatus: isUnknownPremium ? "unknown" : "known",
      buyersPremiumBps: isUnknownPremium ? null : 2000,
      buyersPremiumMinor: isUnknownPremium ? null : Math.round(hammerMinor * 0.2),
      saleStatus: "sold",
      soldAt: "2026-11-16T22:00:00.000Z",
      retentionUntil,
      primaryImageBytes: i === 0 ? pngBytes : null,
      primaryImageMime: i === 0 ? "image/png" : null,
    });
    if (i === 0) lot0Id = inserted.id;
  }

  // Query all-in totals (8 known + 1 unknown excluded)
  const allInRes = await app.request(
    "/v1/auctions/goldin_us/lots?q=1986+Fleer+Jordan&price_basis=total_with_premium",
    {
      headers: x.headers,
    },
  );
  assert.equal(allInRes.status, 200);
  const allInBody = (await allInRes.json()).data;
  assert.equal(allInBody.basis_policy, "strict_single_basis_no_mixing");
  assert.equal(
    allInBody.canonical_query_hash,
    auctionCanonicalHash({
      house: "goldin_us",
      q: "1986 Fleer Jordan",
      priceBasis: "total_with_premium",
      limit: 50,
    }),
  );
  assert.equal(allInBody.stats.n_price_verified, 8);
  assert.equal(allInBody.excluded_counts.unknown_buyers_premium, 1);
  // 8 hammers: 200k..340k * 1.2 -> 240k..408k -> median between 312k & 336k = 324000
  assert.equal(allInBody.stats.median_cents, 324000);

  // Query hammer_only -> all 9 lots included (median index 4 -> 280000)
  const hammerRes = await app.request(
    "/v1/auctions/goldin_us/lots?q=1986+Fleer+Jordan&price_basis=hammer_only",
    {
      headers: x.headers,
    },
  );
  assert.equal(hammerRes.status, 200);
  const hammerBody = (await hammerRes.json()).data;
  assert.equal(hammerBody.stats.n_price_verified, 9);
  assert.equal(hammerBody.stats.median_cents, 280000);

  // Private lot image proxy serves PNG bytes without exposing upstream URLs
  const lot0 = allInBody.lots.find((l) => l.id === lot0Id);
  assert.equal(lot0?.primary_image_path, `/v1/auctions/goldin_us/lots/${lot0Id}/image`);
  const imgRes = await app.request(lot0.primary_image_path, { headers: x.headers });
  assert.equal(imgRes.status, 200);
  assert.equal(imgRes.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await imgRes.arrayBuffer()), pngBytes);

  // Revoking goldin_us stops both lots & image reads (403) while keeping eBay US intact
  await db.query("UPDATE sources SET status='revoked', permission_epoch=permission_epoch+1 WHERE id=$1", [
    goldinSource.sourceId,
  ]);
  assert.equal(
    (await app.request("/v1/auctions/goldin_us/lots?q=1986+Fleer+Jordan", { headers: x.headers })).status,
    403,
  );
  assert.equal((await app.request(lot0.primary_image_path, { headers: x.headers })).status, 403);
  assert.equal((await app.request(`/v1/sold/${x.queryId}`, { headers: x.headers })).status, 200);
  assert.deepEqual(await x.billing.reconcile(x.user), []);
});
