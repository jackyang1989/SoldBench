export const evidenceFields = [
  "listingUrl",
  "condition",
  "price",
  "shipping",
  "soldDate",
  "seller",
  "primaryImage",
  "attributes",
] as const;
export type RecordEvidence = {
  schema: "soldbench.record-evidence.v1";
  profileHash: string;
  recordIndex: number;
  listingUrl: string | null;
  conditionId: string | null;
  conditionRaw: string | null;
  priceRaw: string | null;
  shippingRaw: string | null;
  soldDateRaw: string | null;
  sourceTimeZone: string | null;
  attributes: Record<string, string>;
  fields: Record<(typeof evidenceFields)[number], "present" | "missing" | "withheld">;
};
export function recordEvidenceFromJson(value: unknown): RecordEvidence {
  const x = value as RecordEvidence;
  if (
    x?.schema !== "soldbench.record-evidence.v1" ||
    !/^[a-f0-9]{64}$/.test(x.profileHash) ||
    !Number.isSafeInteger(x.recordIndex) ||
    x.recordIndex < 0 ||
    x.recordIndex > 1000 ||
    !x.attributes ||
    Array.isArray(x.attributes) ||
    Object.keys(x.attributes).length > 32 ||
    !x.fields ||
    Object.keys(x.fields).length !== evidenceFields.length ||
    evidenceFields.some((key) => !["present", "missing", "withheld"].includes(x.fields[key]))
  )
    throw new Error("invalid_record_evidence");
  for (const key of [
    "listingUrl",
    "conditionId",
    "conditionRaw",
    "priceRaw",
    "shippingRaw",
    "soldDateRaw",
    "sourceTimeZone",
  ] as const) {
    const v = x[key];
    if (!(v === null || (typeof v === "string" && v.length <= (key === "listingUrl" ? 2000 : 500))))
      throw new Error("invalid_record_evidence");
  }
  for (const [key, v] of Object.entries(x.attributes))
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || typeof v !== "string" || !v.trim() || v.length > 500)
      throw new Error("invalid_record_evidence");
  if (JSON.stringify(x).length > 24000) throw new Error("invalid_record_evidence");
  return structuredClone(x);
}
