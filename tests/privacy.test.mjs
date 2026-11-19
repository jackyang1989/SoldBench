import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { createApp } from "@soldbench/api";
import { AccountPrivacy, AuthService, localAuthSecrets } from "@soldbench/auth";
import { BillingService } from "@soldbench/billing";
import { database, migrate } from "@soldbench/db";
import { PublicResults, QueryService } from "@soldbench/query";
import { loadConfig } from "@soldbench/shared";
import { pgBinaries } from "../scripts/local-db.mjs";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL),
  roots = [],
  config = loadConfig({}),
  origin = config.origin,
  run = promisify(execFile);
before(() => migrate(db));
after(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
  await db.end();
});
async function session(service, userId, now, connection = db) {
  const token = service.crypto.token("sb_s_"),
    csrf = service.crypto.hash("auth.csrf", token);
  const row = (
    await connection.query(
      "INSERT INTO sessions(user_id,token_hash,csrf_hash,created_at,authenticated_at,expires_at,device_label) VALUES($1,$2,$3,$4,$4,$5,'private-device') RETURNING id",
      [
        userId,
        service.crypto.hash("auth.session", token),
        service.crypto.hash("auth.csrf-store", csrf),
        now,
        new Date(Date.parse(now) + 7 * 86400000),
      ],
    )
  ).rows[0];
  return {
    sessionId: row.id,
    token,
    headers: {
      Cookie: `soldbench_session=${token}`,
      "X-CSRF-Token": csrf,
      Origin: origin,
      "Content-Type": "application/json",
    },
  };
}
const receipt = () => randomBytes(32).toString("base64url");
const submit = (app, actor, value, confirm = true) =>
  app.request("/account/deletion-requests", {
    method: "POST",
    headers: actor.headers,
    body: JSON.stringify({ confirm, receipt_token: value }),
  });
const status = (app, value, id) =>
  app.request(`/account/deletion-requests/${id ?? "by-receipt"}`, {
    headers: { "X-Deletion-Receipt": value },
  });
const ledger = async (connection, userId) =>
  (
    await connection.query("SELECT to_jsonb(l) as line FROM credit_ledger l WHERE user_id=$1 ORDER BY l.id", [
      userId,
    ])
  ).rows;
async function publication(x) {
  await db.query(
    'UPDATE source_clearances SET permitted_fields=permitted_fields || \'{"public_cache":["aggregate"],"public_share":["aggregate"]}\' WHERE id=(SELECT source_clearance_id FROM sources WHERE id=$1)',
    [x.source.sourceId],
  );
  const publish = new PublicResults(x.query);
  await publish.publishFixture(x.queryId);
  return publish;
}

test("deletion immediately removes access and anonymous publication before its worker runs, with isolated receipt and retained ledger", async () => {
  const x = await createProductFixture(db, roots),
    privacy = new AccountPrivacy(x.auth, x.now),
    actor = await session(x.auth, x.user, x.now()),
    token = receipt(),
    flow = await publication(x);
  const other = await createProductFixture(db, roots),
    otherActor = await session(x.auth, other.user, other.now());
  const share = await flow.create(
    await x.auth.sessionIdentity(actor.token),
    x.queryId,
    86400,
    randomUUID(),
    origin,
  );
  const sharePath = new URL(share.data.url).pathname;
  const supportToken = receipt();
  const supportStatus = () =>
    x.app.request("/support/receipt", { headers: { "X-Support-Receipt": supportToken } });
  const support = await x.app.request("/support/requests", {
    method: "POST",
    headers: { ...actor.headers, "X-Support-Receipt": supportToken, "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ category: "account", message: "private message" }),
  });
  assert.equal(support.status, 202);
  assert.equal((await supportStatus()).status, 200);
  const beforeLines = await ledger(db, x.user);
  assert.ok(beforeLines.length > 0);
  assert.equal((await submit(x.app, actor, token, false)).status, 400);
  assert.equal(
    (await submit(x.app, { headers: { ...actor.headers, "X-CSRF-Token": "bad" } }, token)).status,
    403,
  );
  const done = await submit(x.app, actor, token),
    response = await done.json();
  assert.equal(done.status, 202, JSON.stringify(response));
  assert.match(done.headers.get("Set-Cookie"), /Max-Age=0/);
  const { request } = response.data,
    id = request.request_id;
  assert.equal(request.state, "requested");
  assert.ok(!JSON.stringify(response).includes(token));
  const record = (await db.query("SELECT status,email,password_hash FROM users WHERE id=$1", [x.user]))
    .rows[0];
  assert.deepEqual(record, { status: "deleted", email: null, password_hash: null });
  assert.equal((await x.app.request(`/v1/sold/${x.queryId}`, { headers: x.headers })).status, 401);
  assert.equal((await x.app.request("/auth/me", { headers: actor.headers })).status, 401);
  assert.equal((await supportStatus()).status, 404);
  assert.equal((await x.app.request(sharePath)).status, 410);
  const cache = await x.app.request("/web/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ q: x.q.q, limit: x.q.limit }),
  });
  assert.equal(cache.status, 503);
  assert.equal(
    (await x.app.request(`/account/deletion-requests/${id}`, { headers: otherActor.headers })).status,
    404,
  );
  assert.equal((await status(x.app, receipt(), id)).status, 404);
  const recovered = (await (await status(x.app, token)).json()).data;
  assert.equal(recovered.request_id, id);
  assert.equal(recovered.state, "requested");
  assert.equal((await privacy.workOnce()).state, "completed");
  assert.equal(await privacy.workOnce(), null);
  assert.equal((await (await status(x.app, token, id)).json()).data.state, "completed");
  assert.deepEqual(await ledger(db, x.user), beforeLines);
  const privateRows = (
    await db.query(
      "SELECT (SELECT count(*)::int FROM api_keys WHERE user_id=$1) keys,(SELECT count(*)::int FROM query_results WHERE query_id=$2) stats,(SELECT count(*)::int FROM query_snapshot_records WHERE query_id=$2) comps,(SELECT normalized_query FROM queries WHERE id=$2) keyword",
      [x.user, x.queryId],
    )
  ).rows[0];
  assert.deepEqual(privateRows, { keys: 0, stats: 0, comps: 0, keyword: "" });
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM support_requests WHERE message='private message'")).rows[0]
      .n,
    0,
  );
  assert.equal(
    (await other.app.request("/auth/me", { headers: otherActor.headers })).status,
    401,
    "distinct AuthService keys cannot read sessions created under another fixture authority",
  );
  assert.equal(
    (await x.app.request("/auth/me", { headers: otherActor.headers })).status,
    200,
    "other account remains available",
  );
  x.clock.value = "2026-12-17T12:00:00.001Z";
  assert.equal((await status(x.app, token, id)).status, 404);
});

test("batch checkpoints survive retry and pending accounts can delete with recent auth", async () => {
  const x = await createProductFixture(db, roots, { prepareQuery: false }),
    actor = await session(x.auth, x.user, x.now()),
    value = receipt(),
    privacy = new AccountPrivacy(x.auth, x.now);
  await db.query("UPDATE users SET status='pending',email_verified_at=NULL WHERE id=$1", [x.user]);
  await db.query(
    "INSERT INTO queries(user_id,canonical_query_hash,normalizer_version,normalized_query,filters,marketplace,window_days,price_basis,requested_limit,as_of,billing_policy_version,compute_status,settlement_status,result_state,expires_at) SELECT $1,'fixture'||i,'1.1.0','secret-'||i,'{}','ebay_us',90,'item',50,$2,'1.1.0','completed','not_required','available',$3 FROM generate_series(1,101) i",
    [x.user, x.now(), "2026-11-18"],
  );
  const done = await submit(x.app, actor, value);
  assert.equal(done.status, 202);
  assert.deepEqual(await privacy.workOnce(), { state: "running", queries_cleaned: 100 });
  assert.equal(
    (
      await db.query("SELECT count(*)::int n FROM queries WHERE user_id=$1 AND normalized_query<>''", [
        x.user,
      ])
    ).rows[0].n,
    1,
  );
  assert.deepEqual(await new AccountPrivacy(x.auth, x.now).workOnce(), {
    state: "completed",
    queries_cleaned: 1,
  });
  assert.equal((await (await status(x.app, value)).json()).data.state, "completed");
  assert.equal(
    (
      await db.query("SELECT count(*)::int n FROM queries WHERE user_id=$1 AND normalized_query<>''", [
        x.user,
      ])
    ).rows[0].n,
    0,
  );
});

test("anchored CLI recovery reapplies deletion, capability revocation and source restrictions to an older PG backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "soldbench-privacy-restore-"));
  roots.push(root);
  const x = await createProductFixture(db, roots),
    secrets = localAuthSecrets(root),
    auth = new AuthService(db, secrets, origin),
    billing = new BillingService(db),
    query = new QueryService(db, auth, billing, x.query.media),
    app = createApp(config, db, { auth, query }),
    actor = await session(auth, x.user, new Date().toISOString()),
    value = receipt(),
    keep = await createProductFixture(db, roots, {
      count: 8,
      authSecrets: secrets,
      clockValue: new Date().toISOString(),
    }),
    restricted = await createProductFixture(db, roots, {
      count: 8,
      limit: 50,
      authSecrets: secrets,
      clockValue: new Date().toISOString(),
    }),
    revokedSession = await session(auth, keep.user, new Date().toISOString()),
    ledgerBefore = await ledger(db, x.user);
  const oldKey = auth.crypto.token("sb_k_"),
    revokedKey = auth.crypto.token("sb_k_");
  await db.query(
    "INSERT INTO api_keys(user_id,name,key_hash,key_prefix,scopes) VALUES($1,'deleted-owner',$2,'fixture',ARRAY['sold:read']),($3,'newly-revoked',$4,'fixture',ARRAY['sold:read'])",
    [
      x.user,
      auth.crypto.hash("auth.api-key", oldKey),
      keep.user,
      auth.crypto.hash("auth.api-key", revokedKey),
    ],
  );
  const backup = join(root, "before.dump"),
    file = join(root, "tombstones.json"),
    stalePath = join(root, "previous-checkpoint.json"),
    tamperedPath = join(root, "tampered-checkpoint.json"),
    bin = pgBinaries(),
    name = `soldbench_restore_${randomUUID().replaceAll("-", "")}`,
    url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  const env = { ...process.env, LOCAL_STATE_ROOT: root };
  const privacyCli = (action, filePath, options = { env, timeout: 30000 }) =>
    run(process.execPath, ["scripts/privacy-recovery.mjs", action, filePath], options);
  await privacyCli("export", stalePath);
  await run(join(bin, "pg_dump"), ["--format=custom", "--file", backup, process.env.DATABASE_URL], {
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  const response = await submit(app, actor, value),
    created = (await response.json()).data;
  assert.equal(response.status, 202);
  await db.query("UPDATE api_keys SET revoked_at=now() WHERE key_hash=$1", [
    auth.crypto.hash("auth.api-key", revokedKey),
  ]);
  await db.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [revokedSession.sessionId]);
  const original = await restricted.app.request(`/v1/sold/${restricted.queryId}`, {
    headers: restricted.headers,
  });
  assert.equal(original.status, 200);
  const image = (await original.json()).data.comps.find((comp) => comp.primary_image?.url)?.primary_image.url;
  assert.ok(image);
  await restricted.store.revokeSource(restricted.source.sourceId, "fixture backup revocation");
  const exported = JSON.parse((await privacyCli("export", file)).stdout);
  assert.equal(exported.exported, true);
  assert.match(exported.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const written = await readFile(file, "utf8");
  for (const secret of [value, x.user, keep.user, revokedKey, revokedSession.token])
    assert.ok(!written.includes(secret));
  const old = new URL(process.env.DATABASE_URL);
  await db.query(`CREATE DATABASE "${name}"`);
  const restored = database(url.href);
  try {
    await run(join(bin, "pg_restore"), ["--exit-on-error", "--dbname", url.href, backup], {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    const cloneAuth = new AuthService(restored, secrets, origin),
      cloned = new AccountPrivacy(cloneAuth);
    assert.equal((await cloneAuth.sessionIdentity(actor.token)).userId, x.user);
    const signed = JSON.parse(JSON.parse(written).body).account;
    await assert.rejects(
      cloned.replayManifest({ ...signed, body: signed.body.replace("offline_fixture", "unapproved") }),
      /invalid_privacy_manifest_signature/,
    );
    assert.equal((await cloneAuth.keyIdentity(oldKey, "sold:read")).userId, x.user);
    const options = {
      env: {
        ...env,
        DATABASE_URL: url.href,
        PRIVACY_RESTORE_ISOLATED: "true",
        PRIVACY_RECOVERY_MANIFEST_SHA256: exported.sha256,
      },
      timeout: 30000,
    };
    const cloneQuery = new QueryService(
      restored,
      cloneAuth,
      new BillingService(restored),
      restricted.query.media,
    );
    const cloneApp = createApp(config, restored, { auth: cloneAuth, query: cloneQuery });
    await assert.rejects(
      privacyCli("replay", stalePath, options),
      /privacy_recovery_checkpoint_digest_mismatch/,
    );
    const tampered = written.replace("soldbench.offline-recovery.v2", "soldbench.offline-recovery.v9");
    await writeFile(tamperedPath, tampered, { mode: 0o600 });
    await assert.rejects(
      privacyCli("replay", tamperedPath, {
        ...options,
        env: {
          ...options.env,
          PRIVACY_RECOVERY_MANIFEST_SHA256: createHash("sha256").update(tampered).digest("hex"),
        },
      }),
      /invalid_privacy_recovery_checkpoint_signature/,
    );
    const incompletePath = join(root, "incomplete-checkpoint.json");
    const incomplete = JSON.parse(JSON.parse(written).body);
    incomplete.sources = incomplete.sources.filter((source) => source.id !== restricted.source.sourceId);
    const incompleteBody = JSON.stringify(incomplete);
    const incompleteBytes = JSON.stringify({
      body: incompleteBody,
      signature: auth.crypto.hash("recovery.bundle", incompleteBody),
    });
    await writeFile(incompletePath, incompleteBytes, { mode: 0o600 });
    await assert.rejects(
      privacyCli("replay", incompletePath, {
        ...options,
        env: {
          ...options.env,
          PRIVACY_RECOVERY_MANIFEST_SHA256: createHash("sha256").update(incompleteBytes).digest("hex"),
        },
      }),
      /privacy_recovery_source_checkpoint_incomplete/,
    );
    assert.equal((await cloneAuth.keyIdentity(revokedKey, "sold:read")).userId, keep.user);
    assert.equal((await cloneAuth.sessionIdentity(revokedSession.token)).userId, keep.user);
    assert.equal((await cloneApp.request(image, { headers: restricted.headers })).status, 200);
    const replay = JSON.parse((await privacyCli("replay", file, options)).stdout);
    assert.equal(replay.requests_restored, 1);
    assert.equal(replay.sources_quarantined, 1);
    assert.equal(
      (await (await status(cloneApp, value, created.request.request_id)).json()).data.state,
      "completed",
    );
    await assert.rejects(cloneAuth.sessionIdentity(actor.token));
    await assert.rejects(cloneAuth.keyIdentity(oldKey, "sold:read"));
    await assert.rejects(cloneAuth.sessionIdentity(revokedSession.token));
    await assert.rejects(cloneAuth.keyIdentity(revokedKey, "sold:read"));
    assert.equal((await cloneApp.request(`/v1/sold/${keep.queryId}`, { headers: keep.headers })).status, 200);
    const withdrawnImage = await cloneApp.request(image, { headers: restricted.headers });
    const unknownImage = await cloneApp.request(`/v1/media/${randomUUID()}`, { headers: restricted.headers });
    assert.equal(withdrawnImage.status, 404);
    assert.equal(unknownImage.status, 404);
    assert.equal(withdrawnImage.headers.get("Cache-Control"), "private, no-store");
    const stableError = async (response) => {
      const { code, message } = (await response.json()).error;
      return { code, message };
    };
    assert.deepEqual(await stableError(withdrawnImage), await stableError(unknownImage));
    assert.equal(
      (await cloneApp.request(`/v1/sold/${restricted.queryId}`, { headers: restricted.headers })).status,
      403,
    );
    assert.deepEqual(await ledger(restored, x.user), ledgerBefore);
    assert.equal(
      (await restored.query("SELECT normalized_query FROM queries WHERE id=$1", [x.queryId])).rows[0]
        .normalized_query,
      "",
    );
    const repeated = JSON.parse((await privacyCli("replay", file, options)).stdout);
    assert.equal(repeated.requests_restored, 0);
    assert.equal(repeated.sources_quarantined, 0);
    assert.equal(
      (
        await restored.query(
          "SELECT count(*)::int n FROM outbox WHERE kind='collector.media_cleanup' AND payload->>'sourceId'=$1",
          [restricted.source.sourceId],
        )
      ).rows[0].n,
      1,
    );
    assert.deepEqual(await ledger(restored, x.user), ledgerBefore);
    assert.notEqual(url.href, old.href);
  } finally {
    await restored.end();
    await db.query(`DROP DATABASE "${name}"`);
  }
});
