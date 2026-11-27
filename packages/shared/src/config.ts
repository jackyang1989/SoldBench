import {
  DATA_MODES,
  type DataMode,
  MAIL_TRANSPORTS,
  type MailTransportMode,
  PAYMENTS_MODES,
  type PaymentsMode,
  type ProxySummary,
  parseProxyUrl,
} from "./runtime-policy.ts";

export type StripeRuntimeConfig = {
  secretKey: string;
  webhookSecret: string;
  merchantId: string;
  apiBaseUrl?: string;
};

export type PayPalRuntimeConfig = {
  clientId: string;
  clientSecret: string;
  webhookId: string;
  merchantId: string;
  apiBaseUrl?: string;
};

export type MailRuntimeConfig =
  | { mode: "offline" }
  | { mode: "resend"; apiKey: string; from: string; apiBaseUrl?: string }
  | {
      mode: "smtp";
      host: string;
      port: number;
      from: string;
      secure: boolean;
      auth?: { user: string; pass: string };
    };

export type Config = {
  origin: string;
  host: string;
  port: number;
  liveGateAcknowledged: boolean;
  isolatedDeployment: boolean;
  dataMode: DataMode;
  paymentsMode: PaymentsMode;
  paymentFixtures: boolean;
  collectorEnabled: boolean;
  databaseUrl: string | null;
  databaseStartup: "migrate" | "verify";
  localStateRoot: string;
  mediaRoot: string;
  stripe: StripeRuntimeConfig | null;
  paypal: PayPalRuntimeConfig | null;
  mailTransport: MailTransportMode;
  mail: MailRuntimeConfig;
  collectorProxyUrl: string | null;
  collectorProxySummary: ProxySummary | null;
};

function parseStripeConfig(env: Record<string, string | undefined>): StripeRuntimeConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
  const merchantId = env.STRIPE_MERCHANT_ID?.trim();
  if (!secretKey && !webhookSecret && !merchantId) return null;
  if (!secretKey || !webhookSecret || !merchantId) {
    throw new Error(
      "Incomplete Stripe credentials: set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_MERCHANT_ID.",
    );
  }
  return {
    secretKey,
    webhookSecret,
    merchantId,
    ...(env.STRIPE_API_BASE_URL?.trim() ? { apiBaseUrl: env.STRIPE_API_BASE_URL.trim() } : {}),
  };
}

function parsePayPalConfig(env: Record<string, string | undefined>): PayPalRuntimeConfig | null {
  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();
  const webhookId = env.PAYPAL_WEBHOOK_ID?.trim();
  const merchantId = env.PAYPAL_MERCHANT_ID?.trim();
  if (!clientId && !clientSecret && !webhookId && !merchantId) return null;
  if (!clientId || !clientSecret || !webhookId || !merchantId) {
    throw new Error(
      "Incomplete PayPal credentials: set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID, PAYPAL_MERCHANT_ID.",
    );
  }
  return {
    clientId,
    clientSecret,
    webhookId,
    merchantId,
    ...(env.PAYPAL_API_BASE_URL?.trim() ? { apiBaseUrl: env.PAYPAL_API_BASE_URL.trim() } : {}),
  };
}

function parseMailConfig(
  mode: MailTransportMode,
  env: Record<string, string | undefined>,
): MailRuntimeConfig {
  if (mode === "offline") return { mode: "offline" };
  const from = env.MAIL_FROM?.trim();
  if (!from) throw new Error("MAIL_FROM is required when MAIL_TRANSPORT is active.");
  if (mode === "resend") {
    const apiKey = env.RESEND_API_KEY?.trim();
    if (!apiKey) throw new Error("RESEND_API_KEY is required for MAIL_TRANSPORT=resend.");
    return {
      mode: "resend",
      apiKey,
      from,
      ...(env.RESEND_BASE_URL?.trim() ? { apiBaseUrl: env.RESEND_BASE_URL.trim() } : {}),
    };
  }
  const host = env.SMTP_HOST?.trim();
  const port = Number(env.SMTP_PORT ?? 587);
  if (!host || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("Valid SMTP_HOST and SMTP_PORT are required for MAIL_TRANSPORT=smtp.");
  }
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS?.trim();
  if (Boolean(user) !== Boolean(pass)) {
    throw new Error("Set both SMTP_USER and SMTP_PASS when using SMTP authentication.");
  }
  return {
    mode: "smtp",
    host,
    port,
    from,
    secure: env.SMTP_SECURE === "true",
    ...(user && pass ? { auth: { user, pass } } : {}),
  };
}

/**
 * Loads SoldBench runtime configuration. Defaults fail closed to safe offline fixture mode unless
 * `SOLDBENCH_LIVE_GATE_ACKNOWLEDGED=true` is explicitly configured with complete validated credentials.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const liveGateAcknowledged = env.SOLDBENCH_LIVE_GATE_ACKNOWLEDGED === "true";
  if (env.SOLDBENCH_ISOLATED_DEPLOYMENT && !["true", "false"].includes(env.SOLDBENCH_ISOLATED_DEPLOYMENT))
    throw new Error("invalid_isolated_deployment_mode");
  const isolatedDeployment = env.SOLDBENCH_ISOLATED_DEPLOYMENT === "true";
  if (isolatedDeployment && liveGateAcknowledged)
    throw new Error("isolated_deployment_cannot_accept_live_gate");

  if (env.PAYMENT_FIXTURES && !["true", "false"].includes(env.PAYMENT_FIXTURES)) {
    throw new Error("Invalid PAYMENT_FIXTURES");
  }
  const databaseStartup = env.DB_STARTUP_MODE ?? "migrate";
  if (databaseStartup !== "migrate" && databaseStartup !== "verify") {
    throw new Error("invalid_database_startup_mode");
  }
  const port = Number(env.PORT ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");

  if (!liveGateAcknowledged) {
    if (env.COLLECTOR_ENABLED && env.COLLECTOR_ENABLED !== "false")
      throw new Error("Collector requires a separately approved source integration");
    if (env.DATA_MODE && env.DATA_MODE !== "offline_fixture")
      throw new Error("Only offline_fixture is enabled");
    if (env.PAYMENTS_MODE && env.PAYMENTS_MODE !== "offline")
      throw new Error("Payment network access remains disabled");
    if (env.MAIL_TRANSPORT && env.MAIL_TRANSPORT !== "offline")
      throw new Error("Mail transport requires SOLDBENCH_LIVE_GATE_ACKNOWLEDGED=true");
    if (env.NODE_ENV === "production" && !isolatedDeployment)
      throw new Error("Production release gates have not been signed");
    if (isolatedDeployment && (env.PAYMENT_FIXTURES === "true" || env.COLLECTOR_PROXY_URL?.trim()))
      throw new Error("isolated_deployment_requires_disabled_fixtures_and_proxy");
    const host = env.HOST ?? "127.0.0.1";
    const loopbackHosts = ["127.0.0.1", "localhost", "::1"];
    if (!loopbackHosts.includes(host) && !(isolatedDeployment && host === "0.0.0.0"))
      throw new Error("Offline development server must bind to loopback");
    const hostForUrl = host.includes(":") ? `[${host}]` : host === "0.0.0.0" ? "127.0.0.1" : host;
    const origin = new URL(env.APP_ORIGIN ?? `http://${hostForUrl}:${port}`);
    const internalSite =
      isolatedDeployment && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.test$/.test(origin.hostname) && !origin.port;
    if (
      origin.protocol !== "http:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      (!internalSite &&
        (!["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) ||
          Number(origin.port || 80) !== port))
    )
      throw new Error("Invalid APP_ORIGIN");

    const rawProxyUrl = env.COLLECTOR_PROXY_URL?.trim();
    const proxy = rawProxyUrl ? parseProxyUrl(rawProxyUrl) : null;
    return {
      origin: origin.origin,
      host,
      port,
      liveGateAcknowledged: false,
      isolatedDeployment,
      dataMode: "offline_fixture",
      paymentsMode: "offline",
      paymentFixtures: env.PAYMENT_FIXTURES === "true",
      collectorEnabled: false,
      databaseUrl: env.DATABASE_URL ?? null,
      databaseStartup: databaseStartup as "migrate" | "verify",
      localStateRoot: env.LOCAL_STATE_ROOT ?? ".local",
      mediaRoot: env.MEDIA_ROOT ?? `${env.COLLECTOR_DEMO_DIR ?? ".local"}/collector-media`,
      stripe: null,
      paypal: null,
      mailTransport: "offline",
      mail: { mode: "offline" },
      collectorProxyUrl: proxy && rawProxyUrl ? rawProxyUrl : null,
      collectorProxySummary: proxy ? proxy.summary : null,
    };
  }

  // Explicit live-gate-acknowledged mode: validate every setting & credential fail-closed.
  const dataMode = (env.DATA_MODE ?? "offline_fixture") as DataMode;
  if (!DATA_MODES.includes(dataMode)) throw new Error("Invalid DATA_MODE");

  const collectorEnabled = env.COLLECTOR_ENABLED === "true";
  if (env.COLLECTOR_ENABLED && !["true", "false"].includes(env.COLLECTOR_ENABLED)) {
    throw new Error("Invalid COLLECTOR_ENABLED");
  }
  if (collectorEnabled && dataMode !== "approved_network") {
    throw new Error("COLLECTOR_ENABLED=true requires DATA_MODE=approved_network.");
  }

  const paymentsMode = (env.PAYMENTS_MODE ?? "offline") as PaymentsMode;
  if (!PAYMENTS_MODES.includes(paymentsMode)) throw new Error("Invalid PAYMENTS_MODE");
  const paymentFixtures = env.PAYMENT_FIXTURES === "true";
  if (paymentsMode !== "offline" && paymentFixtures) {
    throw new Error("PAYMENT_FIXTURES=true cannot be combined with live/sandbox PAYMENTS_MODE.");
  }

  const stripe = parseStripeConfig(env);
  const paypal = parsePayPalConfig(env);
  if (paymentsMode !== "offline" && !stripe && !paypal) {
    throw new Error("Configure Stripe or PayPal credentials when PAYMENTS_MODE is active.");
  }

  const mailTransport = (env.MAIL_TRANSPORT ?? "offline") as MailTransportMode;
  if (!MAIL_TRANSPORTS.includes(mailTransport)) throw new Error("Invalid MAIL_TRANSPORT");
  const mail = parseMailConfig(mailTransport, env);

  const host = (env.HOST ?? "127.0.0.1").trim();
  if (!host || /\s/.test(host)) throw new Error("Invalid HOST");
  const hostForUrl = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const origin = new URL(env.APP_ORIGIN ?? `http://${hostForUrl}:${port}`);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/"
  ) {
    throw new Error("Invalid APP_ORIGIN");
  }
  if (env.NODE_ENV === "production" && origin.protocol !== "https:") {
    throw new Error("Production APP_ORIGIN must use https://");
  }

  const rawProxyUrl = env.COLLECTOR_PROXY_URL?.trim();
  const proxy = rawProxyUrl ? parseProxyUrl(rawProxyUrl) : null;
  return {
    origin: origin.origin,
    host,
    port,
    liveGateAcknowledged: true,
    isolatedDeployment: false,
    dataMode,
    paymentsMode,
    paymentFixtures,
    collectorEnabled,
    databaseUrl: env.DATABASE_URL ?? null,
    databaseStartup: databaseStartup as "migrate" | "verify",
    localStateRoot: env.LOCAL_STATE_ROOT ?? ".local",
    mediaRoot: env.MEDIA_ROOT ?? `${env.COLLECTOR_DEMO_DIR ?? ".local"}/collector-media`,
    stripe,
    paypal,
    mailTransport,
    mail,
    collectorProxyUrl: proxy && rawProxyUrl ? rawProxyUrl : null,
    collectorProxySummary: proxy ? proxy.summary : null,
  };
}
