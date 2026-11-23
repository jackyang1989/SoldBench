import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import {
  BillingService,
  fixtureSignature,
  formatUsdCentsForPayPal,
  merchant,
  PaymentLifecycle,
  PayPalProviderAdapter,
  parsePayPalUsdCents,
  StripeProviderAdapter,
  verifyStripeWebhookSignature,
} from "@soldbench/billing";
import { database, migrate } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL);
const roots = [];
const servers = [];

before(() => migrate(db));
after(async () => {
  await db.end();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  await Promise.all(roots.map((p) => rm(p, { recursive: true, force: true })));
});

async function startHttpServer(handler) {
  const srv = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    await handler(req, Buffer.concat(chunks), res);
  });
  servers.push(srv);
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address();
  return `http://127.0.0.1:${port}`;
}

test("Stripe adapter sends valid form requests, verifies HMAC signatures with replay/rotation checks, and settles into PaymentLifecycle", async () => {
  const stripeLog = [];
  const stripeBaseUrl = await startHttpServer((req, body, res) => {
    stripeLog.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      idem: req.headers["idempotency-key"],
      contentType: req.headers["content-type"],
      body: body.toString("utf8"),
    });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/checkout/sessions") {
      res.end(JSON.stringify({ id: "cs_test_123", url: "https://checkout.stripe.test/c/cs_test_123" }));
      return;
    }
    if (req.url === "/v1/billing_portal/sessions") {
      res.end(JSON.stringify({ url: "https://billing.stripe.test/p/bps_123" }));
      return;
    }
    if (req.url?.startsWith("/v1/subscriptions/")) {
      res.end(JSON.stringify({ id: "sub_stripe_1", cancel_at_period_end: true }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });

  const webhookSecret = "whsec_real_protocol_test_secret";
  const adapter = new StripeProviderAdapter({
    secretKey: "sk_test_soldbench_secret",
    webhookSecret,
    merchantId: merchant("stripe"),
    apiBaseUrl: stripeBaseUrl,
    environment: "offline_fixture",
  });

  const checkoutId = randomUUID();
  const userId = randomUUID();
  const session = await adapter.createCheckoutSession({
    checkoutIntentId: checkoutId,
    userId,
    planCode: "purchased_1500",
    amountCents: 1000,
    mode: "payment",
    successUrl: "https://soldbench.com/account/billing?ok=1",
    cancelUrl: "https://soldbench.com/account/billing?cancel=1",
    idempotencyKey: `stripe-chk-${randomUUID()}`,
  });
  assert.equal(session.sessionId, "cs_test_123");
  assert.equal(stripeLog[0].auth, "Bearer sk_test_soldbench_secret");
  assert.match(stripeLog[0].contentType, /application\/x-www-form-urlencoded/);
  const form = new URLSearchParams(stripeLog[0].body);
  assert.equal(form.get("client_reference_id"), checkoutId);
  assert.equal(form.get("line_items[0][price_data][unit_amount]"), "1000");

  const portal = await adapter.createBillingPortalSession({
    customerId: "cus_123",
    returnUrl: "https://soldbench.com/account/billing",
  });
  assert.equal(portal.url, "https://billing.stripe.test/p/bps_123");

  const subCancel = await adapter.cancelSubscriptionAtPeriodEnd({
    providerSubscriptionId: "sub_stripe_1",
    idempotencyKey: `cancel-${randomUUID()}`,
  });
  assert.equal(subCancel.cancelAtPeriodEnd, true);

  // Signature verification: rotation (multiple v1), replay window rejection, tampering rejection
  const nowSec = Math.floor(Date.parse("2026-11-17T12:00:00Z") / 1000);
  const rawPayload = Buffer.from(
    JSON.stringify({
      id: "evt_stripe_1",
      type: "payment_intent.succeeded",
      created: nowSec - 10,
      data: {
        object: {
          id: "pi_real_100",
          amount: 1000,
          currency: "usd",
          created: nowSec - 10,
          metadata: { checkout_intent_id: checkoutId },
        },
      },
    }),
  );
  const goodSig = createHmac("sha256", webhookSecret).update(`${nowSec}.`).update(rawPayload).digest("hex");
  const rotatedHeader = `t=${nowSec},v1=${"0".repeat(64)},v1=${goodSig}`;
  const translated = adapter.verifyAndTranslateWebhook(rawPayload, rotatedHeader, nowSec);
  assert.equal(translated.fact?.provider, "stripe");
  assert.equal(translated.fact?.status, "confirmed");
  assert.equal(translated.fact?.amount_cents, 1000);
  assert.equal(translated.fact?.object_id, "pi_real_100");

  assert.throws(
    () => verifyStripeWebhookSignature(rawPayload, `t=${nowSec - 600},v1=${goodSig}`, webhookSecret, nowSec),
    /outside tolerance window/,
  );
  assert.throws(
    () => verifyStripeWebhookSignature(Buffer.from("tampered"), rotatedHeader, webhookSecret, nowSec),
    /verification failed/,
  );

  // Non-USD currency fails closed
  const eurRaw = Buffer.from(
    JSON.stringify({
      id: "evt_eur",
      type: "payment_intent.succeeded",
      created: nowSec,
      data: {
        object: { id: "pi_eur", amount: 1000, currency: "eur", metadata: { checkout_intent_id: checkoutId } },
      },
    }),
  );
  const eurSig = createHmac("sha256", webhookSecret).update(`${nowSec}.`).update(eurRaw).digest("hex");
  assert.throws(() => adapter.verifyAndTranslateWebhook(eurRaw, `t=${nowSec},v1=${eurSig}`, nowSec), /USD/);

  // End-to-end PG16 settlement via PaymentLifecycle
  const x = await createProductFixture(db, roots, { count: 8, limit: 8, claimed: false });
  const config = loadConfig({ PAYMENT_FIXTURES: "true" });
  const fixtureKeys = { stripe: randomBytes(32).toString("hex"), paypal: randomBytes(32).toString("hex") };
  const payments = new PaymentLifecycle(new BillingService(db, x.now), config.origin, fixtureKeys);
  const owner = x.user;
  const order = await payments.checkout(
    owner,
    { plan_code: "purchased_1500", offer_version: "offline-v1", provider: "stripe" },
    `chk-${randomUUID()}`,
  );
  const realIntentId = order.checkout_url.split("/").at(-1);
  const realEvtRaw = Buffer.from(
    JSON.stringify({
      id: `evt_real_${randomUUID()}`,
      type: "payment_intent.succeeded",
      created: nowSec,
      data: {
        object: {
          id: `pi_live_${randomUUID().slice(0, 8)}`,
          amount: 1000,
          currency: "usd",
          created: nowSec,
          metadata: { checkout_intent_id: realIntentId },
        },
      },
    }),
  );
  const realSig = createHmac("sha256", webhookSecret).update(`${nowSec}.`).update(realEvtRaw).digest("hex");
  const { fact } = adapter.verifyAndTranslateWebhook(realEvtRaw, `t=${nowSec},v1=${realSig}`, nowSec);
  await payments.stageFixture(fact);
  const envelope = Buffer.from(
    JSON.stringify({
      id: randomUUID(),
      type: "payment_intent_succeeded",
      environment: "offline_fixture",
      merchant: merchant("stripe"),
      object_id: fact.object_id,
      revision: fact.revision,
    }),
  );
  await payments.receive(
    "stripe",
    new Headers({
      "Content-Type": "application/json",
      ...fixtureSignature("stripe", fixtureKeys.stripe, envelope, new Date(x.now())),
    }),
    envelope,
  );
  const applied = await payments.workOnce();
  assert.equal(applied?.status, "applied");
  const bal = await x.billing.balance(owner);
  assert.equal(bal.available_credits >= 1500, true);
  assert.deepEqual(await x.billing.reconcile(owner), []);
});

test("PayPal adapter caches OAuth tokens, formats BigInt USD strings, verifies webhooks, and translates capture/refund events", async () => {
  let tokenCalls = 0;
  let verifyShouldFail = false;
  const paypalLog = [];

  const paypalBaseUrl = await startHttpServer((req, body, res) => {
    const raw = body.toString("utf8");
    paypalLog.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/oauth2/token") {
      tokenCalls += 1;
      res.end(JSON.stringify({ access_token: "pp_tok_cached_1", expires_in: 3600 }));
      return;
    }
    if (req.url === "/v2/checkout/orders") {
      res.end(
        JSON.stringify({
          id: "ORD_PP_9001",
          links: [{ rel: "approve", href: "https://www.paypal.test/checkoutnow?token=ORD_PP_9001" }],
        }),
      );
      return;
    }
    if (req.url === "/v1/notifications/verify-webhook-signature") {
      res.end(JSON.stringify({ verification_status: verifyShouldFail ? "FAILURE" : "SUCCESS" }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });

  assert.equal(formatUsdCentsForPayPal(1000), "10.00");
  assert.equal(formatUsdCentsForPayPal(2905), "29.05");
  assert.equal(parsePayPalUsdCents("10.00"), 1000);
  assert.equal(parsePayPalUsdCents("19.99"), 1999);
  assert.throws(() => parsePayPalUsdCents("0.00"), /out of range/);

  const adapter = new PayPalProviderAdapter({
    clientId: "pp_client_id",
    clientSecret: "pp_client_secret",
    webhookId: "WH_PP_1",
    merchantId: merchant("paypal"),
    apiBaseUrl: paypalBaseUrl,
    environment: "offline_fixture",
  });

  const checkoutId = randomUUID();
  const order = await adapter.createOrder({
    checkoutIntentId: checkoutId,
    amountCents: 2900,
    returnUrl: "https://soldbench.com/account/billing?ok=1",
    cancelUrl: "https://soldbench.com/account/billing?cancel=1",
    idempotencyKey: "pp-req-key-123456",
  });
  assert.equal(order.orderId, "ORD_PP_9001");
  assert.equal(order.approveUrl, "https://www.paypal.test/checkoutnow?token=ORD_PP_9001");
  const createReq = paypalLog.find((r) => r.url === "/v2/checkout/orders");
  assert.equal(createReq.headers["paypal-request-id"], "pp-req-key-123456");
  assert.equal(JSON.parse(createReq.body).purchase_units[0].amount.value, "29.00");

  const ppEvent = Buffer.from(
    JSON.stringify({
      id: "WH-PP-EVT-1",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      create_time: "2026-11-17T12:00:00Z",
      resource: {
        id: "CAP_PP_1",
        custom_id: checkoutId,
        amount: { currency_code: "USD", value: "29.00" },
        create_time: "2026-11-17T12:00:00Z",
      },
    }),
  );
  const ppHeaders = new Headers({
    "paypal-transmission-id": "tx-1",
    "paypal-transmission-time": "2026-11-17T12:00:00Z",
    "paypal-cert-url": "https://api.paypal.test/cert.pem",
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-transmission-sig": "sig-base64",
  });
  const verified = await adapter.verifyAndTranslateWebhook(ppHeaders, ppEvent);
  assert.equal(verified.fact?.provider, "paypal");
  assert.equal(verified.fact?.amount_cents, 2900);
  assert.equal(verified.fact?.status, "confirmed");
  assert.equal(tokenCalls, 1);

  verifyShouldFail = true;
  await assert.rejects(() => adapter.verifyAndTranslateWebhook(ppHeaders, ppEvent), /rejected/);
});
