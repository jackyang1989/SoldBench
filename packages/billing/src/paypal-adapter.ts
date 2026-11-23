import { AppError } from "@soldbench/shared";
import type { PaymentFact } from "./payment-fixtures.ts";

export type PayPalAdapterConfig = {
  clientId: string;
  clientSecret: string;
  webhookId: string;
  merchantId: string;
  apiBaseUrl?: string;
  environment?: "offline_fixture" | "sandbox" | "live";
  timeoutMs?: number;
};

export type PayPalTranslatedFact = PaymentFact extends infer U
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

function cleanId(raw: unknown, prefix: string): string {
  const s = typeof raw === "string" && raw.trim() ? raw.trim() : `${prefix}_${Date.now()}`;
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
}

/**
 * Exact BigInt USD integer-cent formatter without binary floating-point rounding (`1000 -> "10.00"`).
 */
export function formatUsdCentsForPayPal(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents <= 0) invalid("amountCents must be a positive integer.");
  const b = BigInt(cents);
  return `${b / 100n}.${String(b % 100n).padStart(2, "0")}`;
}

/**
 * Exact decimal string to integer-cent parser (`"10.00" -> 1000`), rejecting invalid or non-positive amounts.
 */
export function parsePayPalUsdCents(value: unknown): number {
  if (typeof value !== "string" && typeof value !== "number") invalid("PayPal amount value missing.");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  if (!match) invalid(`Invalid PayPal USD amount format: ${String(value)}`);
  const minor = BigInt(match[1] ?? "0") * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) invalid("PayPal USD amount out of range.");
  return Number(minor);
}

/**
 * Translates genuine PayPal REST webhook events (`PAYMENT.CAPTURE.*`, `PAYMENT.SALE.COMPLETED`,
 * `CUSTOMER.DISPUTE.CREATED`) into canonical `PaymentFact` records.
 */
export function translatePayPalEventToFact(
  event: unknown,
  merchantId: string,
  environment: "offline_fixture" | "sandbox" | "live" = "offline_fixture",
): PayPalTranslatedFact | null {
  if (!event || typeof event !== "object") invalid("PayPal webhook event must be a JSON object.");
  const evt = event as Record<string, unknown>;
  const eventType = typeof evt.event_type === "string" ? evt.event_type : "";
  const resource = evt.resource as Record<string, unknown> | undefined;
  if (!eventType || !resource || typeof resource !== "object") {
    invalid("PayPal webhook event missing event_type or resource.");
  }

  const statusMap: Record<string, "confirmed" | "failed" | "disputed" | "refunded"> = {
    "PAYMENT.CAPTURE.COMPLETED": "confirmed",
    "PAYMENT.SALE.COMPLETED": "confirmed",
    "PAYMENT.CAPTURE.DENIED": "failed",
    "PAYMENT.CAPTURE.REFUNDED": "refunded",
    "CUSTOMER.DISPUTE.CREATED": "disputed",
  };
  const mappedStatus = statusMap[eventType];
  if (!mappedStatus) return null;

  const checkoutId =
    (typeof resource.custom_id === "string" && resource.custom_id) ||
    (typeof resource.invoice_id === "string" && resource.invoice_id) ||
    "";
  if (!checkoutId) invalid(`PayPal ${eventType} resource missing custom_id checkout intent binding.`);

  const amountObj =
    (resource.amount as { currency_code?: unknown; value?: unknown } | undefined) ??
    (
      resource.disputed_transactions as
        | Array<{
            seller_transaction_id?: unknown;
            gross_amount?: { currency_code?: unknown; value?: unknown };
          }>
        | undefined
    )?.[0]?.gross_amount;
  const currency = String(amountObj?.currency_code ?? "USD").toUpperCase();
  if (currency !== "USD") invalid("Only USD PayPal transactions are supported.");
  const amountCents = parsePayPalUsdCents(amountObj?.value);

  const paidAtRaw =
    (typeof resource.create_time === "string" && resource.create_time) ||
    (typeof evt.create_time === "string" && evt.create_time) ||
    new Date().toISOString();
  const paidAt = new Date(paidAtRaw);
  if (!Number.isFinite(paidAt.getTime())) invalid("Invalid PayPal event timestamp.");

  const subId =
    typeof resource.billing_agreement_id === "string" && resource.billing_agreement_id
      ? cleanId(resource.billing_agreement_id, "pp_sub")
      : null;

  return {
    provider: "paypal",
    merchant: merchantId,
    environment,
    checkout_id: checkoutId,
    object_id: cleanId(resource.id ?? evt.id, "pp"),
    revision: mappedStatus === "refunded" || mappedStatus === "disputed" ? 2 : 1,
    kind: "transaction",
    status: mappedStatus,
    amount_cents: amountCents,
    currency: "USD",
    paid_at: paidAt.toISOString(),
    subscription_id: subId,
    period_start: typeof resource.period_start === "string" ? resource.period_start : null,
    period_end: typeof resource.period_end === "string" ? resource.period_end : null,
  };
}

/**
 * Genuine PayPal REST v1/v2 HTTP & webhook-signature verification adapter.
 */
export class PayPalProviderAdapter {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly environment: "offline_fixture" | "sandbox" | "live";
  private cachedToken: { token: string; expiresAtMs: number } | null = null;

  constructor(private readonly config: PayPalAdapterConfig) {
    if (!config.clientId || !config.clientSecret || !config.webhookId || !config.merchantId) {
      throw new Error("paypal_adapter_credentials_required");
    }
    this.baseUrl = (config.apiBaseUrl ?? "https://api-m.sandbox.paypal.com").replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.environment = config.environment ?? "offline_fixture";
  }

  async getAccessToken(nowMs = Date.now()): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAtMs - 60_000 > nowMs) {
      return this.cachedToken.token;
    }
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`, "utf8").toString(
      "base64",
    );
    const res = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!res.ok || !body.access_token) {
      throw new AppError("service_unavailable", 502, `PayPal OAuth token request failed (${res.status}).`);
    }
    const ttlMs = (Number.isFinite(body.expires_in) ? Number(body.expires_in) : 300) * 1000;
    this.cachedToken = { token: body.access_token, expiresAtMs: nowMs + ttlMs };
    return body.access_token;
  }

  private async requestJson<T>(
    path: string,
    payload: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const token = await this.getAccessToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    if (!res.ok) {
      throw new AppError("service_unavailable", 502, `PayPal API request failed (${res.status}).`, {
        provider: "paypal",
        status: res.status,
      });
    }
    return parsed as T;
  }

  async createOrder(input: {
    checkoutIntentId: string;
    amountCents: number;
    returnUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<{ orderId: string; approveUrl: string }> {
    const order = await this.requestJson<{
      id?: string;
      links?: Array<{ rel?: string; href?: string }>;
    }>(
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            custom_id: input.checkoutIntentId,
            amount: {
              currency_code: "USD",
              value: formatUsdCentsForPayPal(input.amountCents),
            },
          },
        ],
        application_context: {
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
        },
      },
      { "PayPal-Request-Id": input.idempotencyKey },
    );
    const approve = order.links?.find((l) => l.rel === "approve")?.href;
    if (!order.id || !approve) {
      throw new AppError("service_unavailable", 502, "PayPal order response missing id or approve link.");
    }
    return { orderId: order.id, approveUrl: approve };
  }

  async cancelSubscription(input: { providerSubscriptionId: string; reason: string }): Promise<void> {
    await this.requestJson(
      `/v1/billing/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}/cancel`,
      {
        reason: input.reason.slice(0, 128),
      },
    );
  }

  async verifyWebhookSignature(headers: Headers, rawBody: Buffer | string): Promise<Record<string, unknown>> {
    const transmissionId = headers.get("paypal-transmission-id");
    const transmissionTime = headers.get("paypal-transmission-time");
    const certUrl = headers.get("paypal-cert-url");
    const authAlgo = headers.get("paypal-auth-algo");
    const transmissionSig = headers.get("paypal-transmission-sig");
    if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
      forbidden("Missing required PayPal webhook transmission signature headers.");
    }
    let eventJson: Record<string, unknown>;
    try {
      eventJson = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody);
    } catch {
      invalid("Invalid PayPal webhook JSON.");
    }

    const verifyRes = await this.requestJson<{ verification_status?: string }>(
      "/v1/notifications/verify-webhook-signature",
      {
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_sig: transmissionSig,
        transmission_time: transmissionTime,
        webhook_id: this.config.webhookId,
        webhook_event: eventJson,
      },
    );
    if (verifyRes.verification_status !== "SUCCESS") {
      forbidden("PayPal webhook signature verification rejected.");
    }
    return eventJson;
  }

  async verifyAndTranslateWebhook(headers: Headers, rawBody: Buffer | string) {
    const event = await this.verifyWebhookSignature(headers, rawBody);
    const fact = translatePayPalEventToFact(event, this.config.merchantId, this.environment);
    return {
      eventId: cleanId(event.id, "pp_evt"),
      eventType: String(event.event_type ?? ""),
      fact,
    };
  }
}
