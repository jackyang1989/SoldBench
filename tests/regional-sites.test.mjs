import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createApp } from "@soldbench/api";
import { provisionFixtureSource } from "@soldbench/collector";
import {
  convertMinorWithFx,
  evaluateSiteComparables,
  mapRegionalCondition,
  parseRegionalSoldDate,
} from "@soldbench/core";
import { database, migrate } from "@soldbench/db";
import {
  assertRegionalCatalogComplete,
  formatRegionalDate,
  formatRegionalMoney,
  loadConfig,
  regionalMessage,
} from "@soldbench/shared";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL);
const roots = [];

before(() => migrate(db));
after(async () => {
  await db.end();
  await Promise.all(roots.map((p) => rm(p, { recursive: true, force: true })));
});

test("AT-066 regional i18n catalog completeness, en-GB/de email & money/date formats, conditions, and dates", () => {
  assertRegionalCatalogComplete();

  assert.equal(mapRegionalCondition("ebay_uk", "Brand new"), "new_with_tags");
  assert.equal(mapRegionalCondition("ebay_uk", "New other (see details)"), "like_new");
  assert.equal(mapRegionalCondition("ebay_uk", "Used"), "good");
  assert.equal(mapRegionalCondition("ebay_uk", "For parts or not working"), "defective");
  assert.equal(mapRegionalCondition("ebay_de", "Neu"), "new_with_tags");
  assert.equal(mapRegionalCondition("ebay_de", "Neu ohne Etikett"), "new_without_tags");
  assert.equal(mapRegionalCondition("ebay_de", "Neu: Sonstige"), "like_new");
  assert.equal(mapRegionalCondition("ebay_de", "Gebraucht"), "good");
  assert.equal(mapRegionalCondition("ebay_de", "Als Ersatzteil / defekt"), "defective");

  assert.deepEqual(parseRegionalSoldDate("ebay_uk", "Sold 21 Nov 2026"), {
    precision: "day",
    value: "2026-11-21",
    timeZone: "Europe/London",
  });
  assert.deepEqual(parseRegionalSoldDate("ebay_de", "Verkauft am 18. Mär. 2026"), {
    precision: "day",
    value: "2026-03-18",
    timeZone: "Europe/Berlin",
  });
  assert.deepEqual(parseRegionalSoldDate("ebay_de", "Verkauft am 21.11.2026"), {
    precision: "day",
    value: "2026-11-21",
    timeZone: "Europe/Berlin",
  });

  assert.match(formatRegionalMoney("en-GB", 14999, "GBP"), /GBP.*149\.99/);
  assert.match(formatRegionalMoney("de", 14999, "EUR"), /149,99.*EUR/);
  assert.match(formatRegionalDate("en-GB", "2026-11-21T00:00:00Z", "Europe/London", "day"), /Europe\/London/);
  assert.match(formatRegionalDate("de", "2026-11-21T00:00:00Z", "Europe/Berlin", "day"), /Europe\/Berlin/);
  assert.match(
    regionalMessage("de", "email.verify_body", { url: "https://soldbench.com/v", expiresMinutes: 30 }),
    /30 Minuten/,
  );

  // Exact BigInt half-up FX conversion (10001 * 1.275 = 12751.275 -> 12751; 10000 * 1.27505 = 12750.5 -> 12751)
  assert.equal(convertMinorWithFx(10000, 1_275_050), 12751);
  assert.equal(convertMinorWithFx(1000, 1_270_000), 1270);

  // Pure evaluation unit test: mixed EUR rejected inside ebay_uk, expired FX withheld
  const evalMixed = evaluateSiteComparables(
    Array.from({ length: 8 }, (_, i) => ({
      eventKey: `uk-${i}`,
      currency: i === 0 ? "EUR" : "GBP",
      itemMinor: 10000 + i * 100,
      shippingMinor: 0,
      shippingStatus: "verified_free_shipping",
      salePriceStatus: "verified_actual",
      saleFormat: "fixed_price",
      conditionStd: "good",
      comparable: true,
      time: { precision: "day", value: "2026-11-15", timeZone: "Europe/London" },
    })),
    {
      site: "ebay_uk",
      asOf: "2026-11-17T12:00:00.000Z",
      days: 30,
      basis: "item_plus_observed_shipping",
      compareCurrency: "USD",
      fxSnapshot: {
        baseCurrency: "GBP",
        quoteCurrency: "USD",
        rateMicros: 1_270_000,
        evidenceRef: "ecb-expired",
        provider: "fixture",
        capturedAt: "2026-11-01T00:00:00Z",
        expiresAt: "2026-11-10T00:00:00Z",
      },
    },
  );
  assert.equal(evalMixed.currency_mismatch_count, 1);
  assert.equal(evalMixed.native_stats.n_price_verified, 7);
  assert.equal(evalMixed.native_stats.median_minor, null);
  assert.equal(evalMixed.fx_status, "fx_evidence_unavailable");
  assert.equal(evalMixed.comparable_view, null);
});

test("AT-066 UK/DE site endpoints isolate currencies, preserve hash across Accept-Language, attach FX evidence, isolate revocation, and render localized routes", async () => {
  const x = await createProductFixture(db, roots, { count: 10, limit: 10, claimed: false });
  const app = createApp(loadConfig({}), db, { auth: x.auth, query: x.query });

  const sitesRes = await app.request("/v1/sites");
  assert.equal(sitesRes.status, 200);
  const sites = (await sitesRes.json()).data;
  assert.deepEqual(
    sites.map((s) => s.site_id),
    ["ebay_us", "ebay_uk", "ebay_de"],
  );
  assert.equal(sites[1].default_currency, "GBP");
  assert.equal(sites[2].default_currency, "EUR");
  assert.equal(sites[1].gates.source_gate_passed, false);

  const deLoc = await (await app.request("/v1/sites/ebay_de/localization?locale=de")).json();
  assert.equal(deLoc.data.locale, "de");
  assert.equal(deLoc.data.ui_messages["site.shipping_label"], "Versandkosten");

  // Seed independent regional sources for UK and DE
  const ukSource = await provisionFixtureSource(db, x.now(), { retentionDays: 7 });
  const deSource = await provisionFixtureSource(db, x.now(), { retentionDays: 7 });
  await db.query("UPDATE sources SET marketplace='ebay_uk' WHERE id=$1", [ukSource.sourceId]);
  await db.query("UPDATE sources SET marketplace='ebay_de' WHERE id=$1", [deSource.sourceId]);

  // Seed 10 GBP records + 1 leaked EUR record for UK site
  for (let i = 0; i < 11; i++) {
    await db.query(
      `INSERT INTO regional_site_records(
         site_id,source_id,permission_epoch,query_keyword,event_key,title,currency,
         item_minor,shipping_minor,shipping_status,sale_price_status,sale_format,
         condition_raw,condition_std,sold_at,sold_date_precision,comparable,retention_until
       ) VALUES('ebay_uk',$1,1,'Brompton M6L',$2,$3,$4,$5,0,'verified_free_shipping','verified_actual','fixed_price','Used','good',$6,'day',true,$7)`,
      [
        ukSource.sourceId,
        `uk-brompton-${i}`,
        `Brompton M6L #${i}`,
        i === 10 ? "EUR" : "GBP",
        85000 + i * 1000,
        "2026-11-15T12:00:00Z",
        "2026-11-30T00:00:00Z",
      ],
    );
  }
  // Seed only 6 (<8) EUR records for DE site
  for (let i = 0; i < 6; i++) {
    await db.query(
      `INSERT INTO regional_site_records(
         site_id,source_id,permission_epoch,query_keyword,event_key,title,currency,
         item_minor,shipping_minor,shipping_status,sale_price_status,sale_format,
         condition_raw,condition_std,sold_at,sold_date_precision,comparable,retention_until
       ) VALUES('ebay_de',$1,1,'Brompton M6L',$2,$3,'EUR',$4,500,'observed','verified_actual','fixed_price','Gebraucht','good',$5,'day',true,$6)`,
      [
        deSource.sourceId,
        `de-brompton-${i}`,
        `Brompton M6L DE #${i}`,
        95000 + i * 1000,
        "2026-11-15T12:00:00Z",
        "2026-11-30T00:00:00Z",
      ],
    );
  }

  // Seed valid non-expired GBP->USD FX evidence
  await db.query(
    `INSERT INTO fx_rate_snapshots(base_currency,quote_currency,rate_micros,evidence_ref,provider,captured_at,expires_at)
     VALUES('GBP','USD',1270000,'ecb-fx-2026-11-17','ecb_fixture','2026-11-17T08:00:00Z','2026-11-18T12:00:00Z')`,
  );

  // Accept-Language: de-DE never changes explicit ebay_uk selection & keeps identical canonical_query_hash
  const ukDeHeader = await app.request("/v1/sites/ebay_uk/sold-preview?q=Brompton+M6L&compare_currency=USD", {
    headers: { ...x.headers, "Accept-Language": "de-DE,de;q=0.9" },
  });
  assert.equal(ukDeHeader.status, 200);
  const ukBody = (await ukDeHeader.json()).data;

  const ukZhHeader = await app.request("/v1/sites/ebay_uk/sold-preview?q=Brompton+M6L&compare_currency=USD", {
    headers: { ...x.headers, "Accept-Language": "zh-CN" },
  });
  assert.equal(ukZhHeader.status, 200);
  const ukZhBody = (await ukZhHeader.json()).data;

  assert.equal(ukBody.site, "ebay_uk");
  assert.equal(ukBody.native_currency, "GBP");
  assert.equal(ukBody.canonical_query_hash, ukZhBody.canonical_query_hash);
  assert.equal(ukBody.credits_charged, 0);
  assert.equal(ukBody.currency_mismatch_count, 1);
  assert.equal(ukBody.native_stats.n_price_verified, 10);
  assert.equal(ukBody.native_stats.median_minor, 89500);
  assert.equal(ukBody.fx_status, "converted_with_evidence");
  assert.equal(ukBody.fx_evidence.evidence_ref, "ecb-fx-2026-11-17");
  assert.equal(ukBody.comparable_view.median_minor, convertMinorWithFx(89500, 1270000));

  // DE <8 samples keeps median null and withheld missing FX pair
  const dePreview = await (
    await app.request("/v1/sites/ebay_de/sold-preview?q=Brompton+M6L&compare_currency=GBP", {
      headers: x.headers,
    })
  ).json();
  assert.equal(dePreview.data.native_currency, "EUR");
  assert.equal(dePreview.data.native_stats.n_price_verified, 6);
  assert.equal(dePreview.data.native_stats.median_minor, null);
  assert.equal(dePreview.data.fx_status, "fx_evidence_unavailable");
  assert.equal(dePreview.data.comparable_view, null);

  // Per-site revocation: revoking ebay_uk blocks UK (403) while ebay_de stays readable (200)
  await db.query("UPDATE sources SET status='revoked', permission_epoch=permission_epoch+1 WHERE id=$1", [
    ukSource.sourceId,
  ]);
  assert.equal(
    (await app.request("/v1/sites/ebay_uk/sold-preview?q=Brompton+M6L", { headers: x.headers })).status,
    403,
  );
  assert.equal(
    (await app.request("/v1/sites/ebay_de/sold-preview?q=Brompton+M6L", { headers: x.headers })).status,
    200,
  );

  // Localized UK English & German preview HTML routes
  const ukHtml = await app.request("/en-GB/sites");
  assert.equal(ukHtml.status, 200);
  const ukText = await ukHtml.text();
  assert.match(ukText, /<html lang="en-GB">/);
  assert.match(ukText, /Postage &amp; Packaging|Postage & Packaging/);
  assert.match(ukText, /GBP/);

  const deHtml = await app.request("/de/sites");
  assert.equal(deHtml.status, 200);
  const deText = await deHtml.text();
  assert.match(deText, /<html lang="de">/);
  assert.match(deText, /Versandkosten/);
  assert.match(deText, /MwSt/);
  assert.match(deText, /EUR/);

  assert.deepEqual(await x.billing.reconcile(x.user), []);
});
