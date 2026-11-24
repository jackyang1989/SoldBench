import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { createApp } from "@soldbench/api";
import { AuthService, localAuthSecrets } from "@soldbench/auth";
import { BillingService } from "@soldbench/billing";
import {
  CollectorRefresh,
  CollectorStore,
  collectorHealth,
  collectorRunEvidence,
  FixtureTransport,
  OfflineCollectorWorker,
  parseEbayCorpusJson,
  provisionApprovedEbaySource,
  runEbayUsCorpusCycle,
} from "@soldbench/collector";
import { collectionQueryHash, normalizeQuery } from "@soldbench/core";
import { database, migrate } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { QueryService, ResearchService } from "@soldbench/query";
import { loadConfig } from "@soldbench/shared";
import sharp from "sharp";

const execFileAsync = promisify(execFile);
const db = database(process.env.DATABASE_URL);
const roots = [];
const servers = [];

before(() => migrate(db));
after(async () => {
  for (const srv of servers) {
    srv.closeAllConnections();
    await new Promise((resolve) => srv.close(resolve));
  }
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
  await db.end();
});

async function makeRoot(prefix = "soldbench-live-e2e-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function startHttpServer(handler) {
  const srv = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    await handler(req, Buffer.concat(chunks), res);
  });
  servers.push(srv);
  await new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", resolve);
  });
  const addr = srv.address();
  return { server: srv, url: `http://127.0.0.1:${addr.port}`, port: addr.port };
}

function makeFakeEbayServerSetup({ keyword, itemIds, basePrice, pngBytes }) {
  let baseUrl = "";
  const idSet = new Set(itemIds);
  const handler = (req, _body, res) => {
    const reqUrl = new URL(req.url ?? "/", baseUrl);
    if (reqUrl.pathname === "/sch/i.html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html><body>
        <div class="srp-controls__count-heading">${itemIds.length} results for ${keyword}</div>
        <div class="srp-river-results"><ul class="srp-results">
          ${itemIds
            .map(
              (id, idx) => `
            <li class="s-item">
              <div class="s-item__image-wrapper"><img class="s-item__image-img" src="https://i.ebayimg.com/images/g/item-${id}.png"></div>
              <div class="s-item__info">
                <div class="s-item__caption"><span class="POSITIVE">Sold Nov 22, 2026</span></div>
                <a class="s-item__link" href="https://www.ebay.com/itm/${id}"><div class="s-item__title">${keyword} #${idx + 1}</div></a>
                <span class="s-item__price">$${(basePrice + idx * 100).toLocaleString("en-US")}.00</span>
                <span class="s-item__shipping">Free shipping</span>
              </div>
            </li>`,
            )
            .join("\n")}
        </ul></div>
      </body></html>`);
      return;
    }
    const itemMatch = /^\/itm\/(\d+)$/.exec(reqUrl.pathname);
    if (itemMatch?.[1] && idSet.has(itemMatch[1])) {
      const id = itemMatch[1];
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html><head><link rel="canonical" href="https://www.ebay.com/itm/${id}"></head><body>
        <div class="ux-layout-section--itemId"><span class="ux-textspans--BOLD">${id}</span></div>
        <div data-testid="x-item-condition-atf"><span class="ux-textspans">Like New</span></div>
        <div class="ux-layout-section--itemSpecifics"><dl class="ux-labels-values">
          <dt>Brand</dt><dd>Omega</dd>
        </dl></div>
        <div class="d-item-description">Approved live sample #${id}</div>
      </body></html>`);
      return;
    }
    if (/^\/images\/g\/item-\d+\.png$/.test(reqUrl.pathname)) {
      res.setHeader("Content-Type", "image/png");
      res.end(pngBytes);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  };
  return {
    handler,
    setBaseUrl(url) {
      baseUrl = url;
    },
  };
}

function makeAuthProxyHandler(expectedAuth) {
  const hits = [];
  const handler = (req, _body, res) => {
    const authOk = req.headers["proxy-authorization"] === expectedAuth;
    hits.push({ url: req.url, authOk });
    if (!authOk) {
      res.statusCode = 407;
      res.setHeader("Proxy-Authenticate", 'Basic realm="soldbench-proxy"');
      res.end();
      return;
    }
    const fwd = httpRequest(
      new URL(req.url ?? ""),
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
  };
  return { hits, handler };
}

test("provisionApprovedEbaySource enforces audit inputs fail-closed and runs full approved_network pipeline through API, refresh, evidence, maintenance, and revocation", async () => {
  const validHash = createHash("sha256").update("approved-contract-2026").digest("hex");
  await assert.rejects(
    () =>
      provisionApprovedEbaySource(db, {
        accessMethod: "approved_http",
        provider: "synthetic_fixture",
        documentRef: "CONTRACT-1",
        documentHash: validHash,
        reviewedBy: "legal-ops",
        effectiveAt: "2026-11-23T00:00:00Z",
        expiresAt: "2027-01-01T00:00:00Z",
      }),
    /invalid_approved_provider/,
  );
  await assert.rejects(
    () =>
      provisionApprovedEbaySource(db, {
        accessMethod: "approved_http",
        documentRef: "CONTRACT-1",
        documentHash: "not-a-sha256",
        reviewedBy: "legal-ops",
        effectiveAt: "2026-11-23T00:00:00Z",
        expiresAt: "2027-01-01T00:00:00Z",
      }),
    /invalid_approved_document_hash/,
  );
  await assert.rejects(
    () =>
      provisionApprovedEbaySource(db, {
        accessMethod: "approved_http",
        documentRef: "CONTRACT-1",
        documentHash: validHash,
        reviewedBy: "legal-ops",
        effectiveAt: "2026-12-01T00:00:00Z",
        expiresAt: "2026-11-23T00:00:00Z",
      }),
    /invalid_approved_clearance_window/,
  );

  const asOf = "2026-11-24T01:00:00.000Z";
  const provisioned = await provisionApprovedEbaySource(db, {
    accessMethod: "approved_http",
    provider: "ebay_us_http",
    documentRef: "EBAY-US-CONTRACT-2026",
    documentHash: validHash,
    reviewedBy: "legal-ops",
    effectiveAt: "2026-11-24T00:00:00Z",
    expiresAt: "2027-11-24T00:00:00Z",
    now: asOf,
  });
  assert.equal(provisioned.accessMethod, "approved_http");
  assert.equal(provisioned.provider, "ebay_us_http");

  const pngBytes = await sharp({ create: { width: 12, height: 12, channels: 3, background: "navy" } })
    .png()
    .toBuffer();
  const keyword = `Omega Seamaster Live ${randomUUID().slice(0, 6)}`;
  const itemIds = Array.from({ length: 8 }, (_, idx) => `41000000000${idx}`);
  const targetSetup = makeFakeEbayServerSetup({ keyword, itemIds, basePrice: 1000, pngBytes });
  const targetSrv = await startHttpServer(targetSetup.handler);
  targetSetup.setBaseUrl(targetSrv.url);

  const proxyAuth = `Basic ${Buffer.from("liveops:p@ssword1").toString("base64")}`;
  const proxySetup = makeAuthProxyHandler(proxyAuth);
  const proxySrv = await startHttpServer(proxySetup.handler);
  const proxyUrl = `http://liveops:p%40ssword1@127.0.0.1:${proxySrv.port}`;

  const root = await makeRoot("soldbench-approved-net-");
  const mediaRoot = join(root, "media");
  const spoolDir = join(root, "spool");
  const stateRoot = join(root, "state");
  await mkdir(mediaRoot, { recursive: true, mode: 0o700 });
  await mkdir(spoolDir, { recursive: true, mode: 0o700 });
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });

  const targets = parseEbayCorpusJson(JSON.stringify([{ id: "live-omega", q: keyword }]));

  await assert.rejects(
    () =>
      runEbayUsCorpusCycle({
        db,
        targets,
        dataMode: "approved_network",
        transport: "http",
        origin: targetSrv.url,
        imageOriginOverride: targetSrv.url,
        allowLoopbackTestOrigin: true,
        proxyUrl,
        minIntervalMs: 0,
        mediaRoot,
        spoolDir,
        asOf,
      }),
    /approved_source_id_required/,
  );

  const cycleReport = await runEbayUsCorpusCycle({
    db,
    targets,
    dataMode: "approved_network",
    sourceId: provisioned.sourceId,
    configId: provisioned.configId,
    transport: "http",
    origin: targetSrv.url,
    imageOriginOverride: targetSrv.url,
    allowLoopbackTestOrigin: true,
    proxyUrl,
    minIntervalMs: 0,
    maxDetails: 8,
    mediaRoot,
    spoolDir,
    asOf,
  });
  assert.equal(cycleReport.mode, "approved_network");
  assert.equal(cycleReport.completedTargets, 1);
  assert.equal(cycleReport.recordsObserved, 8);
  assert.equal(cycleReport.imagesStored, 8);
  assert.equal(cycleReport.detailsCompleted, 8);
  assert.equal(cycleReport.egressMode, "explicit_proxy");
  assert.equal(cycleReport.proxyHost, "127.0.0.1");
  assert.ok(proxySetup.hits.length >= 17);
  assert.ok(proxySetup.hits.every((h) => h.authOk));

  const liveConfig = loadConfig({
    SOLDBENCH_LIVE_GATE_ACKNOWLEDGED: "true",
    DATA_MODE: "approved_network",
    COLLECTOR_ENABLED: "true",
    COLLECTOR_PROXY_URL: proxyUrl,
    LOCAL_STATE_ROOT: stateRoot,
    MEDIA_ROOT: mediaRoot,
  });
  const now = () => asOf;
  const auth = new AuthService(db, localAuthSecrets(stateRoot), liveConfig.origin, now);
  const billing = new BillingService(db, now);
  const media = new PrivateMediaStore(mediaRoot);
  const liveQuery = new QueryService(db, auth, billing, media, now, "approved_network");
  const offlineQuery = new QueryService(db, auth, billing, media, now, "offline_fixture");
  const app = createApp(liveConfig, db, { auth, billing, query: liveQuery });

  const userId = (
    await db.query(
      "INSERT INTO users(email,password_hash,status,email_verified_at,free_anchor_at) VALUES($1,'fixture','active',$2,$2) RETURNING id",
      [`live-e2e-${randomUUID()}@example.test`, now()],
    )
  ).rows[0].id;
  const apiKey = auth.crypto.token("sb_k_");
  await db.query(
    "INSERT INTO api_keys(user_id,name,key_hash,key_prefix,scopes) VALUES($1,'live-e2e',$2,'sb_k_live',$3)",
    [userId, auth.crypto.hash("auth.api-key", apiKey), ["sold:read", "jobs:read", "usage:read"]],
  );
  const apiHeaders = { Authorization: `Bearer ${apiKey}` };
  const identity = await auth.keyIdentity(apiKey, "sold:read");

  // Offline mode rejects approved_http snapshot; approved_network mode serves it via HTTP API + image proxy.
  await assert.rejects(
    () => offlineQuery.submit(identity, normalizeQuery(new URLSearchParams({ q: keyword, limit: "10" }))),
    { code: "source_unavailable" },
  );

  const submitRes = await app.request(`/v1/sold?${new URLSearchParams({ q: keyword, limit: "10" })}`, {
    headers: apiHeaders,
  });
  assert.equal(submitRes.status, 202);
  const queryId = (await submitRes.json()).data.query_id;
  assert.equal((await liveQuery.workOnce("live-pipeline-worker")).status, "completed");

  const claimRes = await app.request(`/v1/sold/${queryId}/claim`, {
    method: "POST",
    headers: { ...apiHeaders, "Idempotency-Key": `claim-live-${randomUUID()}` },
  });
  assert.equal(claimRes.status, 200);
  const claimBody = await claimRes.json();
  assert.equal(claimBody.data.stats.n_price_verified, 8);
  assert.equal(claimBody.data.stats.median_cents, 135000);
  assert.equal(claimBody.data.comps.length, 8);

  const research = new ResearchService(liveQuery);
  const drawer = await research.detail(identity, queryId, claimBody.data.comps[0].sale_event_id);
  assert.equal(drawer.fields.condition.value.standard, "like_new");
  assert.equal(drawer.fields.attributes.value.brand, "Omega");
  assert.match(drawer.fields.description.value, /Approved live sample/);

  const mediaUrl = new URL(claimBody.data.comps[0].primary_image.url, "http://127.0.0.1").pathname;
  const imgRes = await app.request(mediaUrl, { headers: apiHeaders });
  assert.equal(imgRes.status, 200);
  assert.equal(imgRes.headers.get("content-type"), "image/webp");
  const webpBytes = Buffer.from(await imgRes.arrayBuffer());
  assert.equal(webpBytes.subarray(0, 4).toString("ascii"), "RIFF");

  // Refresh, health, evidence & maintenance operate cleanly on approved_network source.
  const store = new CollectorStore(db, now, { dataMode: "approved_network" });
  const refresh = new CollectorRefresh(store);
  const planId = await refresh.create({
    sourceId: provisioned.sourceId,
    configId: provisioned.configId,
    query: new URLSearchParams({ q: keyword }),
    key: `refresh-live-${randomUUID()}`,
    startAt: "2026-11-24T02:00:00Z",
    intervalSeconds: 3600,
    maxLagSeconds: 300,
  });
  assert.ok(planId);
  const health = await collectorHealth(db, provisioned.sourceId, {
    now: now(),
    dataMode: "approved_network",
  });
  assert.equal(health.mode, "approved_network");
  assert.equal(health.onlineVerified, true);
  assert.equal(health.sourceStopped, false);

  const evidence = await collectorRunEvidence(
    db,
    provisioned.sourceId,
    "2026-11-22",
    "2026-11-23",
    "approved_network",
  );
  assert.equal(evidence.mode, "approved_network");

  const maintWorker = new OfflineCollectorWorker(store, new FixtureTransport(new Map()), media);
  const maintActive = await maintWorker.runMaintenance(provisioned.sourceId);
  assert.equal(maintActive.mediaStoreMatched, true);
  assert.equal(maintActive.revocationPending, false);

  // Clearance revocation immediately denies API reads & drives private media cleanup in maintenance.
  await db.query("UPDATE source_clearances SET status='revoked' WHERE id=$1", [provisioned.clearanceId]);
  const stoppedHealth = await collectorHealth(db, provisioned.sourceId, {
    now: now(),
    dataMode: "approved_network",
  });
  assert.equal(stoppedHealth.sourceStopped, true);
  assert.equal((await app.request(`/v1/sold/${queryId}`, { headers: apiHeaders })).status, 403);
  assert.equal((await app.request(mediaUrl, { headers: apiHeaders })).status, 404);

  const maintRevoked = await maintWorker.runMaintenance(provisioned.sourceId);
  assert.equal(maintRevoked.revocationPending, false);
});

test("Real child-process CLIs run approved_network provisioning, proxied daemon ingestion, query+Resend mail worker, and maintenance", async () => {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const effectiveAt = `${todayUtc}T00:00:00.000Z`;
  const expiresAt = new Date(Date.now() + 30 * 86400_000).toISOString();
  const recentAsOf = new Date(Date.now() - 30_000).toISOString();
  const docHash = createHash("sha256").update("cli-contract-2026").digest("hex");

  const cliRoot = await makeRoot("soldbench-live-cli-");
  const stateRoot = join(cliRoot, "state");
  const mediaRoot = join(cliRoot, "media");
  const spoolDir = join(cliRoot, "spool");
  const corpusPath = join(cliRoot, "corpus.json");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await mkdir(mediaRoot, { recursive: true, mode: 0o700 });
  await mkdir(spoolDir, { recursive: true, mode: 0o700 });

  const keyword = `CLI Live Watch ${randomUUID().slice(0, 6)}`;
  await writeFile(corpusPath, JSON.stringify([{ id: "cli-target-1", q: keyword }]));

  const pngBytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "teal" } })
    .png()
    .toBuffer();
  const itemIds = Array.from({ length: 8 }, (_, idx) => `42000000000${idx}`);
  const targetSetup = makeFakeEbayServerSetup({ keyword, itemIds, basePrice: 2000, pngBytes });
  const targetSrv = await startHttpServer(targetSetup.handler);
  targetSetup.setBaseUrl(targetSrv.url);

  const proxyAuth = `Basic ${Buffer.from("cliuser:clipass").toString("base64")}`;
  const proxySetup = makeAuthProxyHandler(proxyAuth);
  const proxySrv = await startHttpServer(proxySetup.handler);
  const proxyUrl = `http://cliuser:clipass@127.0.0.1:${proxySrv.port}`;

  const resendSent = [];
  const resendSrv = await startHttpServer((req, body, res) => {
    resendSent.push({
      url: req.url,
      auth: req.headers.authorization,
      body: JSON.parse(body.toString("utf8")),
    });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: "re_cli_live_1" }));
  });

  const cliEnv = {
    ...process.env,
    SOLDBENCH_LIVE_GATE_ACKNOWLEDGED: "true",
    DATA_MODE: "approved_network",
    COLLECTOR_ENABLED: "true",
    COLLECTOR_PROXY_URL: proxyUrl,
    LOCAL_STATE_ROOT: stateRoot,
    MEDIA_ROOT: mediaRoot,
    COLLECTOR_DEMO_DIR: spoolDir,
    MAIL_TRANSPORT: "resend",
    MAIL_FROM: "no-reply@soldbench.com",
    RESEND_API_KEY: "re_cli_live_secret",
    RESEND_BASE_URL: resendSrv.url,
  };

  // 1. CLI provision approved source
  const { stdout: provStdout } = await execFileAsync(
    process.execPath,
    [
      "--import",
      "./scripts/test-network.mjs",
      "scripts/collector-provision-source.mjs",
      "--allow-live-provisioning=true",
      "--access-method=approved_http",
      "--provider=ebay_us_http",
      "--document-ref=CLI-CONTRACT-2026",
      `--document-hash=${docHash}`,
      "--reviewed-by=founder-audit",
      `--effective-at=${effectiveAt}`,
      `--expires-at=${expiresAt}`,
      `--now=${effectiveAt}`,
    ],
    { encoding: "utf8", env: cliEnv },
  );
  const provJson = JSON.parse(provStdout);
  assert.equal(provJson.ok, true);
  assert.equal(provJson.mode, "approved_network");

  // 2. CLI collector:ebay-daemon via explicit authenticated proxy
  const { stdout: daemonStdout } = await execFileAsync(
    process.execPath,
    [
      "--import",
      "./scripts/test-network.mjs",
      "scripts/collector-ebay-daemon.mjs",
      "--allow-live-fetch=true",
      `--corpus=${corpusPath}`,
      `--source=${provJson.sourceId}`,
      `--config=${provJson.configId}`,
      `--origin=${targetSrv.url}`,
      `--image-origin-override=${targetSrv.url}`,
      "--allow-loopback-test-origin=true",
      `--proxy-url=${proxyUrl}`,
      "--transport=http",
      "--min-interval-ms=0",
      "--max-details=8",
      `--spool=${spoolDir}`,
      `--as-of=${recentAsOf}`,
    ],
    { encoding: "utf8", env: cliEnv },
  );
  const daemonJson = JSON.parse(daemonStdout);
  assert.equal(daemonJson.ok, true);
  assert.equal(daemonJson.mode, "approved_network");
  assert.equal(daemonJson.completedTargets, 1);
  assert.equal(daemonJson.egressMode, "explicit_proxy");
  assert.equal(daemonJson.proxyHost, "127.0.0.1");

  // 3. Submit approved_network query + queue verification email using shared stateRoot secrets
  const workerConfig = loadConfig(cliEnv);
  const auth = new AuthService(db, localAuthSecrets(stateRoot), workerConfig.origin);
  const billing = new BillingService(db);
  const querySvc = new QueryService(
    db,
    auth,
    billing,
    new PrivateMediaStore(mediaRoot),
    undefined,
    "approved_network",
  );

  const userEmail = `cli-live-mail-${randomUUID()}@example.test`;
  await auth.register(
    { email: userEmail, password: "Passphrase-Live-123!", terms_version: "2026-11" },
    { clientId: "cli-live-e2e", locale: "en", requestId: randomUUID() },
  );
  const userRow = (await db.query("SELECT id FROM users WHERE lower(email)=$1", [userEmail])).rows[0];
  await db.query("UPDATE auth_mail_outbox SET created_at='2020-01-01T00:00:00Z' WHERE user_id=$1", [
    userRow.id,
  ]);
  const activeUserId = (
    await db.query(
      "INSERT INTO users(email,password_hash,status,email_verified_at,free_anchor_at) VALUES($1,'fixture','active',clock_timestamp(),clock_timestamp()) RETURNING id",
      [`cli-live-query-${randomUUID()}@example.test`],
    )
  ).rows[0].id;
  const apiSecret = auth.crypto.token("sb_k_");
  await db.query(
    "INSERT INTO api_keys(user_id,name,key_hash,key_prefix,scopes) VALUES($1,'cli-live',$2,'sb_k_cli',$3)",
    [activeUserId, auth.crypto.hash("auth.api-key", apiSecret), ["sold:read", "jobs:read"]],
  );
  const identity = await auth.keyIdentity(apiSecret, "sold:read");
  const normalizedQ = normalizeQuery(new URLSearchParams({ q: keyword, limit: "10" }));
  const submitted = await querySvc.submit(identity, normalizedQ);
  const qHash = collectionQueryHash(normalizedQ);
  assert.ok(qHash);

  // Run scripts/query-worker.mjs --once: must complete query under approved_network AND send mail via Resend!
  const { stdout: qwStdout } = await execFileAsync(
    process.execPath,
    ["--import", "./scripts/test-network.mjs", "scripts/query-worker.mjs", "--once"],
    { encoding: "utf8", env: cliEnv },
  );
  assert.match(qwStdout, /"data_mode":"approved_network"/);
  const qState = (await db.query("SELECT compute_status FROM queries WHERE id=$1", [submitted.queryId]))
    .rows[0];
  assert.equal(qState.compute_status, "completed");

  assert.equal(resendSent.length, 1);
  assert.equal(resendSent[0].auth, "Bearer re_cli_live_secret");
  assert.deepEqual(resendSent[0].body.to, [userEmail]);
  const mailOutbox = (
    await db.query("SELECT status, encrypted_payload FROM auth_mail_outbox WHERE user_id=$1", [userRow.id])
  ).rows[0];
  assert.equal(mailOutbox.status, "ready_offline");
  assert.equal(mailOutbox.encrypted_payload.length, 0);

  // 4. CLI collector:maintain in approved_network mode
  const { stdout: maintStdout } = await execFileAsync(
    process.execPath,
    [
      "--import",
      "./scripts/test-network.mjs",
      "scripts/collector-maintenance.mjs",
      `--source=${provJson.sourceId}`,
      "--require-clear",
    ],
    { encoding: "utf8", env: cliEnv },
  );
  const maintJson = JSON.parse(maintStdout);
  assert.equal(maintJson.mode, "approved_network");
  assert.equal(maintJson.sources, 1);
});
