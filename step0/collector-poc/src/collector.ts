import { createHash, randomUUID } from 'node:crypto';
import { openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export const VERSION = 'offline-poc-1.0.0';
export const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export class Stop extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export interface Response {
  status: number;
  kind: 'results' | 'empty' | 'login_wall' | 'challenge' | 'error';
  body: string;
  retryAfterSeconds?: number;
}
export interface ListingRecord {
  listingId: string;
  eventKey: string | null;
  identityEvidence: 'synthetic_event_key' | 'unknown';
  title: string;
}
export interface Page {
  schema: 'soldbench.offline.page.v1';
  synthetic: true;
  sourceId: string;
  queryHash: string;
  cursor: string;
  nextCursor: string | null;
  coverageAsOf: string;
  records: ListingRecord[];
}
export interface Transport {
  datasetHash: string;
  byteSize(cursor: string): number;
  fetch(cursor: string): Promise<Response>;
}
// A local fixture replay, intentionally incapable of HTTP or browser access.
export class FixtureTransport implements Transport {
  calls = 0;
  perCursor: Record<string, number> = {};
  datasetHash: string;
  responses: Record<string, Response[]>;
  constructor(responses: Record<string, Response[]>) {
    this.responses = copy(responses);
    this.datasetHash = sha(this.responses);
  }
  private next(cursor: string): Response {
    const entries = this.responses[cursor];
    if (!entries?.length) throw new Stop('fixture_cursor_missing');
    return entries[Math.min(this.perCursor[cursor] ?? 0, entries.length - 1)];
  }
  byteSize(cursor: string): number { return Buffer.byteLength(this.next(cursor).body); }
  async fetch(cursor: string): Promise<Response> {
    const response = copy(this.next(cursor));
    this.calls++;
    this.perCursor[cursor] = (this.perCursor[cursor] ?? 0) + 1;
    return response;
  }
}
export interface Plan {
  runId: string;
  sourceId: string;
  queryHash: string;
  asOf: string;
  mode: string;
  collectorEnabled: boolean;
  allowReplay: () => boolean;
  maxPages: number;
  maxRequests: number;
  maxBytes: number;
  maxAttempts: number;
  deadlineMs: number;
}
interface Progress {
  binding: string;
  next: string | null;
  seen: string[];
  coverage: string[];
  status: string;
  stopReason: string | null;
  requests: number;
  bytes: number;
  attempts: Record<string, number>;
  deadlineAt: number;
}
interface Event {
  record: ListingRecord;
  fingerprint: string;
  status: 'candidate' | 'conflicted';
}
interface State {
  schema: string;
  dataMode: string;
  runs: Record<string, Progress>;
  events: Record<string, Event>;
  observations: Record<string, unknown>;
  quarantined: Record<string, unknown>;
  circuits: Record<string, string>;
  watermarks: Record<string, string>;
}
const empty = (): State => ({ schema: VERSION, dataMode: 'offline_fixture', runs: {}, events: {},
  observations: {}, quarantined: {}, circuits: {}, watermarks: {} });

// Single-process PoC store, not a production database. Lock conflicts fail closed.
export class Store {
  private fd: number | undefined;
  state: State;
  filename: string;
  beforePersist: () => void;
  constructor(filename: string, beforePersist: () => void = () => {}) {
    this.filename = filename; this.beforePersist = beforePersist;
    this.fd = openSync(filename + '.lock', 'wx', 0o600);
    try {
      this.state = existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) : empty();
      if (this.state.schema !== VERSION || this.state.dataMode !== 'offline_fixture' ||
          !['runs','events','observations','quarantined','circuits','watermarks'].every(key =>
            this.state[key] && typeof this.state[key] === 'object' && !Array.isArray(this.state[key]))) {
        throw new Stop('store_schema_mismatch');
      }
    } catch (error) { this.close(); throw error; }
  }
  transact(change: (next: State) => void): void {
    const next = copy(this.state);
    change(next);
    const temp = this.filename + '.' + randomUUID() + '.tmp';
    let fd: number | undefined;
    try {
      this.beforePersist();
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(next));
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temp, this.filename);
      this.state = next;
      // Sync the directory entry; this does not create a separate event/checkpoint commit.
      const directory = openSync(dirname(this.filename), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  close(): void {
    if (this.fd !== undefined) {
      closeSync(this.fd); this.fd = undefined;
      unlinkSync(this.filename + '.lock');
    }
  }
}
export function parsePage(response: Response, plan: Plan, cursor: string): Page {
  if (response.status === 401 || response.status === 403 || response.kind === 'login_wall' || response.kind === 'challenge') {
    throw new Stop('access_blocked');
  }
  if (response.status !== 200) throw new Stop('http_error');
  let page: Page;
  try { page = JSON.parse(response.body); } catch { throw new Stop('schema_mismatch'); }
  const keys = ['schema','synthetic','sourceId','queryHash','cursor','nextCursor','coverageAsOf','records'];
  if (!page || Array.isArray(page) || Object.keys(page).sort().join() !== keys.sort().join() ||
      page.schema !== 'soldbench.offline.page.v1' || page.synthetic !== true ||
      page.sourceId !== plan.sourceId || page.queryHash !== plan.queryHash || page.cursor !== cursor ||
      (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor.length)) ||
      !Array.isArray(page.records) || page.records.length > 1000 ||
      !validDate(page.coverageAsOf) || Date.parse(page.coverageAsOf) > Date.parse(plan.asOf) ||
      !['results','empty'].includes(response.kind) ||
      (response.kind === 'empty' && (page.records.length !== 0 || page.nextCursor !== null)) ||
      (response.kind === 'results' && page.records.length === 0)) throw new Stop('schema_mismatch');
  for (const record of page.records) {
    if (!record || typeof record !== 'object' ||
        Object.keys(record).sort().join() !== ['listingId','eventKey','identityEvidence','title'].sort().join() ||
        typeof record.listingId !== 'string' || !record.listingId ||
        typeof record.title !== 'string' || !record.title ||
        !((record.eventKey === null && record.identityEvidence === 'unknown') ||
          (typeof record.eventKey === 'string' && record.eventKey.length > 0 && record.identityEvidence === 'synthetic_event_key'))) {
      throw new Stop('schema_mismatch');
    }
  }
  return page;
}
function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace('.000Z','Z') === value;
}
function guard(plan: Plan, store: Store): void {
  if (plan.mode !== 'offline_fixture' || plan.collectorEnabled !== false) throw new Stop('network_mode_disabled');
  const safeId = (id: unknown) => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id) &&
    !['constructor','prototype','__proto__'].includes(id);
  if (!safeId(plan.runId) || !safeId(plan.sourceId) || typeof plan.queryHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(plan.queryHash)) throw new Stop('invalid_plan');
  if (!plan.allowReplay()) throw new Stop('replay_permission_revoked');
  if (store.state.circuits[plan.sourceId]) throw new Stop('circuit_open');
}
export async function collect(plan: Plan, transport: Transport, store: Store,
  clock = { now: () => Date.now(), wait: async (ms: number) => new Promise<void>(r => setTimeout(r, ms)) }) {
  const scope = sha([plan.sourceId, plan.queryHash]);
  const binding = sha([VERSION, plan.sourceId, plan.queryHash, plan.asOf, transport.datasetHash]);
  let outcome = 'failed'; let reason: string | null = null;
  try {
    guard(plan, store);
    if (!validDate(plan.asOf) || !plan.runId || !plan.sourceId || !plan.queryHash ||
        ![plan.maxPages,plan.maxRequests,plan.maxBytes,plan.maxAttempts,plan.deadlineMs].every(n => Number.isSafeInteger(n) && n > 0) ||
        plan.maxAttempts > 3) throw new Stop('invalid_plan');
    const existing = store.state.runs[plan.runId];
    if (existing && existing.binding !== binding) throw new Stop('run_binding_conflict');
    if (!existing) store.transact(s => {
      s.runs[plan.runId] = { binding, next: 'start', seen: [], coverage: [], status: 'running', stopReason: null,
        requests: 0, bytes: 0, attempts: {}, deadlineAt: clock.now() + plan.deadlineMs };
    });
    while (true) {
      guard(plan, store);
      const run = store.state.runs[plan.runId];
      if (run.status === 'completed') { outcome = 'completed'; break; }
      if (clock.now() >= run.deadlineAt) throw new Stop('deadline_exceeded');
      if (run.next === null) {
        // Last page's commit is durable before the coverage watermark moves.
        store.transact(s => {
          const current = s.runs[plan.runId];
          const watermark = [...current.coverage].sort()[0];
          if (watermark && (!s.watermarks[scope] || watermark > s.watermarks[scope])) s.watermarks[scope] = watermark;
          current.status = 'completed'; current.stopReason = null;
        });
        outcome = 'completed'; break;
      }
      const cursor = run.next;
      if (run.seen.includes(cursor)) throw new Stop('pagination_loop');
      if (run.seen.length >= plan.maxPages) throw new Stop('page_budget_exceeded');
      const bytes = transport.byteSize(cursor);
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Stop('invalid_transport_size');
      if (run.requests >= plan.maxRequests || (run.attempts[cursor] ?? 0) >= plan.maxAttempts) throw new Stop('request_budget_exceeded');
      if (run.bytes + bytes > plan.maxBytes) throw new Stop('byte_budget_exceeded');
      // Reserve fixture body bytes and attempt before dispatch, also across restart.
      store.transact(s => {
        const current = s.runs[plan.runId]; current.requests++; current.bytes += bytes;
        current.attempts[cursor] = (current.attempts[cursor] ?? 0) + 1;
      });
      guard(plan, store);
      const response = await transport.fetch(cursor);
      if (Buffer.byteLength(response.body) !== bytes) throw new Stop('transport_size_mismatch');
      if (clock.now() >= run.deadlineAt) throw new Stop('deadline_exceeded');
      if (response.status === 401 || response.status === 403 || response.kind === 'challenge' || response.kind === 'login_wall') throw new Stop('access_blocked');
      if (response.status === 429 || response.status >= 500) {
        if ((store.state.runs[plan.runId].attempts[cursor] ?? 0) >= plan.maxAttempts) throw new Stop('retry_exhausted');
        const delay = response.status === 429 ? response.retryAfterSeconds : 2 ** (run.attempts[cursor] ?? 0);
        if (!Number.isSafeInteger(delay) || delay < 0 || delay > 3600) throw new Stop('invalid_retry_after');
        if (clock.now() + delay * 1000 >= run.deadlineAt) throw new Stop('deadline_exceeded');
        await clock.wait(delay * 1000); continue;
      }
      const page = parsePage(response, plan, cursor);
      guard(plan, store);
      store.transact(s => {
        const current = s.runs[plan.runId];
        for (const record of page.records) {
          const fingerprint = sha(record);
          const obs = sha([plan.runId, cursor, fingerprint]);
          s.observations[obs] = { sourceId:plan.sourceId, runId:plan.runId, cursor, fingerprint, pageHash:sha(response.body), record };
          if (record.eventKey === null) { s.quarantined[obs] = { reason:'uncertain_event_identity', observation:obs }; continue; }
          const identity = sha([plan.sourceId, record.eventKey]);
          const event = s.events[identity];
          if (event && event.fingerprint !== fingerprint) {
            event.status = 'conflicted'; s.quarantined[obs] = { reason:'event_identity_conflict', observation:obs };
          } else if (!event) s.events[identity] = { record, fingerprint, status:'candidate' };
        }
        current.seen.push(cursor); current.coverage.push(page.coverageAsOf); current.next = page.nextCursor;
        current.status = 'running'; current.stopReason = null;
      });
    }
  } catch (error) {
    reason = error instanceof Stop ? error.code : 'storage_or_transport_error';
    outcome = ['access_blocked','circuit_open','network_mode_disabled','replay_permission_revoked'].includes(reason) ? 'blocked' : 'failed';
    try { store.transact(s => {
      if (reason === 'access_blocked' || reason === 'schema_mismatch') s.circuits[plan.sourceId] = reason;
      if (s.runs[plan.runId]?.binding === binding && s.runs[plan.runId].status !== 'completed') {
        s.runs[plan.runId].status = outcome; s.runs[plan.runId].stopReason = reason;
      }
    }); } catch { /* The old durable checkpoint remains authoritative when storage fails. */ }
  }
  const progress = Object.hasOwn(store.state.runs,plan.runId) && store.state.runs[plan.runId].binding === binding
    ? store.state.runs[plan.runId] : undefined;
  return { mode:'offline_fixture', onlineVerified:false, sourceApproval:'NOT_CLEARED', version:VERSION,
    runId:plan.runId, outcome, stopReason:reason, completedPages:progress?.seen.length ?? 0,
    attempts:progress?.requests ?? 0, fixtureBodyBytes:progress?.bytes ?? 0,
    storedCandidateEvents:Object.values(store.state.events).filter(e => e.status === 'candidate').length,
    observations:Object.keys(store.state.observations).length, quarantined:Object.keys(store.state.quarantined).length,
    dataAsOf:store.state.watermarks[scope] ?? null, statisticsComputed:false };
}
