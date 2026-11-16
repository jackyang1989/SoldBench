import assert from "node:assert/strict";
import test from "node:test";
import { assertPreflightUnchanged, preflightCollectorAccess } from "@soldbench/collector";

const now = "2026-11-16T09:00:00.000Z";
const clearance = {
  id: "clearance-1",
  provider: "ebay",
  dataset: "sold-listings-us",
  revision: 3,
  status: "active",
  allowedAccessMethods: ["approved_http"],
  permittedFields: ["sale_price", "sold_at", "primary_image"],
  allowedPurposes: ["collect", "store_derived", "publish_stats"],
  jurisdictions: ["US"],
  canStoreRaw: false,
  canStoreDerived: true,
  canRedistributeComp: false,
  canPublishStats: true,
  canShare: false,
  effectiveAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2027-01-01T00:00:00.000Z",
  documentRef: "rights-review-1",
  documentHash: "a".repeat(64),
  reviewedBy: "reviewer-1",
  terminationPolicyRef: "termination-1",
};
const source = {
  id: "source-1",
  clearanceId: "clearance-1",
  marketplace: "ebay_us",
  accessMethod: "approved_http",
  status: "active",
  permissionEpoch: 4,
  entrypointId: "approved-search",
  circuitOpen: false,
};
const config = {
  enabled: true,
  accessMethod: "approved_http",
  allowedEntrypoints: ["approved-search"],
  rateCapPerMinute: 10,
  concurrencyCap: 2,
  maxPagesPerJob: 5,
  maxBytesPerJob: 1_000_000,
};
const request = {
  now,
  purpose: "collect",
  jurisdiction: "US",
  fields: ["sale_price", "sold_at", "primary_image"],
  entrypointId: "approved-search",
  pageCount: 0,
  bytesReserved: 0,
  runningJobs: 0,
  requestsInCurrentMinute: 0,
  offlineFixture: false,
};

test("clearance preflight emits a versioned snapshot but never releases network access", () => {
  const preflight = preflightCollectorAccess({ clearance, source, config, request });
  assert.equal(preflight.mode, "preflight_only");
  assert.equal(preflight.networkAllowed, false);
  assert.equal(preflight.permissionEpoch, 4);
  assert.equal(preflight.clearanceRevision, 3);
  assert.match(preflight.permissionSnapshotHash, /^[a-f0-9]{64}$/);
  assertPreflightUnchanged(preflight, preflight);
  assert.throws(() => assertPreflightUnchanged(preflight, { ...preflight, permittedFields: ["sold_at"] }));
  assert.throws(() =>
    assertPreflightUnchanged(preflight, { ...preflight, accessMethod: "approved_browser" }),
  );
});

test("missing, suspended, expired or mismatched clearance fails closed", () => {
  assert.throws(
    () => preflightCollectorAccess({ clearance: null, source, config, request }),
    /not currently permitted/,
  );
  for (const changed of [
    { ...clearance, status: "suspended" },
    { ...clearance, expiresAt: now },
    { ...clearance, documentHash: null },
    { ...clearance, terminationPolicyRef: null },
  ])
    assert.throws(() => preflightCollectorAccess({ clearance: changed, source, config, request }));
  assert.throws(() =>
    preflightCollectorAccess({ clearance, source: { ...source, clearanceId: "other" }, config, request }),
  );
});

test("method, field, purpose, jurisdiction, entrypoint, source stop and budgets are enforced", () => {
  const invalidRequests = [
    { ...request, fields: ["seller_private_email"] },
    { ...request, purpose: "store_raw" },
    { ...request, jurisdiction: "CA" },
    { ...request, entrypointId: "other" },
    { ...request, pageCount: config.maxPagesPerJob },
    { ...request, bytesReserved: config.maxBytesPerJob },
    { ...request, runningJobs: config.concurrencyCap },
    { ...request, requestsInCurrentMinute: config.rateCapPerMinute },
  ];
  for (const changed of invalidRequests)
    assert.throws(() => preflightCollectorAccess({ clearance, source, config, request: changed }));
  assert.throws(() =>
    preflightCollectorAccess({ clearance, source: { ...source, circuitOpen: true }, config, request }),
  );
  assert.throws(() =>
    preflightCollectorAccess({
      clearance,
      source,
      config: { ...config, accessMethod: "approved_browser" },
      request,
    }),
  );
});

test("offline fixtures require explicit synthetic mode and never authorize network", () => {
  const fixtureSource = {
    ...source,
    id: "synthetic-gameboy",
    clearanceId: "synthetic-fixture",
    accessMethod: "offline_fixture",
  };
  const fixtureConfig = { ...config, accessMethod: "offline_fixture" };
  const fixtureRequest = { ...request, offlineFixture: true };
  const preflight = preflightCollectorAccess({
    clearance: null,
    source: fixtureSource,
    config: fixtureConfig,
    request: fixtureRequest,
  });
  assert.equal(preflight.mode, "offline_fixture");
  assert.equal(preflight.networkAllowed, false);
  assert.equal(preflight.clearanceRevision, 0);
  assert.throws(() =>
    preflightCollectorAccess({ clearance: null, source: fixtureSource, config: fixtureConfig, request }),
  );
  assert.throws(() => assertPreflightUnchanged(preflight, null));
});
