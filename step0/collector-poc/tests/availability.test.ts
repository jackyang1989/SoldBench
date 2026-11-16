import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availability } from '../src/availability.ts';

const input = { now: '2026-11-16T00:00:00Z', dataAsOf: '2026-11-16T00:00:00Z', currentRights: 'allowed' as const,
  snapshotExists: true, allowStale: false, verifiedSamples: 58 };
test('0/24/48/72h outage and millisecond boundaries with explicit stale consent', () => {
  for (const [hours, expected] of [[0, 'fresh'], [24, 'fresh'], [48, 'stale_acceptable'], [72, 'stale_acceptable']] as const) {
    const now = new Date(Date.parse(input.now) + hours * 3_600_000).toISOString();
    const r = availability({ ...input, now });
    assert.equal(r.freshness, expected); assert.equal(r.readable, hours <= 24); assert.equal(r.potentialCredits, hours <= 24 ? 1 : 0);
    assert.equal(availability({ ...input, now, allowStale: true }).readable, true);
    assert.equal(r.actualChargePerformed, false); assert.equal(r.onlineVerified, false);
  }
  assert.equal(availability({ ...input, now: '2026-11-17T00:00:00.001Z' }).freshness, 'stale_acceptable');
  const expired = availability({ ...input, now: '2026-11-19T00:00:00.001Z', allowStale: true });
  assert.equal(expired.freshness, 'expired'); assert.equal(expired.readable, false); assert.equal(expired.potentialCredits, 0);
});
test('revocation overrides cached permission, cold cache and low sample never charge', () => {
  assert.equal(availability(input).readable, true);
  for (const currentRights of ['revoked', 'not_cleared'] as const) {
    assert.equal(availability({ ...input, currentRights, allowStale: true }).readable, false);
    assert.equal(availability({ ...input, currentRights }).potentialCredits, 0);
  }
  assert.equal(availability({ ...input, snapshotExists: false }).readable, false);
  assert.equal(availability({ ...input, dataAsOf: null }).readable, false);
  for (const verifiedSamples of [0, 7]) assert.equal(availability({ ...input, verifiedSamples }).potentialCredits, 0);
  assert.throws(() => availability({ ...input, now: '2026-11-15T23:59:59Z' }), /future_watermark/);
  assert.throws(() => availability({ ...input, verifiedSamples: -1 }));
});
