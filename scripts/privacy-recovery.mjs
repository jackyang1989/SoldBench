import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AccountPrivacy, AuthService, localAuthSecrets } from "@soldbench/auth";
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
const checkpointSchema = "soldbench.offline-recovery.v2";
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
       FROM ${table} k JOIN users u ON u.id=k.user_id WHERE u.status='active' AND ${condition}
       ORDER BY k.${id} LIMIT 25001`,
  );
  if (rows.length > 25000) throw new Error("privacy_recovery_capabilities_require_partitioning");
  return rows.map((row) => ({ id: row.id, proof: crypto.hash(`recovery.${table}`, row.scope) }));
}

function verifyScope(checkpoint) {
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
  const auth = new AuthService(db, localAuthSecrets(resolve(config.localStateRoot)), config.origin),
    privacy = new AccountPrivacy(auth);
  const signing = (body) => auth.crypto.hash("recovery.bundle", body);
  if (action === "export") {
    await migrate(db);
    const body = await transaction(db, async (c) => {
      await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
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
