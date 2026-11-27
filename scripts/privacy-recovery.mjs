import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AccountPrivacy, AuthService, runtimeAuthSecrets } from "@soldbench/auth";
import { CollectorStore } from "@soldbench/collector";
import { assertLocalDatabaseUrl, database, migrate, transaction } from "@soldbench/db";
import { loadConfig } from "@soldbench/shared";
import { localDatabaseUrl } from "./local-db.mjs";

const [action, path, ...rest] = process.argv.slice(2);
if (!["export", "replay"].includes(action) || !path || rest.length)
  throw new Error("usage_privacy_recovery_export_or_replay_file");
if (action === "replay" && process.env.PRIVACY_RESTORE_ISOLATED !== "true")
  throw new Error("require_isolated_restore_database");
const fingerprint = (bytes) => createHash("sha256").update(bytes).digest("hex");
const checkpointSchema = "soldbench.offline-recovery.v3";
const capabilities = [
  ["api_keys", "id", "uuid", "revoked_at"],
  ["sessions", "id", "uuid", "revoked_at"],
  ["auth_tokens", "id", "uuid", "consumed_at"],
  ["shares", "id", "uuid", "revoked_at"],
  ["anonymous_cache_publications", "canonical_query_hash", "text", null],
];
const maxFileBytes = 12 * 1024 * 1024;
const digest = /^[a-f0-9]{64}$/;
const sourceId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const resetRequired = "restore_requires_credential_reset";

async function accountScopes(c, crypto) {
  const { rows } = await c.query(
    `SELECT u.id, jsonb_build_object('email',u.email,'status',u.status,'password_hash',u.password_hash,
       'credential_version',u.credential_version,'verified_at',u.email_verified_at,
       'user_mfa',to_jsonb(m)-ARRAY['last_used_step','updated_at'],
       'admin_mfa',to_jsonb(a)-ARRAY['last_used_step','updated_at'],'role',r.role)::text scope,
       m.last_used_step::text AS user_step,a.last_used_step::text AS admin_step,
       (u.status='suspended' AND u.password_hash=$1) reset_required
     FROM users u LEFT JOIN user_mfa m ON m.user_id=u.id
     LEFT JOIN admin_mfa a ON a.user_id=u.id LEFT JOIN admin_roles r ON r.user_id=u.id
     WHERE u.status<>'deleted' ORDER BY u.id LIMIT 25001`,
    [resetRequired],
  );
  if (rows.length > 25000) throw new Error("privacy_recovery_accounts_require_partitioning");
  return rows.map(({ id, scope, user_step, admin_step, reset_required }) => ({
    id,
    resetRequired: reset_required,
    proof: {
      subject: crypto.hash("recovery.account", id),
      digest: crypto.hash("recovery.account.credentials", scope),
      user_step,
      admin_step,
    },
  }));
}

async function reconcileAccounts(c, crypto, latest, now) {
  const approved = new Map(latest.map((proof) => [proof.subject, proof]));
  const reset = [];
  let mfaCountersAdvanced = 0;
  for (const account of await accountScopes(c, crypto)) {
    const current = approved.get(account.proof.subject);
    if (current?.digest === account.proof.digest) {
      for (const [table, column] of [
        ["user_mfa", "user_step"],
        ["admin_mfa", "admin_step"],
      ]) {
        const step = current[column];
        if (step === null) continue;
        const result = await c.query(
          `UPDATE ${table} SET last_used_step=$2 WHERE user_id=$1 AND (last_used_step IS NULL OR last_used_step<$2)`,
          [account.id, step],
        );
        mfaCountersAdvanced += result.rowCount;
      }
    } else if (!account.resetRequired) reset.push(account.id);
  }
  if (reset.length) {
    await c.query(
      `UPDATE users SET status='suspended',password_hash=$2,updated_at=$3,credential_version=credential_version+1
       WHERE id=ANY($1::uuid[])`,
      [reset, resetRequired, now],
    );
    for (const table of ["sessions", "api_keys", "shares"])
      await c.query(
        `UPDATE ${table} SET revoked_at=$2 WHERE user_id=ANY($1::uuid[]) AND revoked_at IS NULL`,
        [reset, now],
      );
    await c.query(
      "UPDATE auth_tokens SET consumed_at=$2 WHERE user_id=ANY($1::uuid[]) AND consumed_at IS NULL",
      [reset, now],
    );
    await c.query(
      `WITH closed AS (UPDATE auth_mail_outbox SET status='cancelled',offline_closed_at=coalesce(offline_closed_at,$2),
         encrypted_payload=''::bytea WHERE user_id=ANY($1::uuid[]) RETURNING id)
       UPDATE outbox SET processed_at=coalesce(processed_at,$2) WHERE kind='auth.mail_queued'
       AND event_key IN (SELECT 'auth-mail:'||id FROM closed)`,
      [reset, now],
    );
    for (const table of ["user_mfa", "admin_mfa", "admin_roles", "anonymous_cache_publications"])
      await c.query(`DELETE FROM ${table} WHERE user_id=ANY($1::uuid[])`, [reset]);
  }
  return { accounts_quarantined: reset.length, mfa_counters_advanced: mfaCountersAdvanced };
}

async function readCheckpoint(filePath) {
  const expected = process.env.PRIVACY_RECOVERY_MANIFEST_SHA256;
  if (!digest.test(expected ?? "")) throw new Error("require_trusted_recovery_checkpoint_digest");
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxFileBytes || stat.mode & 0o077)
      throw new Error("privacy_manifest_must_be_private_regular_file");
    const bytes = await file.readFile();
    if (bytes.length > maxFileBytes || fingerprint(bytes) !== expected)
      throw new Error("privacy_recovery_checkpoint_digest_mismatch");
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    await file.close();
  }
}

async function sourceScopes(c, crypto) {
  const { rows } = await c.query(
    `SELECT s.id,s.access_method,s.status,s.permission_epoch::text epoch,p.provider,to_jsonb(p)::text scope
       FROM sources s JOIN source_clearances p ON p.id=s.source_clearance_id ORDER BY s.id LIMIT 10001`,
  );
  if (
    rows.length > 10000 ||
    rows.some((row) => row.access_method !== "offline_fixture" || row.provider !== "synthetic_fixture")
  )
    throw new Error("privacy_recovery_unsupported_source_scope");
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    epoch: row.epoch,
    scope: crypto.hash("recovery.source_rights", row.scope),
  }));
}

async function activeCapabilities(c, crypto, table, id, invalidatedAt) {
  const condition = invalidatedAt ? `k.${invalidatedAt} IS NULL` : "TRUE";
  const { rows } = await c.query(
    `SELECT k.${id} AS id, (to_jsonb(k) - ARRAY['last_used_at','last_seen_at','updated_at'])::text AS scope
       FROM ${table} k JOIN users u ON u.id=k.user_id WHERE u.status IN ('active','pending') AND ${condition}
       ORDER BY k.${id} LIMIT 25001`,
  );
  if (rows.length > 25000) throw new Error("privacy_recovery_capabilities_require_partitioning");
  return rows.map((row) => ({ id: row.id, proof: crypto.hash(`recovery.${table}`, row.scope) }));
}

function verifyScope(checkpoint) {
  const validStep = (value) =>
    value === null ||
    (typeof value === "string" && /^\d{1,19}$/.test(value) && BigInt(value) <= 9223372036854775807n);
  const accounts = checkpoint.accounts;
  if (
    !Array.isArray(accounts) ||
    accounts.length > 25000 ||
    accounts.some(
      (proof) =>
        !proof ||
        !digest.test(proof.subject ?? "") ||
        !digest.test(proof.digest ?? "") ||
        !validStep(proof.user_step) ||
        !validStep(proof.admin_step),
    ) ||
    new Set(accounts.map(({ subject }) => subject)).size !== accounts.length
  )
    throw new Error("invalid_privacy_recovery_account_scope");
  if (
    !Array.isArray(checkpoint.sources) ||
    checkpoint.sources.length > 10000 ||
    checkpoint.sources.some(
      (source) =>
        !source ||
        !sourceId.test(source.id) ||
        !["disabled", "active", "suspended", "revoked"].includes(source.status) ||
        typeof source.epoch !== "string" ||
        !/^[1-9]\d{0,18}$/.test(source.epoch) ||
        !digest.test(source.scope),
    ) ||
    new Set(checkpoint.sources.map((source) => source.id)).size !== checkpoint.sources.length
  )
    throw new Error("invalid_privacy_recovery_source_scope");
  for (const [table] of capabilities) {
    const entries = checkpoint.capabilities?.[table];
    if (
      !Array.isArray(entries) ||
      entries.length > 25000 ||
      entries.some((entry) => typeof entry !== "string" || !digest.test(entry))
    )
      throw new Error("invalid_privacy_recovery_capability_scope");
  }
}

const config = loadConfig(process.env),
  url = config.databaseUrl ?? localDatabaseUrl();
assertLocalDatabaseUrl(url, [
  resolve(".local/postgres/socket"),
  ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
]);
const signed = action === "replay" ? await readCheckpoint(path) : undefined;
const db = database(url);
try {
  const auth = new AuthService(db, runtimeAuthSecrets(config.localStateRoot), config.origin),
    privacy = new AccountPrivacy(auth);
  const signing = (body) => auth.crypto.hash("recovery.bundle", body);
  if (action === "export") {
    await migrate(db);
    const body = await transaction(db, async (c) => {
      await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await c.query("SET LOCAL TIME ZONE 'UTC'");
      const { rows } = await c.query("SELECT statement_timestamp() captured_at");
      const state = {};
      for (const [table, id, , invalidatedAt] of capabilities)
        state[table] = (await activeCapabilities(c, auth.crypto, table, id, invalidatedAt)).map(
          (entry) => entry.proof,
        );
      return JSON.stringify({
        schema: checkpointSchema,
        data_mode: "offline_fixture",
        captured_at: rows[0].captured_at,
        account: await privacy.exportManifest(c),
        accounts: (await accountScopes(c, auth.crypto)).map(({ proof }) => proof),
        sources: await sourceScopes(c, auth.crypto),
        capabilities: state,
      });
    });
    const bytes = Buffer.from(JSON.stringify({ body, signature: signing(body) }));
    if (bytes.length > maxFileBytes) throw new Error("privacy_recovery_bundle_requires_partitioning");
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ data_mode: "offline_fixture", exported: true, sha256: fingerprint(bytes) }));
  } else {
    if (
      !signed ||
      typeof signed.body !== "string" ||
      typeof signed.signature !== "string" ||
      !auth.crypto.equal(signed.signature, signing(signed.body))
    )
      throw new Error("invalid_privacy_recovery_checkpoint_signature");
    const checkpoint = JSON.parse(signed.body);
    if (checkpoint.schema !== checkpointSchema || checkpoint.data_mode !== config.dataMode)
      throw new Error("invalid_privacy_recovery_checkpoint_schema");
    verifyScope(checkpoint);
    await migrate(db);
    const revoked = await transaction(db, async (c) => {
      await c.query("SET LOCAL TIME ZONE 'UTC'");
      const now = (await c.query("SELECT clock_timestamp() now")).rows[0].now;
      if (
        !Number.isFinite(Date.parse(checkpoint.captured_at)) ||
        Date.parse(checkpoint.captured_at) > now.getTime()
      )
        throw new Error("invalid_privacy_recovery_checkpoint_time");
      const fromBackup = await sourceScopes(c, auth.crypto);
      const approvedSources = new Map(checkpoint.sources.map((source) => [source.id, source]));
      if (fromBackup.some((source) => !approvedSources.has(source.id)))
        throw new Error("privacy_recovery_source_checkpoint_incomplete");
      const collector = new CollectorStore(db);
      let changed = 0;
      for (const source of fromBackup) {
        const current = approvedSources.get(source.id);
        if (
          source.status === "revoked" ||
          (source.status === current.status &&
            source.epoch === current.epoch &&
            source.scope === current.scope)
        )
          continue;
        await collector.stopLocked(c, source.id, "restore_source_rights_changed", true);
        await c.query(
          "UPDATE sources SET permission_epoch=greatest(permission_epoch,$2::bigint) WHERE id=$1",
          [source.id, current.epoch],
        );
        changed++;
      }
      const removed = {};
      for (const [table, id, type, invalidatedAt] of capabilities) {
        const approved = new Set(checkpoint.capabilities[table]);
        const stale = (await activeCapabilities(c, auth.crypto, table, id, invalidatedAt))
          .filter((entry) => !approved.has(entry.proof))
          .map((entry) => entry.id);
        const mutation = invalidatedAt ? `UPDATE ${table} SET ${invalidatedAt}=$2` : `DELETE FROM ${table}`;
        if (stale.length)
          await c.query(`${mutation} WHERE ${id}=ANY($1::${type}[])`, invalidatedAt ? [stale, now] : [stale]);
        removed[table] = stale.length;
      }
      return {
        ...(await privacy.replayManifest(checkpoint.account, c)),
        ...(await reconcileAccounts(c, auth.crypto, checkpoint.accounts, now)),
        sources_quarantined: changed,
        capabilities_removed: removed,
      };
    });
    let batches = 0;
    for (; batches < 1000; batches++) if (!(await privacy.workOnce())) break;
    if (batches === 1000) throw new Error("privacy_recovery_pending_continue_before_opening_readers");
    console.log(JSON.stringify({ data_mode: "offline_fixture", ...revoked, batches }));
  }
} finally {
  await db.end();
}
