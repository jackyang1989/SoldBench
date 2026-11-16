import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { completedRunEvidence, sha, type Plan, type Store, type Transport } from './collector.ts';
import { candidateFromJson, ENGINE_VERSION, evaluate, type Candidate, type Query } from './pricing.ts';
import { availability } from './availability.ts';

export type StudyQuery = Query & { q: string };
type Scope = Omit<ReturnType<typeof completedRunEvidence>, 'observations'>;
type SnapshotBody = {
  schema: 'soldbench.offline-study.v1';
  mode: 'offline_fixture';
  synthetic: true;
  sourceApproval: 'NOT_CLEARED';
  engineVersion: string;
  scope: Scope;
  query: StudyQuery;
  candidates: Candidate[];
  upstreamConflictedObservations: number;
};
export type StudySnapshot = SnapshotBody & { snapshotHash: string };
type Source = Pick<Transport, 'datasetHash'>;
type Access = {
  now: string;
  allowStale: boolean;
  currentRights: () => 'allowed' | 'revoked' | 'not_cleared';
  limit?: number;
};

export function studyQueryHash(query: StudyQuery): string {
  if (typeof query.q !== 'string' || query.q !== query.q.trim() || !query.q || query.q.length > 120) {
    throw new Error('invalid_study_query');
  }
  evaluate([], query);
  return sha({ q: query.q, sourceId: query.sourceId, days: query.days, basis: query.basis, limit: query.limit });
}

function checkIntegrity(value: unknown): StudySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_snapshot');
  const snapshot = value as StudySnapshot;
  const { snapshotHash, ...body } = snapshot;
  if (snapshot.schema !== 'soldbench.offline-study.v1' || snapshot.mode !== 'offline_fixture' ||
      snapshot.synthetic !== true || snapshot.sourceApproval !== 'NOT_CLEARED' ||
      typeof snapshotHash !== 'string' || snapshotHash !== sha(body) || !Array.isArray(snapshot.candidates)) {
    throw new Error('snapshot_integrity_mismatch');
  }
  if (snapshot.engineVersion !== ENGINE_VERSION) throw new Error('snapshot_engine_version_mismatch');
  return snapshot;
}

function candidatesFromEvidence(observations: ReturnType<typeof completedRunEvidence>['observations']): Candidate[] {
  return observations.map(observation => {
    if (!observation.record.candidate) throw new Error('missing_candidate_payload');
    const candidate = candidateFromJson(observation.record.candidate);
    return { ...candidate, identityVerified: candidate.identityVerified && observation.eventStatus === 'candidate' };
  });
}

export function buildStudySnapshot(plan: Plan, source: Source, store: Store, query: StudyQuery): StudySnapshot {
  if (!plan.allowReplay()) throw new Error('replay_permission_revoked');
  if (studyQueryHash(query) !== plan.queryHash || query.sourceId !== plan.sourceId || query.asOf !== plan.asOf) {
    throw new Error('study_query_scope_mismatch');
  }
  const { observations, ...scope } = completedRunEvidence(plan, source, store);
  const candidates = candidatesFromEvidence(observations);
  if (!plan.allowReplay()) throw new Error('replay_permission_revoked');
  const body: SnapshotBody = {
    schema: 'soldbench.offline-study.v1', mode: 'offline_fixture', synthetic: true,
    sourceApproval: 'NOT_CLEARED', engineVersion: ENGINE_VERSION, scope,
    query: structuredClone(query), candidates,
    upstreamConflictedObservations: observations.filter(observation => observation.eventStatus === 'conflicted').length,
  };
  return { ...body, snapshotHash: sha(body) };
}

export function readStudySnapshot(value: unknown, plan: Plan, source: Source, store: Store, access: Access) {
  const initialRights = access.currentRights();
  const decide = (rights: ReturnType<Access['currentRights']>, dataAsOf: string | null, verifiedSamples: number, snapshotExists: boolean) =>
    availability({ now: access.now, dataAsOf, verifiedSamples, snapshotExists, currentRights: rights, allowStale: access.allowStale });
  const response = (decision: ReturnType<typeof availability>, result: ReturnType<typeof evaluate> | null, snapshotHash: string | null) =>
    ({ mode: 'offline_fixture' as const, sourceApproval: 'NOT_CLEARED' as const, decision, result, snapshotHash });
  if (initialRights !== 'allowed') return response(decide(initialRights, null, 0, false), null, null);
  const snapshot = checkIntegrity(value);
  if (studyQueryHash(snapshot.query) !== plan.queryHash || snapshot.query.asOf !== plan.asOf ||
      snapshot.query.sourceId !== plan.sourceId) throw new Error('study_query_scope_mismatch');
  const { observations, ...currentScope } = completedRunEvidence(plan, source, store);
  if (sha(currentScope) !== sha(snapshot.scope)) throw new Error('snapshot_evidence_changed');
  const candidates = snapshot.candidates.map(candidateFromJson);
  if (sha(candidates) !== sha(candidatesFromEvidence(observations))) throw new Error('snapshot_candidates_mismatch');
  const result = evaluate(candidates, { ...snapshot.query, limit: access.limit ?? snapshot.query.limit });
  const decision = decide(access.currentRights(), snapshot.scope.dataAsOf, result.stats.n_price_verified, true);
  return response(decision, decision.readable ? result : null, decision.readable ? snapshot.snapshotHash : null);
}

// New immutable evidence files are published atomically and never replace an old snapshot.
export function saveStudySnapshot(path: string, value: StudySnapshot, beforePublish: () => void = () => {}): void {
  checkIntegrity(value);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temporary);
    throw error;
  }
  closeSync(fd);
  try {
    beforePublish();
    linkSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { unlinkSync(temporary); }
}
