import { type Database, type Transaction, transaction } from "@soldbench/db";
import { AppError } from "@soldbench/shared";
import type { AuthService, Identity } from "./service.ts";

const receiptPattern = /^[A-Za-z0-9_-]{43}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const days = 86400000;
const categories = ["financial_transaction_and_immutable_ledger", "security_and_deletion_audit"];
const denial = () => new AppError("not_found", 404, "Deletion request not found.");
type Deletion = {
  id: string;
  user_id: string;
  state: "requested" | "running" | "completed" | "failed";
  requested_at: Date;
  completed_at: Date | null;
  receipt_expires_at: Date | null;
  checkpoint: { last_query_id?: string; account_cleaned?: boolean } | null;
};
type Tombstone = {
  user_hash: string;
  deleted_at: string;
  request_id: string;
  receipt_hash: string | null;
  receipt_expires_at: string | null;
};
type Manifest = { body: string; signature: string };

function view(row: Deletion) {
  return {
    request_id: row.id,
    state: row.state,
    requested_at: row.requested_at.toISOString(),
    completed_at: row.completed_at?.toISOString() ?? null,
    retained_categories: categories,
  };
}
function hexDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export class AccountPrivacy {
  constructor(
    readonly auth: AuthService,
    readonly clock?: () => string,
  ) {}
  private async now(c: Transaction): Promise<Date> {
    return this.clock ? new Date(this.clock()) : (await c.query("SELECT clock_timestamp() t")).rows[0].t;
  }
  private userHash(id: string) {
    return this.auth.crypto.hash("account.deletion.subject", id);
  }
  private tokenHash(token: string) {
    return this.auth.crypto.hash("account.deletion.receipt", token);
  }
  private async revokeNow(c: Transaction, userId: string, when: Date) {
    await c.query(
      "UPDATE users SET status='deleted',email=NULL,password_hash=NULL,email_verified_at=NULL,free_anchor_at=NULL,deleted_at=coalesce(deleted_at,$2),updated_at=$2,credential_version=credential_version+(CASE WHEN status='deleted' THEN 0 ELSE 1 END) WHERE id=$1",
      [userId, when],
    );
    for (const table of ["sessions", "api_keys", "shares"])
      await c.query(
        `UPDATE ${table} SET revoked_at=coalesce(revoked_at,$2) WHERE user_id=$1 AND revoked_at IS NULL`,
        [userId, when],
      );
    await c.query("UPDATE auth_tokens SET consumed_at=$2 WHERE user_id=$1 AND consumed_at IS NULL", [
      userId,
      when,
    ]);
    await c.query(
      "UPDATE auth_mail_outbox SET status='cancelled' WHERE user_id=$1 AND status='queued_offline'",
      [userId],
    );
    await c.query("DELETE FROM anonymous_cache_publications WHERE user_id=$1", [userId]);
    await c.query(
      "UPDATE query_jobs j SET status='cancelled',lease_owner=NULL,lease_until=NULL,updated_at=$2,version=j.version+1,retryable=false,error_code=NULL FROM queries q WHERE q.id=j.query_id AND q.user_id=$1 AND j.status IN ('queued','running')",
      [userId, when],
    );
    await c.query(
      "UPDATE queries SET compute_status='cancelled',result_state='forbidden',version=version+1 WHERE user_id=$1 AND compute_status IN ('queued','running')",
      [userId],
    );
    await c.query(
      "UPDATE subscriptions SET cancel_at_period_end=true,version=version+1 WHERE user_id=$1 AND cancel_at_period_end=false",
      [userId],
    );
  }
  private async mark(c: Transaction, stone: Tombstone) {
    await c.query(
      "INSERT INTO tombstones(subject_type,subject_hash,scope,effective_at) VALUES('account',$1,$2,$3) ON CONFLICT(subject_type,subject_hash) DO NOTHING",
      [
        stone.user_hash,
        {
          request_id: stone.request_id,
          receipt_hash: stone.receipt_hash,
          receipt_expires_at: stone.receipt_expires_at,
        },
        stone.deleted_at,
      ],
    );
  }
  async request(actor: Identity, token: string, requestId: string) {
    if (!actor.sessionId || actor.keyId)
      throw new AppError("forbidden", 403, "A recently authenticated session is required.");
    if (!receiptPattern.test(token) || Buffer.from(token, "base64url").toString("base64url") !== token)
      throw new AppError("invalid_parameter", 400, "Use a randomly generated 32-byte base64url receipt.");
    return transaction(this.auth.db, async (c) => {
      const now = await this.now(c);
      await this.auth.assertIdentityLocked(c, actor, "usage:read", now, true, true);
      const hash = this.tokenHash(token),
        expires = new Date(now.getTime() + 30 * days),
        row = (
          await c.query<Deletion>(
            "INSERT INTO deletion_requests(user_id,state,scope,requested_at,receipt_hash,receipt_expires_at) VALUES($1,'requested','{\"mode\":\"offline_fixture\"}',$2,$3,$4) ON CONFLICT(receipt_hash) DO NOTHING RETURNING *",
            [actor.userId, now, hash, expires],
          )
        ).rows[0];
      if (!row) throw new AppError("state_conflict", 409, "Generate a new private receipt and retry.");
      await this.revokeNow(c, actor.userId, now);
      await this.mark(c, {
        user_hash: this.userHash(actor.userId),
        deleted_at: now.toISOString(),
        request_id: row.id,
        receipt_hash: hash,
        receipt_expires_at: expires.toISOString(),
      });
      await c.query(
        "INSERT INTO audit_events(actor_id,action,object_type,object_id,request_id,created_at) VALUES($1,'account.deletion_requested','deletion_request',$2,$3,$4)",
        [actor.userId, row.id, requestId, now],
      );
      return { request: view(row), receipt_expires_at: expires.toISOString() };
    });
  }
  async status(receipt: string | undefined, id: string | undefined, actor?: Identity) {
    if (id && !uuid.test(id)) throw denial();
    return transaction(this.auth.db, async (c) => {
      const now = await this.now(c);
      let row: Deletion | undefined;
      if (receipt !== undefined) {
        if (!receiptPattern.test(receipt)) throw denial();
        row = (
          await c.query<Deletion>(
            "SELECT * FROM deletion_requests WHERE receipt_hash=$1 AND receipt_expires_at>$2 AND user_id IS NOT NULL AND ($3::uuid IS NULL OR id=$3)",
            [this.tokenHash(receipt), now, id ?? null],
          )
        ).rows[0];
      } else if (id && actor?.sessionId && !actor.keyId) {
        await this.auth.assertIdentityLocked(c, actor, "usage:read", now, true, true);
        row = (
          await c.query<Deletion>("SELECT * FROM deletion_requests WHERE id=$1 AND user_id=$2", [
            id,
            actor.userId,
          ])
        ).rows[0];
      }
      if (!row) throw denial();
      return view(row);
    });
  }
  async prune() {
    return transaction(this.auth.db, async (c) => {
      const now = await this.now(c);
      await c.query(
        "DELETE FROM support_requests WHERE id IN (SELECT id FROM support_requests WHERE retention_until<=$1 ORDER BY retention_until,id LIMIT 1000 FOR UPDATE SKIP LOCKED)",
        [now],
      );
      await c.query(
        "DELETE FROM auth_rate_windows WHERE ctid IN (SELECT ctid FROM auth_rate_windows WHERE window_start<$1 ORDER BY window_start LIMIT 1000 FOR UPDATE SKIP LOCKED)",
        [new Date(now.getTime() - 2 * days)],
      );
      await c.query(
        "DELETE FROM idempotency_records WHERE ctid IN (SELECT ctid FROM idempotency_records WHERE operation='support.submit' AND expires_at<=$1 ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED)",
        [now],
      );
    });
  }
  async workOnce() {
    return transaction(this.auth.db, async (c) => {
      const selected = (
        await c.query<Deletion>(
          "SELECT id,user_id FROM deletion_requests WHERE user_id IS NOT NULL AND scope->>'mode'='offline_fixture' AND state IN ('requested','running') ORDER BY requested_at,id LIMIT 1",
        )
      ).rows[0];
      if (!selected) return null;
      await c.query("SELECT id FROM users WHERE id=$1 AND status='deleted' FOR UPDATE", [selected.user_id]);
      const row = (
        await c.query<Deletion>(
          "SELECT * FROM deletion_requests WHERE id=$1 AND state IN ('requested','running') FOR UPDATE",
          [selected.id],
        )
      ).rows[0];
      if (!row) return null;
      const now = await this.now(c),
        owner = row.user_id;
      const user = (await c.query("SELECT status FROM users WHERE id=$1", [owner])).rows[0];
      if (user?.status !== "deleted") throw new Error("privacy_queue_owner_not_revoked");
      if (!row.checkpoint?.account_cleaned) {
        for (const table of [
          "auth_mail_outbox",
          "auth_tokens",
          "user_mfa",
          "admin_mfa",
          "admin_roles",
          "sessions",
        ])
          await c.query(`DELETE FROM ${table} WHERE user_id=$1`, [owner]);
        await c.query(
          "UPDATE support_requests SET message='[removed by account deletion]',request_ref=NULL,user_id=NULL WHERE user_id=$1",
          [owner],
        );
        await c.query("DELETE FROM query_request_audit WHERE user_id=$1", [owner]);
        await c.query("DELETE FROM shares WHERE user_id=$1", [owner]);
        await c.query(
          "DELETE FROM idempotency_records WHERE owner_scope=$1 AND operation NOT IN ('payment.checkout','query.claim')",
          [owner],
        );
      }
      const ids = (
        await c.query<{ id: string }>(
          "SELECT id FROM queries WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100 FOR UPDATE",
          [owner, row.checkpoint?.last_query_id ?? null],
        )
      ).rows.map((r) => r.id);
      if (ids.length) {
        for (const table of [
          "query_result_items",
          "query_calculation_inputs",
          "query_comparables",
          "query_snapshot_records",
          "query_result_sources",
          "query_results",
        ])
          await c.query(`DELETE FROM ${table} WHERE query_id=ANY($1::uuid[])`, [ids]);
        await c.query("DELETE FROM anonymous_cache_deliveries WHERE query_id=ANY($1::uuid[])", [ids]);
        await c.query(
          "UPDATE category_pages SET query_id=NULL,indexable=false,content='[removed by account deletion]',filters='{}',source_scope='{}' WHERE query_id=ANY($1::uuid[])",
          [ids],
        );
        await c.query(
          "UPDATE query_jobs SET dedupe_key='deleted:'||id,status_message=NULL,error_code=NULL WHERE query_id=ANY($1::uuid[])",
          [ids],
        );
        await c.query(
          "UPDATE queries SET normalized_query='',filters='{}',canonical_query_hash='deleted:'||id,api_key_id=NULL,collector_job_id=NULL,result_state='forbidden',version=version+1 WHERE id=ANY($1::uuid[])",
          [ids],
        );
      }
      const completed = ids.length < 100;
      if (completed) await c.query("DELETE FROM api_keys WHERE user_id=$1", [owner]);
      await c.query("UPDATE deletion_requests SET state=$2,checkpoint=$3,completed_at=$4 WHERE id=$1", [
        row.id,
        completed ? "completed" : "running",
        { account_cleaned: true, last_query_id: ids.at(-1) ?? row.checkpoint?.last_query_id ?? null },
        completed ? now : null,
      ]);
      if (completed)
        await c.query(
          "INSERT INTO audit_events(actor_id,action,object_type,object_id,request_id,created_at) VALUES($1,'account.deletion_completed','deletion_request',$2,$2,$3)",
          [owner, row.id, now],
        );
      return { state: completed ? "completed" : "running", queries_cleaned: ids.length };
    });
  }
  async exportManifest(connection: Database | Transaction = this.auth.db): Promise<Manifest> {
    const rows = (
      await connection.query(
        "SELECT subject_hash,effective_at,scope FROM tombstones WHERE subject_type='account' ORDER BY subject_hash LIMIT 10001",
      )
    ).rows;
    if (rows.length > 10000) throw new Error("privacy_manifest_requires_partitioning");
    const stones: Tombstone[] = rows.map((row) => ({
      user_hash: row.subject_hash,
      deleted_at: row.effective_at.toISOString(),
      request_id: row.scope.request_id,
      receipt_hash: row.scope.receipt_hash,
      receipt_expires_at: row.scope.receipt_expires_at,
    }));
    const body = JSON.stringify({
      schema: "soldbench.account-tombstones.v1",
      data_mode: "offline_fixture",
      stones,
    });
    return { body, signature: this.auth.crypto.hash("account.deletion.manifest", body) };
  }
  private parseManifest(input: Manifest) {
    if (
      !input ||
      typeof input.body !== "string" ||
      Buffer.byteLength(input.body) > 4 * 1024 * 1024 ||
      typeof input.signature !== "string" ||
      !digestPattern.test(input.signature) ||
      !this.auth.crypto.equal(input.signature, this.auth.crypto.hash("account.deletion.manifest", input.body))
    )
      throw new Error("invalid_privacy_manifest_signature");
    const decoded = JSON.parse(input.body);
    if (
      decoded.schema !== "soldbench.account-tombstones.v1" ||
      decoded.data_mode !== "offline_fixture" ||
      !Array.isArray(decoded.stones) ||
      decoded.stones.length > 10000
    )
      throw new Error("invalid_privacy_manifest");
    const stones = new Map<string, Tombstone>();
    for (const s of decoded.stones as Tombstone[]) {
      if (
        !s ||
        !digestPattern.test(s.user_hash) ||
        !uuid.test(s.request_id) ||
        !hexDate(s.deleted_at) ||
        (!(s.receipt_hash === null && s.receipt_expires_at === null) &&
          !(
            typeof s.receipt_hash === "string" &&
            digestPattern.test(s.receipt_hash) &&
            hexDate(s.receipt_expires_at) &&
            Date.parse(s.receipt_expires_at) > Date.parse(s.deleted_at)
          )) ||
        stones.has(s.user_hash)
      )
        throw new Error("invalid_privacy_tombstone");
      stones.set(s.user_hash, s);
    }
    return stones;
  }
  async replayManifest(manifest: Manifest, connection?: Transaction) {
    const stones = this.parseManifest(manifest);
    let restored = 0;
    const replay = async (c: Transaction) => {
      const now = await this.now(c);
      for (const stone of stones.values()) {
        if (Date.parse(stone.deleted_at) > now.getTime()) throw new Error("future_privacy_tombstone");
        await this.mark(c, stone);
      }
      let last: string | null = null;
      // Recovery runs offline before readers start. Page existing users and match opaque hashes.
      for (;;) {
        const users: { id: string }[] = (
          await c.query<{ id: string }>(
            "SELECT id FROM users WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 250",
            [last],
          )
        ).rows;
        if (!users.length) break;
        for (const user of users) {
          const stone = stones.get(this.userHash(user.id));
          if (!stone) continue;
          await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user.id]);
          const leaked = (
            await c.query(
              "SELECT email IS NOT NULL OR password_hash IS NOT NULL OR EXISTS(SELECT 1 FROM queries WHERE user_id=$1 AND (normalized_query<>'' OR result_state<>'forbidden')) OR EXISTS(SELECT 1 FROM sessions WHERE user_id=$1 AND revoked_at IS NULL) OR EXISTS(SELECT 1 FROM api_keys WHERE user_id=$1 AND revoked_at IS NULL) AS present FROM users WHERE id=$1",
              [user.id],
            )
          ).rows[0].present;
          await this.revokeNow(c, user.id, new Date(stone.deleted_at));
          const row = (
            await c.query<Deletion>("SELECT * FROM deletion_requests WHERE id=$1", [stone.request_id])
          ).rows[0];
          if (row && row.user_id !== user.id) throw new Error("privacy_restore_request_owner_mismatch");
          if (!row) {
            await c.query(
              "INSERT INTO deletion_requests(id,user_id,state,scope,requested_at,receipt_hash,receipt_expires_at) VALUES($1,$2,'requested','{\"mode\":\"offline_fixture\"}',$3,$4,$5)",
              [stone.request_id, user.id, stone.deleted_at, stone.receipt_hash, stone.receipt_expires_at],
            );
            restored++;
          } else if (leaked) {
            await c.query(
              "UPDATE deletion_requests SET state='requested',checkpoint=NULL,completed_at=NULL WHERE id=$1",
              [stone.request_id],
            );
          }
        }
        last = users.at(-1)?.id ?? null;
      }
    };
    if (connection) await replay(connection);
    else await transaction(this.auth.db, replay);
    return { tombstones: stones.size, requests_restored: restored };
  }
}
