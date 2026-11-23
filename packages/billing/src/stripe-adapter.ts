import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@soldbench/shared";
import type { PaymentFact } from "./payment-fixtures.ts";

export type StripeAdapterConfig = {
  secretKey: string;
  webhookSecret: string;
  merchantId: string;
  apiBaseUrl?: string;
  environment?: "offline_fixture" | "sandbox" | "live";
  timeoutMs?: number;
};

export type StripeCheckoutInput = {
  checkoutIntentId: string;
  userId: string;
  planCode: "starter" | "pro" | "purchased_1500";
  amountCents: number;
  mode: "subscription" | "payment";
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
};

export type StripeTranslatedFact = PaymentFact extends infer U
  ? U extends PaymentFact
    ? Omit<U, "environment"> & { environment: "offline_fixture" | "sandbox" | "live" }
    : never
  : never;

function forbidden(message: string): never {
  throw new AppError("forbidden", 403, message);
}

function invalid(message: string): never {
  throw new AppError("invalid_parameter", 400, message);
}

function unixToIso(seconds: unknown): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(Math.floor(seconds * 1000)).toISOString();
}

function cleanId(raw: unknown, prefix: string): string {
  const s = typeof raw === "string" && raw.trim() ? raw.trim() : `${prefix}_${Date.now()}`;
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
}

/**
 * Verifies a genuine Stripe `Stripe-Signature` header (`t=<unix>,v1=<hex>...`) with constant-time
 * HMAC-SHA256 comparison and strict replay window tolerance (supports multi-`v1` secret rotation).
 */
export function verifyStripeWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): { timestamp: number; signature: string } {
  if (!signatureHeader || !secret) {
    forbidden("Missing Stripe webhook signature or secret.");
  }
  const parts = signatureHeader.split(",").map((p) => p.trim());
  const timestamps = parts.filter((p) => p.startsWith("t=")).map((p) => p.slice(2));
  const v1Candidates = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (parts.length > 16 || timestamps.length !== 1 || !v1Candidates.length) {
    forbidden("Malformed Stripe-Signature header.");
  }
  const stampRaw = timestamps[0] ?? "";
  if (!/^\d{10,12}$/.test(stampRaw)) {
    forbidden("Invalid Stripe-Signature timestamp.");
  }
  const timestamp = Number(stampRaw);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    forbidden("Stripe webhook timestamp is outside tolerance window.");
  }
  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  const expected = createHmac("sha256", secret).update(`${stampRaw}.`, "utf8").update(payload).digest();

  const matched = v1Candidates.find(
    (hex) => /^[0-9a-f]{64}$/i.test(hex) && timingSafeEqual(Buffer.from(hex, "hex"), expected),
  );
  if (!matched) {
    forbidden("Stripe webhook signature verification failed.");
  }
  return { timestamp, signature: matched };
}

/**
 * Translates real Stripe webhook events (`checkout.session.*`, `invoice.paid`, `payment_intent.*`,
 * `charge.refunded`, `charge.dispute.*`) into canonical `PaymentFact` records with strict USD/cent checks.
 */
export function translateStripeEventToFact(
  event: unknown,
  merchantId: string,
  environment: "offline_fixture" | "sandbox" | "live" = "offline_fixture",
): StripeTranslatedFact | null {
  if (!event || typeof event !== "object") invalid("Stripe webhook event must be a JSON object.");
  const evt = event as Record<string, unknown>;
  const type = typeof evt.type === "string" ? evt.type : "";
  const data = (evt.data as Record<string, unknown> | undefined)?.object as
    | Record<string, unknown>
    | undefined;
  if (!type || !data || typeof data !== "object") invalid("Stripe webhook event missing data.object.");

  const createdIso = unixToIso(evt.created) ?? new Date().toISOString();
  const metadata = (data.metadata as Record<string, unknown> | undefined) ?? {};
  const checkoutIdRaw =
    (typeof metadata.checkout_intent_id === "string" && metadata.checkout_intent_id) ||
    (typeof data.client_reference_id === "string" && data.client_reference_id) ||
    "";
  const revisionRaw = Number(metadata.revision ?? 1);
  const revision = Number.isSafeInteger(revisionRaw) && revisionRaw >= 1 ? revisionRaw : 1;

  if (type === "checkout.session.expired") {
    if (!checkoutIdRaw) invalid("Stripe expired checkout missing checkout_intent_id.");
    return {
      provider: "stripe",
      merchant: merchantId,
      environment,
      checkout_id: checkoutIdRaw,
      object_id: checkoutIdRaw,
      revision,
      kind: "checkout_expired",
      checked_at: createdIso,
    };
  }

  const supported: Record<string, "confirmed" | "failed" | "disputed" | "refunded"> = {
    "checkout.session.completed": "confirmed",
    "payment_intent.succeeded": "confirmed",
    "invoice.paid": "confirmed",
    "payment_intent.payment_failed": "failed",
    "charge.refunded": "refunded",
    "charge.dispute.created": "disputed",
  };
  const mappedStatus = supported[type];
  if (!mappedStatus) {
    if (type === "charge.dispute.closed") {
      const outcome = String(data.status ?? "").toLowerCase();
      if (outcome !== "won" && outcome !== "lost") return null;
      if (!checkoutIdRaw) invalid("Stripe dispute closed event missing checkout_intent_id.");
      return {
        provider: "stripe",
        merchant: merchantId,
        environment,
        checkout_id: checkoutIdRaw,
        object_id: cleanId(data.payment_intent ?? data.charge ?? data.id, "dp"),
        revision: Math.max(2, revision),
        kind: "transaction",
        status: outcome === "won" ? "confirmed" : "refunded",
        amount_cents: requireUsdCents(data.amount),
        currency: "USD",
        paid_at: unixToIso(data.created) ?? createdIso,
        subscription_id:
          typeof metadata.subscription_id === "string" ? cleanId(metadata.subscription_id, "sub") : null,
        period_start: typeof metadata.period_start === "string" ? metadata.period_start : null,
        period_end: typeof metadata.period_end === "string" ? metadata.period_end : null,
      };
    }
    return null;
  }

  if (!checkoutIdRaw) invalid(`Stripe ${type} missing metadata.checkout_intent_id or client_reference_id.`);
  const rawCurrency = String(data.currency ?? "usd").toUpperCase();
  if (rawCurrency !== "USD") invalid("Only USD Stripe transactions are supported.");

  const rawAmount =
    type === "checkout.session.completed"
      ? data.amount_total
      : type === "invoice.paid"
        ? data.amount_paid
        : data.amount;
  const amountCents = requireUsdCents(rawAmount);

  if (type === "charge.refunded") {
    const refunded = Number(data.amount_refunded ?? 0);
    if (!Number.isSafeInteger(refunded) || refunded < amountCents) {
      return null;
    }
  }

  const lines = ((data.lines as { data?: Array<Record<string, unknown>> } | undefined)?.data ?? [])[0];
  const period = (lines?.period as { start?: number; end?: number } | undefined) ?? undefined;
  const periodStart =
    unixToIso(period?.start) ?? (typeof metadata.period_start === "string" ? metadata.period_start : null);
  const periodEnd =
    unixToIso(period?.end) ?? (typeof metadata.period_end === "string" ? metadata.period_end : null);

  const subRaw =
    data.subscription ?? (typeof metadata.subscription_id === "string" ? metadata.subscription_id : null);
  const subscriptionId = typeof subRaw === "string" && subRaw ? cleanId(subRaw, "sub") : null;
  const objectId = cleanId(data.payment_intent ?? data.charge ?? data.id, "pi");

  return {
    provider: "stripe",
    merchant: merchantId,
    environment,
    checkout_id: checkoutIdRaw,
    object_id: objectId,
    revision: mappedStatus === "refunded" || mappedStatus === "disputed" ? Math.max(2, revision) : revision,
    kind: "transaction",
    status: mappedStatus,
    amount_cents: amountCents,
    currency: "USD",
    paid_at: unixToIso(data.created) ?? createdIso,
    subscription_id: subscriptionId,
    period_start: periodStart,
    period_end: periodEnd,
  };
}

function requireUsdCents(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) {
    invalid("Stripe monetary amount must be a positive integer cent value.");
  }
  return raw;
}

/**
 * HTTP & webhook protocol adapter for genuine Stripe API v1 (`https://api.stripe.com`) without relaxing
 * offline default config gates unless explicitly configured by an operator.
 */
export class StripeProviderAdapter {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly environment: "offline_fixture" | "sandbox" | "live";

  constructor(private readonly config: StripeAdapterConfig) {
    if (!config.secretKey || !config.webhookSecret || !config.merchantId) {
      throw new Error("stripe_adapter_credentials_required");
    }
    this.baseUrl = (config.apiBaseUrl ?? "https://api.stripe.com").replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.environment = config.environment ?? "offline_fixture";
  }

  private async postForm<T>(path: string, form: Record<string, string>, idempotencyKey?: string): Promise<T> {
    const body = new URLSearchParams(form).toString();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    if (!res.ok) {
      throw new AppError("service_unavailable", 502, `Stripe API request failed (${res.status}).`, {
        provider: "stripe",
        status: res.status,
      });
    }
    return parsed as T;
  }

  async createCheckoutSession(input: StripeCheckoutInput): Promise<{ sessionId: string; url: string }> {
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
      invalid("amountCents must be a positive integer.");
    }
    const form: Record<string, string> = {
      mode: input.mode,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.checkoutIntentId,
      "metadata[checkout_intent_id]": input.checkoutIntentId,
      "metadata[user_id]": input.userId,
      "metadata[plan_code]": input.planCode,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(input.amountCents),
      "line_items[0][price_data][product_data][name]": `SoldBench ${input.planCode}`,
    };
    if (input.mode === "subscription") {
      form["line_items[0][price_data][recurring][interval]"] = "month";
      form["subscription_data[metadata][checkout_intent_id]"] = input.checkoutIntentId;
    } else {
      form["payment_intent_data[metadata][checkout_intent_id]"] = input.checkoutIntentId;
    }
    const session = await this.postForm<{ id?: string; url?: string }>(
      "/v1/checkout/sessions",
      form,
      input.idempotencyKey,
    );
    if (!session.id || !session.url) {
      throw new AppError("service_unavailable", 502, "Stripe checkout session response missing id/url.");
    }
    return { sessionId: session.id, url: session.url };
  }

  async createBillingPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    const portal = await this.postForm<{ url?: string }>("/v1/billing_portal/sessions", {
      customer: input.customerId,
      return_url: input.returnUrl,
    });
    if (!portal.url) {
      throw new AppError("service_unavailable", 502, "Stripe billing portal response missing url.");
    }
    return { url: portal.url };
  }

  async cancelSubscriptionAtPeriodEnd(input: {
    providerSubscriptionId: string;
    idempotencyKey: string;
  }): Promise<{ cancelAtPeriodEnd: boolean }> {
    const sub = await this.postForm<{ cancel_at_period_end?: boolean }>(
      `/v1/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}`,
      { cancel_at_period_end: "true" },
      input.idempotencyKey,
    );
    return { cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end) };
  }

  verifyAndTranslateWebhook(
    rawBody: Buffer | string,
    signatureHeader: string | undefined,
    nowSeconds?: number,
  ) {
    verifyStripeWebhookSignature(rawBody, signatureHeader, this.config.webhookSecret, nowSeconds);
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody);
    } catch {
      invalid("Invalid Stripe webhook JSON.");
    }
    const event = parsed as Record<string, unknown>;
    const fact = translateStripeEventToFact(parsed, this.config.merchantId, this.environment);
    return {
      eventId: cleanId(event.id, "evt"),
      eventType: String(event.type ?? ""),
      fact,
    };
  }
}
