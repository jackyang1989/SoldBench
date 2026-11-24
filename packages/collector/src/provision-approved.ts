import { randomUUID } from "node:crypto";
import { canonicalJson, instant } from "@soldbench/core";
import { type Database, transaction } from "@soldbench/db";
import { COLLECTOR_VERSION, digest } from "./fixture.ts";

export type ApprovedEbaySourceInput = {
  accessMethod: "approved_http" | "approved_browser";
  provider?: string;
  dataset?: string;
  documentRef: string;
  documentHash: string;
  reviewedBy: string;
  effectiveAt: string;
  expiresAt: string;
  now?: string;
  approvalRef?: string;
  retentionDays?: number;
  rateCap?: number;
  concurrency?: number;
  maxPages?: number;
  maxBytes?: number;
  dailyJobs?: number;
  dailyPages?: number;
  dailyBytes?: number;
  budgetPolicyDays?: number;
  searchSummaries?: boolean;
  publicAggregates?: boolean;
};

/**
 * Provisions an explicitly audited, commercially reviewed `approved_http` or `approved_browser`
 * eBay US collector source in PostgreSQL 16. Rejects `synthetic_fixture`, invalid digests, or
 * expired windows fail-closed.
 */
export async function provisionApprovedEbaySource(db: Database, input: ApprovedEbaySourceInput) {
  if (input.accessMethod !== "approved_http" && input.accessMethod !== "approved_browser") {
    throw new Error("invalid_approved_access_method");
  }
  const provider = (
    input.provider ?? (input.accessMethod === "approved_browser" ? "ebay_us_browser" : "ebay_us_http")
  ).trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(provider) || provider === "synthetic_fixture") {
    throw new Error("invalid_approved_provider");
  }
  const documentRef = input.documentRef?.trim() ?? "";
  if (!documentRef || documentRef.length > 256 || /[\r\n]/.test(documentRef)) {
    throw new Error("invalid_approved_document_ref");
  }
  const documentHash = input.documentHash?.trim().toLowerCase() ?? "";
  if (!/^[a-f0-9]{64}$/.test(documentHash)) {
    throw new Error("invalid_approved_document_hash");
  }
  const reviewedBy = input.reviewedBy?.trim() ?? "";
  if (!reviewedBy || reviewedBy.length > 128 || /[\r\n]/.test(reviewedBy)) {
    throw new Error("invalid_approved_reviewer");
  }
  const effectiveMs = instant(input.effectiveAt);
  const expiresMs = instant(input.expiresAt);
  if (expiresMs <= effectiveMs) {
    throw new Error("invalid_approved_clearance_window");
  }
  const nowIso = new Date(instant(input.now ?? input.effectiveAt)).toISOString();
  const effectiveIso = new Date(effectiveMs).toISOString();
  const expiresIso = new Date(expiresMs).toISOString();

  const settings = {
    retentionDays: input.retentionDays ?? 7,
    rateCap: input.rateCap ?? 30,
    concurrency: input.concurrency ?? 2,
    maxPages: input.maxPages ?? 5,
    maxBytes: input.maxBytes ?? 32 * 1024 * 1024,
    dailyJobs: input.dailyJobs ?? 100,
    dailyPages: input.dailyPages ?? 1000,
    dailyBytes: input.dailyBytes ?? 128 * 1024 * 1024,
    budgetPolicyDays: input.budgetPolicyDays ?? 30,
  };
  for (const value of Object.values(settings)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid_approved_budget");
  }
  if (settings.retentionDays > 30) throw new Error("invalid_approved_retention");
  if (settings.budgetPolicyDays > 30) throw new Error("invalid_approved_policy_duration");

  const approvalRef = (input.approvalRef ?? documentRef).trim();
  if (!approvalRef || approvalRef.length > 256) throw new Error("invalid_approved_approval_ref");
  const searchSummaries = input.searchSummaries ?? true;
  const publicAggregates = input.publicAggregates ?? false;

  return transaction(db, async (c) => {
    const clearanceId = randomUUID();
    const sourceId = randomUUID();
    const configId = randomUUID();
    const dataset = (input.dataset ?? sourceId).trim();

    await c.query(
      `INSERT INTO source_clearances(
         id, provider, dataset, revision, status, allowed_access_methods, permitted_fields,
         can_store_raw, can_store_derived, can_redistribute_comp, can_publish_stats, can_share,
         retention_days, effective_at, expires_at, document_ref, document_hash, reviewed_by, reviewed_at
       ) VALUES($1, $2, $3, 1, 'active', $4::text[], $5, false, true, false, true, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        clearanceId,
        provider,
        dataset,
        [input.accessMethod],
        {
          research: [
            "identity",
            "title",
            "condition",
            "attributes",
            "description",
            "defects",
            "price",
            "shipping",
            "sold_date",
            "primary_image",
            ...(searchSummaries ? ["source_match_count", "shipping_context", "seller_aggregate"] : []),
          ],
          ...(publicAggregates ? { public_share: ["aggregate"], public_cache: ["aggregate"] } : {}),
        },
        publicAggregates,
        settings.retentionDays,
        effectiveIso,
        expiresIso,
        documentRef,
        documentHash,
        reviewedBy,
        nowIso,
      ],
    );

    await c.query(
      `INSERT INTO sources(
         id, source_clearance_id, marketplace, access_method, collector_version, entrypoint_id, status
       ) VALUES($1, $2, 'ebay_us', $3, $4, 'ebay-us-sold-search', 'active')`,
      [sourceId, clearanceId, input.accessMethod, COLLECTOR_VERSION],
    );

    await c.query(
      `INSERT INTO collector_configs(
         id, source_id, collector_version, allowed_entrypoints, access_method,
         rate_cap, concurrency_cap, max_pages, max_bytes_per_job, enabled, last_approval_ref
       ) VALUES($1, $2, $3, '["ebay-us-sold-search"]', $4, $5, $6, $7, $8, true, $9)`,
      [
        configId,
        sourceId,
        COLLECTOR_VERSION,
        input.accessMethod,
        settings.rateCap,
        settings.concurrency,
        settings.maxPages,
        settings.maxBytes,
        approvalRef,
      ],
    );

    const validUntil = new Date(instant(nowIso) + settings.budgetPolicyDays * 86400000).toISOString();
    const policyHash = digest(
      canonicalJson({
        sourceId,
        jobs: settings.dailyJobs,
        pages: settings.dailyPages,
        bytes: settings.dailyBytes,
        from: nowIso,
        until: validUntil,
        approval: approvalRef,
      }),
    );

    await c.query(
      `INSERT INTO collector_daily_budget_policies(
         source_id, policy_hash, jobs_cap, pages_cap, bytes_cap, approval_ref, valid_from, valid_until, created_at
       ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $7)`,
      [
        sourceId,
        policyHash,
        settings.dailyJobs,
        settings.dailyPages,
        settings.dailyBytes,
        approvalRef,
        nowIso,
        validUntil,
      ],
    );
    await c.query("UPDATE sources SET daily_budget_policy_hash=$2 WHERE id=$1", [sourceId, policyHash]);

    const budgetDay = nowIso.slice(0, 10);
    for (const [kind, cap] of [
      ["jobs", settings.dailyJobs],
      ["pages", settings.dailyPages],
      ["bytes", settings.dailyBytes],
    ]) {
      await c.query(
        "INSERT INTO source_daily_budget(source_id, day, budget_kind, cap) VALUES($1, $2, $3, $4)",
        [sourceId, budgetDay, kind, cap],
      );
    }

    return {
      sourceId,
      configId,
      clearanceId,
      accessMethod: input.accessMethod,
      provider,
      effectiveAt: effectiveIso,
      expiresAt: expiresIso,
    };
  });
}
