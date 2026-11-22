import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "@soldbench/api";
import { provisionFixtureSource } from "@soldbench/collector";
import {
  evaluateSecondMarketplaceRecords,
  mapSecondMarketplaceCondition,
  secondMarketplaceCanonicalHash,
} from "@soldbench/core";
import { database, migrate } from "@soldbench/db";
import { SecondMarketplaceService } from "@soldbench/query";
import { loadConfig } from "@soldbench/shared";
import sharp from "sharp";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL);
const roots = [];
const servers = [];
const clients = [];

before(() => migrate(db));
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
  await db.end();
  await Promise.all(roots.map((p) => rm(p, { recursive: true, force: true })));
});

test("AT-069 pure evaluation maps Mercari conditions and isolates active listings, unknown shipping, and <8 thresholds", () => {
  assert.equal(mapSecondMarketplaceCondition("mercari_us", "New"), "new_with_tags");
  assert.equal(mapSecondMarketplaceCondition("mercari_us", "Like new"), "like_new");
  assert.equal(mapSecondMarketplaceCondition("mercari_us", "Good"), "good");
  assert.equal(mapSecondMarketplaceCondition("mercari_us", "Fair"), "fair");
  assert.equal(mapSecondMarketplaceCondition("mercari_us", "Poor"), "poor");
  assert.equal(mapSecondMarketplaceCondition("mercari_us", "Something Custom"), "unknown");

  const soldOnly = Array.from({ length: 8 }, (_, i) => ({
    id: `00000000-0000-0000-0000-00000000000${i + 1}`,
    marketplace: "mercari_us",
    listingId: `m-${i}`,
    eventKey: `evt-${i}`,
    listingState: "sold",
    title: `Switch OLED #${i}`,
    currency: "USD",
    itemMinor: 20000 + i * 1000,
    shippingMinor: i === 0 ? null : 500,
    shippingStatus: i === 0 ? "unknown" : "observed",
    salePriceStatus: "verified_actual",
    conditionStd: "good",
    observedAt: "2026-11-17T12:00:00.000Z",
    soldAt: "2026-11-16T12:00:00.000Z",
    comparable: true,
    primaryImagePath: null,
    mediaStatus: "missing",
  }));

  const withExtremeActive = [
    ...soldOnly,
    {
      id: "00000000-0000-0000-0000-000000000099",
      marketplace: "mercari_us",
      listingId: "m-active-outlier",
      eventKey: "evt-active-1",
      listingState: "active",
      title: "Overpriced Active Asking",
      currency: "USD",
      itemMinor: 999900,
      shippingMinor: 0,
      shippingStatus: "verified_free_shipping",
      salePriceStatus: "displayed_only",
      conditionStd: "good",
      observedAt: "2026-11-17T12:00:00.000Z",
      soldAt: null,
      comparable: true,
      primaryImagePath: null,
      mediaStatus: "missing",
    },
  ];

  const baseEval = evaluateSecondMarketplaceRecords(soldOnly, { priceBasis: "item" });
  const mixedEval = evaluateSecondMarketplaceRecords(withExtremeActive, { priceBasis: "item" });
  assert.deepEqual(mixedEval.sold_stats, baseEval.sold_stats);
  assert.equal(mixedEval.sold_stats.n_price_verified, 8);
  assert.equal(mixedEval.sold_stats.median_cents, 23500);
  assert.equal(mixedEval.sold_stats.quality_score, null);
  assert.equal(mixedEval.active_listings.excluded_from_sold_stats, true);
  assert.equal(mixedEval.active_listings.active_count, 1);
  assert.equal(mixedEval.active_listings.max_asking_cents, 999900);

  // Under item_plus_observed_shipping, unknown shipping is excluded (<8 remaining -> null median) and never zero-filled
  const withShippingEval = evaluateSecondMarketplaceRecords(withExtremeActive, {
    priceBasis: "item_plus_observed_shipping",
  });
  assert.equal(withShippingEval.excluded_counts.unknown_shipping, 1);
  assert.equal(withShippingEval.sold_stats.n_price_verified, 7);
  assert.equal(withShippingEval.sold_stats.median_cents, null);
});

test("AT-069 Mercari US closed loop delivers deduped ingestion, REST/MCP parity, image proxy, and isolated source revocation", async () => {
  let app;
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (r) => (app ? app.fetch(r) : new Response(null, { status: 503 })),
  });
  servers.push(server);
  await new Promise((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  const port = server.address().port;

  const x = await createProductFixture(db, roots, { count: 10, limit: 10, port });
  const svc = new SecondMarketplaceService(x.query);
  app = createApp(loadConfig({ PORT: String(port) }), db, {
    auth: x.auth,
    query: x.query,
    secondMarketplace: svc,
  });
  const origin = `http://127.0.0.1:${port}`;

  // Catalog marks mercari_us selected and depop deferred (no sold support)
  const catalogRes = await app.request("/v1/marketplaces");
  assert.equal(catalogRes.status, 200);
  const catalog = (await catalogRes.json()).data;
  assert.equal(
    catalog.find((m) => m.marketplace_id === "mercari_us")?.selection_status,
    "selected_first_vertical",
  );
  const depop = catalog.find((m) => m.marketplace_id === "depop");
  assert.equal(depop?.selection_status, "deferred_candidate");
  assert.equal(depop?.supports_sold, false);

  // Deferred candidates fail closed with 422
  const depopRes = await app.request("/v1/marketplaces/depop/preview?q=Switch", { headers: x.headers });
  assert.equal(depopRes.status, 422);

  // Provision independent mercari_us source
  const mercariSource = await provisionFixtureSource(db, x.now(), { retentionDays: 7 });
  await db.query("UPDATE sources SET marketplace='mercari_us' WHERE id=$1", [mercariSource.sourceId]);

  const pngBytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: "green" } })
    .png()
    .toBuffer();

  // Ingest 10 sold records, re-observing sold-0 twice to confirm dedupe never creates duplicate sales
  let firstRecordId;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < (pass === 0 ? 10 : 1); i++) {
      const inserted = await svc.ingestRecord({
        marketplace: "mercari_us",
        sourceId: mercariSource.sourceId,
        listingId: `mercari-item-${i}`,
        eventKey: `mercari-evt-${i}`,
        listingState: "sold",
        queryKeyword: "Switch OLED",
        title: `Mercari Switch OLED #${i}`,
        currency: "USD",
        itemMinor: 21000 + i * 500,
        shippingMinor: i === 9 ? null : 600,
        shippingStatus: i === 9 ? "unknown" : "observed",
        salePriceStatus: "verified_actual",
        conditionRaw: "Good",
        observedAt: pass === 1 ? "2026-11-17T12:00:00.000Z" : "2026-11-17T10:00:00.000Z",
        soldAt: "2026-11-16T15:00:00.000Z",
        retentionUntil: "2026-11-25T00:00:00.000Z",
        primaryImageBytes: i === 0 ? pngBytes : null,
        primaryImageMime: i === 0 ? "image/png" : null,
      });
      if (i === 0) firstRecordId = inserted.id;
    }
  }

  // Ingest active listings (must stay isolated from sold_stats) + ended_unsold
  await svc.ingestRecord({
    marketplace: "mercari_us",
    sourceId: mercariSource.sourceId,
    listingId: "mercari-active-1",
    eventKey: "mercari-active-evt-1",
    listingState: "active",
    queryKeyword: "Switch OLED",
    title: "Overpriced Active Listing",
    currency: "USD",
    itemMinor: 888800,
    shippingMinor: 0,
    shippingStatus: "verified_free_shipping",
    salePriceStatus: "displayed_only",
    conditionRaw: "Like new",
    observedAt: "2026-11-17T11:30:00.000Z",
    retentionUntil: "2026-11-25T00:00:00.000Z",
  });
  await svc.ingestRecord({
    marketplace: "mercari_us",
    sourceId: mercariSource.sourceId,
    listingId: "mercari-unsold-1",
    eventKey: "mercari-unsold-evt-1",
    listingState: "ended_unsold",
    queryKeyword: "Switch OLED",
    title: "Ended Unsold Listing",
    currency: "USD",
    itemMinor: 30000,
    shippingMinor: 0,
    shippingStatus: "verified_free_shipping",
    salePriceStatus: "unknown",
    conditionRaw: "Fair",
    observedAt: "2026-11-17T11:30:00.000Z",
    retentionUntil: "2026-11-25T00:00:00.000Z",
  });

  // REST preview
  const restRes = await app.request("/v1/marketplaces/mercari_us/preview?q=Switch+OLED", {
    headers: x.headers,
  });
  assert.equal(restRes.status, 200);
  const restBody = await restRes.json();
  assert.equal(restBody.meta.credits_charged, 0);
  const data = restBody.data;
  assert.equal(data.marketplace, "mercari_us");
  assert.equal(
    data.canonical_query_hash,
    secondMarketplaceCanonicalHash({
      marketplace: "mercari_us",
      q: "Switch OLED",
      priceBasis: "item",
      limit: 50,
    }),
  );
  assert.equal(data.sold_stats.n_sold_observed, 10);
  assert.equal(data.sold_stats.n_price_verified, 10);
  assert.equal(data.sold_stats.median_cents, 23250);
  assert.equal(data.active_listings.excluded_from_sold_stats, true);
  assert.equal(data.active_listings.active_count, 1);
  assert.equal(data.active_listings.max_asking_cents, 888800);
  assert.equal(data.excluded_counts.ended_unsold, 1);

  const compWithImage = data.sold_comps.find((c) => c.id === firstRecordId);
  assert.equal(
    compWithImage?.primary_image_path,
    `/v1/marketplaces/mercari_us/records/${firstRecordId}/image`,
  );
  assert.doesNotMatch(JSON.stringify(data), /https?:\/\//);

  // Private image proxy serves exact PNG bytes with private no-store headers
  const imgRes = await app.request(compWithImage.primary_image_path, { headers: x.headers });
  assert.equal(imgRes.status, 200);
  assert.equal(imgRes.headers.get("content-type"), "image/png");
  assert.equal(imgRes.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await imgRes.arrayBuffer()), pngBytes);

  // Unknown shipping is excluded cleanly under item_plus_observed_shipping (never zero-filled)
  const shippedRes = await app.request(
    "/v1/marketplaces/mercari_us/preview?q=Switch+OLED&price_basis=item_plus_observed_shipping",
    { headers: x.headers },
  );
  assert.equal(shippedRes.status, 200);
  const shippedData = (await shippedRes.json()).data;
  assert.equal(shippedData.sold_stats.n_price_verified, 9);
  assert.equal(shippedData.excluded_counts.unknown_shipping, 1);

  // MCP StreamableHTTP parity check (keeps exact two-tool surface)
  const mcp = new Client({ name: "mercari-test-client", version: "1.0.0" });
  clients.push(mcp);
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      authProvider: { token: async () => x.secret },
      requestInit: { redirect: "error" },
    }),
  );
  const toolList = await mcp.listTools();
  assert.deepEqual(toolList.tools.map((t) => t.name).sort(), ["sold_search", "sold_stats"]);

  const mcpPreview = await mcp.callTool({
    name: "sold_search",
    arguments: {
      action: "marketplace_preview",
      marketplace: "mercari_us",
      q: "Switch OLED",
      limit: 20,
    },
  });
  assert.equal(Boolean(mcpPreview.isError), false);
  assert.deepEqual(mcpPreview.structuredContent.data.sold_stats, data.sold_stats);
  assert.equal(mcpPreview.structuredContent.data.active_listings.active_count, 1);
  assert.equal(mcpPreview.structuredContent.meta.credits_charged, 0);

  // Revoke ONLY mercari_us -> REST, image proxy, and MCP fail closed immediately, while eBay US stays intact
  await db.query("UPDATE sources SET status='revoked', permission_epoch=permission_epoch+1 WHERE id=$1", [
    mercariSource.sourceId,
  ]);
  assert.equal(
    (await app.request("/v1/marketplaces/mercari_us/preview?q=Switch+OLED", { headers: x.headers })).status,
    403,
  );
  assert.equal((await app.request(compWithImage.primary_image_path, { headers: x.headers })).status, 403);
  const mcpRevoked = await mcp.callTool({
    name: "sold_search",
    arguments: { action: "marketplace_preview", marketplace: "mercari_us", q: "Switch OLED" },
  });
  assert.equal(mcpRevoked.isError, true);
  assert.equal(mcpRevoked.structuredContent.error.code, "forbidden");

  const cleaned = await svc.reconcileRetention();
  assert.equal(cleaned.cleaned_images, 1);

  // Existing eBay US claimed result remains unaffected
  const ebayRes = await app.request(`/v1/sold/${x.queryId}`, { headers: x.headers });
  assert.equal(ebayRes.status, 200);
  assert.deepEqual(await x.billing.reconcile(x.user), []);
});
