export const DATA_MODES = ["offline_fixture", "approved_network"] as const;
export type DataMode = (typeof DATA_MODES)[number];

export const PAYMENTS_MODES = ["offline", "stripe_paypal_sandbox", "stripe_paypal_live"] as const;
export type PaymentsMode = (typeof PAYMENTS_MODES)[number];

export const MAIL_TRANSPORTS = ["offline", "resend", "smtp"] as const;
export type MailTransportMode = (typeof MAIL_TRANSPORTS)[number];

/**
 * Checks whether a source row's `(access_method, provider)` pair matches the active `DataMode`,
 * independent of whether its clearance is currently active or revoked/draft.
 */
export function isSourceKindAllowedForMode(
  dataMode: DataMode,
  source: {
    access_method?: string | null;
    provider?: string | null;
  },
): boolean {
  if (dataMode === "offline_fixture") {
    return source.access_method === "offline_fixture" && source.provider === "synthetic_fixture";
  }
  return (
    (source.access_method === "approved_http" || source.access_method === "approved_browser") &&
    Boolean(source.provider) &&
    source.provider !== "synthetic_fixture"
  );
}

/**
 * Evaluates whether a source & clearance pair is authorized under the active `DataMode`.
 * Strictly separates synthetic offline fixtures from approved live HTTP/browser sources.
 */
export function isSourceAllowedForMode(
  dataMode: DataMode,
  source: {
    access_method?: string | null;
    provider?: string | null;
    clearance_status?: string | null;
  },
): boolean {
  if (!isSourceKindAllowedForMode(dataMode, source)) return false;
  if (dataMode === "offline_fixture") {
    return ["draft", "reviewed", "active"].includes(source.clearance_status ?? "");
  }
  return source.clearance_status === "active";
}

/**
 * Builds the canonical SQL predicate enforcing source & clearance eligibility for `dataMode`.
 */
export function sqlSourceEligibilityClause(
  dataMode: DataMode,
  sourceAlias = "s",
  clearanceAlias = "x",
): string {
  if (dataMode === "offline_fixture") {
    return `${sourceAlias}.access_method='offline_fixture' AND ${clearanceAlias}.provider='synthetic_fixture' AND ${clearanceAlias}.status IN ('draft','reviewed','active')`;
  }
  return `${sourceAlias}.access_method IN ('approved_http','approved_browser') AND ${clearanceAlias}.provider<>'synthetic_fixture' AND ${clearanceAlias}.status='active'`;
}

/**
 * Builds the access_method + provider pair check (used in queries that omit clearance status filters).
 */
export function sqlSourceKindClause(dataMode: DataMode, sourceAlias = "s", clearanceAlias = "x"): string {
  if (dataMode === "offline_fixture") {
    return `${sourceAlias}.access_method='offline_fixture' AND ${clearanceAlias}.provider='synthetic_fixture'`;
  }
  return `${sourceAlias}.access_method IN ('approved_http','approved_browser') AND ${clearanceAlias}.provider<>'synthetic_fixture'`;
}

export type ProxySummary = {
  host: string;
  port: number;
  protocol: "http:" | "https:";
  hasAuth: boolean;
};

/**
 * Validates an explicit HTTP/HTTPS egress proxy URL and returns its redacted summary without secrets.
 */
export function parseProxyUrl(raw: string): { url: URL; summary: ProxySummary } {
  const trimmed = raw.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) {
    throw new Error("invalid_collector_proxy_url");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("invalid_collector_proxy_url");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("invalid_collector_proxy_url");
  }
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid_collector_proxy_url");
  }
  return {
    url: parsed,
    summary: {
      host: parsed.hostname,
      port,
      protocol: parsed.protocol,
      hasAuth: Boolean(parsed.username || parsed.password),
    },
  };
}
