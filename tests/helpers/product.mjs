import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@soldbench/api";
import { AuthService, newAuthSecrets } from "@soldbench/auth";
import { BillingService } from "@soldbench/billing";
import {
  CollectorStore,
  FixtureTransport,
  fixtureResponse,
  OfflineCollectorWorker,
  provisionFixtureSource,
} from "@soldbench/collector";
import { collectionQueryHash, normalizeQuery } from "@soldbench/core";
import { PrivateMediaStore } from "@soldbench/media";
import { QueryService, RequestAuditService, ResearchService } from "@soldbench/query";
import { loadConfig } from "@soldbench/shared";
import sharp from "sharp";

export async function createProductFixture(
  db,
  roots,
  { claimed = true, count = 58, extra = true, port, limit = 5, prepareQuery = true } = {},
) {
  const clock = { value: "2026-11-17T12:00:00.000Z" },
    now = () => clock.value,
    config = loadConfig(port ? { PORT: String(port) } : {}),
    auth = new AuthService(db, newAuthSecrets(), config.origin, now),
    billing = new BillingService(db, now),
    root = await mkdtemp(join(tmpdir(), "soldbench-research-"));
  roots.push(root);
  const media = new PrivateMediaStore(root),
    query = new QueryService(db, auth, billing, media, now),
    research = new ResearchService(query),
    audit = new RequestAuditService(query),
    source = await provisionFixtureSource(db, now(), { retentionDays: 7 }),
    store = new CollectorStore(db, now),
    q = normalizeQuery(new URLSearchParams({ q: `research fixture ${randomUUID()}`, limit: String(limit) })),
    hash = collectionQueryHash(q),
    _job = await store.enqueue({ ...source, queryHash: hash, runKey: randomUUID(), asOf: now() }),
    rows = Array.from({ length: count }, (_, i) => ({
      listingId: `listing-${i}`,
      title: i === 0 ? '=HYPERLINK("https://example.test")' : `Synthetic ${i}`,
      candidate: {
        sourceId: source.sourceId,
        eventKey: `event-${i}`,
        identityVerified: true,
        comparable: true,
        priceStatus: "verified_actual",
        format: "fixed_price",
        currency: "USD",
        itemCents: i === count - 1 ? 9999 : 1000 + i,
        shippingCents: 0,
        shippingStatus: "verified_free_shipping",
        condition: "good",
        title: i === 0 ? '=HYPERLINK("https://example.test")' : `Synthetic ${i}`,
        time: { precision: "instant", value: now() },
      },
    }));
  if (extra)
    for (const [name, patch] of [
      ["offer", { priceStatus: "displayed_only", format: "best_offer" }],
      ["wrong-model", { comparable: false }],
      ["shipping", { shippingCents: null, shippingStatus: "unknown" }],
      ["time", { time: { precision: "unknown" } }],
      ["identity", { identityVerified: false, eventKey: null }],
    ])
      rows.push({
        listingId: name,
        title: `Synthetic ${name}`,
        candidate: { ...rows[0].candidate, eventKey: name, ...patch },
      });
  const imageUrl = "https://images.example.test/research.png";
  rows[0].primaryImage = { role: "primary", url: imageUrl };
  const frames = new Map();
  for (let i = 0; i < Math.max(1, Math.ceil(rows.length / 50)); i++)
    frames.set(`page:${i ? `p${i}` : "start"}`, [
      fixtureResponse({
        schema: "soldbench.synthetic-page.v1",
        synthetic: true,
        sourceId: source.sourceId,
        queryHash: hash,
        cursor: i ? `p${i}` : "start",
        nextCursor: (i + 1) * 50 < rows.length ? `p${i + 1}` : null,
        asOf: now(),
        empty: !rows.length,
        records: rows.slice(i * 50, (i + 1) * 50),
      }),
    ]);
  frames.set(`image:${imageUrl}`, [
    {
      status: 200,
      contentType: "image/png",
      bytes: await sharp({ create: { width: 12, height: 12, channels: 3, background: "blue" } })
        .png()
        .toBuffer(),
    },
  ]);
  assert.equal(
    (await new OfflineCollectorWorker(store, new FixtureTransport(frames), media).runOne(source.sourceId))
      .status,
    "completed",
  );
  const user = (
      await db.query(
        "INSERT INTO users(email,password_hash,status,email_verified_at,free_anchor_at) VALUES($1,'fixture','active',$2,$2) RETURNING id",
        [`research-${randomUUID()}@example.test`, now()],
      )
    ).rows[0].id,
    secret = auth.crypto.token("sb_k_");
  await db.query(
    "INSERT INTO api_keys(user_id,name,key_hash,key_prefix,scopes) VALUES($1,'fixture',$2,'sb_k_test',$3)",
    [user, auth.crypto.hash("auth.api-key", secret), ["sold:read", "jobs:read", "usage:read"]],
  );
  const identity = await auth.keyIdentity(secret, "sold:read"),
    submitted = prepareQuery ? await query.submit(identity, q) : null;
  if (prepareQuery) assert.equal((await query.workOnce("research-worker")).status, "completed");
  const queryId = submitted?.queryId ?? null;
  if (claimed && queryId) await query.result(identity, queryId, randomUUID(), true, randomUUID());
  const app = createApp(config, db, { auth, query }),
    headers = { Authorization: `Bearer ${secret}` },
    events = (
      await db.query(
        "SELECT s.sale_event_id,s.candidate FROM query_snapshot_records s WHERE s.query_id=$1 ORDER BY s.sale_event_id",
        [queryId],
      )
    ).rows;
  return {
    clock,
    now,
    source,
    store,
    auth,
    billing,
    query,
    research,
    audit,
    identity,
    app,
    headers,
    secret,
    queryId,
    events,
    user,
    q,
  };
}
