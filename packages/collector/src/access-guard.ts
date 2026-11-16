import { createHash } from "node:crypto";
import { AppError } from "@soldbench/shared";

export type AccessMethod = "offline_fixture" | "approved_http" | "approved_browser";
export type AccessPurpose =
  | "collect"
  | "store_raw"
  | "store_derived"
  | "redistribute_comp"
  | "publish_stats"
  | "share";
export type ClearanceStatus = "draft" | "reviewed" | "active" | "suspended" | "expired" | "revoked";

export type SourceClearance = {
  id: string;
  provider: string;
  dataset: string;
  revision: number;
  status: ClearanceStatus;
  allowedAccessMethods: readonly AccessMethod[];
  permittedFields: readonly string[];
  allowedPurposes: readonly AccessPurpose[];
  jurisdictions: readonly string[];
  canStoreRaw: boolean;
  canStoreDerived: boolean;
  canRedistributeComp: boolean;
  canPublishStats: boolean;
  canShare: boolean;
  effectiveAt: string | null;
  expiresAt: string | null;
  documentRef: string | null;
  documentHash: string | null;
  reviewedBy: string | null;
  terminationPolicyRef: string | null;
};

export type CollectorSource = {
  id: string;
  clearanceId: string;
  marketplace: string;
  accessMethod: AccessMethod;
  status: "disabled" | "active" | "suspended" | "revoked";
  permissionEpoch: number;
  entrypointId: string;
  circuitOpen: boolean;
};

export type CollectorConfig = {
  enabled: boolean;
  accessMethod: AccessMethod;
  allowedEntrypoints: readonly string[];
  rateCapPerMinute: number;
  concurrencyCap: number;
  maxPagesPerJob: number;
  maxBytesPerJob: number;
};

export type AccessRequest = {
  now: string;
  purpose: AccessPurpose;
  jurisdiction: string;
  fields: readonly string[];
  entrypointId: string;
  pageCount: number;
  bytesReserved: number;
  runningJobs: number;
  requestsInCurrentMinute: number;
  offlineFixture: boolean;
};

export type AccessPreflight = {
  sourceId: string;
  clearanceId: string;
  clearanceRevision: number;
  permissionEpoch: number;
  permissionSnapshotHash: string;
  accessMethod: AccessMethod;
  entrypointId: string;
  purpose: AccessPurpose;
  permittedFields: readonly string[];
  mode: "offline_fixture" | "preflight_only";
  networkAllowed: false;
};

function deny(reason: string): never {
  throw new AppError("source_unavailable", 503, "Source access is not currently permitted", {
    reason,
  });
}

function validDate(value: string | null): number | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * Pure, fail-closed preflight. This does not reserve concurrent budgets or grant
 * a dispatch permit. No network caller may use this result until a transactional
 * reservation service re-reads current clearance/source/circuit rows and commits
 * rate, page, byte and concurrency reservations. Offline fixtures are zero-network.
 */
export function preflightCollectorAccess(input: {
  clearance: SourceClearance | null;
  source: CollectorSource;
  config: CollectorConfig;
  request: AccessRequest;
}): AccessPreflight {
  const { clearance, source, config, request } = input;
  const now = Date.parse(request.now);
  if (!Number.isFinite(now)) deny("invalid_clock");
  if (!Number.isSafeInteger(source.permissionEpoch) || source.permissionEpoch < 1)
    deny("invalid_permission_epoch");
  if (source.circuitOpen) deny("source_circuit_open");
  if (source.status !== "active" || !config.enabled) deny("source_or_collector_disabled");
  if (
    !Number.isSafeInteger(config.rateCapPerMinute) ||
    config.rateCapPerMinute < 1 ||
    !Number.isSafeInteger(config.concurrencyCap) ||
    config.concurrencyCap < 1 ||
    !Number.isSafeInteger(config.maxPagesPerJob) ||
    config.maxPagesPerJob < 1 ||
    !Number.isSafeInteger(config.maxBytesPerJob) ||
    config.maxBytesPerJob < 1
  )
    deny("collector_config_invalid");
  if (source.marketplace !== "ebay_us") deny("marketplace_not_enabled");
  if (
    !config.allowedEntrypoints.includes(request.entrypointId) ||
    request.entrypointId !== source.entrypointId
  )
    deny("entrypoint_not_allowed");
  if (
    !Number.isSafeInteger(request.pageCount) ||
    request.pageCount < 0 ||
    !Number.isSafeInteger(request.bytesReserved) ||
    request.bytesReserved < 0 ||
    !Number.isSafeInteger(request.runningJobs) ||
    request.runningJobs < 0 ||
    !Number.isSafeInteger(request.requestsInCurrentMinute) ||
    request.requestsInCurrentMinute < 0
  )
    deny("invalid_budget_usage");
  if (
    request.pageCount >= config.maxPagesPerJob ||
    request.bytesReserved >= config.maxBytesPerJob ||
    request.runningJobs >= config.concurrencyCap ||
    request.requestsInCurrentMinute >= config.rateCapPerMinute
  )
    deny("collector_budget_exhausted");

  if (source.accessMethod === "offline_fixture") {
    if (!request.offlineFixture || config.accessMethod !== "offline_fixture") deny("fixture_marker_required");
    return {
      sourceId: source.id,
      clearanceId: "synthetic-fixture",
      clearanceRevision: 0,
      permissionEpoch: source.permissionEpoch,
      permissionSnapshotHash: createHash("sha256").update("soldbench:offline_fixture:v1").digest("hex"),
      accessMethod: "offline_fixture",
      entrypointId: request.entrypointId,
      purpose: request.purpose,
      permittedFields: request.fields,
      mode: "offline_fixture",
      networkAllowed: false,
    };
  }

  if (request.offlineFixture) deny("fixture_must_not_select_network_source");
  if (!clearance) deny("clearance_missing");
  if (source.clearanceId !== clearance.id) deny("source_clearance_mismatch");
  if (
    !clearance.id ||
    !clearance.provider ||
    !clearance.dataset ||
    !Number.isSafeInteger(clearance.revision) ||
    clearance.revision < 1
  )
    deny("clearance_identity_invalid");
  const effectiveAt = validDate(clearance.effectiveAt);
  const expiresAt = validDate(clearance.expiresAt);
  if (
    clearance.status !== "active" ||
    !clearance.documentRef ||
    !/^[a-f0-9]{64}$/i.test(clearance.documentHash ?? "") ||
    !clearance.reviewedBy ||
    !clearance.terminationPolicyRef ||
    effectiveAt === null ||
    expiresAt === null ||
    effectiveAt > now ||
    expiresAt <= now
  )
    deny("clearance_inactive_or_incomplete");
  if (!clearance.allowedAccessMethods.includes(source.accessMethod)) deny("access_method_not_permitted");
  if (config.accessMethod !== source.accessMethod) deny("config_source_method_mismatch");
  if (!clearance.allowedPurposes.includes(request.purpose)) deny("purpose_not_permitted");
  if (!clearance.jurisdictions.includes(request.jurisdiction)) deny("jurisdiction_not_permitted");
  if (request.fields.length === 0 || new Set(request.fields).size !== request.fields.length)
    deny("fields_missing_or_duplicated");
  if (request.fields.some((field) => !clearance.permittedFields.includes(field))) deny("field_not_permitted");
  if (request.purpose === "store_raw" && !clearance.canStoreRaw) deny("raw_storage_not_permitted");
  if (request.purpose === "store_derived" && !clearance.canStoreDerived)
    deny("derived_storage_not_permitted");
  if (request.purpose === "redistribute_comp" && !clearance.canRedistributeComp)
    deny("comp_redistribution_not_permitted");
  if (request.purpose === "publish_stats" && !clearance.canPublishStats) deny("statistics_not_permitted");
  if (request.purpose === "share" && !clearance.canShare) deny("sharing_not_permitted");

  const permissionSnapshot = {
    clearanceId: clearance.id,
    provider: clearance.provider,
    dataset: clearance.dataset,
    revision: clearance.revision,
    sourceId: source.id,
    permissionEpoch: source.permissionEpoch,
    accessMethod: source.accessMethod,
    entrypointId: request.entrypointId,
    purpose: request.purpose,
    jurisdiction: request.jurisdiction,
    fields: [...request.fields].sort(),
    expiresAt: clearance.expiresAt,
  };
  return {
    sourceId: source.id,
    clearanceId: clearance.id,
    clearanceRevision: clearance.revision,
    permissionEpoch: source.permissionEpoch,
    permissionSnapshotHash: createHash("sha256").update(JSON.stringify(permissionSnapshot)).digest("hex"),
    accessMethod: source.accessMethod,
    entrypointId: request.entrypointId,
    purpose: request.purpose,
    permittedFields: [...request.fields],
    mode: "preflight_only",
    networkAllowed: false,
  };
}

/** Compare snapshots after the caller has reloaded and re-evaluated current records. */
export function assertPreflightUnchanged(permit: AccessPreflight, current: AccessPreflight | null): void {
  if (
    !current ||
    current.networkAllowed !== permit.networkAllowed ||
    current.sourceId !== permit.sourceId ||
    current.clearanceId !== permit.clearanceId ||
    current.clearanceRevision !== permit.clearanceRevision ||
    current.permissionEpoch !== permit.permissionEpoch ||
    current.permissionSnapshotHash !== permit.permissionSnapshotHash ||
    current.accessMethod !== permit.accessMethod ||
    current.entrypointId !== permit.entrypointId ||
    current.purpose !== permit.purpose ||
    current.permittedFields.length !== permit.permittedFields.length ||
    current.permittedFields.some((field, index) => field !== permit.permittedFields[index])
  )
    deny("permit_revoked_or_changed");
}
