import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Identity } from "@soldbench/auth";
import { normalizeQuery, queryHash, queryParameters } from "@soldbench/core";
import { type Transaction, transaction } from "@soldbench/db";
import { AppError } from "@soldbench/shared";
import type { QueryService } from "./index.ts";

export const MAX_WATCHLISTS_PER_OWNER = 50;
export const MAX_WEBHOOK_ENDPOINTS_PER_OWNER = 10;
export const MAX_WEBHOOK_ATTEMPTS = 3;
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;
export const WEBHOOK_EVENT_TYPES = ["price_alert", "low_credits", "job_completed"] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
export type WatchlistTriggerKind = "price_below" | "price_above" | "low_credits" | "job_completed";
export type WatchlistScheduleMode = "passive_reuse" | "scheduled_refresh";
export type WatchlistStatus = "active" | "paused" | "unsubscribed";

export interface WebhookDeliveryTransport {
  readonly kind: "memory_fixture" | string;
  send(input: {
    deliveryId: string;
    endpointId: string;
    targetUrl: string;
    eventType: WebhookEventType;
    signatureHeader: string;
    timestamp: number;
    body: string;
  }): Promise<{ status: number; error?: string }>;
}

type WatchlistRow = {
  id: string;
  user_id: string;
  name: string;
  canonical_query_hash: string;
  query_params: Record<string, unknown>;
  trigger_kind: WatchlistTriggerKind;
  threshold_cents: string | number | null;
  low_credits_threshold: number | null;
  schedule_mode: WatchlistScheduleMode;
  billing_consent_accepted: boolean;
  max_credits_per_month: number;
  credits_used_this_period: number;
  budget_period_key: string;
  locale: "en" | "zh-CN";
  status: WatchlistStatus;
  unsubscribe_token_hash: string;
  last_evaluated_at: Date | null;
  last_query_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type EndpointRow = {
  id: string;
  user_id: string;
  name: string;
  target_url: string;
  signing_secret_ciphertext: Uint8Array;
  secret_prefix: string;
  event_types: WebhookEventType[];
  status: "active" | "paused" | "disabled";
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
};

type DeliveryRow = {
  id: string;
  endpoint_id: string;
  user_id: string;
  alert_event_id: string;
  query_id: string | null;
  status: "pending" | "retry" | "delivered" | "dead_letter" | "cancelled_rights_revoked";
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date;
  last_http_status: number | null;
  last_error: string | null;
  delivered_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function deny(code: string, status: number, message: string): never {
  throw new AppError(code, status, message);
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((x) => Number(x));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a = 0, b = 0] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice(7);
    if (isIP(mapped) === 4) return isPrivateOrReservedIpv4(mapped);
  }
  const firstHextet = Number.parseInt(lower.split(":")[0] || "0", 16);
  if ((firstHextet & 0xfe00) === 0xfc00) return true;
  if ((firstHextet & 0xffc0) === 0xfe80) return true;
  if ((firstHextet & 0xff00) === 0xff00) return true;
  return false;
}

/**
 * Validate outbound webhook URLs strictly to mitigate SSRF attacks.
 */
export function validateWebhookTargetUrl(rawUrl: string): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    deny("invalid_parameter", 400, "Webhook target_url must be a valid HTTPS URL.");
  }
  if (u.protocol !== "https:") deny("invalid_parameter", 400, "Webhook target_url must use https://.");
  if (u.username || u.password || u.hash)
    deny("invalid_parameter", 400, "Webhook target_url cannot embed credentials or fragments.");
  const rawHost = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    !rawHost ||
    rawHost === "localhost" ||
    rawHost.endsWith(".localhost") ||
    rawHost.endsWith(".local") ||
    rawHost.endsWith(".internal")
  )
    deny("invalid_parameter", 400, "Webhook target_url host is not allowed.");
  const ipVer = isIP(rawHost);
  if (ipVer === 4 && isPrivateOrReservedIpv4(rawHost))
    deny("invalid_parameter", 400, "Private or loopback IPv4 webhook targets are forbidden.");
  if (ipVer === 6 && isPrivateOrReservedIpv6(rawHost))
    deny("invalid_parameter", 400, "Private or loopback IPv6 webhook targets are forbidden.");
  return u.href;
}

export function signWebhookPayload(secret: string, timestampSeconds: number, rawBody: string): string {
  const digest = createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestampSeconds},v1=${digest}`;
}

export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string,
  nowUnixSeconds: number,
  toleranceSeconds = WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  const parts = new Map(
    signatureHeader
      .split(",")
      .map((item) => item.trim().split("=", 2) as [string, string])
      .filter(([k, v]) => Boolean(k) && Boolean(v)),
  );
  const tsText = parts.get("t");
  const sigHex = parts.get("v1");
  if (!tsText || !sigHex || !/^\d+$/.test(tsText) || !/^[0-9a-f]{64}$/.test(sigHex)) return false;
  const ts = Number(tsText);
  if (!Number.isSafeInteger(ts) || Math.abs(nowUnixSeconds - ts) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`, "utf8").digest("hex");
  return timingSafeEqual(Buffer.from(sigHex, "utf8"), Buffer.from(expected, "utf8"));
}

function normalizeWatchlistQuery(input: Record<string, unknown>) {
  const normalized = normalizeQuery(queryParameters(input));
  return { normalized, canonicalHash: queryHash(normalized) };
}

function serializeWatchlist(row: WatchlistRow) {
  return {
    id: row.id,
    name: row.name,
    canonical_query_hash: row.canonical_query_hash,
    query: row.query_params,
    trigger_kind: row.trigger_kind,
    threshold_cents: row.threshold_cents === null ? null : Number(row.threshold_cents),
    low_credits_threshold: row.low_credits_threshold,
    schedule_mode: row.schedule_mode,
    billing_consent_accepted: row.billing_consent_accepted,
    max_credits_per_month: row.max_credits_per_month,
    credits_used_this_period: row.credits_used_this_period,
    budget_period_key: row.budget_period_key,
    locale: row.locale,
    status: row.status,
    last_evaluated_at: row.last_evaluated_at ? row.last_evaluated_at.toISOString() : null,
    last_query_id: row.last_query_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function serializeEndpoint(row: EndpointRow) {
  return {
    id: row.id,
    name: row.name,
    target_url: row.target_url,
    secret_prefix: row.secret_prefix,
    event_types: row.event_types,
    status: row.status,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    revoked_at: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}

function serializeDelivery(row: DeliveryRow) {
  return {
    id: row.id,
    endpoint_id: row.endpoint_id,
    alert_event_id: row.alert_event_id,
    query_id: row.query_id,
    status: row.status,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    next_attempt_at: row.next_attempt_at.toISOString(),
    last_http_status: row.last_http_status,
    last_error: row.last_error,
    delivered_at: row.delivered_at ? row.delivered_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export class AlertWebhookService {
  constructor(
    readonly query: QueryService,
    readonly transport?: WebhookDeliveryTransport,
  ) {}

  private periodKey(now: Date) {
    return now.toISOString().slice(0, 7);
  }

  private validateTriggerAndSchedule(input: {
    trigger_kind: WatchlistTriggerKind;
    threshold_cents?: number | null;
    low_credits_threshold?: number | null;
    schedule_mode: WatchlistScheduleMode;
    billing_consent_accepted: boolean;
    max_credits_per_month: number;
  }) {
    if (
      input.schedule_mode === "scheduled_refresh" &&
      (!input.billing_consent_accepted || input.max_credits_per_month < 1)
    )
      deny(
        "billing_consent_required",
        400,
        "Scheduled refresh watchlists require explicit billing_consent_accepted=true and max_credits_per_month >= 1.",
      );
    if (input.trigger_kind === "price_below" || input.trigger_kind === "price_above") {
      if (input.threshold_cents === undefined || input.threshold_cents === null || input.threshold_cents < 0)
        deny("invalid_parameter", 400, "Price alerts require non-negative integer threshold_cents.");
      if (input.low_credits_threshold !== undefined && input.low_credits_threshold !== null)
        deny("invalid_parameter", 400, "low_credits_threshold is invalid for price alerts.");
    } else if (input.trigger_kind === "low_credits") {
      if (
        input.low_credits_threshold === undefined ||
        input.low_credits_threshold === null ||
        input.low_credits_threshold < 0
      )
        deny(
          "invalid_parameter",
          400,
          "low_credits alerts require non-negative integer low_credits_threshold.",
        );
      if (input.threshold_cents !== undefined && input.threshold_cents !== null)
        deny("invalid_parameter", 400, "threshold_cents is invalid for low_credits alerts.");
    } else if (
      (input.threshold_cents !== undefined && input.threshold_cents !== null) ||
      (input.low_credits_threshold !== undefined && input.low_credits_threshold !== null)
    ) {
      deny("invalid_parameter", 400, "job_completed alerts do not accept numeric thresholds.");
    }
  }

  async createWatchlist(
    identity: Identity,
    input: {
      name: string;
      query: Record<string, unknown>;
      trigger_kind: WatchlistTriggerKind;
      threshold_cents?: number | null;
      low_credits_threshold?: number | null;
      schedule_mode: WatchlistScheduleMode;
      billing_consent_accepted?: boolean;
      max_credits_per_month?: number;
      locale?: "en" | "zh-CN";
    },
  ) {
    const name = input.name.trim();
    if (!name || name.length > 120) deny("invalid_parameter", 400, "Invalid watchlist name.");
    const consent = input.billing_consent_accepted ?? false;
    const maxCredits = input.max_credits_per_month ?? (input.schedule_mode === "scheduled_refresh" ? 10 : 0);
    const locale = input.locale ?? "en";
    this.validateTriggerAndSchedule({
      trigger_kind: input.trigger_kind,
      threshold_cents: input.threshold_cents ?? null,
      low_credits_threshold: input.low_credits_threshold ?? null,
      schedule_mode: input.schedule_mode,
      billing_consent_accepted: consent,
      max_credits_per_month: maxCredits,
    });
    const { normalized, canonicalHash } =
      input.trigger_kind === "low_credits" && !input.query.q
        ? { normalized: {}, canonicalHash: "account:low_credits" }
        : normalizeWatchlistQuery(input.query);
    const unsubToken = this.query.auth.crypto.token("sb_unsub_");
    const unsubHash = this.query.auth.crypto.hash("alerts.unsubscribe", unsubToken);

    const row = await transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity);
      const countRow = (
        await c.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM watchlists WHERE user_id=$1 AND status IN ('active','paused')",
          [identity.userId],
        )
      ).rows[0];
      if ((countRow?.n ?? 0) >= MAX_WATCHLISTS_PER_OWNER)
        deny(
          "watchlist_limit_exceeded",
          422,
          `Maximum of ${MAX_WATCHLISTS_PER_OWNER} active watchlists reached.`,
        );

      const created = (
        await c.query<WatchlistRow>(
          `INSERT INTO watchlists(
             user_id,name,canonical_query_hash,query_params,trigger_kind,
             threshold_cents,low_credits_threshold,schedule_mode,billing_consent_accepted,
             max_credits_per_month,credits_used_this_period,budget_period_key,locale,
             status,unsubscribe_token_hash,created_at,updated_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,'active',$13,$14,$14)
           RETURNING *`,
          [
            identity.userId,
            name,
            canonicalHash,
            JSON.stringify(normalized),
            input.trigger_kind,
            input.threshold_cents ?? null,
            input.low_credits_threshold ?? null,
            input.schedule_mode,
            consent,
            maxCredits,
            this.periodKey(now),
            locale,
            unsubHash,
            now,
          ],
        )
      ).rows[0];
      if (!created) throw new Error("watchlist_insert_failed");
      return created;
    });
    return { watchlist: serializeWatchlist(row), unsubscribe_token: unsubToken, credits_charged: 0 };
  }

  async listWatchlists(identity: Identity) {
    return transaction(this.query.db, async (c) => {
      await this.query.owner(c, identity);
      return (
        await c.query<WatchlistRow>(
          "SELECT * FROM watchlists WHERE user_id=$1 ORDER BY created_at DESC, id ASC",
          [identity.userId],
        )
      ).rows.map(serializeWatchlist);
    });
  }

  async updateWatchlist(
    identity: Identity,
    id: string,
    patch: {
      name?: string;
      status?: "active" | "paused";
      locale?: "en" | "zh-CN";
      threshold_cents?: number | null;
      low_credits_threshold?: number | null;
      schedule_mode?: WatchlistScheduleMode;
      billing_consent_accepted?: boolean;
      max_credits_per_month?: number;
    },
  ) {
    return transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity);
      const current = (
        await c.query<WatchlistRow>("SELECT * FROM watchlists WHERE id=$1 AND user_id=$2 FOR UPDATE", [
          id,
          identity.userId,
        ])
      ).rows[0];
      if (!current) deny("not_found", 404, "Watchlist not found.");
      if (current.status === "unsubscribed" && patch.status === "active")
        deny(
          "state_conflict",
          409,
          "Unsubscribed watchlist cannot be silently re-enabled; create a new consent rule.",
        );

      const nextName = patch.name === undefined ? current.name : patch.name.trim();
      if (!nextName || nextName.length > 120) deny("invalid_parameter", 400, "Invalid watchlist name.");
      const nextSchedule = patch.schedule_mode ?? current.schedule_mode;
      const nextConsent = patch.billing_consent_accepted ?? current.billing_consent_accepted;
      const nextCap = patch.max_credits_per_month ?? current.max_credits_per_month;
      const nextThreshold =
        patch.threshold_cents === undefined
          ? current.threshold_cents === null
            ? null
            : Number(current.threshold_cents)
          : patch.threshold_cents;
      const nextLowCredits =
        patch.low_credits_threshold === undefined
          ? current.low_credits_threshold
          : patch.low_credits_threshold;

      this.validateTriggerAndSchedule({
        trigger_kind: current.trigger_kind,
        threshold_cents: nextThreshold,
        low_credits_threshold: nextLowCredits,
        schedule_mode: nextSchedule,
        billing_consent_accepted: nextConsent,
        max_credits_per_month: nextCap,
      });

      const updated = (
        await c.query<WatchlistRow>(
          `UPDATE watchlists
           SET name=$3,status=$4,locale=$5,threshold_cents=$6,low_credits_threshold=$7,
               schedule_mode=$8,billing_consent_accepted=$9,max_credits_per_month=$10,updated_at=$11
           WHERE id=$1 AND user_id=$2 RETURNING *`,
          [
            id,
            identity.userId,
            nextName,
            patch.status ?? current.status,
            patch.locale ?? current.locale,
            nextThreshold,
            nextLowCredits,
            nextSchedule,
            nextConsent,
            nextCap,
            now,
          ],
        )
      ).rows[0];
      if (!updated) throw new Error("watchlist_update_failed");
      return serializeWatchlist(updated);
    });
  }

  async deleteWatchlist(identity: Identity, id: string) {
    await transaction(this.query.db, async (c) => {
      await this.query.owner(c, identity);
      const removed = await c.query("DELETE FROM watchlists WHERE id=$1 AND user_id=$2 RETURNING id", [
        id,
        identity.userId,
      ]);
      if (!removed.rowCount) deny("not_found", 404, "Watchlist not found.");
    });
  }

  async unsubscribeByToken(token: string) {
    if (!/^sb_unsub_[A-Za-z0-9_-]{43}$/.test(token))
      deny("token_invalid", 410, "Unsubscribe token is invalid or expired.");
    const hash = this.query.auth.crypto.hash("alerts.unsubscribe", token);
    return transaction(this.query.db, async (c) => {
      const now = await this.query.now(c);
      const row = (
        await c.query<{ id: string; user_id: string }>(
          "UPDATE watchlists SET status='unsubscribed',updated_at=$2 WHERE unsubscribe_token_hash=$1 RETURNING id,user_id",
          [hash, now],
        )
      ).rows[0];
      if (!row) deny("token_invalid", 410, "Unsubscribe token is invalid or expired.");
      await c.query(
        `UPDATE webhook_deliveries d
         SET status='cancelled_rights_revoked',last_error='watchlist_unsubscribed',updated_at=$2
         FROM alert_events e
         WHERE e.id=d.alert_event_id AND e.watchlist_id=$1 AND d.status IN ('pending','retry')`,
        [row.id, now],
      );
      return { unsubscribed: true, watchlist_id: row.id };
    });
  }

  async createWebhookEndpoint(
    identity: Identity,
    input: { name: string; target_url: string; event_types: WebhookEventType[] },
  ) {
    const name = input.name.trim();
    if (!name || name.length > 120) deny("invalid_parameter", 400, "Invalid webhook name.");
    const targetUrl = validateWebhookTargetUrl(input.target_url);
    const events = [...new Set(input.event_types)];
    if (!events.length || events.some((e) => !WEBHOOK_EVENT_TYPES.includes(e)))
      deny("invalid_parameter", 400, "Specify valid webhook event_types.");

    const endpointId = randomUUID();
    const signingSecret = this.query.auth.crypto.token("sb_whsec_");
    const secretPrefix = signingSecret.slice(0, 14);
    const ciphertext = this.query.auth.crypto.seal({ secret: signingSecret }, `alerts.webhook:${endpointId}`);

    const row = await transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity);
      const countRow = (
        await c.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM webhook_endpoints WHERE user_id=$1 AND status IN ('active','paused')",
          [identity.userId],
        )
      ).rows[0];
      if ((countRow?.n ?? 0) >= MAX_WEBHOOK_ENDPOINTS_PER_OWNER)
        deny(
          "webhook_limit_exceeded",
          422,
          `Maximum of ${MAX_WEBHOOK_ENDPOINTS_PER_OWNER} active webhook endpoints reached.`,
        );
      const created = (
        await c.query<EndpointRow>(
          `INSERT INTO webhook_endpoints(id,user_id,name,target_url,signing_secret_ciphertext,secret_prefix,event_types,status,created_at,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,$8) RETURNING *`,
          [endpointId, identity.userId, name, targetUrl, ciphertext, secretPrefix, events, now],
        )
      ).rows[0];
      if (!created) throw new Error("webhook_endpoint_insert_failed");
      return created;
    });
    return { endpoint: serializeEndpoint(row), signing_secret: signingSecret };
  }

  async listWebhookEndpoints(identity: Identity) {
    return transaction(this.query.db, async (c) => {
      await this.query.owner(c, identity);
      return (
        await c.query<EndpointRow>(
          "SELECT * FROM webhook_endpoints WHERE user_id=$1 ORDER BY created_at DESC, id ASC",
          [identity.userId],
        )
      ).rows.map(serializeEndpoint);
    });
  }

  async updateWebhookEndpoint(
    identity: Identity,
    id: string,
    patch: { status?: "active" | "paused" | "disabled"; event_types?: WebhookEventType[] },
  ) {
    return transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity);
      const current = (
        await c.query<EndpointRow>("SELECT * FROM webhook_endpoints WHERE id=$1 AND user_id=$2 FOR UPDATE", [
          id,
          identity.userId,
        ])
      ).rows[0];
      if (!current) deny("not_found", 404, "Webhook endpoint not found.");
      const nextEvents = patch.event_types ? [...new Set(patch.event_types)] : current.event_types;
      if (!nextEvents.length || nextEvents.some((e) => !WEBHOOK_EVENT_TYPES.includes(e)))
        deny("invalid_parameter", 400, "Specify valid webhook event_types.");
      const nextStatus = patch.status ?? current.status;
      const updated = (
        await c.query<EndpointRow>(
          `UPDATE webhook_endpoints
           SET status=$3,event_types=$4,revoked_at=CASE WHEN $3='disabled' THEN COALESCE(revoked_at,$5) ELSE NULL END,updated_at=$5
           WHERE id=$1 AND user_id=$2 RETURNING *`,
          [id, identity.userId, nextStatus, nextEvents, now],
        )
      ).rows[0];
      if (!updated) throw new Error("webhook_update_failed");
      if (nextStatus === "disabled") {
        await c.query(
          "UPDATE webhook_deliveries SET status='cancelled_rights_revoked',last_error='endpoint_disabled',updated_at=$2 WHERE endpoint_id=$1 AND status IN ('pending','retry')",
          [id, now],
        );
      }
      return serializeEndpoint(updated);
    });
  }

  async deleteWebhookEndpoint(identity: Identity, id: string) {
    await transaction(this.query.db, async (c) => {
      await this.query.owner(c, identity);
      const removed = await c.query("DELETE FROM webhook_endpoints WHERE id=$1 AND user_id=$2 RETURNING id", [
        id,
        identity.userId,
      ]);
      if (!removed.rowCount) deny("not_found", 404, "Webhook endpoint not found.");
    });
  }

  private async enqueueAlertEventLocked(
    c: Transaction,
    userId: string,
    watchlistId: string,
    queryId: string | null,
    eventType: WebhookEventType,
    dedupeKey: string,
    payload: Record<string, unknown>,
    now: Date,
  ) {
    const inserted = (
      await c.query<{ id: string }>(
        `INSERT INTO alert_events(user_id,watchlist_id,query_id,event_type,dedupe_key,payload,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(user_id,dedupe_key) DO NOTHING
         RETURNING id`,
        [userId, watchlistId, queryId, eventType, dedupeKey, JSON.stringify(payload), now],
      )
    ).rows[0];
    if (!inserted) return { event: null, deliveriesQueued: 0 };

    const endpoints = (
      await c.query<EndpointRow>(
        "SELECT * FROM webhook_endpoints WHERE user_id=$1 AND status='active' AND revoked_at IS NULL AND $2 = ANY(event_types) ORDER BY id",
        [userId, eventType],
      )
    ).rows;
    let deliveriesQueued = 0;
    for (const ep of endpoints) {
      const deliv = await c.query(
        `INSERT INTO webhook_deliveries(endpoint_id,user_id,alert_event_id,query_id,status,attempts,max_attempts,next_attempt_at,created_at,updated_at)
         VALUES($1,$2,$3,$4,'pending',0,$5,$6,$6,$6)
         ON CONFLICT(endpoint_id,alert_event_id) DO NOTHING`,
        [ep.id, userId, inserted.id, queryId, MAX_WEBHOOK_ATTEMPTS, now],
      );
      if (deliv.rowCount) deliveriesQueued += 1;
    }
    return {
      event: {
        id: inserted.id,
        event_type: eventType,
        dedupe_key: dedupeKey,
        payload,
        created_at: now.toISOString(),
      },
      deliveriesQueued,
    };
  }

  async evaluateWatchlist(identity: Identity, watchlistId: string) {
    return transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity);
      const w = (
        await c.query<WatchlistRow>("SELECT * FROM watchlists WHERE id=$1 AND user_id=$2 FOR UPDATE", [
          watchlistId,
          identity.userId,
        ])
      ).rows[0];
      if (!w) deny("not_found", 404, "Watchlist not found.");
      if (w.status !== "active")
        return {
          watchlist_id: w.id,
          evaluated: false,
          triggered: false,
          skipped_reason: `watchlist_${w.status}`,
          event: null,
          deliveries_queued: 0,
          credits_charged: 0,
        };

      const currentPeriod = this.periodKey(now);
      const usedCredits = w.budget_period_key === currentPeriod ? w.credits_used_this_period : 0;
      if (w.schedule_mode === "scheduled_refresh" && usedCredits >= w.max_credits_per_month) {
        await c.query(
          "UPDATE watchlists SET budget_period_key=$2,credits_used_this_period=$3,last_evaluated_at=$4,updated_at=$4 WHERE id=$1",
          [w.id, currentPeriod, usedCredits, now],
        );
        return {
          watchlist_id: w.id,
          evaluated: false,
          triggered: false,
          skipped_reason: "monthly_budget_exceeded",
          event: null,
          deliveries_queued: 0,
          credits_charged: 0,
        };
      }

      if (w.trigger_kind === "low_credits") {
        const balRow = (
          await c.query<{ total: number }>(
            "SELECT COALESCE(sum(balance),0)::int AS total FROM credit_wallets WHERE user_id=$1 AND status='active' AND (expires_at IS NULL OR expires_at>$2)",
            [identity.userId, now],
          )
        ).rows[0];
        const remaining = balRow?.total ?? 0;
        const threshold = w.low_credits_threshold ?? 0;
        await c.query("UPDATE watchlists SET last_evaluated_at=$2,updated_at=$2 WHERE id=$1", [w.id, now]);
        if (remaining > threshold)
          return {
            watchlist_id: w.id,
            evaluated: true,
            triggered: false,
            skipped_reason: null,
            event: null,
            deliveries_queued: 0,
            credits_charged: 0,
          };
        const res = await this.enqueueAlertEventLocked(
          c,
          identity.userId,
          w.id,
          null,
          "low_credits",
          `${w.id}:low_credits:${remaining}:${currentPeriod}`,
          {
            watchlist_id: w.id,
            name: w.name,
            locale: w.locale,
            trigger_kind: "low_credits",
            remaining_credits: remaining,
            threshold_credits: threshold,
            summary:
              w.locale === "zh-CN"
                ? `剩余额度 ${remaining} 个已触发低于等于 ${threshold} 阈值提醒`
                : `Remaining credits (${remaining}) reached low-credit threshold (${threshold}).`,
          },
          now,
        );
        return {
          watchlist_id: w.id,
          evaluated: true,
          triggered: Boolean(res.event),
          skipped_reason: res.event ? null : "deduplicated",
          event: res.event,
          deliveries_queued: res.deliveriesQueued,
          credits_charged: 0,
        };
      }

      if (w.trigger_kind === "job_completed") {
        const job = (
          await c.query<{ id: string; query_id: string | null; status: string }>(
            `SELECT j.id,j.query_id,j.status
             FROM query_jobs j JOIN queries q ON q.id=j.query_id
             WHERE q.user_id=$1 AND q.canonical_query_hash=$2 AND j.status='completed'
             ORDER BY j.updated_at DESC, j.id DESC LIMIT 1`,
            [identity.userId, w.canonical_query_hash],
          )
        ).rows[0];
        await c.query("UPDATE watchlists SET last_evaluated_at=$2,updated_at=$2 WHERE id=$1", [w.id, now]);
        if (!job?.query_id)
          return {
            watchlist_id: w.id,
            evaluated: true,
            triggered: false,
            skipped_reason: "no_completed_job",
            event: null,
            deliveries_queued: 0,
            credits_charged: 0,
          };
        try {
          await this.query.assertSnapshotRights(c, job.query_id, now);
        } catch {
          return {
            watchlist_id: w.id,
            evaluated: false,
            triggered: false,
            skipped_reason: "source_rights_unavailable",
            event: null,
            deliveries_queued: 0,
            credits_charged: 0,
          };
        }
        const res = await this.enqueueAlertEventLocked(
          c,
          identity.userId,
          w.id,
          job.query_id,
          "job_completed",
          `${w.id}:job:${job.id}`,
          {
            watchlist_id: w.id,
            name: w.name,
            locale: w.locale,
            trigger_kind: "job_completed",
            job_id: job.id,
            query_id: job.query_id,
            summary:
              w.locale === "zh-CN"
                ? `订阅查询任务 ${job.id} 已完成计算`
                : `Subscribed query job ${job.id} completed.`,
          },
          now,
        );
        return {
          watchlist_id: w.id,
          evaluated: true,
          triggered: Boolean(res.event),
          skipped_reason: res.event ? null : "deduplicated",
          event: res.event,
          deliveries_queued: res.deliveriesQueued,
          credits_charged: 0,
        };
      }

      // Price alerts: require delivered authorized snapshot with >=8 verified prices and non-null median.
      const snap = (
        await c.query<{
          id: string;
          stats: { median_cents: number | null; n_price_verified: number };
          data_as_of: Date | null;
        }>(
          `SELECT q.id,r.stats,r.data_as_of
           FROM queries q JOIN query_results r ON r.query_id=q.id
           WHERE q.user_id=$1 AND q.canonical_query_hash=$2 AND q.compute_status='completed'
             AND q.settlement_status IN ('charged','not_required') AND q.delivered_at IS NOT NULL
           ORDER BY q.delivered_at DESC, q.id DESC LIMIT 1`,
          [identity.userId, w.canonical_query_hash],
        )
      ).rows[0];
      if (!snap)
        return {
          watchlist_id: w.id,
          evaluated: false,
          triggered: false,
          skipped_reason: "no_delivered_snapshot",
          event: null,
          deliveries_queued: 0,
          credits_charged: 0,
        };

      try {
        await this.query.assertSnapshotRights(c, snap.id, now);
      } catch {
        return {
          watchlist_id: w.id,
          evaluated: false,
          triggered: false,
          skipped_reason: "source_rights_unavailable",
          event: null,
          deliveries_queued: 0,
          credits_charged: 0,
        };
      }

      const nextCreditsUsed = w.schedule_mode === "scheduled_refresh" ? usedCredits + 1 : usedCredits;
      await c.query(
        "UPDATE watchlists SET budget_period_key=$2,credits_used_this_period=$3,last_evaluated_at=$4,last_query_id=$5,updated_at=$4 WHERE id=$1",
        [w.id, currentPeriod, nextCreditsUsed, now, snap.id],
      );

      const sampleCount = snap.stats?.n_price_verified ?? 0;
      const medianCents = snap.stats?.median_cents ?? null;
      if (sampleCount < 8 || medianCents === null)
        return {
          watchlist_id: w.id,
          evaluated: true,
          triggered: false,
          skipped_reason: "insufficient_sample",
          event: null,
          deliveries_queued: 0,
          credits_charged: 0,
        };

      const threshold = Number(w.threshold_cents);
      const matches = w.trigger_kind === "price_below" ? medianCents <= threshold : medianCents >= threshold;
      if (!matches)
        return {
          watchlist_id: w.id,
          evaluated: true,
          triggered: false,
          skipped_reason: null,
          event: null,
          deliveries_queued: 0,
          credits_charged: 0,
        };

      const res = await this.enqueueAlertEventLocked(
        c,
        identity.userId,
        w.id,
        snap.id,
        "price_alert",
        `${w.id}:price:${snap.id}:${medianCents}`,
        {
          watchlist_id: w.id,
          name: w.name,
          locale: w.locale,
          trigger_kind: w.trigger_kind,
          threshold_cents: threshold,
          median_cents: medianCents,
          sample_count: sampleCount,
          price_basis: w.query_params.price_basis ?? "item",
          window_days: w.query_params.window_days ?? 90,
          data_as_of: snap.data_as_of ? snap.data_as_of.toISOString() : null,
          query_id: snap.id,
          summary:
            w.locale === "zh-CN"
              ? `${w.name}：${sampleCount} 条核验样本中位价 $${(medianCents / 100).toFixed(2)}`
              : `${w.name}: median $${(medianCents / 100).toFixed(2)} across ${sampleCount} verified sales.`,
        },
        now,
      );
      return {
        watchlist_id: w.id,
        evaluated: true,
        triggered: Boolean(res.event),
        skipped_reason: res.event ? null : "deduplicated",
        event: res.event,
        deliveries_queued: res.deliveriesQueued,
        credits_charged: 0,
      };
    });
  }

  async processNextDelivery(filter: { endpointId?: string; userId?: string } = {}) {
    const claimed = await transaction(this.query.db, async (c) => {
      const now = await this.query.now(c);
      const clauses = ["d.status IN ('pending','retry')", "d.next_attempt_at <= $1"];
      const params: unknown[] = [now];
      if (filter.endpointId) {
        params.push(filter.endpointId);
        clauses.push(`d.endpoint_id=$${params.length}`);
      }
      if (filter.userId) {
        params.push(filter.userId);
        clauses.push(`d.user_id=$${params.length}`);
      }
      const next = (
        await c.query<
          DeliveryRow & {
            target_url: string;
            signing_secret_ciphertext: Uint8Array;
            ep_status: string;
            ep_revoked_at: Date | null;
            wl_status: WatchlistStatus;
            event_type: WebhookEventType;
            event_payload: Record<string, unknown>;
          }
        >(
          `SELECT d.*,ep.target_url,ep.signing_secret_ciphertext,ep.status AS ep_status,ep.revoked_at AS ep_revoked_at,
                  w.status AS wl_status,e.event_type,e.payload AS event_payload
           FROM webhook_deliveries d
           JOIN webhook_endpoints ep ON ep.id=d.endpoint_id
           JOIN alert_events e ON e.id=d.alert_event_id
           JOIN watchlists w ON w.id=e.watchlist_id
           WHERE ${clauses.join(" AND ")}
           ORDER BY d.next_attempt_at ASC, d.created_at ASC, d.id ASC
           FOR UPDATE OF d SKIP LOCKED
           LIMIT 1`,
          params,
        )
      ).rows[0];
      if (!next) return { outcome: "idle" as const };

      if (next.ep_status !== "active" || next.ep_revoked_at || next.wl_status !== "active") {
        const cancelled = (
          await c.query<DeliveryRow>(
            "UPDATE webhook_deliveries SET status='cancelled_rights_revoked',last_error='endpoint_or_watchlist_inactive',updated_at=$2 WHERE id=$1 RETURNING *",
            [next.id, now],
          )
        ).rows[0];
        return { outcome: "cancelled" as const, delivery: cancelled ? serializeDelivery(cancelled) : null };
      }

      if (next.query_id) {
        try {
          await this.query.assertSnapshotRights(c, next.query_id, now);
        } catch {
          const revoked = (
            await c.query<DeliveryRow>(
              "UPDATE webhook_deliveries SET status='cancelled_rights_revoked',last_error='source_rights_revoked',updated_at=$2 WHERE id=$1 RETURNING *",
              [next.id, now],
            )
          ).rows[0];
          return { outcome: "cancelled" as const, delivery: revoked ? serializeDelivery(revoked) : null };
        }
      }

      if (this.transport?.kind !== "memory_fixture")
        deny(
          "webhook_transport_unavailable",
          503,
          "Only memory_fixture transport is allowed for webhook dispatch in offline mode.",
        );

      const started = (
        await c.query<DeliveryRow>(
          "UPDATE webhook_deliveries SET attempts=attempts+1,updated_at=$2 WHERE id=$1 RETURNING *",
          [next.id, now],
        )
      ).rows[0];
      if (!started) throw new Error("delivery_row_missing");

      const unsealed = this.query.auth.crypto.open<{ secret: string }>(
        next.signing_secret_ciphertext,
        `alerts.webhook:${next.endpoint_id}`,
      );
      const ts = Math.floor(now.getTime() / 1000);
      const body = JSON.stringify({
        id: next.alert_event_id,
        event_type: next.event_type,
        created_at: now.toISOString(),
        data: next.event_payload,
      });
      const signatureHeader = signWebhookPayload(unsealed.secret, ts, body);

      return {
        outcome: "send" as const,
        row: started,
        targetUrl: next.target_url,
        eventType: next.event_type,
        timestamp: ts,
        body,
        signatureHeader,
      };
    });

    if (claimed.outcome !== "send") return claimed;

    const transport = this.transport;
    if (transport?.kind !== "memory_fixture")
      deny(
        "webhook_transport_unavailable",
        503,
        "Only memory_fixture transport is allowed for webhook dispatch in offline mode.",
      );

    const response = await transport.send({
      deliveryId: claimed.row.id,
      endpointId: claimed.row.endpoint_id,
      targetUrl: claimed.targetUrl,
      eventType: claimed.eventType,
      signatureHeader: claimed.signatureHeader,
      timestamp: claimed.timestamp,
      body: claimed.body,
    });

    return transaction(this.query.db, async (c) => {
      const now = await this.query.now(c);
      if (response.status >= 200 && response.status < 300) {
        const delivered = (
          await c.query<DeliveryRow>(
            "UPDATE webhook_deliveries SET status='delivered',delivered_at=$2,last_http_status=$3,last_error=NULL,updated_at=$2 WHERE id=$1 RETURNING *",
            [claimed.row.id, now, response.status],
          )
        ).rows[0];
        return { outcome: "delivered" as const, delivery: delivered ? serializeDelivery(delivered) : null };
      }

      const exhausted = claimed.row.attempts >= claimed.row.max_attempts;
      const errMsg = response.error ?? `http_${response.status}`;
      const nextRetryAt = new Date(now.getTime() + claimed.row.attempts * 60000);
      const updated = (
        await c.query<DeliveryRow>(
          `UPDATE webhook_deliveries
           SET status=$2,next_attempt_at=$3,last_http_status=$4,last_error=$5,updated_at=$6
           WHERE id=$1 RETURNING *`,
          [
            claimed.row.id,
            exhausted ? "dead_letter" : "retry",
            exhausted ? now : nextRetryAt,
            response.status,
            errMsg,
            now,
          ],
        )
      ).rows[0];
      return {
        outcome: exhausted ? ("dead_letter" as const) : ("retry" as const),
        delivery: updated ? serializeDelivery(updated) : null,
      };
    });
  }

  async listDeliveries(identity: Identity) {
    return transaction(this.query.db, async (c) => {
      await this.query.owner(c, identity);
      return (
        await c.query<DeliveryRow>(
          "SELECT * FROM webhook_deliveries WHERE user_id=$1 ORDER BY created_at DESC, id ASC LIMIT 100",
          [identity.userId],
        )
      ).rows.map(serializeDelivery);
    });
  }
}
