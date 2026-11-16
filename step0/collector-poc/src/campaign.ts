import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, FixtureTransport, Store, type ListingRecord } from './collector.ts';
import { syntheticStudy } from './study-fixture.ts';
import { buildStudySnapshot, readStudySnapshot, type StudySnapshot } from './snapshot.ts';
import type { Candidate } from './pricing.ts';

type Task = { task_id: string; query_id: string; keyword: string; date: string; scheduled_at: string; group: string; tier: 'head' | 'tail' };
type Profile = 'transient' | 'blocked_source';
type Cached = { snapshot: StudySnapshot; study: ReturnType<typeof syntheticStudy> };
const SOURCE = 'synthetic-campaign';

function recordsFor(task: Task): ListingRecord[] {
  return Array.from({ length: 10 }, (_, index) => {
    const eventKey = `${task.query_id}-event-${index}`;
    const candidate: Candidate = {
      sourceId: SOURCE, eventKey, identityVerified: true, comparable: index < 9,
      priceStatus: index < (task.tier === 'head' ? 8 : 7) ? 'verified_actual' : 'displayed_only',
      format: index % 3 === 0 ? 'best_offer' : 'fixed_price', currency: 'USD',
      itemCents: 1000 + index * 37, shippingCents: 0, shippingStatus: 'verified_free_shipping',
      time: { precision: 'instant', value: '2026-11-01T00:00:00Z' },
    };
    return { listingId: `${task.query_id}-listing-${index}`, eventKey, identityEvidence: 'synthetic_event_key',
      title: `Synthetic campaign item ${task.query_id} ${index}`, candidate };
  });
}

export async function replayCampaign(tasks: readonly Task[], output: string, profile: Profile) {
  if (!['transient', 'blocked_source'].includes(profile) || tasks.length === 0 || tasks.length > 1680) throw new Error('invalid_campaign');
  if (new Set(tasks.map(task => task.task_id)).size !== tasks.length) throw new Error('duplicate_campaign_task');
  for (const task of tasks) {
    if (!/^[a-z_]+-\d{2}$/.test(task.query_id) || task.task_id !== `${task.date}/${task.query_id}` ||
        !task.scheduled_at.startsWith(task.date + 'T') || !Number.isFinite(Date.parse(task.scheduled_at)) ||
        !['head', 'tail'].includes(task.tier)) throw new Error('invalid_campaign_task');
  }
  mkdirSync(output);
  mkdirSync(join(output, 'stores'));
  const control = new Store(join(output, 'source-control.json'));
  const log = openSync(join(output, 'results.jsonl'), 'wx', 0o600);
  const cache = new Map<string, Cached>();
  let sourceBlockIndex: number | null = null;
  let dispatchesAfterBlock = 0;
  let dispatches = 0;
  const readStates: Record<string, number> = {};
  const stopReasons: Record<string, number> = {};
  let day = '';
  try {
    for (const [index, task] of tasks.entries()) {
      const cpuStart = process.cpuUsage();
      const wasBlocked = Boolean(control.state.circuits[SOURCE]);
      const query = { q: task.keyword, sourceId: SOURCE, asOf: task.scheduled_at,
        days: 90, basis: 'item_plus_observed_shipping' as const, limit: 50 };
      const study = syntheticStudy(recordsFor(task), query, { runId: `campaign-${index}`, pageSize: 5 });
      study.plan.allowReplay = () => !control.state.circuits[SOURCE];
      let transport = study.transport;
      if (profile === 'blocked_source' && index === 24) {
        transport = new FixtureTransport({ start: [{ status: 403, kind: 'error', body: 'synthetic source refusal' }] });
      } else if (profile === 'transient') {
        const responses = structuredClone(transport.responses);
        if (index % 17 === 0) study.plan.maxRequests = 1;
        else if (index % 13 === 0) responses.start.unshift({ status: 429, kind: 'error', body: 'synthetic rate limit', retryAfterSeconds: 1 });
        else if (index % 19 === 0) responses.start.unshift({ status: 503, kind: 'error', body: 'synthetic temporary failure' });
        transport = new FixtureTransport(responses);
      }
      const store = new Store(join(output, 'stores', task.query_id + '.json'));
      let now = Date.parse(task.scheduled_at);
      try {
        const collected = await collect(study.plan, transport, store,
          { now: () => now, wait: async ms => { now += ms; } });
        dispatches += transport.calls;
        if (wasBlocked) dispatchesAfterBlock += transport.calls;
        if (collected.stopReason === 'access_blocked') {
          control.transact(state => { state.circuits[SOURCE] = 'access_blocked'; });
          sourceBlockIndex = index;
        }
        if (collected.stopReason) stopReasons[collected.stopReason] = (stopReasons[collected.stopReason] ?? 0) + 1;
        if (collected.outcome === 'completed') {
          const snapshot = buildStudySnapshot(study.plan, transport, store, query);
          cache.set(task.query_id, { snapshot, study: { ...study, transport } });
        }
        const cached = cache.get(task.query_id);
        const read = cached ? readStudySnapshot(cached.snapshot, cached.study.plan, cached.study.transport, store,
          { now: new Date(now).toISOString(), allowStale: true, currentRights: () => 'allowed' }) : null;
        const state = read?.decision.freshness ?? 'no_snapshot';
        readStates[state] = (readStates[state] ?? 0) + 1;
        const cpu = process.cpuUsage(cpuStart);
        const completed = collected.outcome === 'completed';
        const row = { task_id: task.task_id, mode: 'offline_fixture', started_at: task.scheduled_at,
          finished_at: new Date(now).toISOString(), attempts: transport.calls,
          first_semantic_success: completed && transport.calls === collected.completedPages,
          semantic_success: completed, billable: completed && read?.decision.potentialCredits === 1,
          pages: collected.completedPages, bytes: collected.fixtureBodyBytes, cpu_ms: Math.ceil((cpu.user + cpu.system) / 1000),
          cost_cents: null, evidence_ref: null, stop_reason: collected.stopReason,
          cached_freshness: state, cached_readable: read?.decision.readable ?? false,
          cached_verified_samples: read?.result?.stats.n_price_verified ?? null,
          actualChargePerformed: false };
        writeFileSync(log, JSON.stringify(row) + '\n');
      } finally { store.close(); }
      if (task.date !== day) {
        day = task.date;
        process.stdout.write(JSON.stringify({ profile, logicalDay: day, processed: index + 1 }) + '\n');
      }
    }
    fsyncSync(log);
    if (dispatchesAfterBlock !== 0) throw new Error('campaign_dispatched_after_source_block');
    const report = { schema: 'soldbench.offline-campaign.v1', profile, mode: 'offline_fixture',
      sourceApproval: 'NOT_CLEARED', onlineVerified: false, actualChargePerformed: false,
      planned: tasks.length, queries: new Set(tasks.map(task => task.query_id)).size,
      logicalDays: new Set(tasks.map(task => task.date)).size, sourceBlockIndex, dispatchesAfterBlock,
      dispatches, readStates, stopReasons, resourceScope: 'fixture body reservations and local CPU; costs unknown',
      sourceCircuitState: control.state.circuits[SOURCE] ?? null };
    writeFileSync(join(output, 'campaign-summary.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return report;
  } finally { closeSync(log); control.close(); }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.env.COLLECTOR_ENABLED && process.env.COLLECTOR_ENABLED !== 'false') throw new Error('COLLECTOR_ENABLED must be false');
  if (process.env.DATA_MODE && process.env.DATA_MODE !== 'offline_fixture') throw new Error('Only offline_fixture is supported');
  const [input, output, profile] = process.argv.slice(2);
  if (!input || !output || !profile) throw new Error('Usage: campaign.ts INPUT_JSON OUTPUT_DIR PROFILE');
  replayCampaign(JSON.parse(readFileSync(input, 'utf8')), resolve(output), profile as Profile)
    .catch(error => { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; });
}
