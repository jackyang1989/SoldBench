export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined>) {
  if (env.COLLECTOR_ENABLED && env.COLLECTOR_ENABLED !== "false")
    throw new Error("Collector requires a separately approved source integration");
  if (env.DATA_MODE && env.DATA_MODE !== "offline_fixture")
    throw new Error("Only offline_fixture is enabled");
  if (env.PAYMENTS_MODE && env.PAYMENTS_MODE !== "offline")
    throw new Error("Payment network access remains disabled");
  if (env.NODE_ENV === "production") throw new Error("Production release gates have not been signed");
  const port = Number(env.PORT ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  const host = env.HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host))
    throw new Error("Offline development server must bind to loopback");
  const hostForUrl = host.includes(":") ? `[${host}]` : host;
  const origin = new URL(env.APP_ORIGIN ?? `http://${hostForUrl}:${port}`);
  if (
    origin.protocol !== "http:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    !["127.0.0.1", "localhost", "::1"].includes(origin.hostname) ||
    Number(origin.port || 80) !== port
  )
    throw new Error("Invalid APP_ORIGIN");
  return {
    origin: origin.origin,
    host,
    port,
    dataMode: "offline_fixture" as const,
    paymentsMode: "offline" as const,
    collectorEnabled: false as const,
    databaseUrl: env.DATABASE_URL ?? null,
    localStateRoot: env.LOCAL_STATE_ROOT ?? ".local",
    mediaRoot: env.MEDIA_ROOT ?? ".local/collector-media",
  };
}
