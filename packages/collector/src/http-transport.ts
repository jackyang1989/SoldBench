import { request } from "node:http";
import { type CollectorTransport, type FixtureResponse, TransportReadError } from "./fixture.ts";

export type LoopbackRoute = { key: string; path: string; maxBytes?: number };
/** Actual bounded HTTP reads for a local fixture server. External origins cannot be configured. */
export class LoopbackHttpTransport implements CollectorTransport {
  readonly mode = "loopback_fixture" as const;
  readonly origin: string;
  readonly timeoutMs: number;
  readonly clock: () => number;
  #routes: Map<string, { url: string; maxBytes: number }>;
  constructor(input: {
    origin: string;
    routes: readonly LoopbackRoute[];
    timeoutMs?: number;
    clock?: () => number;
  }) {
    const base = new URL(input.origin);
    if (
      base.protocol !== "http:" ||
      base.hostname !== "127.0.0.1" ||
      !base.port ||
      base.username ||
      base.password ||
      base.pathname !== "/" ||
      base.search ||
      base.hash
    )
      throw new Error("loopback_origin_required");
    this.origin = base.origin;
    this.timeoutMs = input.timeoutMs ?? 10000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30000)
      throw new Error("invalid_http_timeout");
    this.clock = input.clock ?? Date.now;
    if (input.routes.length < 1 || input.routes.length > 2000) throw new Error("invalid_http_routes");
    this.#routes = new Map();
    for (const r of input.routes) {
      const kind = r.key.startsWith("page:") ? "page" : r.key.startsWith("image:") ? "image" : null;
      if (
        !kind ||
        r.key.length > 2200 ||
        this.#routes.has(r.key) ||
        !r.path.startsWith("/") ||
        r.path.startsWith("//") ||
        r.path.length > 4096
      )
        throw new Error("invalid_http_route");
      const url = new URL(r.path, base),
        cap = r.maxBytes ?? (kind === "page" ? 1024 * 1024 : 5 * 1024 * 1024);
      if (
        url.origin !== base.origin ||
        url.username ||
        url.password ||
        url.hash ||
        !Number.isSafeInteger(cap) ||
        cap < 1 ||
        cap > (kind === "page" ? 1024 * 1024 : 5 * 1024 * 1024)
      )
        throw new Error("invalid_http_route");
      this.#routes.set(r.key, { url: url.href, maxBytes: cap });
    }
    Object.freeze(this);
  }
  async read(key: string, index?: number, signal?: AbortSignal): Promise<FixtureResponse> {
    if (index !== undefined && (!Number.isSafeInteger(index) || index < 0))
      throw new Error("invalid_fixture_response_index");
    const route = this.#routes.get(key);
    if (!route) throw new Error("http_route_missing");
    if (signal?.aborted) throw new TransportReadError("worker_shutdown", 0);
    return new Promise((resolve, reject) => {
      let size = 0,
        done = false,
        response: import("node:http").IncomingMessage | undefined;
      const chunks: Buffer[] = [];
      const finish = (error?: TransportReadError, value?: FixtureResponse) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) {
          response?.destroy();
          req.destroy();
          reject(error);
        } else if (value) resolve(value);
      };
      const abort = () => finish(new TransportReadError("worker_shutdown", size));
      const req = request(
        route.url,
        {
          method: "GET",
          agent: false,
          headers: {
            Accept: "*/*",
            "Accept-Encoding": "identity",
            "User-Agent": "SoldBench-Local-Fixture/1.0",
          },
        },
        (res) => {
          response = res;
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            finish(new TransportReadError("http_redirect_rejected", size));
            return;
          }
          if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") {
            finish(new TransportReadError("http_encoding_rejected", size));
            return;
          }
          const length = res.headers["content-length"];
          if (length !== undefined && (!/^\d+$/.test(length) || BigInt(length) > BigInt(route.maxBytes))) {
            finish(new TransportReadError("response_exceeds_budget", size));
            return;
          }
          res.on("data", (data: Buffer) => {
            size += data.byteLength;
            if (size > route.maxBytes) {
              finish(new TransportReadError("response_exceeds_budget", size));
              return;
            }
            chunks.push(data);
          });
          res.on("aborted", () => finish(new TransportReadError("http_response_interrupted", size)));
          res.on("error", () => finish(new TransportReadError("http_response_interrupted", size)));
          res.on("end", () => {
            if (!res.complete) {
              finish(new TransportReadError("http_response_interrupted", size));
              return;
            }
            const raw = res.headers["retry-after"];
            let retryAfterSeconds: number | undefined;
            if (status === 429 && typeof raw === "string") {
              const delay = /^\d+$/.test(raw)
                ? Number(raw)
                : Math.ceil((Date.parse(raw) - this.clock()) / 1000);
              if (Number.isSafeInteger(delay) && delay >= 1 && delay <= 86400) retryAfterSeconds = delay;
            }
            finish(undefined, {
              status,
              contentType: res.headers["content-type"] ?? "application/octet-stream",
              bytes: Buffer.concat(chunks, size),
              ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
            });
          });
        },
      );
      const timer = setTimeout(
        () => finish(new TransportReadError("http_request_timeout", size)),
        this.timeoutMs,
      );
      signal?.addEventListener("abort", abort, { once: true });
      req.on("error", () => finish(new TransportReadError("http_request_failed", size)));
      req.end();
    });
  }
}
