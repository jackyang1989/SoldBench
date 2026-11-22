import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createApp } from "@soldbench/api";
import { database, migrate } from "@soldbench/db";
import {
  AlertWebhookService,
  signWebhookPayload,
  validateWebhookTargetUrl,
  verifyWebhookSignature,
} from "@soldbench/query";
import { loadConfig } from "@soldbench/shared";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL);
const roots = [];

before(() => migrate(db));
after(async () => {
  await db.end();
  await Promise.all(roots.map((p) => rm(p, { recursive: true, force: true })));
});

test("AT-065 SSRF guard and HMAC timestamp signature verification enforce strict boundaries", () => {
  for (const badUrl of [
    "http://hooks.example.test/webhook",
    "https://127.0.0.1/hook",
    "https://localhost/hook",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.5/internal",
    "https://192.168.1.10/hook",
    "https://[::1]/hook",
    "https://user:pass@hooks.example.test/hook",
    "https://metadata.google.internal/computeMetadata",
  ]) {
    assert.throws(
      () => validateWebhookTargetUrl(badUrl),
      (err) => err?.code === "invalid_parameter",
      badUrl,
    );
  }
  assert.equal(
    validateWebhookTargetUrl("https://hooks.example.test/soldbench"),
    "https://hooks.example.test/soldbench",
  );

  const secret = "sb_whsec_test_secret_material_0123456789";
  const body = JSON.stringify({ event: "price_alert" });
  const nowSec = 1763800000;
  const sig = signWebhookPayload(secret, nowSec, body);
  assert.equal(verifyWebhookSignature(secret, body, sig, nowSec + 60), true);
  assert.equal(verifyWebhookSignature(secret, body, sig, nowSec + 600), false);
  assert.equal(verifyWebhookSignature(secret, `${body} `, sig, nowSec + 10), false);
  assert.equal(verifyWebhookSignature("wrong_secret", body, sig, nowSec + 10), false);
});

test("AT-065 watchlists enforce billing consent, monthly caps, 0-credit language switch, signed delivery retries/DLQ, unsubscribe, and source revocation", async () => {
  const x = await createProductFixture(db, roots, { count: 12, limit: 10, claimed: true });
  const otherSecret = x.auth.crypto.token("sb_k_");
  const otherId = (
    await db.query(
      "INSERT INTO users(email,password_hash,status,email_verified_at,free_anchor_at) VALUES($1,'fixture','active',$2,$2) RETURNING id",
      [`other-alert-${randomUUID()}@example.test`, x.now()],
    )
  ).rows[0].id;
  await db.query(
    "INSERT INTO api_keys(user_id,name,key_hash,key_prefix,scopes) VALUES($1,'other',$2,'sb_k_oth',$3)",
    [otherId, x.auth.crypto.hash("auth.api-key", otherSecret), ["sold:read", "jobs:read", "usage:read"]],
  );
  const otherHeaders = { Authorization: `Bearer ${otherSecret}`, "Content-Type": "application/json" };

  const sentRequests = [];
  let responseMode = "ok";
  const transport = {
    kind: "memory_fixture",
    async send(input) {
      sentRequests.push(input);
      if (responseMode === "fail_500") return { status: 500, error: "downstream_error" };
      return { status: 202 };
    },
  };
  const alertService = new AlertWebhookService(x.query, transport);
  const app = createApp(loadConfig({}), db, { auth: x.auth, query: x.query, alerts: alertService });
  const jsonHeaders = { ...x.headers, "Content-Type": "application/json" };

  // 1. Scheduled refresh without explicit billing consent fails 400 billing_consent_required
  const missingConsent = await app.request("/v1/watchlists", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      name: "Scheduled No Consent",
      query: { q: x.q.q },
      trigger_kind: "price_below",
      threshold_cents: 5000,
      schedule_mode: "scheduled_refresh",
      billing_consent_accepted: false,
      max_credits_per_month: 2,
    }),
  });
  assert.equal(missingConsent.status, 400);
  assert.equal((await missingConsent.json()).error.code, "billing_consent_required");

  // 2. Reject SSRF webhook target
  const badWebhook = await app.request("/v1/webhooks", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      name: "SSRF Probe",
      target_url: "https://169.254.169.254/latest",
      event_types: ["price_alert"],
    }),
  });
  assert.equal(badWebhook.status, 400);

  // 3. Register valid webhook endpoint (secret shown once only)
  const epRes = await app.request("/v1/webhooks", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      name: "Price Listener",
      target_url: "https://hooks.example.test/soldbench-events",
      event_types: ["price_alert", "low_credits", "job_completed"],
    }),
  });
  assert.equal(epRes.status, 201);
  const epCreated = await epRes.json();
  const signingSecret = epCreated.data.signing_secret;
  assert.match(signingSecret, /^sb_whsec_/);
  const listEps = await (await app.request("/v1/webhooks", { headers: x.headers })).json();
  assert.equal("signing_secret" in listEps.data[0], false);

  // 4. Create consented scheduled watchlist (monthly cap = 1) + switch locale cleanly at 0 cost
  const wlRes = await app.request("/v1/watchlists", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      name: "Nintendo price watch",
      query: { q: x.q.q, limit: x.q.limit },
      trigger_kind: "price_below",
      threshold_cents: 5000,
      schedule_mode: "scheduled_refresh",
      billing_consent_accepted: true,
      max_credits_per_month: 1,
      locale: "en",
    }),
  });
  assert.equal(wlRes.status, 201);
  const wlBody = await wlRes.json();
  const watchlistId = wlBody.data.watchlist.id;
  const unsubToken = wlBody.data.unsubscribe_token;
  const originalHash = wlBody.data.watchlist.canonical_query_hash;

  // Cross-owner isolation (404)
  assert.equal(
    (
      await app.request(`/v1/watchlists/${watchlistId}`, {
        method: "PATCH",
        headers: otherHeaders,
        body: JSON.stringify({ name: "Hijack" }),
      })
    ).status,
    404,
  );

  // Switch notification locale -> 0 credits charged & identical canonical_query_hash
  const localeSwitch = await app.request(`/v1/watchlists/${watchlistId}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ locale: "zh-CN" }),
  });
  assert.equal(localeSwitch.status, 200);
  const localeBody = await localeSwitch.json();
  assert.equal(localeBody.meta.credits_charged, 0);
  assert.equal(localeBody.data.locale, "zh-CN");
  assert.equal(localeBody.data.canonical_query_hash, originalHash);

  // First evaluation triggers price_alert and queues 1 webhook delivery
  const eval1 = await (
    await app.request(`/v1/watchlists/${watchlistId}/evaluate`, {
      method: "POST",
      headers: jsonHeaders,
    })
  ).json();
  assert.equal(eval1.data.triggered, true);
  assert.equal(eval1.data.deliveries_queued, 1);

  // Second evaluation in same month hits monthly_budget_exceeded cleanly without triggering extra query
  const eval2 = await (
    await app.request(`/v1/watchlists/${watchlistId}/evaluate`, {
      method: "POST",
      headers: jsonHeaders,
    })
  ).json();
  assert.equal(eval2.data.evaluated, false);
  assert.equal(eval2.data.skipped_reason, "monthly_budget_exceeded");
  assert.equal(eval2.data.credits_charged, 0);

  // Dispatch signed webhook & verify HMAC signature + replay guard
  const proc1 = await alertService.processNextDelivery({ userId: x.user });
  assert.equal(proc1.outcome, "delivered");
  assert.equal(sentRequests.length, 1);
  assert.equal(
    verifyWebhookSignature(
      signingSecret,
      sentRequests[0].body,
      sentRequests[0].signatureHeader,
      sentRequests[0].timestamp + 5,
    ),
    true,
  );
  const deliveredPayload = JSON.parse(sentRequests[0].body);
  assert.equal(deliveredPayload.data.locale, "zh-CN");
  assert.equal(deliveredPayload.data.sample_count, 12);

  // 5. Retry exhaustion (3 attempts -> dead_letter)
  const lowCreditsWl = await (
    await app.request("/v1/watchlists", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        name: "Low credit guard",
        trigger_kind: "low_credits",
        low_credits_threshold: 500,
        schedule_mode: "passive_reuse",
      }),
    })
  ).json();
  const lowId = lowCreditsWl.data.watchlist.id;
  const lowUnsub = lowCreditsWl.data.unsubscribe_token;
  await app.request(`/v1/watchlists/${lowId}/evaluate`, { method: "POST", headers: jsonHeaders });
  responseMode = "fail_500";
  await alertService.processNextDelivery({ userId: x.user });
  x.clock.value = new Date(Date.parse(x.now()) + 120000).toISOString();
  await alertService.processNextDelivery({ userId: x.user });
  x.clock.value = new Date(Date.parse(x.now()) + 240000).toISOString();
  const dlq = await alertService.processNextDelivery({ userId: x.user });
  assert.equal(dlq.outcome, "dead_letter");
  assert.equal(dlq.delivery.attempts, 3);

  // 6. Test one-click unsubscribe cancels queued deliveries cleanly with 0 outbound dispatch
  const jobWl = await (
    await app.request("/v1/watchlists", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        name: "Job done",
        query: { q: x.q.q, limit: x.q.limit },
        trigger_kind: "job_completed",
        schedule_mode: "passive_reuse",
      }),
    })
  ).json();
  await app.request(`/v1/watchlists/${jobWl.data.watchlist.id}/evaluate`, {
    method: "POST",
    headers: jsonHeaders,
  });
  const countBeforeUnsub = sentRequests.length;
  const unsubRes = await app.request("/v1/alerts/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: jobWl.data.unsubscribe_token }),
  });
  assert.equal(unsubRes.status, 200);
  const cancelledUnsub = await alertService.processNextDelivery({ userId: x.user });
  assert.equal(cancelledUnsub.outcome, "idle");
  assert.equal(sentRequests.length, countBeforeUnsub);
  const deliveriesAfterUnsub = await (
    await app.request("/v1/webhooks/deliveries", { headers: x.headers })
  ).json();
  assert.ok(
    deliveriesAfterUnsub.data.some(
      (d) =>
        d.status === "cancelled_rights_revoked" &&
        d.last_error === "watchlist_unsubscribed" &&
        d.attempts === 0,
    ),
  );
  assert.ok(unsubToken && lowUnsub);

  // 7. Source revocation cancels queued delivery carrying query_id with ZERO sends (never leaks revoked data!)
  responseMode = "ok";
  const passivePrice = await (
    await app.request("/v1/watchlists", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        name: "Passive revoke test",
        query: { q: x.q.q, limit: x.q.limit },
        trigger_kind: "price_above",
        threshold_cents: 100,
        schedule_mode: "passive_reuse",
      }),
    })
  ).json();
  await app.request(`/v1/watchlists/${passivePrice.data.watchlist.id}/evaluate`, {
    method: "POST",
    headers: jsonHeaders,
  });
  await db.query("UPDATE sources SET status='revoked',permission_epoch=permission_epoch+1 WHERE id=$1", [
    x.source.sourceId,
  ]);
  const sendsBeforeRevokeDispatch = sentRequests.length;
  const revokedDispatch = await alertService.processNextDelivery({ userId: x.user });
  assert.equal(revokedDispatch.outcome, "cancelled");
  assert.equal(revokedDispatch.delivery.status, "cancelled_rights_revoked");
  assert.equal(revokedDispatch.delivery.last_error, "source_rights_revoked");
  assert.equal(sentRequests.length, sendsBeforeRevokeDispatch);

  // 8. Non-fixture transport rejected with 503 webhook_transport_unavailable
  const badTransportSvc = new AlertWebhookService(x.query, {
    kind: "forbidden_live_http",
    async send() {
      throw new Error("must_not_send");
    },
  });
  const passiveLow = await (
    await app.request("/v1/watchlists", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        name: "Bad transport check",
        trigger_kind: "low_credits",
        low_credits_threshold: 999,
        schedule_mode: "passive_reuse",
      }),
    })
  ).json();
  await app.request(`/v1/watchlists/${passiveLow.data.watchlist.id}/evaluate`, {
    method: "POST",
    headers: jsonHeaders,
  });
  await assert.rejects(
    () => badTransportSvc.processNextDelivery({ userId: x.user }),
    (err) => err.code === "webhook_transport_unavailable" && err.status === 503,
  );
  assert.deepEqual(await x.billing.reconcile(), []);
});
