import { isStandardCondition } from "@soldbench/core";

const baseFields = [
  "listingUrl",
  "condition",
  "price",
  "shipping",
  "soldDate",
  "seller",
  "primaryImage",
  "attributes",
] as const;
export const evidenceFields = [...baseFields, "description", "defects"] as const;
type FieldState = "present" | "missing" | "withheld";
export type RecordEvidence = {
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
} & (
  | {
      schema: "soldbench.record-evidence.v1";
      fields: Record<(typeof baseFields)[number], FieldState>;
    }
  | {
      schema: "soldbench.record-evidence.v2";
      conditionStandard: string | null;
      description: string | null;
      defects: string | null;
      fields: Record<(typeof evidenceFields)[number], FieldState>;
    }
);
export function recordEvidenceFromJson(value: unknown): RecordEvidence {
  const x = value as RecordEvidence;
  const keys = x?.schema === "soldbench.record-evidence.v2" ? evidenceFields : baseFields;
  if (
    (x?.schema !== "soldbench.record-evidence.v1" && x?.schema !== "soldbench.record-evidence.v2") ||
    !/^[a-f0-9]{64}$/.test(x.profileHash) ||
    !Number.isSafeInteger(x.recordIndex) ||
    x.recordIndex < 0 ||
    x.recordIndex > 1000 ||
    !x.attributes ||
    Array.isArray(x.attributes) ||
    Object.keys(x.attributes).length > 32 ||
    !x.fields ||
    Object.keys(x.fields).length !== keys.length ||
    keys.some((key) => !["present", "missing", "withheld"].includes(x.fields[key as keyof typeof x.fields]))
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
  if ((x.fields.attributes === "present") !== Object.keys(x.attributes).length > 0)
    throw new Error("invalid_record_evidence");
  if (x.schema === "soldbench.record-evidence.v2") {
    if (
      x.conditionStandard !== null &&
      (x.fields.condition !== "present" || !isStandardCondition(x.conditionStandard))
    )
      throw new Error("invalid_record_evidence");
    for (const key of ["description", "defects"] as const) {
      const value = x[key];
      if (x.fields[key] === "present") {
        if (typeof value !== "string" || !value.trim() || value.length > 2000)
          throw new Error("invalid_record_evidence");
      } else if (value !== null) throw new Error("invalid_record_evidence");
    }
  } else if (["description", "defects", "conditionStandard"].some((key) => Object.hasOwn(x, key))) {
    throw new Error("invalid_record_evidence");
  }
  if (Buffer.byteLength(JSON.stringify(x), "utf8") > 24000) throw new Error("invalid_record_evidence");
  return structuredClone(x);
}
