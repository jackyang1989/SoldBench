import type { AuthService } from "@soldbench/auth";
import type { MarketplaceSite, SiteCurrency } from "@soldbench/core";
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

type PreviewLocale = "en-GB" | "de" | "fr" | "it" | "es" | "en-CA" | "fr-CA" | "en-AU";

const PREVIEW_PAGES: Record<
  PreviewLocale,
  {
    siteId: MarketplaceSite;
    currency: SiteCurrency;
    timeZone: string;
    title: string;
    gateBanner: string;
  }
> = {
  "en-GB": {
    siteId: "ebay_uk",
    currency: "GBP",
    timeZone: "Europe/London",
    title: "SoldBench United Kingdom (eBay UK · GBP)",
    gateBanner:
      "Offline preview mode — UK site release requires approved source rights, localisation review, legal sign-off, and unit economics (G0–G5).",
  },
  de: {
    siteId: "ebay_de",
    currency: "EUR",
    timeZone: "Europe/Berlin",
    title: "SoldBench Deutschland (eBay DE · EUR)",
    gateBanner:
      "Vorschau im Offline-Modus — Produktive Freigabe erfordert abgeschlossene Quellen-, Übersetzungs-, Rechts- und Kostenprüfung (G0–G5).",
  },
  fr: {
    siteId: "ebay_fr",
    currency: "EUR",
    timeZone: "Europe/Paris",
    title: "SoldBench France (eBay FR · EUR)",
    gateBanner:
      "Aperçu hors ligne — le lancement en France exige l'approbation des droits source, de la traduction, de la conformité et des coûts (G0–G5).",
  },
  it: {
    siteId: "ebay_it",
    currency: "EUR",
    timeZone: "Europe/Rome",
    title: "SoldBench Italia (eBay IT · EUR)",
    gateBanner:
      "Anteprima offline — il rilascio per l'Italia richiede diritti di fonte, traduzione, revisione legale ed economica (G0–G5).",
  },
  es: {
    siteId: "ebay_es",
    currency: "EUR",
    timeZone: "Europe/Madrid",
    title: "SoldBench España (eBay ES · EUR)",
    gateBanner:
      "Vista previa sin conexión — la apertura en España requiere derechos de fuente, traducción, revisión legal y economía unitaria (G0–G5).",
  },
  "en-CA": {
    siteId: "ebay_ca",
    currency: "CAD",
    timeZone: "America/Toronto",
    title: "SoldBench Canada English (eBay CA · CAD)",
    gateBanner:
      "Offline preview mode — eBay Canada release requires independent source rights, EN-CA & FR-CA localisation sign-off, and unit economics (G0–G5).",
  },
  "fr-CA": {
    siteId: "ebay_ca",
    currency: "CAD",
    timeZone: "America/Toronto",
    title: "SoldBench Canada Français (eBay CA · CAD)",
    gateBanner:
      "Aperçu hors ligne — la mise en service au Canada exige des droits de source distincts, l'adaptation fr-CA/en-CA et la validation économique (G0–G5).",
  },
  "en-AU": {
    siteId: "ebay_au",
    currency: "AUD",
    timeZone: "Australia/Sydney",
    title: "SoldBench Australia (eBay AU · AUD)",
    gateBanner:
      "Offline preview mode — Australian launch requires independent source clearance, en-AU GST semantics sign-off, and unit economics (G0–G5).",
  },
};

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderLocalizedSitePage(locale: PreviewLocale): string {
  const dict = regionalMessages[locale];
  const cfg = PREVIEW_PAGES[locale];
  const samplePrice = formatRegionalMoney(locale, 14999, cfg.currency);
  const sampleDay = formatRegionalDate(locale, "2026-11-21T00:00:00.000Z", cfg.timeZone, "day");
  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(cfg.title)}</title>
  <link rel="stylesheet" href="/assets/soldbench.css">
</head>
<body>
  <header class="site-header"><div class="wrap"><strong>SoldBench</strong> · <a href="/account/sites">${escapeHtml(dict["site.heading"])}</a></div></header>
  <main class="wrap section">
    <article class="card stack">
      <h1>${escapeHtml(cfg.title)}</h1>
      <p class="notice">${escapeHtml(cfg.gateBanner)}</p>
      <dl>
        <dt>${escapeHtml(dict["site.selector_label"])}</dt><dd><code>${cfg.siteId}</code></dd>
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
 * Mount V1.5 (`/v1/sites*`, `/v1/fx-rates` for US/UK/DE) and V2 (`/v1/global-sites*`, `/v1/global-fx-rates`
 * covering FR/IT/ES/CA/AU + CAD/AUD) regional site routes and localized preview HTML pages (`TASK-049`, `TASK-055`).
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
    credits_charged: 0 as const,
  });

  // Legacy V1.5 endpoints (frozen to US/UK/DE & USD/GBP/EUR for OpenAPI compatibility)
  app.get("/v1/sites", async (c) => {
    return c.json({ data: await service().regional.listSites(false), meta: meta(c) });
  });

  app.get("/v1/sites/:site/localization", async (c) => {
    const locale = c.req.query("locale");
    return c.json({
      data: await service().regional.getSiteLocalization(c.req.param("site"), locale, true),
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
      data: await service().regional.listFxSnapshots(base, quote, true),
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
    const result = await service().regional.querySiteSoldPreview(
      actor,
      {
        site: c.req.param("site"),
        q,
        window_days: windowDays,
        price_basis: c.req.query("price_basis"),
        condition: c.req.query("condition"),
        compare_currency: c.req.query("compare_currency") as SiteCurrency | undefined,
      },
      true,
    );
    return c.json({ data: result, meta: meta(c) });
  });

  // Additive V2 global sites endpoints (all 8 sites US/UK/DE/FR/IT/ES/CA/AU, CAD/AUD, 10 locales)
  app.get("/v1/global-sites", async (c) => {
    return c.json({ data: await service().regional.listSites(true), meta: meta(c) });
  });

  app.get("/v1/global-sites/:site/localization", async (c) => {
    const locale = c.req.query("locale");
    return c.json({
      data: await service().regional.getSiteLocalization(c.req.param("site"), locale, false),
      meta: meta(c),
    });
  });

  app.get("/v1/global-fx-rates", async (c) => {
    const base = c.req.query("base") as SiteCurrency | undefined;
    const quote = c.req.query("quote") as SiteCurrency | undefined;
    const allowed = ["USD", "GBP", "EUR", "CAD", "AUD"];
    if (base && !allowed.includes(base))
      throw new AppError("invalid_parameter", 400, "base must be USD, GBP, EUR, CAD, or AUD.");
    if (quote && !allowed.includes(quote))
      throw new AppError("invalid_parameter", 400, "quote must be USD, GBP, EUR, CAD, or AUD.");
    return c.json({
      data: await service().regional.listFxSnapshots(base, quote, false),
      meta: meta(c),
    });
  });

  app.get("/v1/global-sites/:site/sold-preview", async (c) => {
    const actor = await identity(c, "sold:read");
    const q = c.req.query("q") ?? "";
    const rawWindow = c.req.query("window_days");
    let windowDays: number | undefined;
    if (rawWindow !== undefined) {
      if (!/^\d+$/.test(rawWindow))
        throw new AppError("invalid_parameter", 400, "window_days must be an integer.");
      windowDays = Number(rawWindow);
    }
    const result = await service().regional.querySiteSoldPreview(
      actor,
      {
        site: c.req.param("site"),
        q,
        window_days: windowDays,
        price_basis: c.req.query("price_basis"),
        condition: c.req.query("condition"),
        compare_currency: c.req.query("compare_currency") as SiteCurrency | undefined,
      },
      false,
    );
    return c.json({ data: result, meta: meta(c) });
  });

  for (const locale of Object.keys(PREVIEW_PAGES) as PreviewLocale[]) {
    app.get(`/${locale}/sites`, (c) => c.html(renderLocalizedSitePage(locale)));
  }
}
