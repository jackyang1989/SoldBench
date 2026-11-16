import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collect, Store, FixtureTransport } from '../src/collector.ts';
import { availability } from '../src/availability.ts';

test('persisted collector coverage drives outage reads and recovery does not duplicate events', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'soldbench-outage-'));
  const store = new Store(join(dir, 'state.json'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/demo.json', import.meta.url), 'utf8'));
  const transport = new FixtureTransport(fixture.responses);
  const plan = { ...fixture.plan, asOf: fixture.asOf, mode: 'offline_fixture', collectorEnabled: false, allowReplay: () => true };
  const clock = { now: () => Date.parse(fixture.asOf), wait: async () => {} };
  const initial = await collect(plan, transport, store, clock);
  const dispatches = transport.calls;
  for (const hours of [0, 24, 48, 72]) {
    const decision = availability({ now: new Date(Date.parse(initial.dataAsOf!) + hours * 3_600_000).toISOString(),
      dataAsOf: initial.dataAsOf, snapshotExists: true, allowStale: true, verifiedSamples: 58, currentRights: 'allowed' });
    assert.equal(decision.readable, true); assert.equal(decision.potentialCredits, hours <= 24 ? 1 : 0);
    assert.equal(transport.calls, dispatches, 'snapshot read must not dispatch collector');
  }
  const recovered = await collect({ ...plan, runId: 'recovery-run' }, transport, store, clock);
  assert.equal(recovered.storedCandidateEvents, initial.storedCandidateEvents);
  assert.equal(recovered.dataAsOf, initial.dataAsOf);
  assert.equal(recovered.observations, initial.observations * 2);
});
