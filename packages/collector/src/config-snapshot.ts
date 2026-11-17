import { canonicalJson } from "@soldbench/core";
import { digest } from "./fixture.ts";
export type SourceSnapshot = {
  id: string;
  source_clearance_id: string;
  marketplace: string;
  access_method: string;
  collector_version: string;
  entrypoint_id: string;
  status: string;
  permission_epoch: string;
  retry_after_until: Date | null;
  daily_budget_policy_hash: string | null;
};
export type ConfigSnapshot = {
  id: string;
  source_id: string;
  collector_version: string;
  allowed_entrypoints: unknown;
  access_method: string;
  rate_cap: number;
  concurrency_cap: number;
  max_pages: number;
  max_bytes_per_job: string;
  enabled: boolean;
  last_approval_ref: string | null;
  updated_at: Date;
};
/** Approval/configuration identity, deliberately excludes live usage and cooldown. */
export function collectorConfigHash(source: SourceSnapshot, config: ConfigSnapshot) {
  return digest(
    canonicalJson({
      version: 1,
      source: {
        id: source.id,
        clearance: source.source_clearance_id,
        marketplace: source.marketplace,
        method: source.access_method,
        collectorVersion: source.collector_version,
        entrypoint: source.entrypoint_id,
        epoch: source.permission_epoch,
        dailyBudgetPolicy: source.daily_budget_policy_hash,
      },
      config: {
        id: config.id,
        sourceId: config.source_id,
        collectorVersion: config.collector_version,
        entrypoints: config.allowed_entrypoints,
        method: config.access_method,
        rate: config.rate_cap,
        concurrency: config.concurrency_cap,
        pages: config.max_pages,
        bytes: String(config.max_bytes_per_job),
        enabled: config.enabled,
        approval: config.last_approval_ref,
        updatedAt: config.updated_at.toISOString(),
      },
    }),
  );
}
