import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { FixtureTransport, type ListingRecord, type Page, type Plan, type Response } from './collector.ts';
import { candidateFromJson, type Candidate } from './pricing.ts';
import { studyQueryHash, type StudyQuery } from './snapshot.ts';

export function syntheticStudy(records: readonly ListingRecord[], query: StudyQuery, options: {
  runId?: string; pageSize?: number; coverageAsOf?: string[];
} = {}) {
  const pageSize = options.pageSize ?? 50;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error('invalid_fixture_page_size');
  const count = Math.max(1, Math.ceil(records.length / pageSize));
  const queryHash = studyQueryHash(query);
  const responses: Record<string, Response[]> = {};
  for (let index = 0; index < count; index++) {
    const cursor = index === 0 ? 'start' : `segment-${index}`;
    const page: Page = {
      schema: 'soldbench.offline.page.v2', synthetic: true, sourceId: query.sourceId, queryHash, cursor,
      nextCursor: index + 1 < count ? `segment-${index + 1}` : null,
      coverageAsOf: options.coverageAsOf?.[index] ?? query.asOf,
      records: structuredClone(records.slice(index * pageSize, (index + 1) * pageSize)),
    };
    responses[cursor] = [{ status: 200, kind: page.records.length ? 'results' : 'empty', body: JSON.stringify(page) }];
  }
  const bytes = Object.values(responses).reduce((sum, entries) => sum + Buffer.byteLength(entries[0].body), 0);
  const plan: Plan = {
    runId: options.runId ?? 'synthetic-study', sourceId: query.sourceId, queryHash, asOf: query.asOf,
    mode: 'offline_fixture', collectorEnabled: false, allowReplay: () => true,
    maxPages: count, maxRequests: count * 3, maxBytes: bytes * 3, maxAttempts: 3, deadlineMs: 60_000,
  };
  return { query: structuredClone(query), plan, transport: new FixtureTransport(responses) };
}

export function goldenStudy() {
  const raw = readFileSync(new URL('../../../v14_gameboy_58_verified.json', import.meta.url));
  const digest = createHash('sha256').update(raw).digest('hex');
  if (digest !== 'd59be9da67aa558d3cb494ec06d9918fd185afc3ec3b4daa31c0f6a7b244ae78') throw new Error('original_fixture_changed');
  const fixture = JSON.parse(raw.toString('utf8'));
  if (fixture.synthetic_test_data !== true || fixture.fixture_version !== 'v1.4') throw new Error('invalid_golden_fixture');
  const sourceId = 'synthetic-gameboy';
  const query: StudyQuery = { q: fixture.query.q, sourceId, asOf: fixture.as_of,
    days: fixture.query.window_days, basis: fixture.query.price_basis, limit: fixture.query.limit };
  const records: ListingRecord[] = fixture.candidate_records.map((row: Record<string, unknown>) => {
    const candidate: Candidate = candidateFromJson({ sourceId, eventKey: row.sale_event_id, identityVerified: true,
      comparable: row.is_comparable, priceStatus: row.sale_price_status, format: row.sale_format,
      currency: row.currency ?? 'XXX', itemCents: row.item_price_cents ?? null,
      shippingCents: row.observed_shipping_cents ?? null, shippingStatus: row.observed_shipping_status,
      // Explicit adapter for the original synthetic UTC oracle, not a source date parser.
      time: { precision: 'instant', value: row.sold_at } });
    return { listingId: typeof row.listing_id === 'string' ? row.listing_id : `synthetic-listing-${row.sale_event_id}`,
      eventKey: candidate.eventKey, identityEvidence: 'synthetic_event_key',
      title: typeof row.title === 'string' ? row.title : `Synthetic candidate ${row.sale_event_id}`, candidate };
  });
  return { ...syntheticStudy(records, query, { runId: 'golden-study' }),
    expectedStats: fixture.expected_stats, expectedQuality: fixture.expected_quality, originalFixtureSha256: digest };
}
