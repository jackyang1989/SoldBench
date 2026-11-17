import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

type Reply = { data?: Record<string, unknown>; error?: { code?: string }; meta?: Record<string, unknown> };
export class ClientError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 0) { super(code); this.code = code; this.status = status; }
}
const uuid = (value: unknown): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new ClientError("invalid_resource_id");
  return value;
};
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
export async function soldPrice(options: { base: string; key: string; keyword: string; claim: boolean }) {
  const base = new URL(options.base.replace(/\/$/, "")), claimKey = randomUUID();
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/v1" || (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)))) throw new ClientError("invalid_base_url");
  if (!/^sb_k_[A-Za-z0-9_-]+$/.test(options.key)) throw new ClientError("invalid_api_key");
  async function send(path: string, claim = false): Promise<{ status: number; body: Reply }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await fetch(`${base.href}${path}`, {
          method: claim ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(30000),
          headers: { Authorization: `Bearer ${options.key}`, Accept: "application/json", ...(claim ? { "Idempotency-Key": claimKey } : {}) },
        });
      } catch {
        if (attempt === 2) throw new ClientError("network_error");
        await sleep(250 * (2 ** attempt)); continue;
      }
      let body: Reply;
      try {
        const reader = response.body?.getReader();
        if (!reader) throw new Error();
        const chunks: Uint8Array[] = []; let size = 0;
        try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 2097152) { await reader.cancel(); throw new Error(); } chunks.push(part.value); } } finally { reader.releaseLock(); }
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        body = value as Reply;
      } catch { throw new ClientError("invalid_response", response.status); }
      const error = typeof body.error?.code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(body.error.code) ? body.error.code : "http_error";
      if ((response.status === 429 || response.status >= 500) && !["quota_exceeded", "insufficient_credits", "forbidden"].includes(error) && attempt < 2) {
        const raw = response.headers.get("Retry-After");
        const delay = raw ? (/^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now()) : 250 * (2 ** attempt);
        if (!Number.isFinite(delay) || delay > 30000) throw new ClientError("retry_later", response.status);
        await sleep(Math.max(0, delay)); continue;
      }
      if (response.status === 409 && error === "result_not_claimed") return { status: 409, body };
      if (!response.ok) throw new ClientError(error, response.status);
      if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) throw new ClientError("invalid_response", response.status);
      return { status: response.status, body };
    }
    throw new ClientError("retry_exhausted");
  }
  const search = await send(`/sold?${new URLSearchParams({ q: options.keyword })}`),
    queryId = uuid(search.body.data?.query_id), jobId = uuid(search.body.data?.job_id);
  let complete = false;
  for (let i = 0; i < 40; i++) {
    const job = (await send(`/jobs/${jobId}`)).body.data;
    if (job?.status === "completed") { complete = true; break; }
    if (job?.status !== "queued" && job?.status !== "running") throw new ClientError("job_not_completed");
    await sleep(250);
  }
  if (!complete) throw new ClientError("poll_limit_reached");
  let result = await send(`/sold/${queryId}`);
  if (result.status === 409) {
    if (!options.claim) throw new ClientError("claim_required", 409);
    result = await send(`/sold/${queryId}/claim`, true);
  }
  const stats = result.body.data?.stats as Record<string, unknown> | undefined;
  if (!stats || !(stats.median_cents === null || (Number.isSafeInteger(stats.median_cents) && Number(stats.median_cents) >= 0)) || !Number.isSafeInteger(stats.n_price_verified) || Number(stats.n_price_verified) < 0) throw new ClientError("invalid_statistics");
  return { query_id: queryId, median_cents: stats.median_cents, n_price_verified: stats.n_price_verified, data_mode: result.body.meta?.data_mode ?? "unknown", credits_charged: result.body.meta?.credits_charged ?? null };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((a) => a !== "--claim")) throw new ClientError("invalid_argument");
    console.log(JSON.stringify(await soldPrice({ base: process.env.SOLDBENCH_BASE_URL ?? "http://127.0.0.1:3000/v1", key: process.env.SOLDBENCH_API_KEY ?? "", keyword: process.env.SOLDBENCH_KEYWORD ?? "Nintendo Switch OLED", claim: process.argv.includes("--claim") })));
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof ClientError ? error.code : "client_error", status: error instanceof ClientError ? error.status : 0 }));
    process.exitCode = 1;
  }
}
