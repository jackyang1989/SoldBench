import type { Identity } from "@soldbench/auth";
import { availability, queryHash, type SoldQuery } from "@soldbench/core";
import { type Transaction, transaction } from "@soldbench/db";
import { AppError, VERSIONS } from "@soldbench/shared";
import type { QueryService } from "./index.ts";
import { publicSummary, type SummaryParts } from "./quality-report.ts";

type Purpose = "public_share" | "public_cache";
type Snapshot = SummaryParts & {
  id: string;
  canonical_query_hash: string;
  data_as_of: Date;
  retention_until: Date | null;
};
type Share = {
  id: string;
  query_id: string;
  user_id: string;
  expires_at: Date;
  created_at: Date;
  revoked_at: Date | null;
};
const dayMs = 86400000;
const unavailable = () => new AppError("share_unavailable", 410, "This share link is unavailable.");
function denied() {
  return new AppError("forbidden", 403, "Current public distribution rights are unavailable.");
}
const missingCache = () =>
  new AppError("source_unavailable", 503, "No current public cache matches this search.", {
    next_action: "register_or_try_later",
  });
const expectedAbsence = (error: unknown) =>
  error instanceof AppError && [403, 404, 409, 410, 503].includes(error.status);
function dateAt(value: number) {
  return new Date(value);
}
function summary(share: Share) {
  return {
    share_id: share.id,
    query_id: share.query_id,
    created_at: share.created_at.toISOString(),
    expires_at: share.expires_at.toISOString(),
    revoked_at: share.revoked_at?.toISOString() ?? null,
  };
}

export class PublicResults {
  constructor(readonly service: QueryService) {}

  private async snapshot(c: Transaction, owner: string, id: string, now: Date, purpose: Purpose) {
    const q = (
      await c.query<Snapshot>(
        "SELECT q.id,q.canonical_query_hash,r.stats,r.quality,r.diagnostics,r.data_as_of,LEAST((SELECT min(x.expires_at) FROM query_result_sources z JOIN source_clearances x ON x.id=z.clearance_id WHERE z.query_id=q.id),(SELECT min(o.retention_until) FROM source_observations o WHERE o.collector_run_id=j.collector_run_id),(SELECT min(o.retention_until) FROM query_snapshot_records k JOIN source_observations o ON o.id=k.observation_id WHERE k.query_id=q.id)) retention_until FROM queries q JOIN query_results r ON r.query_id=q.id LEFT JOIN collector_jobs j ON j.id=q.collector_job_id WHERE q.id=$1 AND q.user_id=$2 AND q.compute_status='completed' AND q.result_state='available' AND q.settlement_status IN ('charged','refunded','not_required') AND q.normalizer_version=$3 AND r.engine_version=$4 AND r.cleaner_version=$5 AND q.billing_policy_version=$6 FOR SHARE OF q",
        [id, owner, VERSIONS.normalizer, VERSIONS.engine, VERSIONS.cleaner, VERSIONS.billing],
      )
    ).rows[0];
    if (!q) throw new AppError("not_found", 404, "Delivered snapshot not found.");
    if (!q.data_as_of || !q.retention_until || q.retention_until <= now || q.data_as_of > now) throw denied();
    await this.service.assertSnapshotRights(c, id, now);
    const rights = (
      await c.query(
        "SELECT x.permitted_fields->$2 AS permission FROM query_result_sources z JOIN source_clearances x ON x.id=z.clearance_id WHERE z.query_id=$1",
        [id, purpose],
      )
    ).rows;
    if (
      !rights.length ||
      rights.some((row) => !Array.isArray(row.permission) || !row.permission.includes("aggregate"))
    )
      throw denied();
    return q;
  }

  private view(q: Snapshot, expires: Date, mode: "history" | "current", now: Date) {
    return {
      ...publicSummary(q, now.getTime() - q.data_as_of.getTime() > dayMs),
      comps: [],
      data_as_of: q.data_as_of.toISOString(),
      expires_at: expires.toISOString(),
      result_mode: mode,
      data_mode: "synthetic_fixture",
    };
  }

  private async ownerMutation(c: Transaction, actor: Identity) {
    if (!actor.sessionId || actor.keyId)
      throw new AppError("forbidden", 403, "A recently authenticated session is required.");
    const now = await this.service.now(c);
    await this.service.auth.assertIdentityLocked(c, actor, "sold:read", now, true);
    return now;
  }

  async create(actor: Identity, id: string, seconds: number, rawKey: string | undefined, origin: string) {
    if (!rawKey || !/^[\x21-\x7e]{16,128}$/.test(rawKey))
      throw new AppError("invalid_parameter", 400, "A valid Idempotency-Key is required.");
    if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 604800)
      throw new AppError("invalid_parameter", 400, "Invalid share lifetime.");
    const key = this.service.auth.crypto.hash("share.idempotency", rawKey),
      shape = JSON.stringify([id, seconds]),
      owner = actor.userId;
    return transaction(this.service.db, async (c) => {
      const now = await this.ownerMutation(c, actor);
      const prior = (
        await c.query(
          "SELECT resource_id,request_hash FROM idempotency_records WHERE owner_scope=$1 AND operation='share.create' AND key_hash=$2",
          [owner, key],
        )
      ).rows[0];
      if (prior && prior.request_hash !== shape)
        throw new AppError("idempotency_conflict", 409, "Share key was used with different parameters.");
      const q = await this.snapshot(c, owner, id, now, "public_share");
      if (!q.retention_until) throw denied();
      if (prior) {
        const row = (
          await c.query<Share>("SELECT * FROM shares WHERE id=$1 AND user_id=$2 FOR SHARE", [
            prior.resource_id,
            owner,
          ])
        ).rows[0];
        if (!row || row.revoked_at || row.expires_at <= now) throw unavailable();
        return {
          replayed: true as const,
          data: {
            share_id: row.id,
            expires_at: new Date(
              Math.min(row.expires_at.getTime(), q.retention_until.getTime()),
            ).toISOString(),
            token_available: false as const,
          },
        };
      }
      const expires = dateAt(Math.min(q.retention_until.getTime(), now.getTime() + seconds * 1000)),
        token = this.service.auth.crypto.token("sb_sh_"),
        digest = this.service.auth.crypto.hash("share.access", token);
      const row = (
        await c.query<Share>(
          "INSERT INTO shares(query_id,user_id,token_hash,field_scope,created_at,expires_at) VALUES($1,$2,$3,'{\"aggregate\":true}',$4,$5) RETURNING id",
          [id, owner, digest, now, expires],
        )
      ).rows[0];
      if (!row) throw new Error("share_insert_failed");
      await c.query(
        "INSERT INTO idempotency_records(owner_scope,operation,key_hash,request_hash,resource_id,status,expires_at) VALUES($1,'share.create',$2,$3,$4,'committed',$5)",
        [owner, key, shape, row.id, expires],
      );
      await this.audit(c, owner, "share.create", row.id, now);
      return {
        replayed: false as const,
        data: {
          share_id: row.id,
          token,
          url: new URL(`/share/${token}`, origin).href,
          expires_at: expires.toISOString(),
        },
      };
    });
  }

  async list(actor: Identity, size: number, id?: string, cursor?: string) {
    return transaction(this.service.db, async (c) => {
      await this.service.owner(c, actor);
      const kind = id ? `shares:${id}` : "shares",
        after = this.service.readCursor(actor.userId, kind, cursor),
        rows = (
          await c.query<Share & { cursor_at: string }>(
            `SELECT id,query_id,user_id,created_at,expires_at,revoked_at,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at FROM shares WHERE user_id=$1 AND ($2::uuid IS NULL OR query_id=$2) AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT $5`,
            [actor.userId, id ?? null, after?.time ?? null, after?.id ?? null, size + 1],
          )
        ).rows;
      const last = rows[size - 1];
      return {
        items: rows.slice(0, size).map(summary),
        next_cursor: rows.length > size && last ? this.service.makeCursor(actor.userId, kind, last) : null,
      };
    });
  }
  private async audit(c: Transaction, owner: string, action: string, id: string, now: Date) {
    await c.query(
      "INSERT INTO audit_events(actor_id,action,object_type,object_id,request_id,created_at) VALUES($1,$2,'share',$3,$4,$5)",
      [owner, action, id, id, now],
    );
  }
  async revoke(actor: Identity, id: string) {
    return transaction(this.service.db, async (c) => {
      const now = await this.ownerMutation(c, actor);
      const row = (
        await c.query<Share>("SELECT id,revoked_at FROM shares WHERE id=$1 AND user_id=$2 FOR UPDATE", [
          id,
          actor.userId,
        ])
      ).rows[0];
      if (!row) throw new AppError("not_found", 404, "Share not found.");
      if (!row.revoked_at) {
        await c.query("UPDATE shares SET revoked_at=$2 WHERE id=$1", [id, now]);
        await this.audit(c, actor.userId, "share.revoke", id, now);
      }
    });
  }
  private async assertPublisher(c: Transaction, userId: string) {
    if (
      !(
        await c.query(
          "SELECT 1 FROM users WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL FOR SHARE",
          [userId],
        )
      ).rowCount
    )
      throw denied();
  }
  async share(token: string) {
    if (!/^sb_sh_[A-Za-z0-9_-]{43}$/.test(token)) throw unavailable();
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c),
        key = this.service.auth.crypto.hash("share.access", token);
      const first = (
        await c.query<Share>("SELECT id,query_id,user_id FROM shares WHERE token_hash=$1", [key])
      ).rows[0];
      if (!first) throw unavailable();
      try {
        await this.assertPublisher(c, first.user_id);
        const q = await this.snapshot(c, first.user_id, first.query_id, now, "public_share");
        if (!q.retention_until) throw denied();
        const share = (
          await c.query<Share>(
            "SELECT id,expires_at,revoked_at FROM shares WHERE id=$1 AND token_hash=$2 AND field_scope->>'aggregate'='true' FOR SHARE",
            [first.id, key],
          )
        ).rows[0];
        if (!share || share.revoked_at || share.expires_at <= now) throw unavailable();
        return this.view(
          q,
          dateAt(Math.min(q.retention_until.getTime(), share.expires_at.getTime())),
          "history",
          now,
        );
      } catch (error) {
        if (expectedAbsence(error)) throw unavailable();
        throw error;
      }
    });
  }

  /** Trusted fixture operation, never invoked by an anonymous or public request. */
  async publishFixture(id: string) {
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c),
        owner = (await c.query("SELECT user_id FROM queries WHERE id=$1", [id])).rows[0]?.user_id;
      if (!owner) throw denied();
      await this.assertPublisher(c, owner);
      const q = await this.snapshot(c, owner, id, now, "public_cache");
      if (now.getTime() - q.data_as_of.getTime() > dayMs) throw missingCache();
      await c.query(
        "INSERT INTO anonymous_cache_publications(canonical_query_hash,query_id,user_id,published_at) VALUES($1,$2,$3,$4) ON CONFLICT(canonical_query_hash) DO UPDATE SET query_id=excluded.query_id,user_id=excluded.user_id,published_at=excluded.published_at",
        [q.canonical_query_hash, id, owner, now],
      );
      return { query_id: id, published_at: now.toISOString(), data_mode: "offline_fixture" };
    });
  }
  private keys(now: Date, visitor: string, network: string) {
    const day = now.toISOString().slice(0, 10);
    const make = (kind: string, value: string) =>
      this.service.auth.crypto.hash(`public.cache.${kind}.${day}`, value);
    return { day, n: make("network", network), v: make("visitor", visitor) };
  }
  private async attempt(visitor: string, network: string) {
    const delay = await transaction(this.service.db, async (c) => {
      const now = await this.service.now(c),
        { n, v } = this.keys(now, visitor, network),
        bucket = dateAt(Math.floor(now.getTime() / 60000) * 60000);
      const limits = [n, v].sort();
      for (const key of limits) {
        const row = await c.query(
          "INSERT INTO anonymous_rate_windows(bucket_hash,window_start,used) VALUES($1,$2,1) ON CONFLICT(bucket_hash,window_start) DO UPDATE SET used=anonymous_rate_windows.used+1 WHERE anonymous_rate_windows.used<20 RETURNING used",
          [key, bucket],
        );
        if (!row.rowCount) return Math.max(1, 60 - now.getUTCSeconds());
      }
      return 0;
    });
    if (delay)
      throw new AppError("rate_limited", 429, "Anonymous search rate exceeded.", { retry_after: delay });
  }

  async prune() {
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c),
        expiry = new Date(now.getTime() - 2 * dayMs);
      await c.query(
        "DELETE FROM anonymous_rate_windows WHERE ctid IN (SELECT ctid FROM anonymous_rate_windows WHERE window_start<$1 ORDER BY window_start LIMIT 1000 FOR UPDATE SKIP LOCKED)",
        [expiry],
      );
      await c.query(
        "DELETE FROM anonymous_quota WHERE ctid IN (SELECT ctid FROM anonymous_quota WHERE day<$1 ORDER BY day LIMIT 1000 FOR UPDATE SKIP LOCKED)",
        [expiry.toISOString().slice(0, 10)],
      );
      await c.query(
        "DELETE FROM anonymous_cache_deliveries WHERE ctid IN (SELECT ctid FROM anonymous_cache_deliveries WHERE day<$1 ORDER BY day LIMIT 1000 FOR UPDATE SKIP LOCKED)",
        [expiry.toISOString().slice(0, 10)],
      );
    });
  }
  async anonymous(input: SoldQuery, visitor: string, network: string) {
    await this.attempt(visitor, network);
    const hash = queryHash(input);
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c),
        { day, n, v } = this.keys(now, visitor, network),
        publication = (
          await c.query(
            "SELECT query_id,user_id FROM anonymous_cache_publications WHERE canonical_query_hash=$1",
            [hash],
          )
        ).rows[0];
      if (!publication) throw missingCache();
      let q: Snapshot;
      try {
        await this.assertPublisher(c, publication.user_id);
        q = await this.snapshot(c, publication.user_id, publication.query_id, now, "public_cache");
      } catch (error) {
        if (expectedAbsence(error)) throw missingCache();
        throw error;
      }
      if (
        !q.retention_until ||
        availability({
          now: now.toISOString(),
          dataAsOf: q.data_as_of.toISOString(),
          currentRights: "allowed",
          snapshotExists: true,
          allowStale: false,
          verifiedSamples: q.stats.n_price_verified,
        }).freshness !== "fresh"
      )
        throw missingCache();
      // Hold both rotating quotas in the same stable lock order; do not count failures or duplicate delivery.
      const quotas = [];
      for (const key of [n, v].sort()) {
        await c.query(
          "INSERT INTO anonymous_quota(rotating_identity,day,used_count) VALUES($1,$2,0) ON CONFLICT DO NOTHING",
          [key, day],
        );
        const row = (
          await c.query(
            "SELECT used_count FROM anonymous_quota WHERE rotating_identity=$1 AND day=$2 FOR UPDATE",
            [key, day],
          )
        ).rows[0];
        quotas.push(row.used_count as number);
      }
      const previous = (
          await c.query(
            "SELECT delivered_at FROM anonymous_cache_deliveries WHERE day=$1 AND visitor_identity=$2 AND network_identity=$3 AND canonical_query_hash=$4 AND query_id=$5",
            [day, v, n, hash, q.id],
          )
        ).rows[0],
        reused = Boolean(previous && now.getTime() - previous.delivered_at.getTime() < 600000),
        used = Math.max(...quotas);
      if (!reused && used >= 5)
        throw new AppError("rate_limited", 429, "Daily anonymous cache allowance exhausted.", {
          retry_after: Math.max(
            1,
            Math.ceil((Date.parse(`${day}T00:00:00Z`) + dayMs - now.getTime()) / 1000),
          ),
          next_action: "register_or_try_later",
        });
      if (!reused) {
        await c.query(
          "UPDATE anonymous_quota SET used_count=used_count+1 WHERE day=$1 AND rotating_identity=ANY($2::text[])",
          [day, [n, v]],
        );
        await c.query(
          "INSERT INTO anonymous_cache_deliveries(day,visitor_identity,network_identity,canonical_query_hash,query_id,delivered_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(day,visitor_identity,network_identity,canonical_query_hash,query_id) DO UPDATE SET delivered_at=excluded.delivered_at",
          [day, v, n, hash, q.id, now],
        );
      }
      return {
        view: this.view(
          q,
          dateAt(Math.min(q.retention_until.getTime(), q.data_as_of.getTime() + dayMs)),
          "current",
          now,
        ),
        remaining: 5 - used - (reused ? 0 : 1),
        reused,
      };
    });
  }
}
