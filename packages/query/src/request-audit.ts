import type { Identity } from "@soldbench/auth";
import { transaction } from "@soldbench/db";
import { AppError } from "@soldbench/shared";
import type { QueryService } from "./index.ts";
export const requestOperations = [
  "sold_search",
  "sold_stats",
  "sold_result",
  "sold_claim",
  "sold_calculation",
  "sold_diagnostics",
  "sold_detail",
  "sold_export",
  "job_get",
  "job_cancel",
  "usage_get",
  "history_get",
  "media_get",
  "marketplace_preview",
] as const;
export type RequestOperation = (typeof requestOperations)[number];
export type RequestAudit = {
  requestId: string;
  operation: RequestOperation;
  channel: "web" | "api" | "mcp";
  queryId?: string;
  jobId?: string;
  status: number;
  errorCode?: string;
  durationMs: number;
  creditsCharged: 0 | 1;
  reused?: boolean;
  stale?: boolean;
};
const uuid = (x: string | undefined) =>
  x && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x) ? x : null;
export class RequestAuditService {
  constructor(readonly query: QueryService) {}
  async record(identity: Identity, input: RequestAudit) {
    if (
      !uuid(input.requestId) ||
      !requestOperations.includes(input.operation) ||
      !["web", "api", "mcp"].includes(input.channel) ||
      !Number.isSafeInteger(input.durationMs) ||
      input.durationMs < 0 ||
      input.durationMs > 2147483647 ||
      !Number.isInteger(input.status) ||
      input.status < 100 ||
      input.status > 599 ||
      ![0, 1].includes(input.creditsCharged) ||
      (input.errorCode !== undefined && !/^[a-z_]{1,80}$/.test(input.errorCode))
    )
      throw new Error("invalid_request_audit");
    await transaction(this.query.db, async (c) => {
      const owner = (await c.query("SELECT id FROM users WHERE id=$1 FOR SHARE", [identity.userId])).rows[0];
      if (!owner) return;
      const now = await this.query.now(c),
        queryId =
          (
            await c.query("SELECT id FROM queries WHERE user_id=$1 AND id=$2", [
              identity.userId,
              uuid(input.queryId),
            ])
          ).rows[0]?.id ?? null,
        job = (
          await c.query(
            "SELECT j.id,j.query_id FROM query_jobs j JOIN queries q ON q.id=j.query_id WHERE q.user_id=$1 AND j.id=$2",
            [identity.userId, uuid(input.jobId)],
          )
        ).rows[0],
        resolved = queryId ?? job?.query_id ?? null,
        charge =
          (
            await c.query("SELECT id FROM billing_charges WHERE user_id=$1 AND query_id=$2", [
              identity.userId,
              resolved,
            ])
          ).rows[0]?.id ?? null,
        ledgers = charge
          ? (
              await c.query(
                "SELECT id FROM credit_ledger WHERE user_id=$1 AND charge_id=$2 ORDER BY created_at,id",
                [identity.userId, charge],
              )
            ).rows.map((r) => r.id)
          : [];
      await c.query(
        "INSERT INTO query_request_audit(request_id,user_id,operation,channel,query_id,job_id,http_status,error_code,duration_ms,credits_charged,charge_id,ledger_ids,reused,stale,created_at,retention_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(request_id) DO NOTHING",
        [
          input.requestId,
          identity.userId,
          input.operation,
          input.channel,
          resolved,
          job?.id ?? null,
          input.status,
          input.errorCode ?? null,
          input.durationMs,
          input.creditsCharged,
          charge,
          ledgers,
          input.reused ?? null,
          input.stale ?? null,
          now,
          new Date(now.getTime() + 30 * 86400000),
        ],
      );
    });
  }
  async list(
    identity: Identity,
    options: { cursor?: string; size?: number; channel?: string; operation?: string; status?: number } = {},
  ) {
    const size = options.size ?? 20;
    if (
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > 100 ||
      (options.channel !== undefined && !["web", "api", "mcp"].includes(options.channel)) ||
      (options.operation !== undefined &&
        !requestOperations.includes(options.operation as RequestOperation)) ||
      (options.status !== undefined &&
        (!Number.isSafeInteger(options.status) || options.status < 100 || options.status > 599))
    )
      throw new AppError("invalid_parameter", 400, "Invalid request log filters.");
    return transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity, "usage:read"),
        kind = `requests:${options.channel ?? "all"}:${options.operation ?? "all"}:${options.status ?? "all"}`,
        after = this.query.readCursor(identity.userId, kind, options.cursor),
        rows = (
          await c.query(
            `SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at FROM query_request_audit WHERE user_id=$1 AND retention_until>$2 AND ($3::text IS NULL OR channel=$3) AND ($4::text IS NULL OR operation=$4) AND ($5::int IS NULL OR http_status=$5) AND ($6::timestamptz IS NULL OR (created_at,id)<($6::timestamptz,$7::uuid)) ORDER BY created_at DESC,id DESC LIMIT $8`,
            [
              identity.userId,
              now,
              options.channel ?? null,
              options.operation ?? null,
              options.status ?? null,
              after?.time ?? null,
              after?.id ?? null,
              size + 1,
            ],
          )
        ).rows;
      const last = rows[size - 1];
      return {
        items: rows.slice(0, size).map((r) => ({
          id: r.id,
          request_id: r.request_id,
          operation: r.operation,
          channel: r.channel,
          query_id: r.query_id,
          job_id: r.job_id,
          http_status: r.http_status,
          error_code: r.error_code,
          duration_ms: r.duration_ms,
          credits_charged: r.credits_charged,
          charge_id: r.charge_id,
          ledger_ids: r.ledger_ids,
          reused: r.reused,
          stale: r.stale,
          created_at: r.created_at.toISOString(),
          retention_until: r.retention_until.toISOString(),
        })),
        next_cursor: rows.length > size && last ? this.query.makeCursor(identity.userId, kind, last) : null,
      };
    });
  }
  /** Internal retention maintenance only; never a customer deletion endpoint. */
  async purgeExpired() {
    return transaction(this.query.db, async (c) => {
      const now = await this.query.now(c),
        r = await c.query(
          "DELETE FROM query_request_audit WHERE id IN (SELECT id FROM query_request_audit WHERE retention_until<=$1 ORDER BY retention_until,id LIMIT 1000 FOR UPDATE SKIP LOCKED)",
          [now],
        );
      return r.rowCount ?? 0;
    });
  }
}
