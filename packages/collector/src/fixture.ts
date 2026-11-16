import { createHash } from "node:crypto";
import { type Candidate, candidateFromJson, canonicalJson, instant } from "@soldbench/core";

export const COLLECTOR_VERSION = "offline-pg-1.1.0";
export const PARSER_VERSION = "synthetic-page-1.0.0";
export type FixtureListing = {
  listingId: string;
  title: string;
  candidate: Candidate;
  primaryImage?: { role: "primary"; url: string };
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
export function parseFixturePage(
  bytes: Uint8Array,
  binding: { sourceId: string; queryHash: string; cursor: string; asOf: string },
): FixturePage {
  const page = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as FixturePage;
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
  if (instant(page.asOf) > instant(binding.asOf)) throw new Error("fixture_page_future_watermark");
  page.records = page.records.map((row) => {
    if (!row || !text(row.listingId, 160) || !text(row.title)) throw new Error("fixture_listing_invalid");
    const candidate = candidateFromJson(row.candidate);
    if (candidate.sourceId !== page.sourceId) throw new Error("fixture_candidate_source_mismatch");
    if (
      row.primaryImage !== undefined &&
      (row.primaryImage?.role !== "primary" || !text(row.primaryImage.url, 2000))
    )
      throw new Error("fixture_primary_image_invalid");
    return { ...row, candidate };
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
  const { primaryImage: _image, candidate, ...record } = row;
  const { observationKey: _key, ...body } = candidate;
  return digest(canonicalJson({ record, candidate: body }));
}
