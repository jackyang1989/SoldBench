import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex, Transform } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { SoldQuery } from "@soldbench/core";
import { approvedImageUrl } from "@soldbench/media";
import { type ProxySummary, parseProxyUrl } from "@soldbench/shared";
import { buildEbayUsItemDetailUrl, buildEbayUsSoldSearchUrl, validateEbayUsOrigin } from "./ebay-us.ts";
import { type FixtureResponse, TransportReadError } from "./fixture.ts";

const defaultUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new TransportReadError("worker_shutdown", 0));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new TransportReadError("worker_shutdown", 0));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isChallengeRedirect(url: URL): boolean {
  return (
    /signin\.ebay\.com$/i.test(url.hostname) ||
    /\/splashui\/challenge|\/captcha|\/signin\b/i.test(url.pathname)
  );
}

/** Bounded self-hosted HTTP/HTTPS transport for opt-in eBay US sold-search capture and test servers. */
export class EbayUsHttpTransport {
  readonly mode = "ebay_us_http" as const;
  readonly query: SoldQuery;
  readonly origin: string;
  readonly allowLoopbackTestOrigin: boolean;
  readonly imageHosts: readonly string[];
  readonly imageOriginOverride: string | null;
  readonly proxySummary: ProxySummary | null;
  readonly egressMode: "direct" | "explicit_proxy";
  readonly itemsPerPage: 60 | 120 | 240;
  readonly timeoutMs: number;
  readonly maxPageBytes: number;
  readonly maxImageBytes: number;
  readonly maxRedirects: number;
  readonly minIntervalMs: number;
  readonly userAgent: string;
  readonly clock: () => number;
  readonly #proxyUrl: URL | null;
  readonly #proxyAuthHeader: string | null;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  #lastRequestAt: number | null = null;

  constructor(input: {
    query: SoldQuery;
    origin?: string;
    allowLoopbackTestOrigin?: boolean;
    imageHosts?: readonly string[];
    imageOriginOverride?: string;
    proxyUrl?: string | null;
    itemsPerPage?: 60 | 120 | 240;
    timeoutMs?: number;
    maxPageBytes?: number;
    maxImageBytes?: number;
    maxRedirects?: number;
    minIntervalMs?: number;
    userAgent?: string;
    clock?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  }) {
    const allowLoopback = input.allowLoopbackTestOrigin === true;
    const rawOrigin = input.origin ?? "https://www.ebay.com";
    let base: URL;
    try {
      base = validateEbayUsOrigin(rawOrigin, allowLoopback);
    } catch {
      throw new Error("ebay_origin_not_allowed");
    }
    let imageOverride: string | null = null;
    if (input.imageOriginOverride !== undefined) {
      if (!allowLoopback) throw new Error("ebay_origin_not_allowed");
      let imgBase: URL;
      try {
        imgBase = new URL(input.imageOriginOverride);
      } catch {
        throw new Error("ebay_origin_not_allowed");
      }
      if (
        imgBase.protocol !== "http:" ||
        imgBase.hostname !== "127.0.0.1" ||
        !imgBase.port ||
        imgBase.username ||
        imgBase.password ||
        imgBase.pathname !== "/" ||
        imgBase.search ||
        imgBase.hash
      )
        throw new Error("ebay_origin_not_allowed");
      imageOverride = imgBase.origin;
    }
    const imageHosts = input.imageHosts ?? ["i.ebayimg.com"];
    if (
      !Array.isArray(imageHosts) ||
      imageHosts.length < 1 ||
      imageHosts.length > 8 ||
      imageHosts.some(
        (host) => typeof host !== "string" || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(host),
      )
    )
      throw new Error("invalid_ebay_image_hosts");
    const timeoutMs = input.timeoutMs ?? 15000;
    const maxPageBytes = input.maxPageBytes ?? 4 * 1024 * 1024;
    const maxImageBytes = input.maxImageBytes ?? 5 * 1024 * 1024;
    const maxRedirects = input.maxRedirects ?? 2;
    const minIntervalMs = input.minIntervalMs ?? 1500;
    const itemsPerPage = input.itemsPerPage ?? 60;
    const userAgent = input.userAgent ?? defaultUserAgent;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
      throw new Error("invalid_http_timeout");
    if (!Number.isSafeInteger(maxPageBytes) || maxPageBytes < 1 || maxPageBytes > 4 * 1024 * 1024)
      throw new Error("invalid_ebay_page_budget");
    if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes < 1 || maxImageBytes > 5 * 1024 * 1024)
      throw new Error("invalid_ebay_image_budget");
    if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 3)
      throw new Error("invalid_ebay_redirect_limit");
    if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0 || minIntervalMs > 60000)
      throw new Error("invalid_ebay_interval");
    if (![60, 120, 240].includes(itemsPerPage)) throw new Error("invalid_ebay_items_per_page");
    if (!userAgent || userAgent.length > 256 || /[\r\n]/.test(userAgent))
      throw new Error("invalid_ebay_user_agent");
    const parsedProxy =
      typeof input.proxyUrl === "string"
        ? parseProxyUrl(input.proxyUrl)
        : input.proxyUrl
          ? parseProxyUrl(input.proxyUrl)
          : null;
    this.#proxyUrl = parsedProxy ? parsedProxy.url : null;
    this.#proxyAuthHeader =
      parsedProxy && (parsedProxy.url.username || parsedProxy.url.password)
        ? `Basic ${Buffer.from(
            `${decodeURIComponent(parsedProxy.url.username)}:${decodeURIComponent(parsedProxy.url.password)}`,
          ).toString("base64")}`
        : null;
    this.proxySummary = parsedProxy ? Object.freeze({ ...parsedProxy.summary }) : null;
    this.egressMode = parsedProxy ? "explicit_proxy" : "direct";
    this.query = structuredClone(input.query);
    this.origin = base.origin;
    this.allowLoopbackTestOrigin = allowLoopback;
    this.imageHosts = Object.freeze([...imageHosts]);
    this.imageOriginOverride = imageOverride;
    this.itemsPerPage = itemsPerPage;
    this.timeoutMs = timeoutMs;
    this.maxPageBytes = maxPageBytes;
    this.maxImageBytes = maxImageBytes;
    this.maxRedirects = maxRedirects;
    this.minIntervalMs = minIntervalMs;
    this.userAgent = userAgent;
    this.clock = input.clock ?? Date.now;
    this.#sleep = input.sleep ?? abortableSleep;
    Object.freeze(this);
  }

  private resolveTarget(key: string): { kind: "page" | "image"; url: URL; maxBytes: number } {
    if (key.startsWith("page:")) {
      const url = buildEbayUsSoldSearchUrl(this.query, {
        cursor: key.slice(5),
        itemsPerPage: this.itemsPerPage,
        origin: this.origin,
      });
      return { kind: "page", url, maxBytes: this.maxPageBytes };
    }
    if (key.startsWith("detail:")) {
      const url = buildEbayUsItemDetailUrl(key.slice(7), { origin: this.origin });
      return { kind: "page", url, maxBytes: this.maxPageBytes };
    }
    if (key.startsWith("image:")) {
      const safe = new URL(approvedImageUrl(key.slice(6), this.imageHosts));
      const url = this.imageOriginOverride
        ? new URL(`${safe.pathname}${safe.search}`, this.imageOriginOverride)
        : safe;
      return { kind: "image", url, maxBytes: this.maxImageBytes };
    }
    throw new Error("invalid_ebay_transport_key");
  }

  private isAllowedRedirectTarget(kind: "page" | "image", target: URL): boolean {
    if (target.username || target.password || target.hash) return false;
    if (kind === "page") {
      if (this.allowLoopbackTestOrigin && target.origin === this.origin) return true;
      return (
        target.protocol === "https:" &&
        !target.port &&
        (target.hostname === "www.ebay.com" || target.hostname === "ebay.com")
      );
    }
    if (
      this.allowLoopbackTestOrigin &&
      this.imageOriginOverride &&
      target.origin === this.imageOriginOverride
    )
      return true;
    return target.protocol === "https:" && !target.port && this.imageHosts.includes(target.hostname);
  }

  private fetchHop(
    url: URL,
    kind: "page" | "image",
    maxBytes: number,
    remainingMs: number,
    signal?: AbortSignal,
  ): Promise<
    | { kind: "response"; response: FixtureResponse }
    | { kind: "redirect"; status: number; location: string; wireBytes: number }
  > {
    if (signal?.aborted) return Promise.reject(new TransportReadError("worker_shutdown", 0));
    if (remainingMs < 1) return Promise.reject(new TransportReadError("http_request_timeout", 0));
    return new Promise((resolve, reject) => {
      let wireBytes = 0;
      let decodedBytes = 0;
      let done = false;
      let resCompleted = false;
      let response: IncomingMessage | undefined;
      let decoder: Transform | undefined;
      let activeReq: ClientRequest | undefined;
      let tunnelReq: ClientRequest | undefined;
      let activeSocket: Duplex | undefined;
      const chunks: Buffer[] = [];

      const finish = (
        error?: TransportReadError,
        outcome?:
          | { kind: "response"; response: FixtureResponse }
          | { kind: "redirect"; status: number; location: string; wireBytes: number },
      ) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error) {
          decoder?.destroy();
          response?.destroy();
          activeReq?.destroy();
          tunnelReq?.destroy();
          activeSocket?.destroy();
          reject(error);
        } else if (outcome) {
          if (outcome.kind === "redirect") activeSocket?.destroy();
          resolve(outcome);
        }
      };

      const onAbort = () => finish(new TransportReadError("worker_shutdown", wireBytes));
      const timer = setTimeout(
        () => finish(new TransportReadError("http_request_timeout", wireBytes)),
        remainingMs,
      );
      signal?.addEventListener("abort", onAbort, { once: true });

      const requestHeaders: Record<string, string> = {
        Accept:
          kind === "page"
            ? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            : "image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": kind === "page" ? "gzip, deflate, br" : "identity",
        "Cache-Control": "no-cache",
        "User-Agent": this.userAgent,
      };

      const onResponse = (res: IncomingMessage) => {
        response = res;
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          const location = typeof res.headers.location === "string" ? res.headers.location : "";
          res.destroy();
          finish(undefined, { kind: "redirect", status, location, wireBytes });
          return;
        }
        const rawEncoding = (res.headers["content-encoding"] ?? "identity")
          .split(",")[0]
          ?.trim()
          .toLowerCase();
        if (!["", "identity", "gzip", "x-gzip", "deflate", "br"].includes(rawEncoding ?? "")) {
          finish(new TransportReadError("http_encoding_rejected", wireBytes));
          return;
        }
        const declared = res.headers["content-length"];
        if (declared !== undefined && (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(maxBytes))) {
          finish(new TransportReadError("response_exceeds_budget", wireBytes));
          return;
        }
        const finalizeSuccess = () => {
          if (!resCompleted) {
            finish(new TransportReadError("http_response_interrupted", wireBytes));
            return;
          }
          const rawRetry = res.headers["retry-after"];
          let retryAfterSeconds: number | undefined;
          if ((status === 429 || status === 503) && typeof rawRetry === "string") {
            const delay = /^\d+$/.test(rawRetry)
              ? Number(rawRetry)
              : Math.ceil((Date.parse(rawRetry) - this.clock()) / 1000);
            if (Number.isSafeInteger(delay) && delay >= 1 && delay <= 86400) retryAfterSeconds = delay;
          }
          finish(undefined, {
            kind: "response",
            response: {
              status,
              contentType: res.headers["content-type"] ?? "application/octet-stream",
              bytes: Buffer.concat(chunks, decodedBytes),
              ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
            },
          });
        };

        res.on("data", (chunk: Buffer) => {
          wireBytes += chunk.byteLength;
          if (wireBytes > maxBytes) {
            finish(new TransportReadError("response_exceeds_budget", wireBytes));
            return;
          }
          if (!decoder) {
            decodedBytes += chunk.byteLength;
            if (decodedBytes > maxBytes) {
              finish(new TransportReadError("response_exceeds_budget", wireBytes));
              return;
            }
            chunks.push(chunk);
          }
        });
        res.on("aborted", () => finish(new TransportReadError("http_response_interrupted", wireBytes)));
        res.on("error", () => finish(new TransportReadError("http_response_interrupted", wireBytes)));

        if (
          rawEncoding === "gzip" ||
          rawEncoding === "x-gzip" ||
          rawEncoding === "deflate" ||
          rawEncoding === "br"
        ) {
          decoder =
            rawEncoding === "br"
              ? createBrotliDecompress()
              : rawEncoding === "deflate"
                ? createInflate()
                : createGunzip();
          decoder.on("data", (chunk: Buffer) => {
            decodedBytes += chunk.byteLength;
            if (decodedBytes > maxBytes) {
              finish(new TransportReadError("response_exceeds_budget", wireBytes));
              return;
            }
            chunks.push(chunk);
          });
          decoder.on("error", () => finish(new TransportReadError("http_decode_failed", wireBytes)));
          res.on("end", () => {
            if (!res.complete) {
              finish(new TransportReadError("http_response_interrupted", wireBytes));
              return;
            }
            resCompleted = true;
          });
          decoder.on("end", finalizeSuccess);
          res.pipe(decoder);
        } else {
          res.on("end", () => {
            if (!res.complete) {
              finish(new TransportReadError("http_response_interrupted", wireBytes));
              return;
            }
            resCompleted = true;
            finalizeSuccess();
          });
        }
      };

      const proxy = this.#proxyUrl;
      if (!proxy) {
        const doRequest = url.protocol === "https:" ? httpsRequest : httpRequest;
        const req = doRequest(url, { method: "GET", agent: false, headers: requestHeaders }, onResponse);
        activeReq = req;
        req.on("error", () => finish(new TransportReadError("http_request_failed", wireBytes)));
        req.end();
        return;
      }

      const proxyHostname = proxy.hostname.replace(/^\[(.*)\]$/, "$1");
      const proxyPort = proxy.port ? Number(proxy.port) : proxy.protocol === "https:" ? 443 : 80;
      const proxyRequestFn = proxy.protocol === "https:" ? httpsRequest : httpRequest;
      const proxyHeaders = this.#proxyAuthHeader ? { "Proxy-Authorization": this.#proxyAuthHeader } : {};

      if (url.protocol === "http:") {
        const req = proxyRequestFn(
          {
            protocol: proxy.protocol,
            hostname: proxyHostname,
            port: proxyPort,
            method: "GET",
            path: url.href,
            agent: false,
            headers: {
              ...requestHeaders,
              Host: url.host,
              ...proxyHeaders,
            },
          },
          (res) => {
            if ((res.statusCode ?? 0) === 407) {
              res.destroy();
              finish(new TransportReadError("proxy_auth_required", wireBytes));
              return;
            }
            onResponse(res);
          },
        );
        activeReq = req;
        req.on("error", () => finish(new TransportReadError("proxy_connect_failed", wireBytes)));
        req.end();
        return;
      }

      const authority = `${url.hostname}:${url.port || "443"}`;
      let tunnelConnected = false;
      const connectReq = proxyRequestFn({
        protocol: proxy.protocol,
        hostname: proxyHostname,
        port: proxyPort,
        method: "CONNECT",
        path: authority,
        agent: false,
        headers: {
          Host: authority,
          ...proxyHeaders,
        },
      });
      tunnelReq = connectReq;
      connectReq.on("connect", (proxyRes, socket) => {
        tunnelConnected = true;
        activeSocket = socket;
        socket.on("error", () => finish(new TransportReadError("proxy_connect_failed", wireBytes)));
        const proxyStatus = proxyRes.statusCode ?? 0;
        if (proxyStatus === 407) {
          finish(new TransportReadError("proxy_auth_required", wireBytes));
          return;
        }
        if (proxyStatus !== 200) {
          finish(new TransportReadError("proxy_connect_failed", wireBytes));
          return;
        }
        if (done) {
          socket.destroy();
          return;
        }
        const innerReq = httpsRequest(
          url,
          {
            method: "GET",
            agent: false,
            headers: requestHeaders,
            createConnection: () =>
              tlsConnect({
                socket,
                servername: url.hostname.replace(/^\[(.*)\]$/, "$1"),
                rejectUnauthorized: true,
              }),
          },
          onResponse,
        );
        activeReq = innerReq;
        innerReq.on("error", () => finish(new TransportReadError("http_request_failed", wireBytes)));
        innerReq.end();
      });
      connectReq.on("error", () => finish(new TransportReadError("proxy_connect_failed", wireBytes)));
      connectReq.on("close", () => {
        if (!tunnelConnected && !done) finish(new TransportReadError("proxy_connect_failed", wireBytes));
      });
      connectReq.end();
    });
  }

  async read(key: string, index?: number, signal?: AbortSignal): Promise<FixtureResponse> {
    if (index !== undefined && (!Number.isSafeInteger(index) || index < 0))
      throw new Error("invalid_fixture_response_index");
    if (signal?.aborted) throw new TransportReadError("worker_shutdown", 0);
    const { kind, url: initialUrl, maxBytes } = this.resolveTarget(key);
    if (this.#lastRequestAt !== null && this.minIntervalMs > 0) {
      const elapsed = this.clock() - this.#lastRequestAt;
      if (elapsed < this.minIntervalMs) await this.#sleep(this.minIntervalMs - elapsed, signal);
    }
    this.#lastRequestAt = this.clock();
    const deadlineAt = this.clock() + this.timeoutMs;
    let currentUrl = initialUrl;
    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      const remaining = deadlineAt - this.clock();
      const result = await this.fetchHop(currentUrl, kind, maxBytes, remaining, signal);
      if (result.kind === "response") return result.response;
      if (!result.location) throw new TransportReadError("http_redirect_rejected", result.wireBytes);
      let nextUrl: URL;
      try {
        nextUrl = new URL(result.location, currentUrl);
      } catch {
        throw new TransportReadError("http_redirect_rejected", result.wireBytes);
      }
      if (isChallengeRedirect(nextUrl)) {
        return {
          status: 403,
          contentType: "text/html",
          bytes: Buffer.from("ebay_challenge_redirect"),
        };
      }
      if (hop >= this.maxRedirects || !this.isAllowedRedirectTarget(kind, nextUrl))
        throw new TransportReadError("http_redirect_rejected", result.wireBytes);
      currentUrl = nextUrl;
    }
    throw new TransportReadError("http_redirect_rejected", 0);
  }
}
