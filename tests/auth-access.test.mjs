import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "@soldbench/api";
import { AuthCrypto, AuthService, newAuthSecrets } from "@soldbench/auth";
import { database, migrate } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";
import { generate } from "otplib";

const db = database(process.env.DATABASE_URL),
  config = loadConfig({}),
  password = "Correct horse battery 17!";
before(async () => migrate(db));
after(async () => db.end());
function setup(shared) {
  const clock = shared?.clock ?? { value: "2026-11-17T12:00:00Z" },
    secrets = shared?.secrets ?? newAuthSecrets(),
    auth = new AuthService(db, secrets, config.origin, () => clock.value),
    context = { clientId: randomUUID(), locale: "en", requestId: randomUUID() };
  return {
    clock,
    secrets,
    auth,
    context,
    email: `user-${randomUUID()}@example.test`,
    app: createApp(config, db, { auth }),
  };
}
async function mail(x, purpose) {
  const row = (
    await db.query(
      "SELECT m.* FROM auth_mail_outbox m JOIN users u ON u.id=m.user_id WHERE u.email=$1 AND m.purpose=$2 ORDER BY m.created_at DESC,m.id DESC LIMIT 1",
      [x.email, purpose],
    )
  ).rows[0];
  assert.ok(row);
  const payload = x.auth.crypto.open(row.encrypted_payload, `auth.mail:${row.id}`);
  return { row, payload, token: new URLSearchParams(new URL(payload.link).hash.slice(1)).get("token") };
}
async function register(x, verified = true) {
  await x.auth.register({ email: x.email, password, terms_version: "offline-v1" }, x.context);
  if (verified) await x.auth.verifyEmail((await mail(x, "verify_email")).token, x.context);
  return x.auth.login(x.email, password, x.context);
}
const advance = (x, ms) => {
  x.clock.value = new Date(Date.parse(x.clock.value) + ms).toISOString();
};
function request(x, path, { method = "GET", token, csrf, body, origin = config.origin, headers = {} } = {}) {
  return x.app.request(path, {
    method,
    headers: {
      ...(method !== "GET" ? { Origin: origin } : {}),
      ...(token ? { Cookie: `soldbench_session=${token}` } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function enableMfa(x, login) {
  const pending = await x.auth.mfaSetup(login.token, x.context),
    code = await generate({ secret: pending.secret, epoch: Date.parse(x.clock.value) / 1000 }),
    confirmed = await x.auth.mfaConfirm(login.token, code, x.context);
  return { ...confirmed, secret: pending.secret };
}

test("registration and verification persist encrypted localized mail and single-use hash-only tokens", async () => {
  const x = setup();
  x.context.locale = "zh-CN";
  await x.auth.register(
    { email: ` ${x.email.toUpperCase()} `, password, terms_version: "offline-v1" },
    x.context,
  );
  const { row, payload, token } = await mail(x, "verify_email");
  assert.equal(row.locale, "zh-CN");
  assert.equal(row.status, "queued_offline");
  assert.equal(row.encrypted_payload.includes(Buffer.from(payload.link)), false);
  const stored = (await db.query("SELECT * FROM auth_tokens WHERE id=$1", [row.token_id])).rows[0];
  assert.notEqual(stored.token_hash, token);
  const event = (await db.query("SELECT payload FROM outbox WHERE event_key=$1", [`auth-mail:${row.id}`]))
    .rows[0].payload;
  assert.equal(JSON.stringify(event).includes(token), false);
  const before = (await db.query("SELECT * FROM users WHERE email=$1", [x.email])).rows[0];
  assert.equal(before.status, "pending");
  assert.match(before.password_hash, /^scrypt\$131072\$8\$1\$/);
  await x.auth.verifyEmail(token, x.context);
  await assert.rejects(x.auth.verifyEmail(token, x.context), (e) => e.status === 410);
  const user = (await db.query("SELECT * FROM users WHERE email=$1", [x.email])).rows[0];
  assert.equal(user.status, "active");
  assert.equal(user.free_anchor_at.toISOString(), new Date(x.clock.value).toISOString());
  assert.equal(
    (await db.query("SELECT * FROM outbox WHERE event_key=$1", [`email-verified:${user.id}`])).rowCount,
    1,
  );
  await x.auth.register(
    { email: x.email, password: "A different password 17!", terms_version: "offline-v1" },
    x.context,
  );
  assert.equal((await x.auth.login(x.email, password, x.context)).view.email_verified, true);
});

test("session reauthentication rotates cookie/CSRF without extending expiry and revocation is immediate", async () => {
  const x = setup(),
    a = await register(x),
    rotated = await x.auth.reauthenticate(a.token, password, undefined, x.context);
  assert.notEqual(rotated.token, a.token);
  assert.notEqual(rotated.view.csrf_token, a.view.csrf_token);
  assert.equal(rotated.view.expires_at, a.view.expires_at);
  await assert.rejects(x.auth.sessionIdentity(a.token));
  const b = await x.auth.login(x.email, password, x.context),
    sessions = await x.auth.listSessions(rotated.token),
    target = sessions.find((s) => !s.is_current);
  await x.auth.revokeSession(rotated.token, target.id, x.context);
  await assert.rejects(x.auth.sessionIdentity(b.token));
  advance(x, 604800000);
  await assert.rejects(x.auth.sessionIdentity(rotated.token));
});

test("password changes invalidate existing reset links and resetting twice cannot change credentials again", async () => {
  const x = setup(),
    a = await register(x);
  await x.auth.requestMail(x.email, "reset_password", x.context);
  const old = (await mail(x, "reset_password")).token;
  await x.auth.changePassword(a.token, password, "Replacement correct horse 17!", x.context);
  await assert.rejects(x.auth.sessionIdentity(a.token));
  await assert.rejects(
    x.auth.resetPassword(old, "Attacker new password 17!", x.context),
    (e) => e.status === 410,
  );
  advance(x, 61000);
  await x.auth.requestMail(x.email, "reset_password", x.context);
  const token = (await mail(x, "reset_password")).token;
  await x.auth.resetPassword(token, "Final correct horse 17!", x.context);
  await assert.rejects(
    x.auth.resetPassword(token, "Another correct horse 17!", x.context),
    (e) => e.status === 410,
  );
  assert.equal((await x.auth.login(x.email, "Final correct horse 17!", x.context)).view.email_verified, true);
  const y = setup();
  await y.auth.register({ email: y.email, password, terms_version: "offline-v1" }, y.context);
  const verification = (await mail(y, "verify_email")).token;
  advance(y, 86400000);
  await assert.rejects(y.auth.verifyEmail(verification, y.context), (e) => e.status === 410);
});

test("HTTP auth/key handlers enforce Origin, CSRF, body limits and no replayed key secret", async () => {
  const x = setup(),
    a = await register(x),
    csrf = a.view.csrf_token;
  let r = await request(x, "/auth/login", {
    method: "POST",
    body: { email: x.email, password },
    origin: "https://attacker.invalid",
  });
  assert.equal(r.status, 403);
  r = await request(x, "/auth/login", { method: "POST", body: { email: x.email, password } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("set-cookie"), /HttpOnly/i);
  assert.match(r.headers.get("set-cookie"), /SameSite=Lax/i);
  const command = { name: "research", scopes: ["sold:read"] },
    headers = { "Idempotency-Key": "key-first-attempt-17" };
  r = await request(x, "/v1/keys", { method: "POST", token: a.token, body: command, headers });
  assert.equal(r.status, 403);
  r = await request(x, "/v1/keys", { method: "POST", token: a.token, csrf, body: command, headers });
  assert.equal(r.status, 201);
  const created = (await r.json()).data;
  assert.match(created.key, /^sb_k_/);
  r = await request(x, "/v1/keys", { method: "POST", token: a.token, csrf, body: command, headers });
  assert.equal(r.status, 200);
  const replay = (await r.json()).data;
  assert.equal(replay.key, undefined);
  assert.equal(replay.key_info.id, created.key_info.id);
  r = await request(x, "/v1/keys", { token: a.token });
  assert.equal(JSON.stringify(await r.json()).includes(created.key), false);
  r = await request(x, "/auth/login", {
    method: "POST",
    body: { email: x.email, password: "a".repeat(9000) },
  });
  assert.equal(r.status, 413);
  r = await request(x, "/v1/keys", { token: a.token, headers: { Authorization: `Bearer ${created.key}` } });
  assert.equal(r.status, 403);
});

test("API key scopes, rotation, cross-owner denial and account suspension stay current", async () => {
  const x = setup(),
    a = await register(x),
    y = setup(x),
    b = await register(y),
    created = await x.auth.createKey(
      a.token,
      { name: "client", scopes: ["sold:read"] },
      "create-key-owner-17",
      x.context,
    );
  assert.equal((await x.auth.keyIdentity(created.key, "sold:read")).userId, a.view.user_id);
  await assert.rejects(x.auth.keyIdentity(created.key, "usage:read"), (e) => e.status === 403);
  await assert.rejects(y.auth.revokeKey(b.token, created.key_info.id, y.context), (e) => e.status === 404);
  const next = await x.auth.createKey(
    a.token,
    { name: "client2", scopes: ["sold:read", "usage:read"] },
    "rotate-key-owner-17",
    x.context,
    created.key_info.id,
  );
  await assert.rejects(x.auth.keyIdentity(created.key, "sold:read"));
  assert.equal((await x.auth.keyIdentity(next.key, "usage:read")).userId, a.view.user_id);
  await x.auth.revokeKey(a.token, next.key_info.id, x.context);
  await assert.rejects(x.auth.keyIdentity(next.key, "sold:read"));
  const active = await x.auth.createKey(
    a.token,
    { name: "status", scopes: ["sold:read"] },
    "create-status-key-17",
    x.context,
  );
  await db.query("UPDATE users SET status='suspended' WHERE id=$1", [a.view.user_id]);
  await assert.rejects(x.auth.keyIdentity(active.key, "sold:read"));
  await assert.rejects(x.auth.sessionIdentity(a.token));
});

test("MFA login is restricted until proof, rotates cookie and consumes recovery codes once under concurrency", async () => {
  const x = setup(),
    a = await register(x),
    enabled = await enableMfa(x, a);
  assert.equal(enabled.recovery_codes.length, 10);
  await assert.rejects(x.auth.sessionIdentity(a.token));
  advance(x, 31000);
  const pending = await x.auth.login(x.email, password, x.context);
  assert.equal(pending.view.mfa_required, true);
  await assert.rejects(x.auth.listKeys(pending.token), (e) => e.code === "mfa_required");
  const full = await x.auth.mfaVerify(
    pending.token,
    { totp_code: await generate({ secret: enabled.secret, epoch: Date.parse(x.clock.value) / 1000 }) },
    x.context,
  );
  assert.notEqual(full.token, pending.token);
  await assert.rejects(x.auth.sessionIdentity(pending.token));
  const p1 = await x.auth.login(x.email, password, x.context),
    p2 = await x.auth.login(x.email, password, x.context),
    results = await Promise.allSettled([
      x.auth.mfaVerify(p1.token, { recovery_code: enabled.recovery_codes[0] }, x.context),
      x.auth.mfaVerify(p2.token, { recovery_code: enabled.recovery_codes[0] }, x.context),
    ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  const row = (await db.query("SELECT * FROM user_mfa WHERE user_id=$1", [a.view.user_id])).rows[0];
  assert.equal(row.recovery_code_hashes.length, 9);
  assert.equal(row.encrypted_secret.includes(Buffer.from(enabled.secret)), false);
  assert.equal(JSON.stringify(row.recovery_code_hashes).includes(enabled.recovery_codes[0]), false);
});

test("per-owner MFA budget survives distributed client IDs and admin promotion restricts existing sessions", async () => {
  const x = setup(),
    a = await register(x);
  await enableMfa(x, a);
  const pending = await x.auth.login(x.email, password, x.context);
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      x.auth.mfaVerify(
        pending.token,
        { recovery_code: "0".repeat(32) },
        { ...x.context, clientId: randomUUID() },
      ),
      (e) => e.code === "mfa_invalid",
    );
  await assert.rejects(
    x.auth.mfaVerify(
      pending.token,
      { recovery_code: "0".repeat(32) },
      { ...x.context, clientId: randomUUID() },
    ),
    (e) => e.status === 429,
  );
  const y = setup(),
    normal = await register(y);
  await db.query("INSERT INTO admin_roles(user_id,role) VALUES($1,'admin')", [normal.view.user_id]);
  await assert.rejects(y.auth.sessionIdentity(normal.token), (e) => e.code === "mfa_required");
  assert.equal((await y.auth.me(normal.token)).mfa_required, true);
  const configured = await enableMfa(y, normal);
  assert.equal((await y.auth.sessionIdentity(configured.token)).mfaPending, false);
  await assert.rejects(y.auth.mfaDisable(configured.token, y.context), (e) => e.status === 403);
});

test("AES-GCM rejects ciphertext tampering and cross-purpose replay", () => {
  const crypto = new AuthCrypto(newAuthSecrets()),
    bytes = crypto.seal({ token: "synthetic-only" }, "mail:one");
  assert.deepEqual(crypto.open(bytes, "mail:one"), { token: "synthetic-only" });
  assert.throws(() => crypto.open(bytes, "mfa:one"));
  bytes[14] ^= 1;
  assert.throws(() => crypto.open(bytes, "mail:one"));
});

test("a real loopback HTTP server creates and authenticates an actual cookie session", async () => {
  const x = setup();
  await register(x);
  let app;
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: (request, env) => app.fetch(request, env) });
  await new Promise((resolve) => server.on("listening", resolve));
  const address = server.address(),
    origin = `http://127.0.0.1:${address.port}`;
  app = createApp({ ...config, origin, port: address.port }, db, { auth: x.auth });
  try {
    const response = await fetch(`${origin}/auth/login`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ email: x.email, password }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie").split(";")[0],
      me = await fetch(`${origin}/auth/me`, {
        headers: { Cookie: cookie },
        signal: AbortSignal.timeout(5000),
      });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).data.email_verified, true);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("password reset retains enabled MFA and a previously consumed TOTP step cannot be replayed", async () => {
  const x = setup(),
    a = await register(x),
    enabled = await enableMfa(x, a),
    oldCode = await generate({ secret: enabled.secret, epoch: Date.parse(x.clock.value) / 1000 });
  const pending = await x.auth.login(x.email, password, x.context);
  await assert.rejects(
    x.auth.mfaVerify(pending.token, { totp_code: oldCode }, x.context),
    (e) => e.code === "mfa_invalid",
  );
  await x.auth.requestMail(x.email, "reset_password", x.context);
  const token = (await mail(x, "reset_password")).token;
  await x.auth.resetPassword(token, "MFA retained password 17!", x.context);
  const login = await x.auth.login(x.email, "MFA retained password 17!", x.context);
  assert.equal(login.view.mfa_required, true);
  await assert.rejects(x.auth.sessionIdentity(login.token), (e) => e.code === "mfa_required");
  const full = await x.auth.mfaVerify(login.token, { recovery_code: enabled.recovery_codes[0] }, x.context);
  assert.equal((await x.auth.sessionIdentity(full.token)).mfaPending, false);
});

test("concurrent first-boot processes publish one complete private secret file atomically", async () => {
  const { mkdtemp, rm, stat } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path"),
    { execFile } = await import("node:child_process"),
    { promisify } = await import("node:util");
  const directory = await mkdtemp(join(tmpdir(), "soldbench-auth-race-"));
  try {
    const program =
      "import {localAuthSecrets} from '@soldbench/auth';import {createHash} from 'node:crypto';const secrets=localAuthSecrets(process.argv[1]);console.log(createHash('sha256').update(JSON.stringify(secrets)).digest('hex'));";
    const outputs = await Promise.all(
      Array.from({ length: 8 }, () =>
        promisify(execFile)(process.execPath, ["--input-type=module", "-e", program, directory], {
          env: { ...process.env, NODE_ENV: "test" },
        }),
      ),
    );
    assert.equal(new Set(outputs.map((r) => r.stdout.trim())).size, 1);
    assert.equal((await stat(join(directory, "auth-secrets.json"))).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
