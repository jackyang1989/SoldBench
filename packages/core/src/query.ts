import { createHash } from "node:crypto";
import { AppError, VERSIONS } from "@soldbench/shared";
import { type Candidate, canonicalJson } from "./pricing.ts";

export type SoldQuery = {
  q: string;
  marketplace: "ebay_us";
  window_days: 30 | 90 | 180 | 365;
  price_basis: "item" | "item_plus_observed_shipping";
  limit: number;
  allow_stale: boolean;
  category?: string;
  brand?: string;
  model?: string;
  condition?: string;
  attributes: Record<string, string>;
  min_price_cents?: number;
  max_price_cents?: number;
  sale_format?: "fixed_price" | "auction" | "best_offer";
};
const attributeSets: Record<string, readonly string[]> = {
  cards_graded: ["grading_company", "grade", "card_number", "language", "set", "edition", "year"],
  sneakers: ["size", "size_system", "colorway", "year"],
  watches: ["reference", "year", "box", "papers"],
  video_games: ["platform", "region", "variant", "completeness"],
  gpu_hardware: ["vram_gb", "chipset", "variant"],
  collectibles: ["series", "number", "variant", "completeness"],
};
const conditions = [
  "new_with_tags",
  "new_without_tags",
  "like_new",
  "good",
  "fair",
  "defective",
  "unknown",
] as const;
type Condition = (typeof conditions)[number];
export function isStandardCondition(value: unknown): value is Condition {
  return typeof value === "string" && conditions.some((condition) => condition === value);
}
export function normalizeQuery(
  input: URLSearchParams,
  supportedWindows: readonly number[] = [30, 90],
): SoldQuery {
  const allowed = new Set([
    "q",
    "marketplace",
    "window_days",
    "price_basis",
    "limit",
    "allow_stale",
    "category",
    "brand",
    "model",
    "condition",
    "min_price_cents",
    "max_price_cents",
    "sale_format",
  ]);
  for (const key of input.keys()) {
    if (input.getAll(key).length !== 1 || (!allowed.has(key) && !key.startsWith("attr_")))
      throw new AppError("invalid_parameter", 400, "Unknown or repeated query parameter", {
        fields: [{ field: key, reason: "unknown_or_repeated" }],
      });
  }
  const q = (input.get("q") ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
  if (!q || q.length > 120)
    throw new AppError("invalid_parameter", 400, "Query must contain 1–120 characters");
  if (input.has("marketplace") && input.get("marketplace") !== "ebay_us")
    throw new AppError("invalid_parameter", 400, "Unsupported marketplace");
  const rawWindow = input.get("window_days") ?? "90";
  if (!["30", "90", "180", "365"].includes(rawWindow))
    throw new AppError("invalid_parameter", 400, "Invalid window");
  const window = Number(rawWindow) as SoldQuery["window_days"];
  if (!supportedWindows.includes(window))
    throw new AppError("unsupported_window", 422, "Requested history is unavailable");
  const basis = input.get("price_basis") ?? "item_plus_observed_shipping";
  if (!["item", "item_plus_observed_shipping"].includes(basis))
    throw new AppError("invalid_parameter", 400, "Invalid price basis");
  const rawLimit = input.get("limit") ?? "50";
  if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 200)
    throw new AppError("invalid_parameter", 400, "Limit must be 1–200");
  const stale = input.get("allow_stale") ?? "false";
  if (!["true", "false"].includes(stale))
    throw new AppError("invalid_parameter", 400, "allow_stale must be true or false");
  const category = input.get("category") ?? undefined;
  if (category !== undefined && !Object.hasOwn(attributeSets, category))
    throw new AppError("invalid_parameter", 400, "Unknown category");
  const attributes: Record<string, string> = {};
  for (const [key, value] of [...input.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (key.startsWith("attr_")) {
      if (
        !category ||
        !attributeSets[category]?.includes(key.slice(5)) ||
        !value.trim() ||
        value.length > 120
      )
        throw new AppError("invalid_parameter", 400, "Unknown or invalid category attribute", {
          fields: [{ field: key, reason: "invalid_attribute" }],
        });
      attributes[key.slice(5)] = value.normalize("NFC").trim();
    }
  }
  const query: SoldQuery = {
    q,
    marketplace: "ebay_us",
    window_days: window,
    price_basis: basis as SoldQuery["price_basis"],
    limit: Number(rawLimit),
    allow_stale: stale === "true",
    attributes,
  };
  if (category) query.category = category;
  for (const key of ["min_price_cents", "max_price_cents"] as const) {
    const raw = input.get(key);
    if (raw !== null) {
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
        throw new AppError("invalid_parameter", 400, "Price bounds must be nonnegative integer cents", {
          fields: [{ field: key, reason: "invalid_integer_cents" }],
        });
      query[key] = Number(raw);
    }
  }
  if (
    query.min_price_cents !== undefined &&
    query.max_price_cents !== undefined &&
    query.min_price_cents > query.max_price_cents
  )
    throw new AppError("invalid_parameter", 400, "Minimum price exceeds maximum price");
  const format = input.get("sale_format");
  if (format !== null) {
    if (!["fixed_price", "auction", "best_offer"].includes(format))
      throw new AppError("invalid_parameter", 400, "Invalid sale format");
    query.sale_format = format as SoldQuery["sale_format"];
  }
  for (const key of ["brand", "model", "condition"] as const) {
    const value = input.get(key)?.normalize("NFC").trim();
    if (value !== undefined) {
      if (!value || value.length > 120 || (key === "condition" && !isStandardCondition(value)))
        throw new AppError("invalid_parameter", 400, `Invalid ${key}`);
      query[key] = value;
    }
  }
  return query;
}
export function queryHash(query: SoldQuery): string {
  return createHash("sha256")
    .update(canonicalJson({ version: VERSIONS.normalizer, ...query }))
    .digest("hex");
}
export function matchStrongAttributes(
  required: Record<string, string>,
  actual: Record<string, string | null>,
) {
  return Object.entries(required).flatMap(([key, value]) =>
    actual[key] !== value ? [{ attribute: key, expected: value, actual: actual[key] ?? null }] : [],
  );
}

export function hasStrongFilters(query: SoldQuery) {
  return Boolean(
    query.category ||
      query.brand ||
      query.model ||
      query.condition ||
      Object.keys(query.attributes ?? {}).length,
  );
}

export function compatibleCleaner(query: SoldQuery, cleaner: string | null) {
  return cleaner === VERSIONS.cleaner || (cleaner === "1.0.0" && !hasStrongFilters(query));
}

/** A tabular fixture may carry standard condition on the candidate; HTML must declare it explicitly. */
export function applyStrongFilters(
  query: SoldQuery,
  candidate: Candidate,
  evidence: { attributes?: Record<string, string>; conditionStandard?: string | null } | null,
): Candidate {
  if (!candidate.comparable || !hasStrongFilters(query)) return candidate;
  const required = { ...query.attributes };
  for (const key of ["category", "brand", "model", "condition"] as const) {
    const value = query[key];
    if (value !== undefined) required[key] = value;
  }
  const condition = evidence ? evidence.conditionStandard : candidate.condition;
  const actual = Object.fromEntries(
    Object.keys(required).map((key) => {
      const value = key === "condition" ? condition : evidence?.attributes?.[key];
      return [
        key,
        typeof value === "string" && (key !== "condition" || isStandardCondition(value))
          ? value.normalize("NFC").trim() || null
          : null,
      ];
    }),
  );
  const failures = matchStrongAttributes(required, actual);
  if (!failures.length) return candidate;
  return failures.every((failure) => failure.actual === null)
    ? { ...candidate, comparable: false, strongAttributeEvidenceMissing: true }
    : { ...candidate, comparable: false };
}

/** A collector watermark is scoped to every filter, but not presentation or stale consent. */
export function collectionQueryHash(query: SoldQuery): string {
  const { limit: _limit, allow_stale: _stale, ...scope } = query;
  return createHash("sha256")
    .update(canonicalJson({ collection_version: "1", normalizer: VERSIONS.normalizer, ...scope }))
    .digest("hex");
}

/** JSON adapters share the same accepted keys/types before the canonical query normalizer. */
export function queryParameters(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("invalid_parameter", 400, "Invalid search parameters.");
  const input = value as Record<string, unknown>,
    allowed = [
      "q",
      "marketplace",
      "category",
      "brand",
      "model",
      "condition",
      "window_days",
      "price_basis",
      "limit",
      "allow_stale",
      "min_price_cents",
      "max_price_cents",
      "sale_format",
      "attributes",
    ];
  if (Object.keys(input).some((k) => !allowed.includes(k)))
    throw new AppError("invalid_parameter", 400, "Invalid search parameters.");
  const params = new URLSearchParams();
  for (const [key, text] of Object.entries(input)) {
    if (key === "attributes") {
      if (!text || typeof text !== "object" || Array.isArray(text))
        throw new AppError("invalid_parameter", 400, "Invalid attributes.");
      for (const [attribute, v] of Object.entries(text)) {
        if (typeof v !== "string") throw new AppError("invalid_parameter", 400, "Invalid attribute value.");
        params.set(`attr_${attribute}`, v);
      }
    } else {
      const expected =
        key === "allow_stale"
          ? "boolean"
          : ["window_days", "limit", "min_price_cents", "max_price_cents"].includes(key)
            ? "number"
            : "string";
      if (typeof text !== expected || (expected === "number" && !Number.isSafeInteger(text)))
        throw new AppError("invalid_parameter", 400, "Invalid parameter type.");
      params.set(key, String(text));
    }
  }
  return params;
}
