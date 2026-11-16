import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { replayCampaign } from '../src/campaign.ts';
import { collect, Store } from '../src/collector.ts';
import { syntheticStudy } from '../src/study-fixture.ts';

function tasks(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const day = `2026-11-${16 + Math.floor(index / 12)}`;
    const queryId = `cards-${String(index % 12 + 1).padStart(2, '0')}`;
    return { task_id: `${day}/${queryId}`, query_id: queryId, keyword: `Synthetic query ${index % 12}`,
      date: day, scheduled_at: `${day}T00:00:00Z`, group: 'cards', tier: index % 2 ? 'tail' as const : 'head' as const };
  });
}
function temporary(t) {
  const path = mkdtempSync(join(tmpdir(), 'soldbench-campaign-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('campaign rejects empty, duplicate and unsafe query file identifiers', async t => {
  const directory = temporary(t);
  await assert.rejects(replayCampaign([], join(directory, 'empty'), 'transient'), /invalid_campaign/);
  const rows = tasks(2); rows[1] = rows[0];
  await assert.rejects(replayCampaign(rows, join(directory, 'duplicate'), 'transient'), /duplicate/);
  const unsafe = [{ ...tasks(1)[0], query_id: '../escape' }];
  await assert.rejects(replayCampaign(unsafe, join(directory, 'unsafe'), 'transient'), /invalid_campaign_task/);
});

test('transient campaign keeps budget failures, bounded retries and unknown costs in log', async t => {
  const directory = join(temporary(t), 'transient');
  const report = await replayCampaign(tasks(20), directory, 'transient');
  const rows = readFileSync(join(directory, 'results.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 20);
  assert.equal(rows.filter(row => row.stop_reason === 'request_budget_exceeded').length, 2);
  assert.equal(rows[13].semantic_success, true); assert.equal(rows[13].first_semantic_success, false);
  assert.equal(rows[19].semantic_success, true); assert.equal(rows[19].attempts, 3);
  assert.equal(report.onlineVerified, false);
  assert.ok(rows.every(row => row.cost_cents === null && row.actualChargePerformed === false));
});

test('source-wide refusal persists and prevents all later query dispatches after reopening', async t => {
  const directory = join(temporary(t), 'blocked');
  const report = await replayCampaign(tasks(27), directory, 'blocked_source');
  assert.equal(report.sourceBlockIndex, 24); assert.equal(report.dispatchesAfterBlock, 0);
  const rows = readFileSync(join(directory, 'results.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows[24].stop_reason, 'access_blocked');
  assert.ok(rows.slice(25).every(row => row.attempts === 0 && !row.semantic_success));
  const control = new Store(join(directory, 'source-control.json'));
  const fresh = new Store(join(directory, 'new-run.json'));
  try {
    const query = { q: 'Synthetic query', sourceId: 'synthetic-campaign', asOf: '2026-11-19T00:00:00Z',
      days: 90, basis: 'item' as const, limit: 50 };
    const study = syntheticStudy([], query);
    study.plan.allowReplay = () => !control.state.circuits[query.sourceId];
    const result = await collect(study.plan, study.transport, fresh);
    assert.equal(result.stopReason, 'replay_permission_revoked');
    assert.equal(study.transport.calls, 0);
  } finally { fresh.close(); control.close(); }
});
