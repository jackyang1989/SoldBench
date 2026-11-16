import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, Store } from './collector.ts';
import { goldenStudy } from './study-fixture.ts';
import { buildStudySnapshot, readStudySnapshot, saveStudySnapshot } from './snapshot.ts';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--output-dir')) throw new Error('Use --output-dir PATH');
  if (process.env.COLLECTOR_ENABLED && process.env.COLLECTOR_ENABLED !== 'false') throw new Error('COLLECTOR_ENABLED must be false');
  if (process.env.DATA_MODE && process.env.DATA_MODE !== 'offline_fixture') throw new Error('Only offline_fixture is supported');
  const base = fileURLToPath(new URL('../artifacts/', import.meta.url));
  const output = resolve(args[1] ?? resolve(base, 'study-' + Date.now()));
  mkdirSync(output, { recursive: true });
  const study = goldenStudy();
  const store = new Store(resolve(output, 'collector-state.json'));
  try {
    const clock = { now: () => Date.parse(study.query.asOf), wait: async () => {} };
    const collected = await collect(study.plan, study.transport, store, clock);
    if (collected.outcome !== 'completed') throw new Error(collected.stopReason ?? collected.outcome);
    const snapshot = buildStudySnapshot(study.plan, study.transport, store, study.query);
    const path = resolve(output, 'snapshot.json');
    saveStudySnapshot(path, snapshot);
    const loaded = JSON.parse(readFileSync(path, 'utf8'));
    const scenarios = [];
    for (const hours of [0, 24, 48, 72]) {
      for (const allowStale of [false, true]) {
        const now = new Date(Date.parse(snapshot.scope.dataAsOf) + hours * 3_600_000).toISOString();
        const result = readStudySnapshot(loaded, study.plan, study.transport, store,
          { now, allowStale, currentRights: () => 'allowed' });
        scenarios.push({ hours, allowStale, ...result });
      }
    }
    for (const rights of ['not_cleared', 'revoked'] as const) {
      scenarios.push({ rights, ...readStudySnapshot(loaded, study.plan, study.transport, store,
        { now: study.query.asOf, allowStale: true, currentRights: () => rights }) });
    }
    const replay = await collect(study.plan, study.transport, store, clock);
    const report = {
      schema: 'soldbench.offline-study-report.v1', mode: 'offline_fixture', sourceApproval: 'NOT_CLEARED',
      onlineVerified: false, stageVerdict: 'NOT_ISSUED', actualChargePerformed: false,
      statisticsComputed: true,
      originalFixtureSha256: study.originalFixtureSha256, collected, replay,
      snapshotHash: snapshot.snapshotHash, scenarios,
    };
    writeFileSync(resolve(output, 'study-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify({ output, snapshotHash: snapshot.snapshotHash,
      collectedEvents: collected.storedCandidateEvents, scenarios: scenarios.length,
      mode: report.mode, onlineVerified: false }) + '\n');
  } finally { store.close(); }
}

main().catch(error => { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; });
