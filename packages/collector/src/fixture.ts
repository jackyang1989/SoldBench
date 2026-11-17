import { createHash } from "node:crypto";
import { type Candidate, candidateFromJson, canonicalJson, instant } from "@soldbench/core";
import { type RecordEvidence, recordEvidenceFromJson } from "./record-evidence.ts";

export const COLLECTOR_VERSION = "offline-pg-1.4.0";
export const PARSER_VERSION = "offline-page-1.2.0";
export type FixtureListing = {
  listingId: string;
  title: string;
  candidate: Candidate;
  primaryImage?: { role: "primary"; url: string };
  recordEvidence?: RecordEvidence;
};
export type FixturePage = {
  schema: "soldbench.synthetic-page.v1";
  synthetic: true;
  sourceId: string;
  queryHash: string;
  cursor: string;
  nextCursor: string | null;
  asOf: string;
  empty: boolean;
  records: FixtureListing[];
  sourceReported?: { count: number; unit: "listings" | "items" | "events" | "unknown"; estimated: boolean };
};
export type FixtureResponse = {
  status: number;
  contentType: string;
  bytes: Uint8Array;
  retryAfterSeconds?: number;
};
export function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function fixtureResponse(page: FixturePage): FixtureResponse {
  return { status: 200, contentType: "application/json", bytes: Buffer.from(JSON.stringify(page)) };
}
/** Only in-memory bytes; this class has no URL, HTTP, DNS or browser operations. */
export class FixtureTransport {
  #responses: Map<string, FixtureResponse[]>;
  calls: string[] = [];
  constructor(responses: ReadonlyMap<string, readonly FixtureResponse[]>) {
    this.#responses = new Map([...responses].map(([key, values]) => [key, structuredClone([...values])]));
  }
  async read(key: string, index?: number): Promise<FixtureResponse> {
    this.calls.push(key);
    const values = this.#responses.get(key);
    if (!values?.length) throw new Error("fixture_response_missing");
    if (index !== undefined && (!Number.isSafeInteger(index) || index < 0))
      throw new Error("invalid_fixture_response_index");
    const value =
      index === undefined
        ? values.length > 1
          ? values.shift()
          : values[0]
        : values[Math.min(index, values.length - 1)];
    if (!value) throw new Error("fixture_response_missing");
    return structuredClone(value);
  }
}
function text(value: unknown, max = 500): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function storedInstant(value: string): number {
  if (value.startsWith("0000-")) throw new Error("fixture_timestamp_out_of_range");
  return instant(value);
}
export function parseFixturePage(
  bytes: Uint8Array,
  binding: { sourceId: string; queryHash: string; cursor: string; asOf: string },
): FixturePage {
  if (bytes.byteLength > 1024 * 1024) throw new Error("fixture_page_too_large");
  const page = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as FixturePage;
  // PostgreSQL jsonb rejects NUL and unpaired surrogates, including in extra
  // fields. Bound depth as well so malformed trees cannot exhaust the stack.
  const pending: Array<{ value: unknown; depth: number }> = [{ value: page, depth: 0 }];
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) break;
    if (entry.depth > 64) throw new Error("fixture_page_text_invalid");
    if (typeof entry.value === "string") {
      if (entry.value.includes("\u0000") || Buffer.from(entry.value).toString("utf8") !== entry.value)
        throw new Error("fixture_page_text_invalid");
    } else if (entry.value !== null && typeof entry.value === "object") {
      for (const [key, value] of Object.entries(entry.value)) {
        pending.push({ value: key, depth: entry.depth + 1 }, { value, depth: entry.depth + 1 });
      }
    }
  }
  if (
    page?.schema !== "soldbench.synthetic-page.v1" ||
    page.synthetic !== true ||
    page.sourceId !== binding.sourceId ||
    page.queryHash !== binding.queryHash ||
    page.cursor !== binding.cursor ||
    !(page.nextCursor === null || text(page.nextCursor, 160)) ||
    !Array.isArray(page.records) ||
    page.records.length > 1000 ||
    typeof page.empty !== "boolean" ||
    page.empty !== (page.records.length === 0) ||
    (page.empty && page.nextCursor !== null)
  )
    throw new Error("fixture_page_binding_or_shape_invalid");
  if (storedInstant(page.asOf) > storedInstant(binding.asOf))
    throw new Error("fixture_page_future_watermark");
  if (
    page.sourceReported !== undefined &&
    (!page.sourceReported ||
      !Number.isSafeInteger(page.sourceReported.count) ||
      page.sourceReported.count < 0 ||
      !["listings", "items", "events", "unknown"].includes(page.sourceReported.unit) ||
      typeof page.sourceReported.estimated !== "boolean")
  )
    throw new Error("fixture_reported_count_invalid");
  page.records = page.records.map((row) => {
    if (!row || !text(row.listingId, 160) || !text(row.title)) throw new Error("fixture_listing_invalid");
    const candidate = candidateFromJson(row.candidate);
    if (candidate.sourceId !== page.sourceId) throw new Error("fixture_candidate_source_mismatch");
    if (candidate.eventKey !== null && Buffer.byteLength(candidate.eventKey, "utf8") > 512)
      throw new Error("fixture_event_key_too_large");
    // Match persistence semantics at the parser boundary. Unknown values stay
    // unknown; inconsistent assertions are a bad page, not a database outage.
    if (
      (candidate.priceStatus === "verified_actual" && candidate.itemCents === null) ||
      (candidate.shippingStatus === "unknown" &&
        (candidate.shippingCents !== null || (candidate.usdConversion?.shippingCents ?? null) !== null)) ||
      (candidate.shippingStatus === "observed" && candidate.shippingCents === null) ||
      (candidate.shippingStatus === "verified_free_shipping" &&
        (candidate.shippingCents !== 0 ||
          (candidate.usdConversion !== undefined && candidate.usdConversion.shippingCents !== 0)))
    )
      throw new Error("fixture_candidate_semantics_invalid");
    if (candidate.time.precision === "instant") storedInstant(candidate.time.value);
    if (candidate.time.precision === "day") {
      // A missing/unknown zone is retained for exclusion by the shared engine.
      storedInstant(`${candidate.time.value}T00:00:00Z`);
    }
    if (
      row.primaryImage !== undefined &&
      (row.primaryImage?.role !== "primary" || !text(row.primaryImage.url, 2000))
    )
      throw new Error("fixture_primary_image_invalid");
    return {
      ...row,
      candidate,
      ...(row.recordEvidence === undefined
        ? {}
        : { recordEvidence: recordEvidenceFromJson(row.recordEvidence) }),
    };
  });
  return page;
}
export function eventFacts(row: FixtureListing): string {
  const {
    comparable: _comparable,
    title: _title,
    condition: _condition,
    sellerRef: _sellerRef,
    sellerDisplayName: _sellerDisplayName,
    shippingContextRef: _shippingContext,
    observationKey: _observation,
    ...facts
  } = row.candidate;
  return digest(canonicalJson({ listingId: row.listingId, ...facts }));
}

/** Fingerprint of one permitted raw synthetic record, excluding pagination and photos.
 * This deduplicates uncertain candidates, never proves a real transaction identity. */
export function uncertainCandidateKey(row: FixtureListing): string {
  if (row.candidate.observationKey) return row.candidate.observationKey;
  const { primaryImage: _image, recordEvidence: _evidence, candidate, ...record } = row;
  const { observationKey: _key, ...body } = candidate;
  return digest(canonicalJson({ record, candidate: body }));
}
