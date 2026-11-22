import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createApp } from "@soldbench/api";
import { provisionFixtureSource } from "@soldbench/collector";
import { cardValuationCanonicalHash, evaluateCardComparables } from "@soldbench/core";
import { database, migrate } from "@soldbench/db";
import { CardsVerticalService } from "@soldbench/query";
import { loadConfig } from "@soldbench/shared";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL);
const roots = [];

before(() => migrate(db));
after(async () => {
  await db.end();
  await Promise.all(roots.map((p) => rm(p, { recursive: true, force: true })));
});

test("AT-070 pure card evaluator enforces strict raw/graded isolation, edition fidelity, grader/grade matching, and <8 threshold", () => {
  const baseRecords = Array.from({ length: 8 }, (_, i) => ({
    id: `00000000-0000-0000-0000-00000000001${i}`,
    productId: "tcg-pkmn-base-4-1st",
    eventKey: `psa10-evt-${i}`,
    gradingState: "graded",
    gradingCompany: "PSA",
    gradeValue: "10",
    rawCondition: null,
    edition: "1st_edition",
    currency: "USD",
    itemMinor: 500000 + i * 10000,
    shippingMinor: 0,
    shippingStatus: "verified_free_shipping",
    salePriceStatus: "verified_actual",
    soldAt: "2026-11-16T12:00:00.000Z",
    comparable: true,
  }));

  const noisy = [
    ...baseRecords,
    // Raw ungraded must be excluded from graded query
    {
      ...baseRecords[0],
      id: "00000000-0000-0000-0000-000000000080",
      eventKey: "raw-nm-1",
      gradingState: "raw",
      gradingCompany: null,
      gradeValue: null,
      rawCondition: "near_mint",
      itemMinor: 45000,
    },
    // Wrong grader (BGS 10 vs PSA 10)
    {
      ...baseRecords[0],
      id: "00000000-0000-0000-0000-000000000081",
      eventKey: "bgs10-1",
      gradingCompany: "BGS",
      gradeValue: "10",
      itemMinor: 900000,
    },
    // Wrong grade (PSA 9 vs PSA 10)
    {
      ...baseRecords[0],
      id: "00000000-0000-0000-0000-000000000082",
      eventKey: "psa9-1",
      gradingCompany: "PSA",
      gradeValue: "9",
      itemMinor: 180000,
    },
    // Wrong edition (unlimited vs 1st_edition)
    {
      ...baseRecords[0],
      id: "00000000-0000-0000-0000-000000000083",
      eventKey: "unlim-1",
      edition: "unlimited",
      itemMinor: 30000,
    },
  ];

  const gradedOnly = evaluateCardComparables(noisy, {
    productId: "tcg-pkmn-base-4-1st",
    expectedEdition: "1st_edition",
    gradingState: "graded",
    gradingCompany: "PSA",
    gradeValue: "10",
    priceBasis: "item",
  });
  assert.equal(gradedOnly.stats.n_price_verified, 8);
  assert.equal(gradedOnly.stats.median_cents, 535000);
  assert.equal(gradedOnly.stats.quality_score, null);
  assert.equal(gradedOnly.excluded_counts.grading_state_mismatch, 1);
  assert.equal(gradedOnly.excluded_counts.grading_company_mismatch, 1);
  assert.equal(gradedOnly.excluded_counts.grade_mismatch, 1);
  assert.equal(gradedOnly.excluded_counts.edition_mismatch, 1);

  // Raw query sees ONLY raw records (<8 -> null median)
  const rawOnly = evaluateCardComparables(noisy, {
    productId: "tcg-pkmn-base-4-1st",
    expectedEdition: "1st_edition",
    gradingState: "raw",
    rawCondition: "near_mint",
    priceBasis: "item",
  });
  assert.equal(rawOnly.stats.n_price_verified, 1);
  assert.equal(rawOnly.stats.median_cents, null);
  assert.equal(rawOnly.excluded_counts.grading_state_mismatch, 10);
});

test("AT-070 PG16 card valuation enforces catalog identity, isolates PSA pop from sales, and revokes sources independently", async () => {
  const x = await createProductFixture(db, roots, { count: 10, limit: 10 });
  const cardsSvc = new CardsVerticalService(x.query);
  const app = createApp(loadConfig({}), db, { auth: x.auth, query: x.query, cardsVertical: cardsSvc });

  const catalogRes = await app.request("/v1/cards/products?tcg_game=pokemon&card_number=4/102");
  assert.equal(catalogRes.status, 200);
  const catalog = (await catalogRes.json()).data;
  assert.deepEqual(
    catalog.map((p) => p.product_id),
    ["tcg-pkmn-base-4-1st", "tcg-pkmn-base-4-unlim"],
  );

  // Unknown free-text eBay title cannot be substituted as a card product_id
  assert.equal(
    (
      await app.request("/v1/cards/products/charizard-holo-1999-psa-10/valuation?grading_state=graded", {
        headers: x.headers,
      })
    ).status,
    404,
  );
  // Mixing raw + grading_company or graded + raw_condition rejected cleanly (400)
  assert.equal(
    (
      await app.request(
        "/v1/cards/products/tcg-pkmn-base-4-1st/valuation?grading_state=raw&grading_company=PSA",
        { headers: x.headers },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await app.request(
        "/v1/cards/products/tcg-pkmn-base-4-1st/valuation?grading_state=graded&raw_condition=near_mint",
        { headers: x.headers },
      )
    ).status,
    400,
  );

  // Provision independent offline sources for card sales (tcgplayer_us) & grading census (psa_registry)
  const tcgSource = await provisionFixtureSource(db, x.now(), { retentionDays: 7 });
  const psaSource = await provisionFixtureSource(db, x.now(), { retentionDays: 7 });
  await db.query("UPDATE sources SET marketplace='tcgplayer_us' WHERE id=$1", [tcgSource.sourceId]);
  await db.query("UPDATE sources SET marketplace='psa_registry' WHERE id=$1", [psaSource.sourceId]);

  const retentionUntil = "2026-11-25T00:00:00.000Z";
  for (let i = 0; i < 9; i++) {
    await cardsSvc.ingestCardSale({
      productId: "tcg-pkmn-base-4-1st",
      sourceId: tcgSource.sourceId,
      eventKey: `charizard-psa10-${i}`,
      gradingState: "graded",
      gradingCompany: "PSA",
      gradeValue: "10",
      edition: "1st_edition",
      currency: "USD",
      itemMinor: 400000 + i * 10000,
      shippingMinor: i === 8 ? null : 2000,
      shippingStatus: i === 8 ? "unknown" : "observed",
      salePriceStatus: "verified_actual",
      soldAt: "2026-11-16T15:00:00.000Z",
      retentionUntil,
    });
  }
  // Ingest raw & wrong grader rows into same product_id to prove strict query isolation
  await cardsSvc.ingestCardSale({
    productId: "tcg-pkmn-base-4-1st",
    sourceId: tcgSource.sourceId,
    eventKey: "charizard-raw-nm",
    gradingState: "raw",
    rawCondition: "near_mint",
    edition: "1st_edition",
    currency: "USD",
    itemMinor: 35000,
    shippingMinor: 0,
    shippingStatus: "verified_free_shipping",
    salePriceStatus: "verified_actual",
    soldAt: "2026-11-16T15:00:00.000Z",
    retentionUntil,
  });
  await cardsSvc.ingestCardSale({
    productId: "tcg-pkmn-base-4-1st",
    sourceId: tcgSource.sourceId,
    eventKey: "charizard-bgs-10",
    gradingState: "graded",
    gradingCompany: "BGS",
    gradeValue: "10",
    edition: "1st_edition",
    currency: "USD",
    itemMinor: 750000,
    shippingMinor: 0,
    shippingStatus: "verified_free_shipping",
    salePriceStatus: "verified_actual",
    soldAt: "2026-11-16T15:00:00.000Z",
    retentionUntil,
  });

  // Ingest PSA registry population metadata (must never count as sold transaction)
  await cardsSvc.ingestGradingPopulation({
    productId: "tcg-pkmn-base-4-1st",
    sourceId: psaSource.sourceId,
    gradingCompany: "PSA",
    gradeValue: "10",
    popCount: 121,
    popHigherCount: 0,
    asOf: "2026-11-17T08:00:00.000Z",
    retentionUntil,
  });

  const valRes = await app.request(
    "/v1/cards/products/tcg-pkmn-base-4-1st/valuation?grading_state=graded&grading_company=PSA&grade_value=10",
    { headers: x.headers },
  );
  assert.equal(valRes.status, 200);
  const valBody = await valRes.json();
  assert.equal(valBody.meta.credits_charged, 0);
  const d = valBody.data;
  assert.equal(d.identity_authority, "structured_card_catalog");
  assert.equal(d.free_text_title_substitution_allowed, false);
  assert.equal(
    d.canonical_query_hash,
    cardValuationCanonicalHash({
      productId: "tcg-pkmn-base-4-1st",
      gradingState: "graded",
      edition: "1st_edition",
      gradingCompany: "PSA",
      gradeValue: "10",
      priceBasis: "item",
    }),
  );
  assert.equal(d.stats.n_price_verified, 9);
  assert.equal(d.stats.median_cents, 440000);
  assert.equal(d.excluded_counts.grading_state_mismatch, 1);
  assert.equal(d.excluded_counts.grading_company_mismatch, 1);
  assert.equal(d.grading_population.is_sold_transaction, false);
  assert.equal(d.grading_population.excluded_from_sold_stats, true);
  assert.equal(d.grading_population.registry_status, "available");
  assert.equal(d.grading_population.entries[0].pop_count, 121);

  // Under item_plus_observed_shipping, unknown-shipping row excluded (8 left)
  const shippedRes = await app.request(
    "/v1/cards/products/tcg-pkmn-base-4-1st/valuation?grading_state=graded&grading_company=PSA&grade_value=10&price_basis=item_plus_observed_shipping",
    { headers: x.headers },
  );
  assert.equal(shippedRes.status, 200);
  const shippedData = (await shippedRes.json()).data;
  assert.equal(shippedData.stats.n_price_verified, 8);
  assert.equal(shippedData.excluded_counts.unknown_shipping, 1);

  // Revoking psa_registry removes population metadata while authorized tcgplayer_us sales remain readable
  await db.query("UPDATE sources SET status='revoked', permission_epoch=permission_epoch+1 WHERE id=$1", [
    psaSource.sourceId,
  ]);
  const afterPsaRevoke = await (
    await app.request(
      "/v1/cards/products/tcg-pkmn-base-4-1st/valuation?grading_state=graded&grading_company=PSA&grade_value=10",
      { headers: x.headers },
    )
  ).json();
  assert.equal(afterPsaRevoke.data.stats.n_price_verified, 9);
  assert.equal(afterPsaRevoke.data.grading_population.registry_status, "unavailable_or_revoked");
  assert.equal(afterPsaRevoke.data.grading_population.entries.length, 0);

  // Revoking tcgplayer_us fails closed (403) while keeping eBay US intact
  await db.query("UPDATE sources SET status='revoked', permission_epoch=permission_epoch+1 WHERE id=$1", [
    tcgSource.sourceId,
  ]);
  assert.equal(
    (
      await app.request(
        "/v1/cards/products/tcg-pkmn-base-4-1st/valuation?grading_state=graded&grading_company=PSA&grade_value=10",
        { headers: x.headers },
      )
    ).status,
    403,
  );
  assert.equal((await app.request(`/v1/sold/${x.queryId}`, { headers: x.headers })).status, 200);
  assert.deepEqual(await x.billing.reconcile(x.user), []);
});
