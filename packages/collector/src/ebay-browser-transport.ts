import type { SoldQuery } from "@soldbench/core";
import { type ProxySummary, parseProxyUrl } from "@soldbench/shared";
import { buildEbayUsItemDetailUrl, buildEbayUsSoldSearchUrl, validateEbayUsOrigin } from "./ebay-us.ts";
import { type FixtureResponse, TransportReadError } from "./fixture.ts";

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
    /\/splashui\/|\/captcha|\/mitigation|\/signin\b/i.test(url.pathname)
  );
}

type RouteRequest = {
  url(): string;
  resourceType(): string;
  method(): string;
  headers(): Record<string, string>;
};

type BrowserRoute = {
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
  fulfill(response: {
    status?: number;
    headers?: Record<string, string>;
    body?: Buffer | string;
  }): Promise<void>;
};

type PlaywrightPage = {
  url(): string;
  request: {
    fetch(
      url: string,
      options?: { maxRedirects?: number; timeout?: number; headers?: Record<string, string> },
    ): Promise<{
      status(): number;
      headers(): Record<string, string>;
      body(): Promise<Buffer>;
    }>;
  };
  route(
    pattern: string,
    handler: (route: BrowserRoute, req: RouteRequest) => Promise<void> | void,
  ): Promise<void>;
  goto(
    url: string,
    options: { waitUntil: "domcontentloaded"; timeout: number },
  ): Promise<{
    status(): number;
    headers(): Record<string, string>;
  } | null>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
  content(): Promise<string>;
  close(): Promise<void>;
};

type PlaywrightContext = {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
};

type PlaywrightBrowser = {
  newContext(options: {
    locale: string;
    viewport: { width: number; height: number };
    userAgent?: string;
  }): Promise<PlaywrightContext>;
  close(): Promise<void>;
};

type PlaywrightModule = {
  chromium: {
    launch(options: {
      executablePath: string;
      headless: boolean;
      args: string[];
      proxy?: { server: string; username?: string; password?: string };
    }): Promise<PlaywrightBrowser>;
  };
};

const blockedResourceTypes = new Set([
  "image",
  "media",
  "font",
  "stylesheet",
  "websocket",
  "eventsource",
  "manifest",
]);

/** Self-hosted bounded headless-browser transport for JS-rendered eBay US pages without external origin leakage. */
export class EbayUsBrowserTransport {
  readonly mode = "ebay_us_browser" as const;
  readonly query: SoldQuery;
  readonly origin: string;
  readonly allowLoopbackTestOrigin: boolean;
  readonly executablePath: string | null;
  readonly proxySummary: ProxySummary | null;
  readonly egressMode: "direct" | "explicit_proxy";
  readonly itemsPerPage: 60 | 120 | 240;
  readonly timeoutMs: number;
  readonly maxPageBytes: number;
  readonly minIntervalMs: number;
  readonly waitForSelector: string | null;
  readonly userAgent: string | null;
  readonly clock: () => number;
  readonly #playwrightProxy: { server: string; username?: string; password?: string } | null;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  #lastRequestAt: number | null = null;
  blockedRequests = 0;

  constructor(input: {
    query: SoldQuery;
    executablePath?: string;
    origin?: string;
    allowLoopbackTestOrigin?: boolean;
    proxyUrl?: string | null;
    itemsPerPage?: 60 | 120 | 240;
    timeoutMs?: number;
    maxPageBytes?: number;
    minIntervalMs?: number;
    waitForSelector?: string;
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
    const timeoutMs = input.timeoutMs ?? 20000;
    const maxPageBytes = input.maxPageBytes ?? 4 * 1024 * 1024;
    const minIntervalMs = input.minIntervalMs ?? 2000;
    const itemsPerPage = input.itemsPerPage ?? 60;
    const executablePath = input.executablePath ?? process.env.SOLDBENCH_BROWSER_BINARY ?? null;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000)
      throw new Error("invalid_http_timeout");
    if (!Number.isSafeInteger(maxPageBytes) || maxPageBytes < 1 || maxPageBytes > 4 * 1024 * 1024)
      throw new Error("invalid_ebay_page_budget");
    if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0 || minIntervalMs > 60000)
      throw new Error("invalid_ebay_interval");
    if (![60, 120, 240].includes(itemsPerPage)) throw new Error("invalid_ebay_items_per_page");
    if (
      input.waitForSelector !== undefined &&
      (typeof input.waitForSelector !== "string" ||
        !input.waitForSelector.trim() ||
        input.waitForSelector.length > 256)
    )
      throw new Error("invalid_browser_wait_selector");
    if (input.userAgent !== undefined && (!input.userAgent || input.userAgent.length > 256))
      throw new Error("invalid_ebay_user_agent");
    const parsedProxy =
      typeof input.proxyUrl === "string"
        ? parseProxyUrl(input.proxyUrl)
        : input.proxyUrl
          ? parseProxyUrl(input.proxyUrl)
          : null;
    this.proxySummary = parsedProxy ? Object.freeze({ ...parsedProxy.summary }) : null;
    this.egressMode = parsedProxy ? "explicit_proxy" : "direct";
    this.#playwrightProxy = parsedProxy
      ? {
          server: `${parsedProxy.url.protocol}//${parsedProxy.url.hostname}${
            parsedProxy.url.port ? `:${parsedProxy.url.port}` : ""
          }`,
          ...(parsedProxy.url.username ? { username: decodeURIComponent(parsedProxy.url.username) } : {}),
          ...(parsedProxy.url.password ? { password: decodeURIComponent(parsedProxy.url.password) } : {}),
        }
      : null;

    this.query = structuredClone(input.query);
    this.origin = base.origin;
    this.allowLoopbackTestOrigin = allowLoopback;
    this.executablePath = executablePath;
    this.itemsPerPage = itemsPerPage;
    this.timeoutMs = timeoutMs;
    this.maxPageBytes = maxPageBytes;
    this.minIntervalMs = minIntervalMs;
    this.waitForSelector = input.waitForSelector?.trim() ?? null;
    this.userAgent = input.userAgent ?? null;
    this.clock = input.clock ?? Date.now;
    this.#sleep = input.sleep ?? abortableSleep;
  }

  private resolveTarget(key: string): URL {
    if (key.startsWith("page:")) {
      return buildEbayUsSoldSearchUrl(this.query, {
        cursor: key.slice(5),
        itemsPerPage: this.itemsPerPage,
        origin: this.origin,
      });
    }
    if (key.startsWith("detail:")) {
      return buildEbayUsItemDetailUrl(key.slice(7), { origin: this.origin });
    }
    throw new Error("invalid_ebay_transport_key");
  }

  private isAllowedOrigin(target: URL): boolean {
    if (target.href === "about:blank") return true;
    if (this.allowLoopbackTestOrigin && target.origin === this.origin) return true;
    return (
      target.protocol === "https:" &&
      !target.port &&
      (target.hostname === "www.ebay.com" || target.hostname === "ebay.com")
    );
  }

  async read(key: string, _index?: number, signal?: AbortSignal): Promise<FixtureResponse> {
    if (signal?.aborted) throw new TransportReadError("worker_shutdown", 0);
    if (!this.executablePath) throw new Error("browser_binary_required");
    const targetUrl = this.resolveTarget(key);
    if (this.#lastRequestAt !== null && this.minIntervalMs > 0) {
      const elapsed = this.clock() - this.#lastRequestAt;
      if (elapsed < this.minIntervalMs) await this.#sleep(this.minIntervalMs - elapsed, signal);
    }
    this.#lastRequestAt = this.clock();

    const browserModule = process.env.SOLDBENCH_BROWSER_MODULE ?? "playwright-core";
    const { chromium } = (await import(browserModule)) as PlaywrightModule;
    let browser: PlaywrightBrowser | undefined;
    let context: PlaywrightContext | undefined;
    let page: PlaywrightPage | undefined;
    let aborted = false;
    let redirectedToChallenge = false;
    const onAbort = () => {
      aborted = true;
      void browser?.close().catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      browser = await chromium.launch({
        executablePath: this.executablePath,
        headless: true,
        args: ["--disable-background-networking", "--disable-component-update", "--disable-sync"],
        ...(this.#playwrightProxy ? { proxy: this.#playwrightProxy } : {}),
      });
      if (aborted) throw new TransportReadError("worker_shutdown", 0);
      context = await browser.newContext({
        locale: "en-US",
        viewport: { width: 1280, height: 800 },
        ...(this.userAgent ? { userAgent: this.userAgent } : {}),
      });
      const activePage = await context.newPage();
      page = activePage;
      await activePage.route("**/*", async (route, req) => {
        let parsed: URL;
        try {
          parsed = new URL(req.url());
        } catch {
          this.blockedRequests++;
          await route.abort("blockedbyclient");
          return;
        }
        if (req.resourceType() === "document" && isChallengeRedirect(parsed)) {
          redirectedToChallenge = true;
          await route.abort("blockedbyclient");
          return;
        }
        if (!this.isAllowedOrigin(parsed) || blockedResourceTypes.has(req.resourceType())) {
          this.blockedRequests++;
          await route.abort("blockedbyclient");
          return;
        }
        // Inspect document HTTP redirects hop-by-hop (maxRedirects: 0) so Chromium never leaks connections on 302 Location.
        if (req.resourceType() === "document" && req.method() === "GET") {
          let currentUrl = parsed.href;
          const forwardHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers())) {
            const lower = k.toLowerCase();
            if (lower !== "host" && lower !== "content-length") forwardHeaders[k] = v;
          }
          for (let hop = 0; hop <= 5; hop++) {
            let hopResp: Awaited<ReturnType<PlaywrightPage["request"]["fetch"]>>;
            try {
              hopResp = await activePage.request.fetch(currentUrl, {
                maxRedirects: 0,
                timeout: this.timeoutMs,
                headers: forwardHeaders,
              });
            } catch {
              await route.abort("failed");
              return;
            }
            const loc = hopResp.headers().location;
            if (hopResp.status() >= 300 && hopResp.status() < 400 && loc) {
              let nextUrl: URL;
              try {
                nextUrl = new URL(loc, currentUrl);
              } catch {
                this.blockedRequests++;
                await route.abort("blockedbyclient");
                return;
              }
              if (isChallengeRedirect(nextUrl)) {
                redirectedToChallenge = true;
                await route.abort("blockedbyclient");
                return;
              }
              if (!this.isAllowedOrigin(nextUrl)) {
                this.blockedRequests++;
                await route.abort("blockedbyclient");
                return;
              }
              currentUrl = nextUrl.href;
              continue;
            }
            const cleanHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(hopResp.headers())) {
              const lower = k.toLowerCase();
              if (lower !== "content-encoding" && lower !== "content-length" && lower !== "transfer-encoding")
                cleanHeaders[k] = v;
            }
            const rawBody = await hopResp.body();
            await route.fulfill({
              status: hopResp.status(),
              headers: cleanHeaders,
              body: rawBody,
            });
            return;
          }
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      });

      let response: Awaited<ReturnType<PlaywrightPage["goto"]>>;
      try {
        response = await page.goto(targetUrl.href, {
          waitUntil: "domcontentloaded",
          timeout: this.timeoutMs,
        });
      } catch (error) {
        if (redirectedToChallenge) {
          return { status: 403, contentType: "text/html", bytes: Buffer.from("ebay_challenge_redirect") };
        }
        throw error;
      }
      if (aborted) throw new TransportReadError("worker_shutdown", 0);
      if (redirectedToChallenge) {
        return { status: 403, contentType: "text/html", bytes: Buffer.from("ebay_challenge_redirect") };
      }

      let finalUrl: URL | null = null;
      try {
        finalUrl = new URL(page.url());
      } catch {
        finalUrl = null;
      }
      if (finalUrl && isChallengeRedirect(finalUrl)) {
        return { status: 403, contentType: "text/html", bytes: Buffer.from("ebay_challenge_redirect") };
      }
      const status = response?.status() ?? 200;
      const headers = response?.headers() ?? {};
      let retryAfterSeconds: number | undefined;
      if ((status === 429 || status === 503) && typeof headers["retry-after"] === "string") {
        const rawRetry = headers["retry-after"];
        const delay = /^\d+$/.test(rawRetry)
          ? Number(rawRetry)
          : Math.ceil((Date.parse(rawRetry) - this.clock()) / 1000);
        if (Number.isSafeInteger(delay) && delay >= 1 && delay <= 86400) retryAfterSeconds = delay;
      }

      if (status === 200 && this.waitForSelector) {
        await page
          .waitForSelector(this.waitForSelector, { timeout: Math.min(3000, this.timeoutMs) })
          .catch(() => {});
      }
      if (aborted) throw new TransportReadError("worker_shutdown", 0);

      const html = await page.content();
      const bytes = Buffer.from(html, "utf8");
      if (bytes.byteLength > this.maxPageBytes) {
        throw new TransportReadError("response_exceeds_budget", bytes.byteLength);
      }
      return {
        status,
        contentType: headers["content-type"] ?? "text/html; charset=utf-8",
        bytes,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }
}
