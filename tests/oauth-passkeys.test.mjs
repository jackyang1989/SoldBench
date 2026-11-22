import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { rm } from "node:fs/promises";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { OAuthService } from "@soldbench/auth";
import { database, migrate } from "@soldbench/db";
import { generate } from "otplib";
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

function sha256B64u(input) {
  return createHash("sha256").update(input, "ascii").digest("base64url");
}

function makeAuthData(rpId, flags, signCount) {
  const rpHash = createHash("sha256").update(rpId, "utf8").digest();
  const tail = Buffer.alloc(5);
  tail.writeUInt8(flags, 0);
  tail.writeUInt32BE(signCount, 1);
  return Buffer.concat([rpHash, tail]);
}

function buildAssertion({
  rpId,
  origin,
  challenge,
  type = "webauthn.get",
  flags = 0x05,
  signCount = 1,
  privateKey,
  algorithm = "ES256",
}) {
  const clientDataBytes = Buffer.from(JSON.stringify({ type, challenge, origin }), "utf8");
  const authDataBytes = makeAuthData(rpId, flags, signCount);
  const clientHash = createHash("sha256").update(clientDataBytes).digest();
  const payload = Buffer.concat([authDataBytes, clientHash]);
  const sig = algorithm === "Ed25519" ? sign(null, payload, privateKey) : sign("sha256", payload, privateKey);
  return {
    client_data_json: clientDataBytes.toString("base64url"),
    authenticator_data: authDataBytes.toString("base64url"),
    signature: sig.toString("base64url"),
  };
}

function cookieValue(res) {
  const setCookie = res.headers.get("set-cookie") ?? "";
  return /^soldbench_session=([^;]+)/.exec(setCookie)?.[1] ?? "";
}

async function setupServer() {
  let app;
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (r) => (app ? app.fetch(r) : new Response(null, { status: 503 })),
  });
  servers.push(server);
  await new Promise((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  const port = server.address().port;
  const x = await createProductFixture(db, roots, { limit: 50, prepareQuery: false, port });
  app = x.app;
  return { ...x, origin: `http://127.0.0.1:${port}`, rpId: "127.0.0.1" };
}

test("AT-061 Hosted MCP OAuth 2.1/PKCE enforces discovery, S256, exact redirect, client isolation, refresh replay revocation, and source rights", async () => {
  const x = await setupServer();
  const oauth = new OAuthService(x.auth);
  const email = `oauth-${randomUUID()}@example.test`;
  const password = "Passphrase-LongEnough-123!";

  await x.auth.register(
    { email, password, terms_version: "2026-11" },
    {
      clientId: "test",
      locale: "en",
      requestId: randomUUID(),
    },
  );
  const verifyRow = (await db.query("SELECT u.id AS user_id FROM users u WHERE lower(u.email)=$1", [email]))
    .rows[0];
  await db.query("UPDATE users SET status='active',email_verified_at=$2,free_anchor_at=$2 WHERE id=$1", [
    verifyRow.user_id,
    x.now(),
  ]);

  // Login web session for consent and grant management
  const loginRes = await x.auth.login(email, password, {
    clientId: "test",
    locale: "en",
    requestId: randomUUID(),
  });
  const webHeaders = {
    Origin: x.origin,
    Cookie: `soldbench_session=${loginRes.token}`,
    "X-CSRF-Token": loginRes.view.csrf_token,
    "Content-Type": "application/json",
  };

  // Discovery & MCP 401 WWW-Authenticate resource_metadata
  const prmRes = await fetch(`${x.origin}/.well-known/oauth-protected-resource`);
  assert.equal(prmRes.status, 200);
  const prm = await prmRes.json();
  assert.equal(prm.resource, `${x.origin}/mcp`);
  assert.deepEqual(prm.authorization_servers, [x.origin]);

  const asmRes = await fetch(`${x.origin}/.well-known/oauth-authorization-server`);
  assert.equal(asmRes.status, 200);
  const asm = await asmRes.json();
  assert.deepEqual(asm.code_challenge_methods_supported, ["S256"]);

  const mcpUnauth = await fetch(`${x.origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  assert.equal(mcpUnauth.status, 401);
  assert.match(
    mcpUnauth.headers.get("www-authenticate") ?? "",
    /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"/,
  );

  // Register two isolated clients
  const alphaRedirect = "http://127.0.0.1:51001/callback";
  const betaRedirect = "http://127.0.0.1:51002/callback";
  const { client: alpha } = await oauth.registerClient({
    client_id: "mcp-alpha-public",
    name: "MCP Client Alpha",
    client_type: "public",
    redirect_uris: [alphaRedirect],
    allowed_scopes: ["sold:read", "jobs:read"],
  });
  const { client: beta, client_secret: betaSecret } = await oauth.registerClient({
    client_id: "mcp-beta-conf",
    name: "MCP Client Beta",
    client_type: "confidential",
    redirect_uris: [betaRedirect],
    allowed_scopes: ["jobs:read"],
  });
  assert.ok(betaSecret);

  const verifier = "alpha-pkce-verifier-with-sufficient-entropy-0123456789";
  const challenge = sha256B64u(verifier);

  // Reject wrong redirect URI and plain PKCE
  const badRedirect = await x.app.request(
    `/oauth/authorize?response_type=code&client_id=${alpha.client_id}&redirect_uri=${encodeURIComponent("http://127.0.0.1:59999/evil")}&scope=sold:read&state=state-123456&code_challenge=${challenge}&code_challenge_method=S256`,
    { headers: { Cookie: `soldbench_session=${loginRes.token}` } },
  );
  assert.equal(badRedirect.status, 400);

  const badMethod = await x.app.request(
    `/oauth/authorize?response_type=code&client_id=${alpha.client_id}&redirect_uri=${encodeURIComponent(alphaRedirect)}&scope=sold:read&state=state-123456&code_challenge=${challenge}&code_challenge_method=plain`,
    { headers: { Cookie: `soldbench_session=${loginRes.token}` } },
  );
  assert.equal(badMethod.status, 400);

  // Explicit denial produces access_denied with zero codes/grants
  const denyRes = await x.app.request("/oauth/authorize", {
    method: "POST",
    headers: webHeaders,
    body: JSON.stringify({
      response_type: "code",
      client_id: alpha.client_id,
      redirect_uri: alphaRedirect,
      scope: "sold:read jobs:read",
      state: "deny-state-123",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${x.origin}/mcp`,
      approved: false,
    }),
  });
  assert.equal(denyRes.status, 200);
  const denyBody = await denyRes.json();
  assert.equal(denyBody.data.approved, false);
  assert.equal(denyBody.data.code, null);
  assert.match(denyBody.data.redirect_to, /error=access_denied/);

  async function issueTokens({
    clientId,
    clientSecret,
    redirectUri,
    scope,
    state,
    pkceVerifier,
    formEncoded = true,
  }) {
    const ch = sha256B64u(pkceVerifier);
    const consent = await x.app.request("/oauth/authorize", {
      method: "POST",
      headers: webHeaders,
      body: JSON.stringify({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope,
        state,
        code_challenge: ch,
        code_challenge_method: "S256",
        resource: `${x.origin}/mcp`,
        approved: true,
      }),
    });
    assert.equal(consent.status, 200);
    const code = (await consent.json()).data.code;
    assert.ok(code);

    const payload = {
      grant_type: "authorization_code",
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      code,
      redirect_uri: redirectUri,
      code_verifier: pkceVerifier,
      resource: `${x.origin}/mcp`,
    };
    const tokRes = await x.app.request("/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": formEncoded ? "application/x-www-form-urlencoded" : "application/json",
      },
      body: formEncoded ? new URLSearchParams(payload).toString() : JSON.stringify(payload),
    });
    assert.equal(tokRes.status, 200);
    return { code, tokens: await tokRes.json() };
  }

  // Wrong PKCE code_verifier fails
  const consentForBadVerifier = await x.app.request("/oauth/authorize", {
    method: "POST",
    headers: webHeaders,
    body: JSON.stringify({
      response_type: "code",
      client_id: alpha.client_id,
      redirect_uri: alphaRedirect,
      scope: "sold:read",
      state: "bad-verif-123",
      code_challenge: challenge,
      code_challenge_method: "S256",
      approved: true,
    }),
  });
  const badVerifCode = (await consentForBadVerifier.json()).data.code;
  const badVerifTok = await x.app.request("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: alpha.client_id,
      code: badVerifCode,
      redirect_uri: alphaRedirect,
      code_verifier: "wrong-verifier-does-not-match-the-s256-challenge-000000",
    }).toString(),
  });
  assert.equal(badVerifTok.status, 400);

  // Issue Alpha & Beta tokens; replay Alpha's authorization code -> revokes Alpha tokens immediately
  const firstAlpha = await issueTokens({
    clientId: alpha.client_id,
    redirectUri: alphaRedirect,
    scope: "sold:read jobs:read",
    state: "alpha-state-111",
    pkceVerifier: verifier,
    formEncoded: true,
  });
  const codeReplay = await x.app.request("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: alpha.client_id,
      code: firstAlpha.code,
      redirect_uri: alphaRedirect,
      code_verifier: verifier,
    }),
  });
  assert.equal(codeReplay.status, 400);
  const revokedMcpCheck = await fetch(`${x.origin}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${firstAlpha.tokens.access_token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  assert.equal(revokedMcpCheck.status, 401);

  // Re-authorize Alpha cleanly + authorize Beta (jobs:read only)
  const alphaGrant = await issueTokens({
    clientId: alpha.client_id,
    redirectUri: alphaRedirect,
    scope: "sold:read jobs:read",
    state: "alpha-state-222",
    pkceVerifier: verifier,
    formEncoded: true,
  });
  const betaGrant = await issueTokens({
    clientId: beta.client_id,
    clientSecret: betaSecret,
    redirectUri: betaRedirect,
    scope: "jobs:read",
    state: "beta-state-222",
    pkceVerifier: "beta-pkce-verifier-with-sufficient-entropy-01234567890",
    formEncoded: false,
  });

  // Cross-client refresh token attack fails
  const crossClientRefresh = await x.app.request("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: beta.client_id,
      client_secret: betaSecret,
      refresh_token: alphaGrant.tokens.refresh_token,
    }),
  });
  assert.equal(crossClientRefresh.status, 401);

  // Refresh rotation works once; replaying rotated refresh token revokes the entire token family
  const rotatedRes = await x.app.request("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: alpha.client_id,
      refresh_token: alphaGrant.tokens.refresh_token,
    }).toString(),
  });
  assert.equal(rotatedRes.status, 200);
  const rotatedTokens = await rotatedRes.json();
  assert.notEqual(rotatedTokens.access_token, alphaGrant.tokens.access_token);
  assert.notEqual(rotatedTokens.refresh_token, alphaGrant.tokens.refresh_token);

  // Beta lacks sold:read scope -> MCP rejects before any credit charge
  const betaMcp = await fetch(`${x.origin}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${betaGrant.tokens.access_token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  assert.equal(betaMcp.status, 403);

  // Alpha uses real MCP Client over StreamableHTTPClientTransport to run search -> worker -> claim -> stats
  const mcpClient = new Client(
    { name: "oauth-alpha-mcp", version: "1.0.0" },
    { versionNegotiation: { mode: "legacy" } },
  );
  clients.push(mcpClient);
  await mcpClient.connect(
    new StreamableHTTPClientTransport(new URL(`${x.origin}/mcp`), {
      authProvider: { token: async () => rotatedTokens.access_token },
      requestInit: { redirect: "error" },
    }),
  );
  const keyword = x.q.q;
  const searchOut = await mcpClient.callTool({
    name: "sold_search",
    arguments: { action: "search", query: { q: keyword, limit: 50 } },
  });
  const searchJson = JSON.parse(searchOut.content[0].text);
  const jobId = searchJson.data.job_id;
  for (let i = 0; i < 16; i += 1) {
    const row = (await db.query("SELECT status,query_id FROM query_jobs WHERE id=$1", [jobId])).rows[0];
    if (row.status === "completed") break;
    await x.query.workOnce("oauth-mcp-worker");
  }
  const queryId = (await db.query("SELECT query_id FROM query_jobs WHERE id=$1", [jobId])).rows[0].query_id;
  const claimOut = await mcpClient.callTool({
    name: "sold_search",
    arguments: {
      action: "claim",
      query_id: queryId,
      idempotency_key: `oauth-claim-${randomUUID()}`,
    },
  });
  const claimJson = JSON.parse(claimOut.content[0].text);
  assert.equal(claimJson.meta.credits_charged, 1);

  const statsOut = await mcpClient.callTool({
    name: "sold_stats",
    arguments: { query_id: queryId },
  });
  assert.equal(JSON.parse(statsOut.content[0].text).data.stats.n_price_verified, 58);

  // Replaying already-rotated old refresh token triggers family revocation & immediately blocks rotatedTokens.access_token
  const refreshReplay = await x.app.request("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: alpha.client_id,
      refresh_token: alphaGrant.tokens.refresh_token,
    }),
  });
  assert.equal(refreshReplay.status, 401);
  await assert.rejects(
    () => mcpClient.callTool({ name: "sold_stats", arguments: { query_id: queryId } }),
    /Unauthorized/,
  );

  // Re-authorize Alpha, list grants in owner session, verify DELETE grant revokes immediately, AND verify source revocation overrides OAuth!
  const alphaFresh = await issueTokens({
    clientId: alpha.client_id,
    redirectUri: alphaRedirect,
    scope: "sold:read jobs:read",
    state: "alpha-state-333",
    pkceVerifier: verifier,
    formEncoded: true,
  });
  const grantsRes = await x.app.request("/v1/oauth/grants", {
    headers: { Cookie: `soldbench_session=${loginRes.token}` },
  });
  assert.equal(grantsRes.status, 200);
  const grantsBody = await grantsRes.json();
  const alphaGrantRow = grantsBody.data.find((g) => g.client_id === alpha.client_id);
  assert.equal(alphaGrantRow.status, "active");

  // Revoke source -> even with active OAuth token, MCP stats must reject with 403 forbidden!
  await db.query("UPDATE sources SET status='revoked',permission_epoch=permission_epoch+1 WHERE id=$1", [
    x.source.sourceId,
  ]);
  const mcpAfterSourceRevoke = new Client(
    { name: "oauth-alpha-revoked-source", version: "1.0.0" },
    { versionNegotiation: { mode: "legacy" } },
  );
  clients.push(mcpAfterSourceRevoke);
  await mcpAfterSourceRevoke.connect(
    new StreamableHTTPClientTransport(new URL(`${x.origin}/mcp`), {
      authProvider: { token: async () => alphaFresh.tokens.access_token },
      requestInit: { redirect: "error" },
    }),
  );
  const statsRevokedSource = await mcpAfterSourceRevoke.callTool({
    name: "sold_stats",
    arguments: { query_id: queryId },
  });
  assert.equal(statsRevokedSource.isError, true);
  assert.equal(JSON.parse(statsRevokedSource.content[0].text).error.code, "forbidden");

  // Grant revocation revokes token immediately too
  const delGrant = await x.app.request(`/v1/oauth/grants/${alphaGrantRow.id}`, {
    method: "DELETE",
    headers: webHeaders,
  });
  assert.equal(delGrant.status, 204);
  const postRevokeHttp = await fetch(`${x.origin}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${alphaFresh.tokens.access_token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  assert.equal(postRevokeHttp.status, 401);
  assert.deepEqual(await x.billing.reconcile(), []);
});

test("AT-061 Passkeys support ES256 and Ed25519 registration/login, reject challenge/sign_count replays and wrong origin, and never downgrade TOTP MFA", async () => {
  const x = await setupServer();
  const email = `passkey-${randomUUID()}@example.test`;
  const password = "Passkey-User-Secret-123!";
  await x.auth.register(
    { email, password, terms_version: "2026-11" },
    {
      clientId: "test",
      locale: "en",
      requestId: randomUUID(),
    },
  );
  const userId = (await db.query("SELECT id FROM users WHERE lower(email)=$1", [email])).rows[0].id;
  await db.query("UPDATE users SET status='active',email_verified_at=$2,free_anchor_at=$2 WHERE id=$1", [
    userId,
    x.now(),
  ]);
  const login = await x.auth.login(email, password, {
    clientId: "test",
    locale: "en",
    requestId: randomUUID(),
  });

  // Setup & enable TOTP MFA on this user so we verify passkeys never downgrade MFA
  const mfaSetup = await x.app.request("/account/mfa/setup", {
    method: "POST",
    headers: {
      Origin: x.origin,
      Cookie: `soldbench_session=${login.token}`,
      "X-CSRF-Token": login.view.csrf_token,
    },
  });
  assert.equal(mfaSetup.status, 200);
  const totpSecret = (await mfaSetup.json()).data.secret;
  const code = () => generate({ secret: totpSecret, epoch: Date.parse(x.now()) / 1000 });
  const mfaConfirm = await x.app.request("/account/mfa/confirm", {
    method: "POST",
    headers: {
      Origin: x.origin,
      Cookie: `soldbench_session=${login.token}`,
      "X-CSRF-Token": login.view.csrf_token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ totp_code: await code() }),
  });
  assert.equal(mfaConfirm.status, 200);
  const mfaConfirmCookie = cookieValue(mfaConfirm);
  const mfaConfirmCsrf = (await mfaConfirm.json()).data.csrf_token;

  // Rotate after MFA reauthentication via reauthenticate to get fresh recent session
  x.clock.value = new Date(Date.parse(x.now()) + 30000).toISOString();
  const reauthRes = await x.app.request("/auth/reauthenticate", {
    method: "POST",
    headers: {
      Origin: x.origin,
      Cookie: `soldbench_session=${mfaConfirmCookie}`,
      "X-CSRF-Token": mfaConfirmCsrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password, totp_code: await code() }),
  });
  assert.equal(reauthRes.status, 200);
  const recentCookie = cookieValue(reauthRes);
  const recentCsrf = (await reauthRes.json()).data.csrf_token;
  const recentHeaders = {
    Origin: x.origin,
    Cookie: `soldbench_session=${recentCookie}`,
    "X-CSRF-Token": recentCsrf,
    "Content-Type": "application/json",
  };

  // Backdate session auth_at -> stale session must fail registration with 403 reauthentication_required
  await db.query("UPDATE sessions SET authenticated_at=$2 WHERE user_id=$1", [
    userId,
    new Date(Date.parse(x.now()) - 700000),
  ]);
  const staleRegOpts = await x.app.request("/v1/auth/passkeys/register/options", {
    method: "POST",
    headers: recentHeaders,
    body: JSON.stringify({ label: "Should fail" }),
  });
  assert.equal(staleRegOpts.status, 403);
  assert.equal((await staleRegOpts.json()).error.code, "reauthentication_required");

  // Restore fresh auth timestamp
  await db.query("UPDATE sessions SET authenticated_at=$2,mfa_at=$2 WHERE user_id=$1", [userId, x.now()]);

  // Generate ES256 and Ed25519 keypairs & register both
  const ecPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const edPair = generateKeyPairSync("ed25519");
  const ecSpki = ecPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const edSpki = edPair.publicKey.export({ type: "spki", format: "pem" }).toString();

  const regOpts1 = await (
    await x.app.request("/v1/auth/passkeys/register/options", {
      method: "POST",
      headers: recentHeaders,
      body: JSON.stringify({ label: "Laptop ES256" }),
    })
  ).json();
  const ecAssertion = buildAssertion({
    rpId: x.rpId,
    origin: x.origin,
    challenge: regOpts1.data.challenge,
    type: "webauthn.create",
    flags: 0x05,
    signCount: 0,
    privateKey: ecPair.privateKey,
    algorithm: "ES256",
  });
  const regVerify1 = await x.app.request("/v1/auth/passkeys/register/verify", {
    method: "POST",
    headers: recentHeaders,
    body: JSON.stringify({
      credential_id: "cred-es256-0001",
      public_key_spki_pem: ecSpki,
      algorithm: "ES256",
      label: "Laptop ES256",
      transports: ["internal"],
      client_data_json: ecAssertion.client_data_json,
      authenticator_data: ecAssertion.authenticator_data,
    }),
  });
  assert.equal(regVerify1.status, 201);
  const ecPasskeyId = (await regVerify1.json()).data.id;

  // Replay same registration challenge rejected 410
  const regReplay = await x.app.request("/v1/auth/passkeys/register/verify", {
    method: "POST",
    headers: recentHeaders,
    body: JSON.stringify({
      credential_id: "cred-es256-0002",
      public_key_spki_pem: ecSpki,
      algorithm: "ES256",
      client_data_json: ecAssertion.client_data_json,
      authenticator_data: ecAssertion.authenticator_data,
    }),
  });
  assert.equal(regReplay.status, 410);

  const regOpts2 = await (
    await x.app.request("/v1/auth/passkeys/register/options", {
      method: "POST",
      headers: recentHeaders,
      body: JSON.stringify({ label: "Security Key Ed25519" }),
    })
  ).json();
  const edRegAssertion = buildAssertion({
    rpId: x.rpId,
    origin: x.origin,
    challenge: regOpts2.data.challenge,
    type: "webauthn.create",
    flags: 0x05,
    signCount: 0,
    privateKey: edPair.privateKey,
    algorithm: "Ed25519",
  });
  const regVerify2 = await x.app.request("/v1/auth/passkeys/register/verify", {
    method: "POST",
    headers: recentHeaders,
    body: JSON.stringify({
      credential_id: "cred-ed25519-0002",
      public_key_spki_pem: edSpki,
      algorithm: "Ed25519",
      label: "Security Key Ed25519",
      transports: ["usb"],
      client_data_json: edRegAssertion.client_data_json,
      authenticator_data: edRegAssertion.authenticator_data,
    }),
  });
  assert.equal(regVerify2.status, 201);

  // Login with ES256 passkey UP=1, UV=0 (`flags = 0x01`): TOTP MFA user MUST keep mfa_required = true!
  const loginOpts1 = await (
    await x.app.request("/auth/passkeys/login/options", {
      method: "POST",
      headers: { Origin: x.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    })
  ).json();
  assert.equal(loginOpts1.data.allowCredentials.length, 2);
  const upOnlyAssertion = buildAssertion({
    rpId: x.rpId,
    origin: x.origin,
    challenge: loginOpts1.data.challenge,
    type: "webauthn.get",
    flags: 0x01,
    signCount: 1,
    privateKey: ecPair.privateKey,
    algorithm: "ES256",
  });
  const upOnlyVerify = await x.app.request("/auth/passkeys/login/verify", {
    method: "POST",
    headers: { Origin: x.origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      credential_id: "cred-es256-0001",
      ...upOnlyAssertion,
    }),
  });
  assert.equal(upOnlyVerify.status, 200);
  const upOnlyCookie = cookieValue(upOnlyVerify);
  assert.ok(upOnlyCookie);
  assert.equal((await upOnlyVerify.json()).data.mfa_required, true);
  // Session cannot bypass MFA!
  assert.equal(
    (await x.app.request("/v1/auth/passkeys", { headers: { Cookie: `soldbench_session=${upOnlyCookie}` } }))
      .status,
    403,
  );

  // Clone / sign_count replay (`signCount: 1` again <= stored `1`) rejected 401
  const loginOptsClone = await (
    await x.app.request("/auth/passkeys/login/options", {
      method: "POST",
      headers: { Origin: x.origin, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
  ).json();
  const cloneAssertion = buildAssertion({
    rpId: x.rpId,
    origin: x.origin,
    challenge: loginOptsClone.data.challenge,
    type: "webauthn.get",
    flags: 0x05,
    signCount: 1,
    privateKey: ecPair.privateKey,
    algorithm: "ES256",
  });
  const cloneVerify = await x.app.request("/auth/passkeys/login/verify", {
    method: "POST",
    headers: { Origin: x.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ credential_id: "cred-es256-0001", ...cloneAssertion }),
  });
  assert.equal(cloneVerify.status, 401);

  // Challenge replay on login rejected 410; wrong origin rejected 403
  const replayLogin = await x.app.request("/auth/passkeys/login/verify", {
    method: "POST",
    headers: { Origin: x.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ credential_id: "cred-es256-0001", ...upOnlyAssertion }),
  });
  assert.equal(replayLogin.status, 410);

  const wrongOriginAssertion = buildAssertion({
    rpId: x.rpId,
    origin: "https://phishing.example.test",
    challenge: loginOptsClone.data.challenge,
    type: "webauthn.get",
    flags: 0x05,
    signCount: 2,
    privateKey: ecPair.privateKey,
    algorithm: "ES256",
  });
  const wrongOriginVerify = await x.app.request("/auth/passkeys/login/verify", {
    method: "POST",
    headers: { Origin: x.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ credential_id: "cred-es256-0001", ...wrongOriginAssertion }),
  });
  assert.equal(wrongOriginVerify.status, 403);

  // Login with Ed25519 passkey UP+UV (`flags = 0x05`) + monotonic `signCount = 1` succeeds with mfa_required=false
  const loginOptsEd = await (
    await x.app.request("/auth/passkeys/login/options", {
      method: "POST",
      headers: { Origin: x.origin, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
  ).json();
  const edLoginAssertion = buildAssertion({
    rpId: x.rpId,
    origin: x.origin,
    challenge: loginOptsEd.data.challenge,
    type: "webauthn.get",
    flags: 0x05,
    signCount: 1,
    privateKey: edPair.privateKey,
    algorithm: "Ed25519",
  });
  const edLoginVerify = await x.app.request("/auth/passkeys/login/verify", {
    method: "POST",
    headers: { Origin: x.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ credential_id: "cred-ed25519-0002", ...edLoginAssertion }),
  });
  assert.equal(edLoginVerify.status, 200);
  const edCookie = cookieValue(edLoginVerify);
  const edBody = await edLoginVerify.json();
  assert.equal(edBody.data.mfa_required, false);
  const edListRes = await x.app.request("/v1/auth/passkeys", {
    headers: { Cookie: `soldbench_session=${edCookie}` },
  });
  assert.equal(edListRes.status, 200);
  assert.equal((await edListRes.json()).data.length, 2);

  // Revoke ES256 passkey; verify login with revoked passkey fails AND user_mfa remains enabled!
  const revokePasskey = await x.app.request(`/v1/auth/passkeys/${ecPasskeyId}`, {
    method: "DELETE",
    headers: {
      Origin: x.origin,
      Cookie: `soldbench_session=${edCookie}`,
      "X-CSRF-Token": edBody.data.csrf_token,
    },
  });
  assert.equal(revokePasskey.status, 204);

  const loginOptsAfterRevoke = await (
    await x.app.request("/auth/passkeys/login/options", {
      method: "POST",
      headers: { Origin: x.origin, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
  ).json();
  const revokedAssertion = buildAssertion({
    rpId: x.rpId,
    origin: x.origin,
    challenge: loginOptsAfterRevoke.data.challenge,
    type: "webauthn.get",
    flags: 0x05,
    signCount: 9,
    privateKey: ecPair.privateKey,
    algorithm: "ES256",
  });
  const revokedVerify = await x.app.request("/auth/passkeys/login/verify", {
    method: "POST",
    headers: { Origin: x.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ credential_id: "cred-es256-0001", ...revokedAssertion }),
  });
  assert.equal(revokedVerify.status, 401);

  // Confirm user_mfa stays enabled even after passkey revocation
  const mfaRow = (await db.query("SELECT state FROM user_mfa WHERE user_id=$1", [userId])).rows[0];
  assert.equal(mfaRow.state, "enabled");
});
