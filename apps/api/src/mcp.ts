import { type CallToolResult, createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { AuthService, Identity } from "@soldbench/auth";
import { normalizeQuery, queryParameters } from "@soldbench/core";
import { type QueryService, RequestAuditService, type RequestOperation } from "@soldbench/query";
import { AppError, type Config } from "@soldbench/shared";
import type { Hono } from "hono";
import * as z from "zod";

type Env = { Variables: { requestId: string } };
const querySchema = z.strictObject({
  q: z.string(),
  marketplace: z.literal("ebay_us").optional(),
  category: z.string().optional(),
  brand: z.string().optional(),
  model: z.string().optional(),
  condition: z.string().optional(),
  window_days: z.int().optional(),
  price_basis: z.enum(["item", "item_plus_observed_shipping"]).optional(),
  limit: z.int().min(1).max(200).optional(),
  allow_stale: z.boolean().optional(),
  min_price_cents: z.int().nonnegative().optional(),
  max_price_cents: z.int().nonnegative().optional(),
  sale_format: z.enum(["fixed_price", "auction", "best_offer"]).optional(),
  attributes: z.record(z.string(), z.string()).optional(),
});
const searchSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("search"), query: querySchema }),
  z.strictObject({ action: z.literal("status"), job_id: z.uuid() }),
  z.strictObject({ action: z.literal("result"), query_id: z.uuid() }),
  z.strictObject({
    action: z.literal("claim"),
    query_id: z.uuid(),
    idempotency_key: z.string().regex(/^[\x21-\x7e]{16,128}$/),
  }),
]);
const output = (payload: object, error = false): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
  structuredContent: JSON.parse(JSON.stringify(payload)),
  ...(error ? { isError: true } : {}),
});
function presentation(result: Awaited<ReturnType<QueryService["result"]>>) {
  const comps = result.data.comps.slice(0, 20);
  return {
    ...result,
    data: { ...result.data, comps },
    meta: {
      ...result.meta,
      returned_comp_count: comps.length,
      truncated: comps.length < result.meta.available_comp_count,
      truncation_reasons: [
        ...result.meta.truncation_reasons,
        ...(comps.length < result.data.comps.length ? ["mcp_presentation_limit"] : []),
      ],
    },
  };
}
async function requestBody(request: Request, signal: AbortSignal) {
  if (request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    throw new AppError("invalid_parameter", 415, "Use application/json.");
  const reader = request.body?.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  if (!reader) throw new AppError("invalid_parameter", 400, "MCP request body is required.");
  let aborted = false;
  const abort = () => {
    aborted = true;
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.byteLength;
      if (size > 131072) {
        await reader.cancel().catch(() => {});
        throw new AppError("request_too_large", 413, "MCP request body exceeds 128 KiB.");
      }
      chunks.push(r.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  if (aborted) throw new AppError("request_timeout", 408, "MCP request body timed out or was cancelled.");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch {
    throw new AppError("invalid_parameter", 400, "Invalid MCP JSON.");
  }
  if (Array.isArray(value))
    throw new AppError("invalid_parameter", 400, "MCP request batches are not enabled.");
  return value;
}
export function mountMcp(app: Hono<Env>, config: Config, auth?: AuthService, query?: QueryService) {
  app.all("/mcp", async (c) => {
    if (!auth || !query) throw new AppError("service_unavailable", 503, "MCP service is not configured.");
    const authService = auth,
      service = query;
    const configured = new URL(config.origin),
      host = c.req.header("Host") ?? new URL(c.req.url).host;
    if (
      host !== configured.host ||
      (c.req.header("Origin") !== undefined && c.req.header("Origin") !== config.origin)
    )
      throw new AppError("forbidden", 403, "MCP request origin is not allowed.");
    if (c.req.header("Cookie"))
      throw new AppError("invalid_parameter", 400, "MCP accepts Bearer API keys only.");
    const token = /^Bearer (\S+)$/.exec(c.req.header("Authorization") ?? "")?.[1];
    if (!token) {
      c.header("WWW-Authenticate", "Bearer");
      throw new AppError("unauthenticated", 401, "An API key is required.");
    }
    const initial = await authService.keyIdentity(token, "sold:read"),
      requestId = c.get("requestId"),
      audit = new RequestAuditService(service);
    async function invoke(
      operation: RequestOperation,
      work: (
        actor: Identity,
        trace: { queryId?: string; jobId?: string; creditsCharged: 0 | 1; reused?: boolean; stale?: boolean },
      ) => Promise<object>,
      scope = "sold:read",
    ) {
      const started = performance.now(),
        trace: {
          queryId?: string;
          jobId?: string;
          creditsCharged: 0 | 1;
          reused?: boolean;
          stale?: boolean;
        } = { creditsCharged: 0 };
      let actor = initial,
        errorCode: string | undefined;
      try {
        actor = await authService.keyIdentity(token ?? "", scope);
        await service.rate(actor);
        return output(await work(actor, trace));
      } catch (error) {
        const known = error instanceof AppError;
        errorCode = known ? error.code : "service_unavailable";
        return output(
          {
            error: {
              code: errorCode,
              message: known ? error.message : "The service could not complete this request.",
              details: known ? (error.details ?? {}) : {},
              request_id: requestId,
            },
            meta: { request_id: requestId, credits_charged: trace.creditsCharged },
          },
          true,
        );
      } finally {
        try {
          await audit.record(actor, {
            requestId,
            operation,
            channel: "mcp",
            queryId: trace.queryId,
            jobId: trace.jobId,
            status: 200,
            errorCode,
            durationMs: Math.min(2147483647, Math.max(0, Math.round(performance.now() - started))),
            creditsCharged: trace.creditsCharged,
            reused: trace.reused,
            stale: trace.stale,
          });
        } catch {
          console.error("soldbench_mcp_audit_write_failed");
        }
      }
    }
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30000)]),
      parsedBody = c.req.method === "POST" ? await requestBody(c.req.raw, signal) : undefined;
    const handler = createMcpHandler(
      () => {
        const server = new McpServer(
          { name: "soldbench", version: "1.0.0" },
          {
            supportedProtocolVersions: ["2026-07-28", "2025-11-25"],
            instructions:
              "SoldBench offline synthetic data only. Search/status do not charge. Claim is explicit and costs at most 1 credit. Never present fixtures as real sold prices.",
          },
        );
        server.registerTool(
          "sold_search",
          {
            description:
              "Search sold-price snapshots, inspect job status, explicitly claim a ready result, or retrieve a delivered result. Search never implicitly claims. Output shows at most 20 comps; statistics use the complete snapshot.",
            inputSchema: searchSchema,
            annotations: {
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: false,
              openWorldHint: false,
            },
          },
          async (args) => {
            const op =
              args.action === "search"
                ? "sold_search"
                : args.action === "status"
                  ? "job_get"
                  : args.action === "claim"
                    ? "sold_claim"
                    : "sold_result";
            return invoke(
              op,
              async (actor, trace) => {
                if (args.action === "search") {
                  const r = await service.submit(actor, normalizeQuery(queryParameters(args.query)));
                  trace.queryId = r.queryId;
                  trace.jobId = r.jobId;
                  trace.reused = r.reused;
                  return {
                    data: {
                      query_id: r.queryId,
                      job_id: r.jobId,
                      status: r.status,
                      status_url: `/v1/jobs/${r.jobId}`,
                      claim_url: `/v1/sold/${r.queryId}/claim`,
                      expires_at: r.expiresAt,
                      next_action: r.status === "completed" ? "result_or_explicit_claim" : "status",
                    },
                    meta: {
                      request_id: requestId,
                      credits_charged: 0,
                      reused: r.reused,
                      data_mode: "synthetic_fixture",
                    },
                  };
                }
                if (args.action === "status") {
                  trace.jobId = args.job_id;
                  return {
                    data: await service.job(actor, args.job_id),
                    meta: { request_id: requestId, credits_charged: 0 },
                  };
                }
                trace.queryId = args.query_id;
                const result = await service.result(
                  actor,
                  args.query_id,
                  requestId,
                  args.action === "claim",
                  args.action === "claim" ? args.idempotency_key : undefined,
                );
                trace.creditsCharged = result.meta.credits_charged;
                trace.reused = result.meta.reused;
                trace.stale = result.meta.stale;
                return presentation(result);
              },
              args.action === "status" ? "jobs:read" : "sold:read",
            );
          },
        );
        server.registerTool(
          "sold_stats",
          {
            description:
              "Read statistics from an existing owned readable snapshot. Does not start a query or silently claim an unpaid result.",
            inputSchema: z.strictObject({ query_id: z.uuid() }),
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          async (args) =>
            invoke("sold_stats", async (actor, trace) => {
              trace.queryId = args.query_id;
              const r = await service.result(actor, args.query_id, requestId);
              trace.reused = r.meta.reused;
              trace.stale = r.meta.stale;
              return {
                data: {
                  query_id: r.data.query_id,
                  query: r.data.query,
                  stats: r.data.stats,
                  quality: r.data.quality,
                  supplemental_stats: r.data.supplemental_stats,
                },
                meta: {
                  ...r.meta,
                  returned_comp_count: 0,
                  truncated: r.meta.available_comp_count > 0,
                  truncation_reasons: r.meta.available_comp_count > 0 ? ["stats_only"] : [],
                },
              };
            }),
        );
        return server;
      },
      {
        legacy: "stateless",
        responseMode: "auto",
        maxRequestBodySize: 131072,
        maxSubscriptions: 0,
        keepAliveMs: 0,
        onerror: () => console.error("soldbench_mcp_protocol_error"),
      },
    );
    try {
      const request = new Request(c.req.url, {
          method: c.req.method,
          headers: c.req.raw.headers,
          signal,
        }),
        response = await handler.fetch(request, { parsedBody }),
        body = await response.arrayBuffer();
      return new Response(
        response.status === 204 || (response.status === 202 && body.byteLength === 0) ? null : body,
        { status: response.status, statusText: response.statusText, headers: response.headers },
      );
    } finally {
      await handler.close();
    }
  });
}
