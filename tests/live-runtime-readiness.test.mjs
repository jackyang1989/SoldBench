import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "@soldbench/api";
import { AuthService, newAuthSecrets } from "@soldbench/auth";
import {
  BillingService,
  offerVersion,
  PaymentLifecycle,
  PayPalProviderAdapter,
  StripeProviderAdapter,
} from "@soldbench/billing";
import {
  CollectorStore,
  collectorHealth,
  EbayUsBrowserTransport,
  EbayUsHttpTransport,
  FixtureTransport,
  fixtureResponse,
  OfflineCollectorWorker,
  parseEbayCorpusJson,
  provisionFixtureSource,
  runEbayUsCorpusCycle,
} from "@soldbench/collector";
import { collectionQueryHash, normalizeQuery } from "@soldbench/core";
import { database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { QueryService } from "@soldbench/query";
import { loadConfig } from "@soldbench/shared";
import sharp from "sharp";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL);
const roots = [];
const servers = [];

before(() => migrate(db));
after(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
  await db.end();
});

async function makeRoot(prefix = "soldbench-live-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function startHttpServer(handler, onConnect) {
  const srv = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    await handler(req, Buffer.concat(chunks), res);
  });
  if (onConnect) srv.on("connect", onConnect);
  servers.push(srv);
  await new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", resolve);
  });
  const address = srv.address();
  return { server: srv, url: `http://127.0.0.1:${address.port}`, port: address.port };
}

test("loadConfig fails closed by default and validates live/sandbox combinations only when gate is acknowledged", () => {
  const def = loadConfig({});
  assert.equal(def.liveGateAcknowledged, false);
  assert.equal(def.dataMode, "offline_fixture");
  assert.equal(def.paymentsMode, "offline");
  assert.equal(def.collectorEnabled, false);
  assert.equal(def.mailTransport, "offline");
  assert.equal(def.collectorProxyUrl, null);
  assert.equal(def.collectorProxySummary, null);

  assert.throws(() => loadConfig({ DATA_MODE: "approved_network" }), /Only offline_fixture is enabled/);
  assert.throws(() => loadConfig({ COLLECTOR_ENABLED: "true" }), /separately approved/);
  assert.throws(() => loadConfig({ PAYMENTS_MODE: "stripe_paypal_live" }), /Payment network access/);
  assert.throws(() => loadConfig({ MAIL_TRANSPORT: "resend" }), /SOLDBENCH_LIVE_GATE_ACKNOWLEDGED=true/);
  assert.throws(() => loadConfig({ NODE_ENV: "production" }), /Production release gates/);

  const offlineProxy = loadConfig({
    COLLECTOR_PROXY_URL: "http://proxyuser:s%40cret@127.0.0.1:8888",
  });
  assert.equal(offlineProxy.collectorProxyUrl, "http://proxyuser:s%40cret@127.0.0.1:8888");
  assert.deepEqual(offlineProxy.collectorProxySummary, {
    host: "127.0.0.1",
    port: 8888,
    protocol: "http:",
    hasAuth: true,
  });

  const liveProd = loadConfig({
    SOLDBENCH_LIVE_GATE_ACKNOWLEDGED: "true",
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    APP_ORIGIN: "https://api.soldbench.com",
    DATA_MODE: "approved_network",
    COLLECTOR_ENABLED: "true",
    PAYMENTS_MODE: "stripe_paypal_live",
    STRIPE_SECRET_KEY: "sk_live_test",
    STRIPE_WEBHOOK_SECRET: "whsec_live_test",
    STRIPE_MERCHANT_ID: "acct_live_test",
    PAYPAL_CLIENT_ID: "pp_live_id",
    PAYPAL_CLIENT_SECRET: "pp_live_secret",
    PAYPAL_WEBHOOK_ID: "WH_PP_LIVE",
    PAYPAL_MERCHANT_ID: "PP_MERCH_LIVE",
    MAIL_TRANSPORT: "resend",
    MAIL_FROM: "no-reply@soldbench.com",
    RESEND_API_KEY: "re_test_key",
    COLLECTOR_PROXY_URL: "http://u:p@proxy.example.test:3128",
  });
  assert.equal(liveProd.liveGateAcknowledged, true);
  assert.equal(liveProd.origin, "https://api.soldbench.com");
  assert.equal(liveProd.dataMode, "approved_network");
  assert.equal(liveProd.collectorEnabled, true);
  assert.equal(liveProd.paymentsMode, "stripe_paypal_live");
  assert.equal(liveProd.mail.mode, "resend");
  assert.equal(liveProd.collectorProxyUrl, "http://u:p@proxy.example.test:3128");
  assert.deepEqual(liveProd.collectorProxySummary, {
    host: "proxy.example.test",
    port: 3128,
    protocol: "http:",
    hasAuth: true,
  });

  const smtpLive = loadConfig({
    SOLDBENCH_LIVE_GATE_ACKNOWLEDGED: "true",
    MAIL_TRANSPORT: "smtp",
    MAIL_FROM: "no-reply@soldbench.com",
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: "465",
    SMTP_SECURE: "true",
    SMTP_USER: "mailer",
    SMTP_PASS: "app-pass",
  });
  assert.equal(smtpLive.mail.mode, "smtp");
  assert.equal(smtpLive.mail.secure, true);

  assert.throws(
    () =>
      loadConfig({
        SOLDBENCH_LIVE_GATE_ACKNOWLEDGED: "true",
        PAYMENTS_MODE: "stripe_paypal_sandbox",
        PAYMENT_FIXTURES: "true",
        STRIPE_SECRET_KEY: "sk",
        STRIPE_WEBHOOK_SECRET: "whsec",
        STRIPE_MERCHANT_ID: "acct",
      }),
    /cannot be combined/,
  );
  assert.throws(
    () =>
      loadConfig({
        SOLDBENCH_LIVE_GATE_ACKNOWLEDGED: "true",
        COLLECTOR_ENABLED: "true",
        DATA_MODE: "offline_fixture",
      }),
    /requires DATA_MODE=approved_network/,
  );
  assert.throws(
    () =>
      loadConfig({
        SOLDBENCH_LIVE_GATE_ACKNOWLEDGED: "true",
        NODE_ENV: "production",
        APP_ORIGIN: "http://soldbench.com",
      }),
    /must use https:\/\//,
  );
  assert.throws(
    () =>
      loadConfig({
        SOLDBENCH_LIVE_GATE_ACKNOWLEDGED: "true",
        PAYMENTS_MODE: "stripe_paypal_live",
      }),
    /Configure Stripe or PayPal credentials/,
  );
  assert.throws(
    () =>
      loadConfig({
        SOLDBENCH_LIVE_GATE_ACKNOWLEDGED: "true",
        STRIPE_SECRET_KEY: "sk_only",
        STRIPE_WEBHOOK_SECRET: "whsec_only",
      }),
    /Incomplete Stripe credentials/,
  );
  assert.throws(
    () =>
      loadConfig({
        SOLDBENCH_LIVE_GATE_ACKNOWLEDGED: "true",
        PAYPAL_CLIENT_ID: "id_only",
      }),
    /Incomplete PayPal credentials/,
  );
  assert.throws(
    () =>
      loadConfig({
        SOLDBENCH_LIVE_GATE_ACKNOWLEDGED: "true",
        MAIL_TRANSPORT: "resend",
        MAIL_FROM: "no-reply@soldbench.com",
      }),
    /RESEND_API_KEY is required/,
  );
  assert.throws(
    () =>
      loadConfig({
        SOLDBENCH_LIVE_GATE_ACKNOWLEDGED: "true",
        COLLECTOR_PROXY_URL: "socks5://127.0.0.1:1080",
      }),
    /invalid_collector_proxy_url/,
  );
});

test("PG16 QueryService and collectorHealth strictly isolate offline_fixture vs approved_network sources", async () => {
  const tokenA = `FixIsoA_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const tokenB = `NetIsoB_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const tokenC = `DraftIsoC_${randomUUID().replace(/-/g, "").slice(0, 8)}`;

  const fx = await createProductFixture(db, roots, {
    count: 8,
    extra: false,
    keyword: tokenA,
    clockValue: "2026-11-23T10:00:00.000Z",
  });
  const mediaRoot = await makeRoot("soldbench-iso-media-");
  const media = new PrivateMediaStore(mediaRoot);
  const now = () => "2026-11-23T10:00:00.000Z";

  async function seedCustomSource(keyword, accessMethod, provider, clearanceStatus) {
    const src = await provisionFixtureSource(db, now(), { retentionDays: 7 });
    const store = new CollectorStore(db, now);
    const q = normalizeQuery(new URLSearchParams({ q: keyword, limit: "10" }));
    const qHash = collectionQueryHash(q);
    await store.enqueue({ ...src, queryHash: qHash, runKey: randomUUID(), asOf: now() });
    const rows = Array.from({ length: 8 }, (_, idx) => ({
      listingId: `${keyword}-listing-${idx}`,
      title: `${keyword} Item ${idx}`,
      candidate: {
        sourceId: src.sourceId,
        eventKey: `${keyword}-ev-${idx}`,
        identityVerified: true,
        comparable: true,
        priceStatus: "verified_actual",
        format: "fixed_price",
        currency: "USD",
        itemCents: 2500 + idx * 100,
        shippingCents: 0,
        shippingStatus: "verified_free_shipping",
        condition: "good",
        title: `${keyword} Item ${idx}`,
        time: { precision: "instant", value: now() },
      },
    }));
    const frames = new Map([
      [
        "page:start",
        [
          fixtureResponse({
            schema: "soldbench.synthetic-page.v1",
            synthetic: true,
            sourceId: src.sourceId,
            queryHash: qHash,
            cursor: "start",
            nextCursor: null,
            asOf: now(),
            empty: false,
            records: rows,
          }),
        ],
      ],
    ]);
    assert.equal(
      (await new OfflineCollectorWorker(store, new FixtureTransport(frames), media).runOne(src.sourceId))
        .status,
      "completed",
    );
    const { source_clearance_id: clearanceId } = (
      await db.query("SELECT source_clearance_id FROM sources WHERE id=$1", [src.sourceId])
    ).rows[0];
    if (clearanceStatus === "active") {
      await db.query(
        "UPDATE source_clearances SET provider=$2, status=$3, document_ref='doc-ref-1', document_hash='doc-hash-1', reviewed_by='legal-reviewer', reviewed_at=$4, effective_at='2026-11-23T00:00:00Z', expires_at='2027-11-23T00:00:00Z' WHERE id=$1",
        [clearanceId, provider, clearanceStatus, now()],
      );
    } else {
      await db.query("UPDATE source_clearances SET provider=$2, status=$3 WHERE id=$1", [
        clearanceId,
        provider,
        clearanceStatus,
      ]);
    }
    await db.query("UPDATE sources SET access_method=$2 WHERE id=$1", [src.sourceId, accessMethod]);
    return { ...src, q };
  }

  const netActive = await seedCustomSource(tokenB, "approved_http", "ebay_us_http", "active");
  const netDraft = await seedCustomSource(tokenC, "approved_http", "ebay_us_http", "draft");

  const offlineQuery = fx.query;
  const networkQuery = new QueryService(db, fx.auth, fx.billing, media, now, "approved_network");

  // Offline mode sees tokenA synthetic fixture, never approved_http tokenB.
  const offFixSub = await offlineQuery.submit(
    fx.identity,
    normalizeQuery(new URLSearchParams({ q: tokenA, limit: "10" })),
  );
  assert.equal((await offlineQuery.workOnce("iso-off-on-fix")).status, "completed");
  const offFixRes = await offlineQuery.result(
    fx.identity,
    offFixSub.queryId,
    randomUUID(),
    true,
    randomUUID(),
  );
  assert.equal(offFixRes.data.stats.n_price_verified, 8);

  await assert.rejects(
    () => offlineQuery.submit(fx.identity, normalizeQuery(new URLSearchParams({ q: tokenB, limit: "10" }))),
    { code: "source_unavailable" },
  );

  // Network mode ignores tokenA (synthetic) and tokenC (draft), sees ONLY active approved_http tokenB.
  await assert.rejects(
    () => networkQuery.submit(fx.identity, normalizeQuery(new URLSearchParams({ q: tokenA, limit: "10" }))),
    { code: "source_unavailable" },
  );
  await assert.rejects(() => networkQuery.submit(fx.identity, netDraft.q), {
    code: "source_unavailable",
  });

  const netActiveSub = await networkQuery.submit(fx.identity, netActive.q);
  assert.equal((await networkQuery.workOnce("iso-net-on-active")).status, "completed");
  const netActiveRes = await networkQuery.result(
    fx.identity,
    netActiveSub.queryId,
    randomUUID(),
    true,
    randomUUID(),
  );
  assert.equal(netActiveRes.data.stats.n_price_verified, 8);
  assert.equal(netActiveRes.data.stats.median_cents, 2850);

  const healthOffline = await collectorHealth(db, fx.source.sourceId, {
    now: now(),
    dataMode: "offline_fixture",
  });
  assert.equal(healthOffline.sourceId, fx.source.sourceId);
  await assert.rejects(
    () => collectorHealth(db, netActive.sourceId, { now: now(), dataMode: "offline_fixture" }),
    /network_collector_not_enabled/,
  );

  const healthNetwork = await collectorHealth(db, netActive.sourceId, {
    now: now(),
    dataMode: "approved_network",
  });
  assert.equal(healthNetwork.sourceId, netActive.sourceId);
  assert.equal(healthNetwork.sourceStopped, false);
  await assert.rejects(
    () => collectorHealth(db, fx.source.sourceId, { now: now(), dataMode: "approved_network" }),
    /network_collector_not_enabled/,
  );
  const draftHealthNetwork = await collectorHealth(db, netDraft.sourceId, {
    now: now(),
    dataMode: "approved_network",
  });
  assert.equal(draftHealthNetwork.sourceStopped, true);
});

test("Hono createApp live-sandbox checkout + real Stripe/PayPal webhook verification settle credits atomically", async () => {
  const stripeLog = [];
  const stripeSrv = await startHttpServer((req, body, res) => {
    stripeLog.push({ url: req.url, body: body.toString("utf8") });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/checkout/sessions") {
      res.end(JSON.stringify({ id: "cs_live_test_1", url: "https://checkout.stripe.test/pay/1" }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });

  const paypalLog = [];
  const paypalSrv = await startHttpServer((req, body, res) => {
    paypalLog.push({ url: req.url, body: body.toString("utf8") });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/oauth2/token") {
      res.end(JSON.stringify({ access_token: "pp_tok_live", expires_in: 3600 }));
      return;
    }
    if (req.url === "/v2/checkout/orders") {
      res.end(
        JSON.stringify({
          id: "ORD_LIVE_1",
          links: [{ rel: "approve", href: "https://www.paypal.test/checkoutnow?token=ORD_LIVE_1" }],
        }),
      );
      return;
    }
    if (req.url === "/v1/notifications/verify-webhook-signature") {
      res.end(JSON.stringify({ verification_status: "SUCCESS" }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });

  const webhookSecret = "whsec_live_roundtrip_secret";
  const liveConfig = loadConfig({
    SOLDBENCH_LIVE_GATE_ACKNOWLEDGED: "true",
    PAYMENTS_MODE: "stripe_paypal_sandbox",
    STRIPE_SECRET_KEY: "sk_test_roundtrip",
    STRIPE_WEBHOOK_SECRET: webhookSecret,
    STRIPE_MERCHANT_ID: "acct_roundtrip_1",
    STRIPE_API_BASE_URL: stripeSrv.url,
    PAYPAL_CLIENT_ID: "pp_id_roundtrip",
    PAYPAL_CLIENT_SECRET: "pp_secret_roundtrip",
    PAYPAL_WEBHOOK_ID: "WH_PP_ROUNDTRIP",
    PAYPAL_MERCHANT_ID: "PP_MERCH_ROUNDTRIP",
    PAYPAL_API_BASE_URL: paypalSrv.url,
  });

  const clock = { value: "2026-11-23T12:00:00.000Z" };
  const now = () => clock.value;
  const nowSec = Math.floor(Date.parse(clock.value) / 1000);
  const auth = new AuthService(db, newAuthSecrets(), liveConfig.origin, now);
  const billing = new BillingService(db, now);
  const stripe = new StripeProviderAdapter({ ...liveConfig.stripe, environment: "sandbox" });
  const paypal = new PayPalProviderAdapter({ ...liveConfig.paypal, environment: "sandbox" });
  const payments = new PaymentLifecycle(
    billing,
    liveConfig.origin,
    {},
    { environment: "sandbox", stripe, paypal },
  );
  const mediaRoot = await makeRoot("soldbench-pay-media-");
  const query = new QueryService(
    db,
    auth,
    billing,
    new PrivateMediaStore(mediaRoot),
    now,
    liveConfig.dataMode,
  );
  const app = createApp(liveConfig, db, { auth, billing, query, payments });

  const sessionToken = auth.crypto.token("sb_s_");
  const csrfToken = auth.crypto.hash("auth.csrf", sessionToken);
  const userId = (
    await db.query(
      "INSERT INTO users(email,password_hash,status,email_verified_at,free_anchor_at) VALUES($1,'fixture','active',$2,$2) RETURNING id",
      [`livepay-${randomUUID()}@example.test`, now()],
    )
  ).rows[0].id;
  await db.query(
    "INSERT INTO sessions(user_id,token_hash,csrf_hash,created_at,authenticated_at,expires_at) VALUES($1,$2,$3,$4,$4,'2027-01-01T00:00:00Z')",
    [
      userId,
      auth.crypto.hash("auth.session", sessionToken),
      auth.crypto.hash("auth.csrf-store", csrfToken),
      now(),
    ],
  );
  const sessionHeaders = {
    Cookie: `soldbench_session=${sessionToken}`,
    Origin: liveConfig.origin,
    "X-CSRF-Token": csrfToken,
    "Content-Type": "application/json",
  };
  const hostHeader = new URL(liveConfig.origin).host;

  // 1. Stripe topup checkout + signed webhook settlement
  const stripeCheckoutRes = await app.request("/billing/checkout", {
    method: "POST",
    headers: { ...sessionHeaders, "Idempotency-Key": `chk-stripe-${randomUUID()}` },
    body: JSON.stringify({ plan_code: "purchased_1500", offer_version: offerVersion, provider: "stripe" }),
  });
  assert.equal(stripeCheckoutRes.status, 200);
  const stripeCheckoutBody = await stripeCheckoutRes.json();
  assert.equal(stripeCheckoutBody.data.provider, "stripe");
  assert.equal(stripeCheckoutBody.data.checkout_url, "https://checkout.stripe.test/pay/1");

  const stripeForm = new URLSearchParams(stripeLog[0].body);
  const stripeIntentId = stripeForm.get("client_reference_id");
  assert.ok(stripeIntentId);
  const stripeIntentRow = (
    await db.query("SELECT environment, state FROM payment_checkout_intents WHERE id=$1", [stripeIntentId])
  ).rows[0];
  assert.equal(stripeIntentRow.environment, "sandbox");
  assert.equal(stripeIntentRow.state, "pending");

  clock.value = "2026-11-23T12:00:10.000Z";
  const webhookNowSec = Math.floor(Date.parse(clock.value) / 1000);
  const stripePaidSec = nowSec + 5;

  const stripeWebhookBytes = Buffer.from(
    JSON.stringify({
      id: `evt_live_${randomUUID()}`,
      type: "payment_intent.succeeded",
      created: stripePaidSec,
      data: {
        object: {
          id: `pi_live_${randomUUID()}`,
          amount: 1000,
          currency: "usd",
          created: stripePaidSec,
          metadata: { checkout_intent_id: stripeIntentId },
        },
      },
    }),
  );
  const badSigRes = await app.request("/webhooks/stripe", {
    method: "POST",
    headers: {
      Host: hostHeader,
      "Content-Type": "application/json",
      "Stripe-Signature": `t=${webhookNowSec},v1=${"0".repeat(64)}`,
    },
    body: stripeWebhookBytes,
  });
  assert.equal(badSigRes.status, 403);

  const validSig = createHmac("sha256", webhookSecret)
    .update(`${webhookNowSec}.`)
    .update(stripeWebhookBytes)
    .digest("hex");
  const stripeWhHeader = {
    Host: hostHeader,
    "Content-Type": "application/json",
    "Stripe-Signature": `t=${webhookNowSec},v1=${validSig}`,
  };
  const stripeWhRes = await app.request("/webhooks/stripe", {
    method: "POST",
    headers: stripeWhHeader,
    body: stripeWebhookBytes,
  });
  assert.equal(stripeWhRes.status, 200);

  // Replay identical event bytes -> idempotent 200, no double grant
  const replayRes = await app.request("/webhooks/stripe", {
    method: "POST",
    headers: stripeWhHeader,
    body: stripeWebhookBytes,
  });
  assert.equal(replayRes.status, 200);

  // Conflicting bytes with same event id -> 409 idempotency_conflict
  const conflictBytes = Buffer.from(stripeWebhookBytes.toString("utf8").replace('"usd"', '"USD"'));
  const conflictSig = createHmac("sha256", webhookSecret)
    .update(`${webhookNowSec}.`)
    .update(conflictBytes)
    .digest("hex");
  const conflictRes = await app.request("/webhooks/stripe", {
    method: "POST",
    headers: {
      Host: hostHeader,
      "Content-Type": "application/json",
      "Stripe-Signature": `t=${webhookNowSec},v1=${conflictSig}`,
    },
    body: conflictBytes,
  });
  assert.equal(conflictRes.status, 409);

  // 2. PayPal subscription checkout + loopback verification settlement
  const ppCheckoutRes = await app.request("/billing/checkout", {
    method: "POST",
    headers: { ...sessionHeaders, "Idempotency-Key": `chk-pp-${randomUUID()}` },
    body: JSON.stringify({ plan_code: "pro", offer_version: offerVersion, provider: "paypal" }),
  });
  assert.equal(ppCheckoutRes.status, 200);
  const createOrderReq = paypalLog.find((r) => r.url === "/v2/checkout/orders");
  const ppIntentId = JSON.parse(createOrderReq.body).purchase_units[0].custom_id;

  clock.value = "2026-11-23T12:00:20.000Z";
  const ppWebhookBytes = Buffer.from(
    JSON.stringify({
      id: `WH-LIVE-${randomUUID()}`,
      event_type: "PAYMENT.SALE.COMPLETED",
      create_time: "2026-11-23T12:00:15Z",
      resource: {
        id: `CAP_LIVE_${randomUUID()}`,
        custom_id: ppIntentId,
        billing_agreement_id: `I-PP-SUB-${randomUUID().slice(0, 8)}`,
        period_start: "2026-11-23T12:00:10Z",
        period_end: "2026-12-23T12:00:10Z",
        amount: { currency_code: "USD", value: "29.00" },
        create_time: "2026-11-23T12:00:15Z",
      },
    }),
  );
  const ppWhRes = await app.request("/webhooks/paypal", {
    method: "POST",
    headers: {
      Host: hostHeader,
      "Content-Type": "application/json",
      "paypal-transmission-id": "tx-live-1",
      "paypal-transmission-time": "2026-11-23T11:59:55Z",
      "paypal-cert-url": "https://api.paypal.test/cert.pem",
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-transmission-sig": "sig-live",
    },
    body: ppWebhookBytes,
  });
  assert.equal(ppWhRes.status, 200);

  const wallets = await db.query(
    "SELECT bucket_type, balance FROM credit_wallets WHERE user_id=$1 ORDER BY bucket_type",
    [userId],
  );
  const purchasedWallet = wallets.rows.find((r) => r.bucket_type === "purchased");
  const subWallet = wallets.rows.find((r) => r.bucket_type === "subscription");
  assert.equal(Number(purchasedWallet?.balance), 1500);
  assert.equal(Number(subWallet?.balance), 10000);
  assert.deepEqual(await billing.reconcile(), []);
});

test("Explicit HTTP/CONNECT proxy egress enforces allowlist pre-checks, Proxy-Authorization, fail-closed 407/403, browser config, and runner telemetry redaction", async () => {
  const onePixelPng = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "green" },
  })
    .png()
    .toBuffer();

  const detailPath = "/itm/123456789012";
  const redirectDetailPath = "/itm/999999999999";
  const imagePath = "/images/g/proxy-item/s-l1600.png";
  const q = normalizeQuery(new URLSearchParams({ q: "Proxy Test Watch" }));
  const qHash = collectionQueryHash(q);

  let targetSrvUrl = "";
  const targetSrv = await startHttpServer((req, _body, res) => {
    const reqUrl = new URL(req.url ?? "/", targetSrvUrl);
    if (reqUrl.pathname === "/sch/i.html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html><body>
        <div class="srp-controls__count-heading">1 result for Proxy Test Watch</div>
        <div class="srp-river-results"><ul class="srp-results">
          <li class="s-item">
            <div class="s-item__image-wrapper"><img class="s-item__image-img" src="https://i.ebayimg.com${imagePath}"></div>
            <div class="s-item__info">
              <div class="s-item__caption"><span class="POSITIVE">Sold Nov 20, 2026</span></div>
              <a class="s-item__link" href="https://www.ebay.com${detailPath}"><div class="s-item__title">Proxy Test Watch Automatic</div></a>
              <span class="s-item__price">$1,200.00</span>
              <span class="s-item__shipping">Free shipping</span>
            </div>
          </li>
        </ul></div>
      </body></html>`);
      return;
    }
    if (reqUrl.pathname === detailPath) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html><head><link rel="canonical" href="https://www.ebay.com${detailPath}"></head><body>
        <div class="ux-layout-section--itemId"><span class="ux-textspans--BOLD">123456789012</span></div>
        <div data-testid="x-item-condition-atf"><span class="ux-textspans">Good</span></div>
        <div class="d-item-description">Clean watch verified via proxy</div>
      </body></html>`);
      return;
    }
    if (reqUrl.pathname === imagePath) {
      res.setHeader("Content-Type", "image/png");
      res.end(onePixelPng);
      return;
    }
    if (reqUrl.pathname === redirectDetailPath) {
      res.statusCode = 302;
      res.setHeader("Location", "http://169.254.169.254/latest/meta-data");
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  targetSrvUrl = targetSrv.url;

  const proxyRequests = [];
  let connectBehavior = "reject_407";
  const expectedAuth = `Basic ${Buffer.from("proxyuser:p@ss!word").toString("base64")}`;

  const proxySrv = await startHttpServer(
    (req, _body, res) => {
      proxyRequests.push({
        method: req.method,
        url: req.url,
        hasAuth: req.headers["proxy-authorization"] === expectedAuth,
      });
      if (req.headers["proxy-authorization"] !== expectedAuth) {
        res.statusCode = 407;
        res.setHeader("Proxy-Authenticate", 'Basic realm="test"');
        res.end();
        return;
      }
      let forwardUrl;
      try {
        forwardUrl = new URL(req.url ?? "");
      } catch {
        res.statusCode = 400;
        res.end();
        return;
      }
      const fwd = httpRequest(
        forwardUrl,
        {
          method: "GET",
          headers: { Accept: req.headers.accept ?? "*/*", "User-Agent": req.headers["user-agent"] ?? "ua" },
        },
        (upRes) => {
          res.statusCode = upRes.statusCode ?? 502;
          for (const [k, v] of Object.entries(upRes.headers)) {
            if (v !== undefined) res.setHeader(k, v);
          }
          upRes.pipe(res);
        },
      );
      fwd.on("error", () => {
        res.statusCode = 502;
        res.end();
      });
      fwd.end();
    },
    (req, socket) => {
      proxyRequests.push({
        method: "CONNECT",
        url: req.url,
        hasAuth: req.headers["proxy-authorization"] === expectedAuth,
      });
      if (connectBehavior === "reject_407") {
        socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n");
        return;
      }
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    },
  );

  const encodedProxyUrl = `http://proxyuser:p%40ss!word@127.0.0.1:${proxySrv.port}`;
  const wrongPassProxyUrl = `http://proxyuser:wrong@127.0.0.1:${proxySrv.port}`;

  // Disallowed origin fails BEFORE touching proxy.
  assert.throws(
    () => new EbayUsHttpTransport({ query: q, origin: "http://127.0.0.1:9999", proxyUrl: encodedProxyUrl }),
    /ebay_origin_not_allowed/,
  );
  assert.equal(proxyRequests.length, 0);

  // Valid proxy forwarding fetches search page, detail page, and image with Proxy-Authorization.
  const tx = new EbayUsHttpTransport({
    query: q,
    origin: targetSrvUrl,
    imageOriginOverride: targetSrvUrl,
    allowLoopbackTestOrigin: true,
    proxyUrl: encodedProxyUrl,
    minIntervalMs: 0,
  });
  assert.equal(tx.egressMode, "explicit_proxy");
  assert.deepEqual(tx.proxySummary, {
    host: "127.0.0.1",
    port: proxySrv.port,
    protocol: "http:",
    hasAuth: true,
  });
  assert.equal(JSON.stringify(tx).includes("p@ss"), false);

  const pageRes = await tx.read("page:start");
  assert.equal(pageRes.status, 200);
  const detailRes = await tx.read("detail:123456789012");
  assert.equal(detailRes.status, 200);
  const imgRes = await tx.read(`image:https://i.ebayimg.com${imagePath}`);
  assert.equal(imgRes.status, 200);
  assert.equal(imgRes.bytes.equals(onePixelPng), true);
  assert.equal(proxyRequests.length, 3);
  assert.ok(proxyRequests.every((r) => r.hasAuth && r.url.startsWith(targetSrvUrl)));

  // 407 on HTTP proxy forwarding fails closed with proxy_auth_required.
  const badAuthTx = new EbayUsHttpTransport({
    query: q,
    origin: targetSrvUrl,
    allowLoopbackTestOrigin: true,
    proxyUrl: wrongPassProxyUrl,
    minIntervalMs: 0,
  });
  await assert.rejects(() => badAuthTx.read("page:start"), { message: "proxy_auth_required" });

  // HTTPS CONNECT 407 and 403 fail closed without hitting real eBay.
  const connectTx = new EbayUsHttpTransport({
    query: q,
    proxyUrl: encodedProxyUrl,
    minIntervalMs: 0,
  });
  connectBehavior = "reject_407";
  await assert.rejects(() => connectTx.read("page:start"), { message: "proxy_auth_required" });
  connectBehavior = "reject_403";
  await assert.rejects(() => connectTx.read("page:start"), { message: "proxy_connect_failed" });
  const connectLogs = proxyRequests.filter((r) => r.method === "CONNECT");
  assert.equal(connectLogs.length, 2);
  assert.equal(connectLogs[0].url, "www.ebay.com:443");
  assert.equal(connectLogs[0].hasAuth, true);

  // Disallowed SSRF redirect over proxy throws http_redirect_rejected and never dials 169.254.169.254.
  await assert.rejects(() => tx.read("detail:999999999999"), {
    message: "http_redirect_rejected",
  });
  assert.equal(
    proxyRequests.some((r) => r.url.includes("169.254.169.254")),
    false,
  );

  // Runner cycle over loopback proxy reports redacted egress metadata.
  const mediaRoot = await makeRoot("soldbench-proxy-media-");
  const spoolDir = await makeRoot("soldbench-proxy-spool-");
  const targets = parseEbayCorpusJson(JSON.stringify([{ id: "proxy-watch", q: "Proxy Test Watch" }]));
  assert.equal(targets[0].queryHash, qHash);
  const report = await runEbayUsCorpusCycle({
    db,
    targets,
    transport: "http",
    origin: targetSrvUrl,
    imageOriginOverride: targetSrvUrl,
    allowLoopbackTestOrigin: true,
    proxyUrl: encodedProxyUrl,
    minIntervalMs: 0,
    maxDetails: 1,
    mediaRoot,
    spoolDir,
    asOf: "2026-11-23T12:00:00Z",
  });
  assert.equal(report.completedTargets, 1);
  assert.equal(report.egressMode, "explicit_proxy");
  assert.equal(report.proxyHost, "127.0.0.1");
  const serializedReport = JSON.stringify(report);
  assert.equal(serializedReport.includes("proxyuser"), false);
  assert.equal(serializedReport.includes("p@ss"), false);

  // Browser transport passes Playwright proxy object to chromium.launch without leaking creds in telemetry.
  const stubDir = await makeRoot("soldbench-pw-stub-");
  const stubPath = join(stubDir, "pw-stub.mjs");
  await writeFile(
    stubPath,
    `export const captured = [];
export const chromium = {
  async launch(opts) {
    captured.push(opts);
    return {
      async newContext() {
        return {
          async newPage() {
            return {
              url: () => opts.proxy?.server ?? "about:blank",
              request: { async fetch() { return { status: () => 200, headers: () => ({}), async body() { return Buffer.from(""); } }; } },
              async route() {},
              async goto() { return { status: () => 200, headers: () => ({ "content-type": "text/html" }) }; },
              async waitForSelector() {},
              async content() { return "<html><body>ok</body></html>"; },
              async close() {},
            };
          },
          async close() {},
        };
      },
      async close() {},
    };
  },
};
`,
  );
  const prevBrowserModule = process.env.SOLDBENCH_BROWSER_MODULE;
  process.env.SOLDBENCH_BROWSER_MODULE = stubPath;
  try {
    const browserTx = new EbayUsBrowserTransport({
      query: q,
      origin: targetSrvUrl,
      allowLoopbackTestOrigin: true,
      executablePath: "/usr/bin/true",
      proxyUrl: encodedProxyUrl,
      minIntervalMs: 0,
    });
    assert.equal(browserTx.egressMode, "explicit_proxy");
    assert.equal(browserTx.proxySummary?.hasAuth, true);
    const bRes = await browserTx.read("page:start");
    assert.equal(bRes.status, 200);
    const { captured } = await import(stubPath);
    assert.deepEqual(captured[0].proxy, {
      server: `http://127.0.0.1:${proxySrv.port}`,
      username: "proxyuser",
      password: "p@ss!word",
    });
  } finally {
    if (prevBrowserModule === undefined) {
      delete process.env.SOLDBENCH_BROWSER_MODULE;
    } else {
      process.env.SOLDBENCH_BROWSER_MODULE = prevBrowserModule;
    }
  }
});
