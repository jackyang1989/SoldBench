import type { AuthService } from "@soldbench/auth";
import type { SiteCurrency } from "@soldbench/core";
import { type QueryService, RegionalSiteService } from "@soldbench/query";
import {
  AppError,
  type Config,
  formatRegionalDate,
  formatRegionalMoney,
  regionalMessages,
} from "@soldbench/shared";
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";

type Env = { Variables: { requestId: string } };

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderLocalizedSitePage(locale: "en-GB" | "de"): string {
  const dict = regionalMessages[locale];
  const siteId = locale === "de" ? "ebay_de" : "ebay_uk";
  const currency = locale === "de" ? "EUR" : "GBP";
  const timeZone = locale === "de" ? "Europe/Berlin" : "Europe/London";
  const samplePrice = formatRegionalMoney(locale, 14999, currency);
  const sampleDay = formatRegionalDate(locale, "2026-11-21T00:00:00.000Z", timeZone, "day");
  const title =
    locale === "de" ? "SoldBench Deutschland (eBay DE · EUR)" : "SoldBench United Kingdom (eBay UK · GBP)";
  const gateBanner =
    locale === "de"
      ? "Vorschau im Offline-Modus — Produktive Freigabe erfordert abgeschlossene Quellen-, Übersetzungs-, Rechts- und Kostenprüfung (G0–G5)."
      : "Offline preview mode — UK site release requires approved source rights, localisation review, legal sign-off, and unit economics (G0–G5).";
  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/assets/soldbench.css">
</head>
<body>
  <header class="site-header"><div class="wrap"><strong>SoldBench</strong> · <a href="/account/sites">${escapeHtml(dict["site.heading"])}</a></div></header>
  <main class="wrap section">
    <article class="card stack">
      <h1>${escapeHtml(title)}</h1>
      <p class="notice">${escapeHtml(gateBanner)}</p>
      <dl>
        <dt>${escapeHtml(dict["site.selector_label"])}</dt><dd><code>${siteId}</code></dd>
        <dt>${escapeHtml(dict["site.shipping_label"])}</dt><dd>${escapeHtml(dict["site.tax_disclosure"])}</dd>
        <dt>${escapeHtml(dict["site.currency_notice"])}</dt><dd>${escapeHtml(samplePrice)} · ${escapeHtml(sampleDay)}</dd>
      </dl>
      <p>${escapeHtml(dict["site.mode_notice"])}</p>
      <footer><small>${escapeHtml(dict["site.legal_imprint"])} · ${escapeHtml(dict["site.legal_privacy"])}</small></footer>
    </article>
  </main>
</body>
</html>`;
}

/**
 * Mount V1.5 regional US/UK/DE site metadata, localization catalogs, FX evidence snapshots,
 * and currency-isolated sold-price preview routes (`/v1/sites*`, `/v1/fx-rates`).
 */
export function mountRegionalSites(
  app: Hono<Env>,
  _config: Config,
  auth?: AuthService,
  query?: QueryService,
  regionalSites?: RegionalSiteService,
) {
  const regional = regionalSites ?? (query ? new RegionalSiteService(query) : null);

  const service = () => {
    if (!query || !regional)
      throw new AppError("service_unavailable", 503, "Regional site service is not configured.");
    return { query, regional };
  };

  const identity = async (c: Context<Env>, scope = "sold:read") => {
    if (!auth) throw new AppError("unauthenticated", 401, "Sign in or provide an API key.");
    const bearer = c.req.header("Authorization");
    const cookie = getCookie(c, "soldbench_session");
    if (bearer && cookie) throw new AppError("invalid_parameter", 400, "Use one authentication method.");
    if (bearer) {
      const token = /^Bearer (\S+)$/.exec(bearer)?.[1];
      if (!token) throw new AppError("unauthenticated", 401, "Invalid authentication header.");
      const actor = await auth.bearerIdentity(token, scope);
      await service().query.rate(actor);
      return actor;
    }
    const actor = await auth.sessionIdentity(cookie ?? "");
    await service().query.rate(actor);
    return actor;
  };

  const meta = (c: Context<Env>) => ({
    request_id: c.get("requestId"),
    credits_charged: 0,
  });

  app.get("/v1/sites", async (c) => {
    return c.json({ data: await service().regional.listSites(), meta: meta(c) });
  });

  app.get("/v1/sites/:site/localization", async (c) => {
    const locale = c.req.query("locale");
    return c.json({
      data: await service().regional.getSiteLocalization(c.req.param("site"), locale),
      meta: meta(c),
    });
  });

  app.get("/v1/fx-rates", async (c) => {
    const base = c.req.query("base") as SiteCurrency | undefined;
    const quote = c.req.query("quote") as SiteCurrency | undefined;
    if (base && !["USD", "GBP", "EUR"].includes(base))
      throw new AppError("invalid_parameter", 400, "base must be USD, GBP, or EUR.");
    if (quote && !["USD", "GBP", "EUR"].includes(quote))
      throw new AppError("invalid_parameter", 400, "quote must be USD, GBP, or EUR.");
    return c.json({
      data: await service().regional.listFxSnapshots(base, quote),
      meta: meta(c),
    });
  });

  app.get("/v1/sites/:site/sold-preview", async (c) => {
    const actor = await identity(c, "sold:read");
    const q = c.req.query("q") ?? "";
    const rawWindow = c.req.query("window_days");
    let windowDays: number | undefined;
    if (rawWindow !== undefined) {
      if (!/^\d+$/.test(rawWindow))
        throw new AppError("invalid_parameter", 400, "window_days must be an integer.");
      windowDays = Number(rawWindow);
    }
    const basis = c.req.query("price_basis");
    const condition = c.req.query("condition");
    const compareCurrency = c.req.query("compare_currency") as SiteCurrency | undefined;
    const result = await service().regional.querySiteSoldPreview(actor, {
      site: c.req.param("site"),
      q,
      window_days: windowDays,
      price_basis: basis,
      condition,
      compare_currency: compareCurrency,
    });
    return c.json({ data: result, meta: meta(c) });
  });

  app.get("/en-GB/sites", (c) => c.html(renderLocalizedSitePage("en-GB")));
  app.get("/de/sites", (c) => c.html(renderLocalizedSitePage("de")));
}
