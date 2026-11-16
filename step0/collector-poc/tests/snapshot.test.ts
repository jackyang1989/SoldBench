import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect, completedRunEvidence, FixtureTransport, sha, Store, type ListingRecord } from '../src/collector.ts';
import { candidateFromJson, type Candidate } from '../src/pricing.ts';
import { goldenStudy, syntheticStudy } from '../src/study-fixture.ts';
import { buildStudySnapshot, readStudySnapshot, saveStudySnapshot, type StudyQuery } from '../src/snapshot.ts';

const query: StudyQuery = { q: 'synthetic comparable', sourceId: 'synthetic-study', asOf: '2026-11-16T00:00:00Z',
  days: 90, basis: 'item_plus_observed_shipping', limit: 50 };
const record = (id: string, changes: Partial<Candidate> = {}): ListingRecord => {
  const candidate: Candidate = { sourceId: query.sourceId, eventKey: id, identityVerified: true, comparable: true,
    priceStatus: 'verified_actual', format: 'fixed_price', currency: 'USD', itemCents: 100, shippingCents: 0,
    shippingStatus: 'verified_free_shipping', time: { precision: 'instant', value: '2026-11-01T00:00:00Z' }, ...changes };
  return { listingId: 'listing-' + id, eventKey: candidate.eventKey,
    identityEvidence: candidate.eventKey === null ? 'unknown' : 'synthetic_event_key', title: 'Synthetic item', candidate };
};
function setup(t, study = syntheticStudy(Array.from({ length: 30 }, (_, i) => record('event-' + i)), query)) {
  const dir = mkdtempSync(join(tmpdir(), 'soldbench-study-'));
  let store = new Store(join(dir, 'state.json'));
  const clock = { now: () => Date.parse(study.query.asOf), wait: async () => {} };
  const context = { dir, study, get store() { return store; },
    collect: () => collect(study.plan, study.transport, store, clock),
    build: () => buildStudySnapshot(study.plan, study.transport, store, study.query),
    read: (snapshot: unknown, access = {}) => readStudySnapshot(snapshot, study.plan, study.transport, store,
      { now: study.query.asOf, allowStale: false, currentRights: () => 'allowed', ...access }),
    reopen: () => { store.close(); store = new Store(join(dir, 'state.json')); }, clock };
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return context;
}
function reseal(snapshot) {
  const { snapshotHash: _hash, ...body } = snapshot;
  return { ...body, snapshotHash: sha(body) };
}

test('golden fixture flows through 3 committed pages into all expected statistics and quality fields', async t => {
  const study = goldenStudy(), c = setup(t, study);
  const collected = await c.collect();
  assert.equal(collected.completedPages, 3); assert.equal(collected.storedCandidateEvents, 121);
  const snapshot = c.build(), result = c.read(snapshot);
  assert.deepEqual(result.result!.stats, study.expectedStats);
  assert.deepEqual(result.result!.quality, study.expectedQuality);
  assert.equal(result.result!.comps.length, 50); assert.equal(result.result!.available_comp_count, 58);
  assert.equal(result.result!.diagnostics.hard_mismatch_events, 57);
  assert.equal(result.result!.diagnostics.price_exclusions.length, 6);
  assert.equal(result.decision.potentialCredits, 1); assert.equal(result.decision.actualChargePerformed, false);
  assert.equal(result.sourceApproval, 'NOT_CLEARED');
});

for (const n of [0, 7, 8, 29, 30]) {
  test(`real computed n=${n} drives availability and small sample statistics`, async t => {
    const c = setup(t, syntheticStudy(Array.from({ length: n }, (_, i) => record('event-' + i)), query));
    await c.collect();
    const result = c.read(c.build());
    assert.equal(result.result!.stats.n_price_verified, n);
    assert.equal(result.decision.potentialCredits, n >= 8 ? 1 : 0);
    assert.equal(result.result!.stats.median_cents, n >= 8 ? 100 : null);
  });
}

test('cross-page duplicate observation is retained without a duplicate event or price', async t => {
  const rows = Array.from({ length: 8 }, (_, i) => record('event-' + i));
  const c = setup(t, syntheticStudy([...rows, rows[0]], query, { pageSize: 4 }));
  await c.collect();
  const result = c.read(c.build()).result!;
  assert.equal(result.stats.n_price_verified, 8); assert.equal(result.diagnostics.duplicate_observations, 1);
});

test('same event may be comparable for one query and excluded for another', async t => {
  const c = setup(t); await c.collect();
  const original = c.build();
  const otherQuery = { ...query, q: 'different synthetic model' };
  const otherRows = Array.from({ length: 30 }, (_, i) => record('event-' + i, { comparable: false }));
  const other = syntheticStudy(otherRows, otherQuery, { runId: 'other-query' });
  await collect(other.plan, other.transport, c.store, c.clock);
  const changed = buildStudySnapshot(other.plan, other.transport, c.store, otherQuery);
  const excluded = readStudySnapshot(changed, other.plan, other.transport, c.store,
    { now: query.asOf, allowStale: false, currentRights: () => 'allowed' });
  assert.equal(excluded.result!.stats.n_comparable, 0);
  assert.equal(c.read(original).result!.stats.n_price_verified, 30);
  assert.equal(Object.values(c.store.state.events).filter(event => event.status === 'conflicted').length, 0);
});

test('unrelated later runs do not enter the original candidate snapshot', async t => {
  const c = setup(t); await c.collect(); const original = c.build();
  const other = syntheticStudy([record('unrelated', { itemCents: 999999 })], { ...query, q: 'another item' }, { runId: 'unrelated-query' });
  await collect(other.plan, other.transport, c.store, c.clock);
  assert.equal(c.read(original).result!.stats.n_price_verified, 30);
  assert.equal(c.read(original).result!.stats.observed_max_cents, 100);
});

test('JSON property order changes do not conflict the same v2 event', async t => {
  const original = record('event-0');
  const c = setup(t, syntheticStudy([original], query)); await c.collect(); const snapshot = c.build();
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  reordered.candidate = Object.fromEntries(Object.entries(original.candidate!).reverse());
  const second = syntheticStudy([reordered], query, { runId: 'reordered' });
  await collect(second.plan, second.transport, c.store, c.clock);
  assert.equal(Object.values(c.store.state.events)[0].status, 'candidate');
  assert.equal(c.read(snapshot).result!.stats.n_price_verified, 1);
});

test('source circuit opened by a later run does not require collector dispatch for snapshot reads', async t => {
  const c = setup(t); await c.collect(); const snapshot = c.build();
  const blocked = new FixtureTransport({ start: [{ status: 403, kind: 'error', body: 'synthetic blocked source' }] });
  const result = await collect({ ...c.study.plan, runId: 'blocked-run' }, blocked, c.store, c.clock);
  assert.equal(result.stopReason, 'access_blocked');
  const calls = c.study.transport.calls;
  assert.equal(c.read(snapshot).result!.stats.n_price_verified, 30);
  assert.equal(c.study.transport.calls, calls);
});

test('later coverage cannot refresh the timestamp of an earlier snapshot', async t => {
  const c = setup(t); await c.collect(); const original = c.build();
  const laterQuery = { ...query, asOf: '2026-11-18T00:00:00Z' };
  const later = syntheticStudy(Array.from({ length: 30 }, (_, i) => record('event-' + i)), laterQuery, { runId: 'later-run' });
  await collect(later.plan, later.transport, c.store, { now: () => Date.parse(laterQuery.asOf), wait: async () => {} });
  const result = c.read(original, { now: laterQuery.asOf, allowStale: true });
  assert.equal(result.decision.freshness, 'stale_acceptable'); assert.equal(result.decision.potentialCredits, 0);
  assert.equal(original.scope.dataAsOf, query.asOf);
});

test('fresh/stale/expired and current revocation use computed snapshot samples without dispatching', async t => {
  const c = setup(t); await c.collect(); const snapshot = c.build(), dispatches = c.study.transport.calls;
  for (const [hours, freshness, readable] of [[24, 'fresh', true], [48, 'stale_acceptable', false], [72, 'stale_acceptable', false]] as const) {
    const now = new Date(Date.parse(query.asOf) + hours * 3_600_000).toISOString();
    const result = c.read(snapshot, { now });
    assert.equal(result.decision.freshness, freshness); assert.equal(result.result !== null, readable);
    assert.equal(c.read(snapshot, { now, allowStale: true }).decision.readable, true);
  }
  assert.equal(c.read(snapshot, { now: '2026-11-19T00:00:00.001Z', allowStale: true }).result, null);
  for (const rights of ['not_cleared', 'revoked']) {
    assert.equal(c.read(snapshot, { currentRights: () => rights }).result, null);
  }
  let checks = 0;
  assert.equal(c.read(snapshot, { currentRights: () => ++checks === 1 ? 'allowed' : 'revoked' }).result, null);
  assert.equal(c.study.transport.calls, dispatches);
});

test('only completed runs can publish; partial failure preserves committed page evidence', async t => {
  const c = setup(t);
  assert.throws(() => c.build(), /run_binding_conflict/);
  await c.collect();
  const partial = syntheticStudy(Array.from({ length: 8 }, (_, i) => record('partial-' + i)), query, { runId: 'partial', pageSize: 4 });
  const failed = await collect({ ...partial.plan, maxRequests: 1 }, partial.transport, c.store, c.clock);
  assert.equal(failed.stopReason, 'request_budget_exceeded');
  assert.throws(() => buildStudySnapshot(partial.plan, partial.transport, c.store, query), /run_not_completed/);
  c.reopen();
  assert.equal((await collect(partial.plan, partial.transport, c.store, c.clock)).outcome, 'completed');
  const snapshot = buildStudySnapshot(partial.plan, partial.transport, c.store, query);
  assert.equal(snapshot.candidates.length, 8);
});

test('restart preserves snapshot evidence and repeated complete run has no dispatch', async t => {
  const c = setup(t); await c.collect(); const snapshot = c.build(), calls = c.study.transport.calls;
  c.reopen();
  assert.equal(c.read(snapshot).result!.stats.n_price_verified, 30);
  await c.collect(); assert.equal(c.study.transport.calls, calls);
  assert.equal(c.build().snapshotHash, snapshot.snapshotHash);
});

test('snapshot integrity, candidate evidence and query scope reject altered data', async t => {
  const c = setup(t); await c.collect(); const original = c.build();
  const damaged = structuredClone(original); damaged.candidates[0].itemCents = 9999;
  assert.throws(() => c.read(damaged), /integrity/);
  assert.throws(() => c.read(reseal(damaged)), /candidates_mismatch/);
  const otherQuery = structuredClone(original); otherQuery.query.q = 'wrong query';
  assert.throws(() => c.read(reseal(otherQuery)), /scope_mismatch/);
  assert.throws(() => c.read(original, { limit: 201 }), /invalid_query/);
  assert.deepEqual(c.read(original, { limit: 1 }).result!.stats, c.read(original).result!.stats);
});

test('corrupt or missing page evidence cannot produce a complete price snapshot', async t => {
  const c = setup(t); await c.collect();
  c.store.transact(state => {
    const page = state.runs[c.study.plan.runId].pages!.start;
    delete state.observations[page.observationIds[0]];
  });
  assert.throws(() => c.build(), /evidence_mismatch/);
});

test('new price evidence conflicts the event and prevents stale cached results', async t => {
  const c = setup(t); await c.collect(); const original = c.build();
  const conflicting = syntheticStudy([record('event-0', { itemCents: 9999 })], query, { runId: 'conflicting-price' });
  await collect(conflicting.plan, conflicting.transport, c.store, c.clock);
  assert.throws(() => c.read(original), /evidence_changed/);
  const rebuilt = c.read(c.build());
  assert.equal(rebuilt.result!.stats.n_price_verified, 29);
});

test('unknown identity and missing shipping remain excluded with explanatory diagnostics', async t => {
  const rows = [record('known'), record('shipping', { shippingCents: null, shippingStatus: 'unknown' }),
    record('unknown', { eventKey: null, identityVerified: false })];
  const c = setup(t, syntheticStudy(rows, query)); await c.collect();
  const result = c.read(c.build()).result!;
  assert.equal(result.stats.n_observed, 3);
  assert.equal(result.stats.n_comparable, 2);
  assert.equal(result.stats.n_price_verified, 1);
  assert.equal(result.diagnostics.unidentified_observations, 1);
  assert.deepEqual(result.diagnostics.price_exclusions, [{ eventKey: 'shipping', reason: 'missing_shipping_evidence' }]);
});

test('unknown-identity repeated page evidence counts one candidate and zero verified events', async t => {
  const unknown = record('unknown', { eventKey: null, identityVerified: false });
  const c = setup(t, syntheticStudy([unknown, unknown], query, { pageSize: 1 }));
  await c.collect();
  const result = c.read(c.build()).result!;
  assert.equal(result.stats.n_observed, 1); assert.equal(result.stats.n_comparable, 0);
  assert.equal(result.stats.n_price_verified, 0); assert.equal(result.diagnostics.duplicate_uncertain_observations, 1);
});

test('schema v2 rejects candidate fields that do not belong to the enclosing event/source', async t => {
  const invalid = record('event-1', { sourceId: 'different-source' });
  const c = setup(t, syntheticStudy([invalid], query));
  assert.equal((await c.collect()).stopReason, 'schema_mismatch');
  assert.throws(() => c.build(), /run_not_completed/);
  assert.throws(() => candidateFromJson({ ...record('e').candidate, itemCents: 0.5 }), /invalid_candidate/);
});

test('snapshot files publish atomically, preserve existing evidence and recover after interrupted publish', async t => {
  const c = setup(t); await c.collect(); const snapshot = c.build(), path = join(c.dir, 'snapshot.json');
  assert.throws(() => saveStudySnapshot(path, snapshot, () => { throw new Error('injected interruption'); }), /interruption/);
  assert.equal(readdirSync(c.dir).some(name => name.endsWith('.tmp')), false);
  saveStudySnapshot(path, snapshot);
  const before = readFileSync(path, 'utf8');
  assert.throws(() => saveStudySnapshot(path, snapshot), /EEXIST/);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(c.read(JSON.parse(before)).result!.stats.n_price_verified, 30);
  assert.equal(readdirSync(c.dir).some(name => name.endsWith('.tmp')), false);
});
