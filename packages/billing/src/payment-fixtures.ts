import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@soldbench/shared";
import * as z from "zod";

export const providers = ["stripe", "paypal"] as const;
export type Provider = (typeof providers)[number];
export const merchant = (provider: Provider) => `fixture_${provider}_soldbench`;
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const time = z.iso.datetime().refine((value) => /^[1-9]\d{3}-/.test(value), "Unsupported date");
const revision = z.int().min(1).max(2147483647);
const common = {
  provider: z.enum(providers),
  merchant: identifier,
  environment: z.literal("offline_fixture"),
  checkout_id: z.uuid(),
  object_id: identifier,
  revision,
};
export const factSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...common,
    kind: z.literal("checkout_expired"),
    checked_at: time,
  }),
  z.strictObject({
    ...common,
    kind: z.literal("transaction"),
    status: z.enum(["confirmed", "failed", "disputed", "refunded"]),
    amount_cents: z.int().positive(),
    currency: z.literal("USD"),
    paid_at: time,
    subscription_id: identifier.nullable(),
    period_start: time.nullable(),
    period_end: time.nullable(),
  }),
]);
export type PaymentFact = z.infer<typeof factSchema>;
const envelopeSchema = z.strictObject({
  id: identifier,
  type: identifier,
  environment: z.literal("offline_fixture"),
  merchant: identifier,
  object_id: identifier,
  revision,
});
export type Envelope = z.infer<typeof envelopeSchema>;
const accepted = {
  stripe: new Set([
    "invoice_paid",
    "payment_intent_succeeded",
    "payment_intent_failed",
    "dispute_changed",
    "charge_refunded",
    "checkout_expired",
  ]),
  paypal: new Set([
    "sale_completed",
    "capture_completed",
    "capture_denied",
    "dispute_changed",
    "capture_refunded",
    "checkout_expired",
  ]),
};
export type FixtureKeys = Readonly<Record<Provider, string>>;
const digest = (algorithm: string, raw: Buffer) => createHash(algorithm).update(raw).digest("hex");
const signature = (key: string, prefix: string, raw: Buffer) =>
  createHmac("sha256", key).update(prefix).update(raw).digest();
function rejected(): never {
  throw new AppError("unauthenticated", 401, "Fixture webhook signature is invalid.");
}
export function fixtureSignature(provider: Provider, key: string, raw: Buffer, now: Date) {
  const timestamp = Math.floor(now.getTime() / 1000);
  if (provider === "stripe") {
    return {
      "Stripe-Signature": `t=${timestamp},v1=${signature(key, `${timestamp}.`, raw).toString("hex")}`,
    };
  }
  return {
    "X-SoldBench-Fixture-PayPal-Time": String(timestamp),
    "X-SoldBench-Fixture-PayPal-Signature": signature(
      key,
      `${merchant(provider)}.${timestamp}.`,
      raw,
    ).toString("hex"),
  };
}
/** Test-only delivery verification. The PayPal path deliberately uses a separate, non-vendor protocol. */
export function verifyFixture(provider: Provider, key: string, headers: Headers, raw: Buffer, now: Date) {
  let stamp: string, candidates: string[];
  if (provider === "stripe") {
    const parts = (headers.get("Stripe-Signature") ?? "").split(",");
    const times = parts.filter((part) => part.startsWith("t="));
    if (parts.length > 16 || times.length !== 1) rejected();
    stamp = times[0]?.slice(2) ?? "";
    candidates = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  } else {
    stamp = headers.get("X-SoldBench-Fixture-PayPal-Time") ?? "";
    candidates = [headers.get("X-SoldBench-Fixture-PayPal-Signature") ?? ""];
  }
  if (!/^\d{10}$/.test(stamp) || Math.abs(Math.floor(now.getTime() / 1000) - Number(stamp)) > 300) rejected();
  const prefix = provider === "stripe" ? `${stamp}.` : `${merchant(provider)}.${stamp}.`;
  const expected = signature(key, prefix, raw);
  if (
    !candidates.some(
      (value) => /^[0-9a-f]{64}$/i.test(value) && timingSafeEqual(Buffer.from(value, "hex"), expected),
    )
  )
    rejected();
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new AppError("invalid_parameter", 400, "Invalid fixture webhook JSON.");
  }
  const valid = envelopeSchema.safeParse(value);
  if (
    !valid.success ||
    !accepted[provider].has(valid.data.type) ||
    valid.data.merchant !== merchant(provider)
  )
    throw new AppError("invalid_parameter", 400, "Unexpected fixture envelope.");
  return { envelope: valid.data, sha256: digest("sha256", raw) };
}
