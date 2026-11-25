import { readFileSync } from "node:fs";
import type { Locale } from "@soldbench/shared";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type DocsView, Documentation } from "./developer.tsx";
import { Editorial, type EditorialView, editorialUrl } from "./editorial.tsx";
import { highlightCode } from "./highlight.tsx";
import {
  BrandLogo,
  fmtCondition,
  fmtFormat,
  fmtFormatClass,
  fmtMoney,
  fmtShipping,
  fmtSoldDate,
  HomeSections,
  type HomeShowcase,
  ProductThumbSvg,
  SiteFooter,
} from "./home.tsx";

export type { EditorialEntry, EditorialView } from "./editorial.tsx";
export type { HomeShowcase, HomeShowcaseComp } from "./home.tsx";

export const webCss = readFileSync(new URL("../src/site.css", import.meta.url), "utf8");
export const webClient = readFileSync(new URL("../src/site.js", import.meta.url), "utf8");

export const operationsPanels = [
  "overview",
  "users",
  "approvals",
  "incidents",
  "sources",
  "jobs",
  "billing",
  "recovery",
  "support",
  "audit",
  "settings",
  "monitoring",
  "api",
  "collector",
  "records",
  "rules",
  "coverage",
  "quality",
  "growth",
  "costs",
] as const;

const filters = [
  "q",
  "window_days",
  "price_basis",
  "condition",
  "sale_format",
  "allow_stale",
  "min_price_cents",
  "max_price_cents",
  "category",
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const webPages = [
  "/",
  "/search",
  "/research",
  "/login",
  "/register",
  "/verify-email",
  "/forgot-password",
  "/reset-password",
  "/account",
  "/account/queries",
  "/account/lookup",
  "/account/saved",
  "/account/batches",
  "/account/inventory",
  "/account/sites",
  "/account/marketplaces",
  "/account/cards",
  "/account/auctions",
  "/account/history",
  "/account/alerts",
  "/account/usage",
  "/account/logs",
  "/account/keys",
  "/account/security",
  "/account/billing",
  "/pricing",
  "/deletion-receipt",
  "/playground",
  "/support",
  "/categories",
  "/data-availability",
  "/guides",
  "/faq",
  "/methodology",
  "/agents",
  "/operations",
] as const;
type Page =
  | (typeof webPages)[number]
  | "/results"
  | "/share"
  | "/docs"
  | "/admin/content"
  | "/editorial"
  | "/404"
  | "/503";
type PublishedSection = { slug: string; title: string; body: string };
type SiteBlock = PublishedSection & { kind: string; target?: string };
type SharedSummary = {
  data_as_of: string;
  expires_at: string;
  stats: {
    median_cents: number | null;
    p25_cents: number | null;
    p75_cents: number | null;
    n_price_verified: number;
  };
};

export function renderPage(
  locale: Locale,
  page: Page,
  url: URL,
  resultId?: string,
  shared?: SharedSummary,
  docs?: DocsView,
  sections: PublishedSection[] = [],
  blocks: SiteBlock[] = [],
  editorial?: EditorialView,
  homeShowcase: HomeShowcase | null = null,
): string {
  const zh = locale === "zh-CN";
  const t = (en: string, cn: string) => (zh ? cn : en);
  const prefix = zh ? "/zh-CN" : "";
  const link = (path: string) => prefix + path;
  const draft = new URLSearchParams();
  for (const key of filters) {
    const value = url.searchParams.get(key);
    if (value && value.length <= 120) draft.set(key, value);
  }
  for (const key of ["result", "job", "saved"]) {
    const value = url.searchParams.get(key);
    if (value && uuid.test(value)) draft.set(key, value);
  }
  if (page === "/account/billing") {
    const checkout = url.searchParams.get("checkout");
    if (checkout && uuid.test(checkout)) draft.set("checkout", checkout);
    const plan = url.searchParams.get("plan");
    if (plan && /^[a-z][a-z0-9_]{0,39}$/.test(plan)) draft.set("plan", plan);
  }
  if (resultId) draft.set("result", resultId);
  const query = draft.size ? `?${draft}` : "";
  const resume = (path: string) => link(path) + query;
  const operationParams = new URLSearchParams();
  if (page === "/operations") {
    for (const key of ["account", "charge", "incident", "source", "record"]) {
      const value = url.searchParams.get(key);
      if (value && uuid.test(value)) operationParams.set(key, value);
    }
    const days = url.searchParams.get("days");
    if (days && /^[1-9][0-9]?$/.test(days) && Number(days) <= 30) operationParams.set("days", days);
  }
  const failedPath = zh ? url.pathname.slice("/zh-CN".length) || "/" : url.pathname;
  const other =
    page === "/operations"
      ? (zh ? "" : "/zh-CN") +
        (zh ? url.pathname.slice("/zh-CN".length) : url.pathname) +
        (operationParams.size ? `?${operationParams}` : "")
      : page === "/503"
        ? (zh ? "" : "/zh-CN") + (/^\/(?:\/|share\/)/.test(failedPath) ? "/" : failedPath)
        : editorial
          ? (zh ? "" : "/zh-CN") + editorial.path + (editorial.path === "/worth" ? query : "")
          : docs
            ? docs.alternate
            : page === "/share" || page === "/admin/content"
              ? `${url.pathname}?lang=${zh ? "en" : "zh-CN"}`
              : (zh ? "" : "/zh-CN") + (resultId ? `/results/${resultId}` : page) + query;
  const priceDraft = (key: string) => {
    const value = draft.get(key);
    if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return "";
    const cents = String(Number(value)).padStart(3, "0");
    return `${cents.slice(0, -2)}.${cents.slice(-2)}`;
  };
  const headings: Partial<Record<Page, [string, string]>> = {
    "/": ["eBay sold prices, with evidence", "eBay 成交价，附可核查的证据"],
    "/login": ["Sign in", "登录"],
    "/register": ["Create an account", "创建账户"],
    "/verify-email": ["Verify your email", "验证邮箱"],
    "/forgot-password": ["Reset your password", "找回密码"],
    "/reset-password": ["Choose a new password", "设置新密码"],
    "/account": ["Overview", "账户概览"],
    "/account/queries": ["Research history", "研究历史"],
    "/account/lookup": ["Image & Barcode Lookup", "图片与条码查价"],
    "/account/saved": ["Saved research", "已保存的研究"],
    "/account/batches": ["Batch lookup & CSV", "批量查价与 CSV"],
    "/account/inventory": ["Inventory valuation", "库存估值"],
    "/account/sites": ["Regional sites (UK / DE)", "区域站点（英国 / 德国）"],
    "/account/marketplaces": ["Second marketplaces (Mercari US)", "第二平台（Mercari US）"],
    "/account/cards": ["Cards & Grading (TCG / PSA)", "卡牌与评级（TCG / PSA）"],
    "/account/auctions": ["Auction sales (Goldin US)", "拍卖成交（Goldin US）"],
    "/account/history": ["Archive history", "历史档案研究"],
    "/account/alerts": ["Alerts & Webhooks", "提醒与 Webhook"],
    "/account/usage": ["Usage", "用量"],
    "/account/logs": ["Request logs", "请求日志"],
    "/account/keys": ["API keys", "API 密钥"],
    "/account/security": ["Account security", "账户安全"],
    "/account/billing": ["Billing", "账单"],
    "/pricing": ["Pricing and credits", "定价与额度"],
    "/deletion-receipt": ["Deletion receipt", "删除回执"],
    "/playground": ["API Playground", "API 调试台"],
    "/categories": ["Research categories", "研究类目"],
    "/data-availability": ["Data availability", "数据可用性"],
    "/share": ["Shared price research", "分享的成交研究"],
    "/support": ["Support", "支持"],
    "/guides": ["Research guides", "研究指南"],
    "/faq": ["Frequently asked questions", "常见问题"],
    "/methodology": ["Price methodology", "价格研究方法"],
    "/agents": ["Agents and MCP", "Agent 与 MCP"],
    "/operations": ["Operations", "运营中心"],
    "/admin/content": ["Content studio", "内容中心"],
    "/503": ["Service temporarily unavailable", "服务暂时不可用"],
  };
  const title =
    editorial?.title ?? docs?.current.title ?? t(...(headings[page] ?? ["Search sold prices", "查询成交价"]));
  const isDestination = (target: string | undefined): target is string =>
    !!target &&
    ((webPages as readonly string[]).includes(target) ||
      ["/docs", "/blog", "/about", "/changelog"].includes(target));
  const browseableLinks = (kind: "navigation" | "footer") =>
    blocks.flatMap((block) =>
      block.kind === kind && isDestination(block.target) ? (
        <a key={block.slug} href={link(block.target)}>
          {block.title}
        </a>
      ) : (
        []
      ),
    );
  const navigation = browseableLinks("navigation");
  const footer = browseableLinks("footer");
  const isNavOn = (target: string) =>
    page === target ||
    editorial?.path === target ||
    (target === "/docs" && Boolean(docs)) ||
    (target === "/account" && page.startsWith("/account"));
  const nav = (
    <>
      {navigation}
      <a className={isNavOn("/search") ? "on" : undefined} href={link("/search")}>
        {t("Search", "查价")}
      </a>
      <a className={isNavOn("/pricing") ? "on" : undefined} href={link("/pricing")}>
        {t("Pricing", "定价")}
      </a>
      <a
        className={isNavOn("/docs") ? "on" : undefined}
        href={zh ? "/docs/zh-CN/quickstart" : "/docs/en/quickstart"}
      >
        {t("Docs", "文档")}
      </a>
      <a className={isNavOn("/agents") ? "on" : undefined} href={link("/agents")}>
        {t("Agents", "智能体")}
      </a>
      <a className={isNavOn("/alternatives") ? "on" : undefined} href={link("/alternatives")}>
        {t("Alternatives", "竞品对比")}
      </a>
      <a className={isNavOn("/account") ? "on" : undefined} href={link("/account")}>
        {t("Dashboard", "用户中心")}
      </a>
    </>
  );
  const examples = (
    <div className="chips">
      <span>{t("Sample queries", "示例搜索")}</span>
      {["Nintendo Switch", "Nintendo Switch OLED", "Game Boy Color"].map((q) => (
        <a className="chip" key={q} href={`${link("/search")}?${new URLSearchParams({ q })}`}>
          {q}
        </a>
      ))}
    </div>
  );
  const searchBox = (
    <div className="searchbox">
      <label htmlFor="q" className="sr-only">
        {t("Search sold prices", "查询成交价")}
      </label>
      <input
        id="q"
        required
        name="q"
        maxLength={120}
        defaultValue={draft.get("q") ?? ""}
        placeholder={t("e.g. Nintendo Switch OLED", "例如 Nintendo Switch OLED")}
      />
      <button className="btn brand" type="submit">
        {t("Search", "查价")}
      </button>
    </div>
  );
  const market = (
    <p className="small market">
      {t("eBay US · USD", "eBay 美国站 · 美元")}.{" "}
      {t("Sample results use synthetic records.", "示例结果使用合成记录。")}
    </p>
  );
  const status = <p className="notice" data-status="" aria-live="polite" hidden />;
  const research =
    page === "/search" || page === "/research" || page === "/results" || page === "/playground";
  const auth = ["/login", "/register", "/verify-email", "/forgot-password", "/reset-password"].includes(page);
  let content: ReactNode;
  if (page === "/503") {
    content = (
      <section className="wrap section editorial">
        <h1>{title}</h1>
        <p>{t("Reload this page in a few moments.", "请稍后重新加载当前页面。")}</p>
        <a className="btn ghost" href={link("/docs")}>
          {t("Open documentation", "打开开发文档")}
        </a>
      </section>
    );
  } else if (page === "/") {
    content = (
      <HomeSections
        locale={locale}
        link={link}
        searchBox={searchBox}
        examples={examples}
        market={market}
        status={status}
        sections={sections}
        blocks={blocks}
        homeShowcase={homeShowcase}
      />
    );
  } else if (editorial) {
    content = <Editorial view={editorial} locale={locale} query={draft.get("q") ?? undefined} />;
  } else if (docs) {
    content = <Documentation view={docs} locale={locale} />;
  } else if (page === "/share") {
    const currency = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      currencyDisplay: "code",
    });
    const money = (cents: number | null) => (cents === null ? "—" : currency.format(cents / 100));
    content = (
      <section className="wrap workbench">
        <h1>{title}</h1>
        {shared ? (
          <div className="live-card result-card">
            <h2 className="live-head">{t("Historical price summary", "历史价格摘要")}</h2>
            <div className="result-metrics">
              <div>
                <b>{t("Median", "中位价")}</b>
                <strong>{money(shared.stats.median_cents)}</strong>
              </div>
              <div>
                <b>{t("Typical range", "典型区间")}</b>
                <strong>{`${money(shared.stats.p25_cents)} – ${money(shared.stats.p75_cents)}`}</strong>
              </div>
              <div>
                <b>{t("Verified prices", "已核验价格")}</b>
                <strong>{shared.stats.n_price_verified}</strong>
              </div>
            </div>
            <p className="summary-note">
              {t("Data as of", "数据时点")} <time dateTime={shared.data_as_of}>{shared.data_as_of}</time>
            </p>
            <p className="summary-note">
              {t("Link expires", "链接过期")} <time dateTime={shared.expires_at}>{shared.expires_at}</time>
            </p>
            <p className="summary-note">
              {t("Synthetic samples from the offline workspace.", "本机离线工作区的合成样本。")}
            </p>
          </div>
        ) : (
          <p className="notice" data-kind="warning">
            {t("This share is unavailable.", "此分享已不可用。")}
          </p>
        )}
      </section>
    );
  } else if (page === "/data-availability") {
    const components = [
      {
        name: "API (/v1/sold & /v1/jobs)",
        desc: t("Research API and idempotent claim endpoints", "标准研究接口与原子领用结算服务"),
        state: t("Local operational", "本地运行中"),
        cls: "badge badge-green",
      },
      {
        name: t("Sold Listings Corpus", "已售样本语料库"),
        desc: t("Offline synthetic fixture source for local testing", "当前处于离线夹具演示模式"),
        state: t("Offline fixture", "离线演示"),
        cls: "badge badge-amber",
      },
      {
        name: t("Dashboard & Workbench", "网页研究与账户中心"),
        desc: t("SSR pages, exports, shares, and billing ledger", "服务端渲染页面、导出与账单流水"),
        state: t("Local operational", "本地运行中"),
        cls: "badge badge-green",
      },
      {
        name: t("Self-Hosted Collector", "自研采集管线"),
        desc: t(
          "Disabled in offline CI/dev defaults until G0 clearance",
          "离线默认禁用（等待 G0 与来源准入）",
        ),
        state: t("Disabled offline", "离线禁用"),
        cls: "badge badge-gray",
      },
      {
        name: t("Billing & Webhooks", "支付与额度账本"),
        desc: t(
          "Stripe/PayPal adapters in offline sandbox verification",
          "Stripe 主路径与 PayPal 离线沙盒校验",
        ),
        state: t("Sandbox mode", "沙盒模式"),
        cls: "badge badge-amber",
      },
    ];
    const freshnessRows = [
      [t("Graded cards", "集换与评级卡牌"), "30 / 90 days", t("Offline fixture", "离线演示样本")],
      [t("Sneakers", "潮流球鞋"), "30 / 90 days", t("Offline fixture", "离线演示样本")],
      [t("Watches", "收藏腕表"), "30 / 90 days", t("Offline fixture", "离线演示样本")],
      [t("Video games", "电子游戏与主机"), "30 / 90 days", t("Offline fixture", "离线演示样本")],
      [t("GPUs & hardware", "显卡与硬件"), "30 / 90 days", t("Offline fixture", "离线演示样本")],
      [t("Collectibles", "潮流玩具与收藏品"), "30 / 90 days", t("Offline fixture", "离线演示样本")],
    ];

    content = (
      <>
        <section className="page-head">
          <div className="wrap">
            <p className="eyebrow">{t("DATA AVAILABILITY · STATUS", "数据可用性与运行状态")}</p>
            <h1>{title}</h1>
            <p className="sub">
              {t(
                "Live source readiness, freshness windows, and outage boundaries. Missing or unverified metrics stay explicit instead of synthetic SLA claims.",
                "展示支持类目数据源状态、时间窗口及断源边界说明；未接通或未实测指标不填虚假 SLA 数字。",
              )}
            </p>
            <div className="actions mt-16">
              <span className="badge badge-amber">
                {t("Offline fixture mode · Not production live", "本地离线演示模式 · 非生产实时环境")}
              </span>
              <a className="btn ghost btn-sm" href={link("/categories")}>
                {t("Research categories", "研究类目")}
              </a>
              <a className="btn brand btn-sm" href={link("/search")}>
                {t("Open research workbench", "打开研究工作台")}
              </a>
            </div>
            {status}
          </div>
        </section>
        <section className="blk blk-tight-top">
          <div className="wrap">
            <div className="grid3 eq" data-results="" />
            <div className="grid2 mt-22">
              <div className="card">
                <h2>{t("Component readiness", "核心模块就绪状态")}</h2>
                <div className="mt-12">
                  {components.map((comp) => (
                    <div className="status-row" key={comp.name}>
                      <div>
                        <b>{comp.name}</b>
                        <p className="small">{comp.desc}</p>
                      </div>
                      <span className={comp.cls}>{comp.state}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="grid-stack">
                <div className="card">
                  <h3>{t("How freshness works", "数据时效性窗口规则")}</h3>
                  <p>
                    {t(
                      "Every category snapshot tracks its latest verified observation timestamp. Candidate freshness targets fresh (≤24h) and explicit stale consent (≤72h, 0 credits); expired sources never masquerade as current prices.",
                      "每个类目均绑定最近一次有效观察时间戳：候选新鲜窗口为 ≤24h，过期延展 ≤72h 需显式同意且免费；超出窗口或撤权数据源绝不继续充当当前价。",
                    )}
                  </p>
                </div>
                <div className="card mt-18">
                  <h3>{t("Rights & immediate revocation", "授权与即时撤权保护")}</h3>
                  <p>
                    {t(
                      "Permissions for collection, storage, statistics, display, and image delivery are evaluated live against permission epochs on every read, export, and share link.",
                      "网页查询、导出文件、外链分享与主图代理读取每次都会核验当前来源许可及权限纪元，撤权时先拒绝访问再清理副本。",
                    )}
                  </p>
                </div>
              </div>
            </div>

            <h2 className="serif section-h2 mt-36">{t("Freshness by category", "各类目可用性概览")}</h2>
            <div className="live-card mt-12">
              <div className="table-scroll">
                <div className="dtable">
                  <div className="dt-h">
                    <span className="dt-c">{t("Category", "研究类目")}</span>
                    <span className="dt-c">{t("Supported windows", "时间窗口")}</span>
                    <span className="dt-c">{t("Readiness", "当前状态")}</span>
                  </div>
                  {freshnessRows.map(([name, win, state]) => (
                    <div className="dt-r" key={name}>
                      <span className="dt-c">
                        <b>{name}</b>
                      </span>
                      <span className="dt-c">{win}</span>
                      <span className="dt-c">
                        <span className="badge badge-amber">{state}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>
      </>
    );
  } else if (page === "/categories") {
    const categoryCatalog = [
      {
        slug: "graded-cards",
        name: t("Graded cards", "集换与评级卡牌"),
        attrs: t(
          "Grader, grade, set, card number, variant, language",
          "评级机构、分数、系列、卡号、版本、语言",
        ),
        sample: "18,240",
        quality: t("Strong", "高完整度"),
        badge: "badge badge-green",
        updated: "Nov 2026",
        chips: ["Charizard PSA 10", "Pokemon Base Set PSA 10"],
      },
      {
        slug: "sneakers",
        name: t("Sneakers", "潮流球鞋"),
        attrs: t("SKU, colorway, size, condition", "货号、配色、尺码、全新/二手"),
        sample: "9,860",
        quality: t("Good", "良好"),
        badge: "badge badge-amber",
        updated: "Nov 2026",
        chips: ["Air Jordan 1 Retro High OG", "New Balance 550"],
      },
      {
        slug: "watches",
        name: t("Watches", "收藏腕表"),
        attrs: t("Reference, case size, materials, box & papers", "型号编码、表径、材质、盒证状态"),
        sample: "6,420",
        quality: t("Good", "良好"),
        badge: "badge badge-amber",
        updated: "Nov 2026",
        chips: ["Rolex Datejust 36mm", "Omega Speedmaster"],
      },
      {
        slug: "video-games",
        name: t("Video games", "电子游戏与主机"),
        attrs: t("Model, platform, region, completeness (CIB / loose)", "主机型号、平台、区版、盒说完整度"),
        sample: "7,915",
        quality: t("Strong", "高完整度"),
        badge: "badge badge-green",
        updated: "Nov 2026",
        chips: ["Nintendo Switch OLED", "Game Boy Color CIB"],
      },
      {
        slug: "gpus-hardware",
        name: t("GPUs & hardware", "显卡与硬件"),
        attrs: t("Model, memory capacity, brand, condition", "核心型号、显存容量、品牌、成色"),
        sample: "5,308",
        quality: t("Strong", "高完整度"),
        badge: "badge badge-green",
        updated: "Nov 2026",
        chips: ["RTX 4070", "Steam Deck OLED"],
      },
      {
        slug: "collectibles",
        name: t("Collectibles", "潮流玩具与收藏品"),
        attrs: t("Type, variant, edition, grading", "品名、限定版本、编号与完整度"),
        sample: "4,672",
        quality: t("Good", "良好"),
        badge: "badge badge-amber",
        updated: "Nov 2026",
        chips: ["LEGO retired set", "Funko Pop exclusive"],
      },
    ];
    content = (
      <>
        <section className="page-head">
          <div className="wrap">
            <p className="eyebrow">
              {page === "/categories" ? t("CATEGORIES", "开放类目") : t("DATA AVAILABILITY", "数据可用性")}
            </p>
            <h1>{title}</h1>
            <p className="sub">
              {page === "/categories"
                ? t(
                    "Each category declares the strong attributes it matches on, its supported windows (30 / 90 days), and live source readiness.",
                    "每个类目均明确声明可匹配的强属性字段、支持时间窗口（30/90 天）及实时数据可用性。",
                  )
                : t(
                    "Live freshness and ingestion visibility across supported marketplace categories.",
                    "查看支持类目的实时更新状态与数据可用性监测指标。",
                  )}
            </p>
            {market}
            <div className="actions mt-18">
              <a
                className="btn ghost"
                href={link(page === "/categories" ? "/data-availability" : "/categories")}
              >
                {page === "/categories"
                  ? t("Data availability", "数据可用性")
                  : t("Research categories", "研究类目")}
              </a>
              <a className="btn brand" href={link("/search")}>
                {t("Open research workbench", "打开研究工作台")}
              </a>
            </div>
            {status}
          </div>
        </section>
        <section className="blk blk-tight-top">
          <div className="wrap">
            <div className="grid3 eq" data-results="" />
            <h2 className="serif mt-30">{t("Supported research taxonomy", "支持的研究类目与核心属性")}</h2>
            <div className="grid3 eq mt-16">
              {categoryCatalog.map((cat) => (
                <div className="card" key={cat.slug}>
                  <h3>
                    <a href={link("/search")}>{cat.name}</a>
                  </h3>
                  <p className="mt-8">
                    <b>{t("Supported attributes:", "匹配属性：")}</b> {cat.attrs}
                  </p>
                  <p>
                    <b>{t("Windows:", "时间窗口：")}</b> 30 / 90 days · <b>{t("Benchmark:", "基线样本：")}</b>{" "}
                    {cat.sample}
                  </p>
                  <p>
                    <b>{t("Quality:", "覆盖质量：")}</b> <span className={cat.badge}>{cat.quality}</span>
                  </p>
                  <div className="chips mt-12">
                    {cat.chips.map((ch) => (
                      <a
                        key={ch}
                        className="chip"
                        href={`${link("/search")}?${new URLSearchParams({ q: ch })}`}
                      >
                        {ch}
                      </a>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <h2 className="serif mt-36">{t("All categories, in one table", "全部类目汇总表")}</h2>
            <div className="live-card mt-12">
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{t("Category", "类目")}</th>
                      <th>{t("Supported attributes", "匹配属性")}</th>
                      <th>{t("Windows", "时间窗口")}</th>
                      <th>{t("Sample tier", "样本参考")}</th>
                      <th>{t("Quality", "质量评级")}</th>
                      <th>{t("Updated", "更新周期")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {categoryCatalog.map((cat) => (
                      <tr key={`row-${cat.slug}`}>
                        <td>
                          <b>{cat.name}</b>
                        </td>
                        <td>{cat.attrs}</td>
                        <td>30 / 90 days</td>
                        <td>{cat.sample}</td>
                        <td>
                          <span className={cat.badge}>{cat.quality}</span>
                        </td>
                        <td>{cat.updated}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>
      </>
    );
  } else if (page === "/methodology") {
    const methSections = [
      {
        id: "meth-1",
        heading: t('What a "sold comp" is', "什么是可核验的“已售样本”"),
        body: t(
          "A comp is a completed sale: money changed hands at a knowable price. Live asking listings measure seller hopes, never verified clearing value, and never enter a SoldBench statistic.",
          "可比成交是指真金白银换手完成、成交价明确已知的记录。在售挂牌出价只代表卖家预期，绝不混入任何 SoldBench 中心统计口径。",
        ),
      },
      {
        id: "meth-2",
        heading: t("How the median is computed", "中位价、四分位与截尾均价算法"),
        body: t(
          "We start from the full qualified candidate snapshot stored in integer USD cents. The headline number is the Type 7 median, paired with the P25–P75 typical range and 5% trimmed mean (removing floor(5% × n) values from each tail). Fewer than 8 verified sales return null rather than publishing a misleading estimate.",
          "统计始终基于完整合格快照并采用整数美元分计算。主指标使用 Type 7 分位数中位价，配合 P25–P75 典型区间以及两端各切除 floor(5% × n) 条的 5% 截尾均价；有效核验成交少于 8 条时强制置空，绝不给出误导估计。",
        ),
      },
      {
        id: "meth-4",
        heading: t("The five quality dimensions", "五维可核验质量结构"),
        body: t(
          "Every result reports structured signals for attribute match, price verifiability share, sample tier (insufficient <8, limited 8–29, sufficient ≥30), comparable coverage ratio, and data recency. quality.total_score stays intentionally null so variation is never hidden behind a synthetic letter grade.",
          "所有结果均拆解展示强属性匹配率、核验实价占比、样本充分性档位（<8 不足、8–29 有限、≥30 充足）、可比覆盖率以及时效性。质量总分字段始终保持为 null，绝不用单一合成分遮掩样本风险。",
        ),
      },
      {
        id: "meth-6",
        heading: t("Coverage & freshness limits", "窗口边界与时效降级规则"),
        body: t(
          "Delivered research represents qualifying completed transactions observed in the 30-day or 90-day window on eBay US (USD), not full marketplace volume. Records outside the window, missing required shipping under a total-cost basis, or revoked by permission epoch are automatically excluded.",
          "结果体现指定窗口内符合条件的 eBay 美国站（USD）实际观测样本，而非平台全市场总销量。超出时间窗口、总价口径缺运费或所属数据源权限撤销的记录均会被即时阻断与剥离。",
        ),
      },
    ];
    content = (
      <>
        <section className="page-head">
          <div className="wrap">
            <p className="eyebrow">{t("METHODOLOGY", "方法论规范")}</p>
            <h1>
              {t("How SoldBench prices are ", "价格研究方法：")}
              <span className="kw">{t("made", "成交统计与核验规则")}</span>
            </h1>
            <div className="inshort mt-20">
              <b>{t("In short:", "核心摘要：")}</b>{" "}
              {t(
                "a SoldBench price is the median of verified, comparable, completed eBay US sales — computed in integer USD cents with Type 7 quantiles, with every exclusion rule exposed. Below 8 verified sales, no median is published.",
                "SoldBench 价格采用整数美元分与 Type 7 插值计算，并仅纳入可比且核验实价的 eBay US 已完成成交记录；核验样本少于 8 条时一律不发布中位价。",
              )}
            </div>
          </div>
        </section>
        <section className="blk blk-tight-top">
          <div className="wrap">
            <div className="meth-layout">
              <article className="docs-body">
                <h2 id={methSections[0]?.id}>{methSections[0]?.heading}</h2>
                <p>{methSections[0]?.body}</p>

                <h2 id={methSections[1]?.id}>{methSections[1]?.heading}</h2>
                <p>{methSections[1]?.body}</p>
                <p>
                  {t(
                    "Worked example: five verified prices ($49.99, $54.50, $61.00, $68.00, $72.00) have a raw midpoint of $61.00 — yet at n = 5 SoldBench withholds the center statistic entirely, shows the observed min–max honestly, and charges 0 credits.",
                    "示例说明：5 条核验记录（$49.99 / $54.50 / $61.00 / $68.00 / $72.00）虽有 $61.00 数值中点，但因 n = 5 < 8，系统拒绝输出中心统计，仅展示实际观察起止区间且不扣费。",
                  )}
                </p>

                <h2 id="meth-3">{t("Price status layers", "价格可信度分层")}</h2>
                <div className="dtable">
                  <div className="dt-h">
                    <span className="dt-c">{t("Layer", "层级")}</span>
                    <span className="dt-c">{t("Meaning", "语义定义")}</span>
                    <span className="dt-c">{t("In statistics?", "纳入默认统计？")}</span>
                  </div>
                  <div className="dt-r">
                    <span className="dt-c">
                      <code>verified_actual</code>
                    </span>
                    <span className="dt-c">{t("Actual paid amount verified", "实付成交价已核验明确")}</span>
                    <span className="dt-c">
                      <span className="badge badge-green">{t("Yes", "纳入")}</span>
                    </span>
                  </div>
                  <div className="dt-r">
                    <span className="dt-c">
                      <code>unknown_best_offer</code>
                    </span>
                    <span className="dt-c">
                      {t("Best Offer accepted; amount undisclosed", "议价成立但真实成交价未公开")}
                    </span>
                    <span className="dt-c">
                      <span className="badge badge-gray">{t("Diagnostics only", "仅诊断")}</span>
                    </span>
                  </div>
                  <div className="dt-r">
                    <span className="dt-c">
                      <code>listing_only</code>
                    </span>
                    <span className="dt-c">{t("Display or asking price only", "仅标价或活跃在售价格")}</span>
                    <span className="dt-c">
                      <span className="badge badge-gray">{t("Never", "绝不纳入")}</span>
                    </span>
                  </div>
                </div>

                <h2 id={methSections[2]?.id}>{methSections[2]?.heading}</h2>
                <p>{methSections[2]?.body}</p>

                <h2 id="meth-5">{t("What we exclude, and why", "清洗剔除规则说明")}</h2>
                <div className="dtable cols-2">
                  <div className="dt-h">
                    <span className="dt-c">{t("Rule & Exclusion", "规则编号与排除对象")}</span>
                    <span className="dt-c">{t("Handling", "处理策略")}</span>
                  </div>
                  {[
                    [
                      t(
                        "R-01 Attribute mismatch (grade, model, capacity, size)",
                        "R-01 核心强属性冲突（评级分数、型号、容量或版本不符）",
                      ),
                      t("Excluded from comparable set", "移出可比样本集"),
                    ],
                    [
                      t(
                        "R-02 Multi-item lots, parts-only, or accessory listings",
                        "R-02 多件捆绑包、故障零件件或单卖配件",
                      ),
                      t("Excluded from comparable set", "移出可比样本集"),
                    ],
                    [
                      t(
                        "R-03 Duplicate observation of the same sale event",
                        "R-03 同一笔实际成交事件的多次重复采集观测",
                      ),
                      t("Deduplicated before statistics", "按成交事件去重合并"),
                    ],
                    [
                      t(
                        "R-04 Undisclosed Best Offer or missing required shipping",
                        "R-04 未公开实际接受价或总价口径缺必要运费",
                      ),
                      t("Isolated in diagnostics; never zero-filled", "隔离展示；绝不补零计算"),
                    ],
                    [
                      t(
                        "R-05 Statistical outlier beyond IQR bounds or out of window",
                        "R-05 超过 IQR 围栏离群记录或超出时间窗口",
                      ),
                      t("Flagged / trimmed with rule explanation", "保留解释或按 5% 截尾剔除"),
                    ],
                  ].map(([rule, act]) => (
                    <div className="dt-r" key={rule}>
                      <span className="dt-c">{rule}</span>
                      <span className="dt-c">{act}</span>
                    </div>
                  ))}
                </div>

                <h2 id={methSections[3]?.id}>{methSections[3]?.heading}</h2>
                <p>{methSections[3]?.body}</p>

                <h2 id="meth-7">{t("Corrections & data takedown", "异常纠偏与权利申诉")}</h2>
                <p>
                  {t(
                    "Found a comp that fails attribute parity or requires rights verification? Every inquiry is reviewed against immutable permission epochs and rule versions.",
                    "发现不应纳入样本的记录或需核实来源权限时，可通过工单提交对应 query_id 与记录编号进行逐条核查。",
                  )}
                </p>
                <div className="actions mt-16">
                  <a className="btn btn-brand" href={link("/search")}>
                    {t("Search sold prices", "查询成交价")}
                  </a>
                  <a className="btn btn-ghost" href={link("/support")}>
                    {t("Report a data issue", "报告数据问题")}
                  </a>
                </div>
              </article>

              <aside className="otp">
                <h4>{t("ON THIS PAGE", "本页目录")}</h4>
                <div className="otp-list">
                  <a href="#meth-1">{`1. ${t("What a sold comp is", "什么是已售样本")}`}</a>
                  <a href="#meth-2">{`2. ${t("Median & typical range", "中位价与典型区间")}`}</a>
                  <a href="#meth-3">{`3. ${t("Price status layers", "价格可信度分层")}`}</a>
                  <a href="#meth-4">{`4. ${t("Five quality dimensions", "五维质量结构")}`}</a>
                  <a href="#meth-5">{`5. ${t("Exclusion rules", "清洗排除规则")}`}</a>
                  <a href="#meth-6">{`6. ${t("Coverage & limits", "窗口与覆盖边界")}`}</a>
                  <a href="#meth-7">{`7. ${t("Corrections & takedown", "纠偏与反馈")}`}</a>
                </div>
                <div className="card mt-20">
                  <h3>{t("Try the workbench", "试用研究工作台")}</h3>
                  <p>
                    {t(
                      "Filter conditions, inspect exclusions, and recompute adjusted statistics locally.",
                      "现场调整成色过滤、查阅排除明细并重算本地排除均值。",
                    )}
                  </p>
                  <p className="mt-14">
                    <a className="btn btn-brand btn-sm" href={link("/search")}>
                      {t("Open workbench →", "打开工作台 →")}
                    </a>
                  </p>
                </div>
              </aside>
            </div>
          </div>
        </section>
      </>
    );
  } else if (page === "/agents") {
    const clientSetupMap: Array<[string, string, string]> = [
      [
        "claude",
        "Claude Code",
        `# Add SoldBench Hosted MCP server\nclaude mcp add --transport http soldbench https://soldbench.com/mcp \\\n  --header "Authorization: Bearer $SOLDBENCH_API_KEY"`,
      ],
      [
        "chatgpt",
        "ChatGPT",
        `# ChatGPT -> Settings -> Connectors -> Add custom connector\nName: SoldBench\nURL:  https://soldbench.com/mcp\nAuth: Bearer $SOLDBENCH_API_KEY`,
      ],
      [
        "cursor",
        "Cursor",
        `// ~/.cursor/mcp.json\n{\n  "mcpServers": {\n    "soldbench": {\n      "url": "https://soldbench.com/mcp",\n      "headers": { "Authorization": "Bearer $SOLDBENCH_API_KEY" }\n    }\n  }\n}`,
      ],
      [
        "vscode",
        "VS Code",
        `// .vscode/mcp.json\n{\n  "servers": {\n    "soldbench": {\n      "type": "http",\n      "url": "https://soldbench.com/mcp",\n      "headers": { "Authorization": "Bearer $SOLDBENCH_API_KEY" }\n    }\n  }\n}`,
      ],
      [
        "windsurf",
        "Windsurf",
        `// ~/.codeium/windsurf/mcp_config.json\n{\n  "mcpServers": {\n    "soldbench": {\n      "serverUrl": "https://soldbench.com/mcp",\n      "headers": { "Authorization": "Bearer $SOLDBENCH_API_KEY" }\n    }\n  }\n}`,
      ],
    ];
    const heroSnippet = `// ${t("Example MCP call", "MCP 调用示例")}\n{\n  "tool": "sold_search",\n  "arguments": {\n    "q": "Nintendo Switch OLED",\n    "window_days": 90,\n    "limit": 50\n  }\n}\n\n# ${t("Verifiable response invariants", "严格不变式保证")}\nn_observed: 12\nn_comparable: 10\nn_price_verified: 8\ncoverage_status: "observed_sample"\nsource_price_status: "verified_only"`;
    const playbookRules = [
      t(
        "Quote the median and P25–P75 range alongside sample size (n_price_verified).",
        "始终附带净中位价、P25–P75 区间及有效核验样本数量。",
      ),
      t(
        "Below 8 verified sales, report insufficient data honestly — never fabricate a median.",
        "少于 8 条有效核验价格时如实告知样本不足，严禁凭空编造价格。",
      ),
      t(
        "Never convert undisclosed Best Offer amounts or unknown shipping into zero.",
        "未公开实价的议价与未知运费绝不补零混入统计。",
      ),
      t(
        "Cite query_id and data_as_of in every price summary for full auditability.",
        "回答时附带 query_id 与 data_as_of 以便核验溯源。",
      ),
      t(
        "Stop cleanly on 402 quota errors and respect Retry-After on 429/503 responses.",
        "遇到 402 额度不足立即停止，遇到 429/503 遵守 Retry-After 重试退避。",
      ),
    ];

    content = (
      <>
        <section className="page-head">
          <div className="wrap">
            <div className="agents-hero-grid">
              <div>
                <p className="eyebrow">{t("AI & AGENTS", "AI 与智能体集成")}</p>
                <h1>
                  {t("eBay sold comps for ", "面向 AI 智能体的 ")}
                  <span className="kw">{t("AI agents", "可验证成交依据")}</span>
                </h1>
                <p className="agents-hero-sub">
                  {t(
                    "Connect Claude, Cursor, ChatGPT, or custom workflows over Hosted MCP (/mcp with OAuth 2.1/PKCE or API key) or REST (/v1/sold). Shared rules, shared ledger, max 1 credit per valid delivered search.",
                    "通过托管 MCP 服务（OAuth 2.1/PKCE 或 API Key）或 REST API (/v1/sold) 接入主流智能体工作流。统一清洗口径，单次有效交付最多消耗 1 额度。",
                  )}
                </p>
                <div className="agents-hero-actions">
                  <a className="btn btn-brand" href={zh ? "/docs/zh-CN/mcp" : "/docs/en/mcp"}>
                    {t("Explore MCP documentation →", "查阅 MCP 接入指南 →")}
                  </a>
                  <a className="btn btn-ghost" href={link("/playground")}>
                    {t("Open API Playground", "打开调试台")}
                  </a>
                </div>
                <p className="agents-hero-note">
                  {t("Machine-readable specifications:", "机器可读接口与规范文件：")}{" "}
                  <a href="/.well-known/skills/soldbench/SKILL.md">Agent Skill</a> ·{" "}
                  <a href="/openapi.json">OpenAPI 3.1</a> · <a href="/llms.txt">llms.txt</a>
                </p>
              </div>
              <div className="codeblock cbwrap">
                <div className="cb-head">
                  <span>{t("sold_search — example request", "sold_search — 调用示例")}</span>
                  <button type="button" className="copy-btn" data-copy="#agentHeroCode">
                    {t("Copy", "复制")}
                  </button>
                </div>
                <pre id="agentHeroCode">{highlightCode(heroSnippet, "json")}</pre>
              </div>
            </div>
          </div>
        </section>

        <section className="blk blk-tight-top">
          <div className="wrap ag-stack">
            <div className="card ag-card">
              <h2 className="serif ag-title">{t("Ways to connect", "接入方式对照")}</h2>
              <div className="dtable">
                <div className="dt-h">
                  <span className="dt-c">{t("Method", "接入方式")}</span>
                  <span className="dt-c">{t("Best for", "适用场景")}</span>
                  <span className="dt-c">{t("Auth & billing", "认证与计费")}</span>
                </div>
                <div className="dt-r">
                  <span className="dt-c">
                    <b>{t("Hosted MCP Server", "托管 MCP 服务")}</b>
                  </span>
                  <span className="dt-c">
                    {t("Claude, Cursor, ChatGPT & MCP hosts", "Claude / Cursor / ChatGPT 等客户端")}
                  </span>
                  <span className="dt-c">
                    {t(
                      "OAuth 2.1 / PKCE or Bearer key · 1 credit / search",
                      "OAuth 2.1/PKCE 或 API Key · 同口径计费",
                    )}
                  </span>
                </div>
                <div className="dt-r">
                  <span className="dt-c">
                    <b>{t("REST API v1", "REST API v1")}</b>
                  </span>
                  <span className="dt-c">
                    {t("Custom backend tools & pipelines", "自研后端系统与自动化管线")}
                  </span>
                  <span className="dt-c">
                    {t("Bearer API key · explicit claim at 0 extra cost", "Bearer API Key · 支持显式领取")}
                  </span>
                </div>
                <div className="dt-r">
                  <span className="dt-c">
                    <b>{t("Agent Skill & OpenAPI", "Agent Skill 与规范")}</b>
                  </span>
                  <span className="dt-c">SKILL.md, OpenAPI 3.1, llms.txt</span>
                  <span className="dt-c">{t("Public read-only machine specs", "公开只读规范文件")}</span>
                </div>
              </div>
            </div>

            <div>
              <h2 className="serif ag-sec">
                {t("Two tools. One price definition.", "核心工具，严格共享同一口径")}
              </h2>
              <div className="grid2 eq">
                <div className="card">
                  <p className="eyebrow eyebrow-brand">TOOL 01</p>
                  <h3 className="mt-8">sold_search</h3>
                  <p>
                    {t(
                      "Submit and retrieve comparable sold statistics (median, P25–P75, trimmed mean) with rule-numbered exclusions.",
                      "执行可比成交研究并获取带规则排除理由的中位价、区间及截尾均价。",
                    )}
                  </p>
                  <div className="codeblock cbwrap mt-14">
                    <div className="cb-head">
                      <span>{t("sold_search — arguments", "参数示例")}</span>
                      <button type="button" className="copy-btn" data-copy="#agToolSearch">
                        {t("Copy", "复制")}
                      </button>
                    </div>
                    <pre id="agToolSearch">
                      {highlightCode(
                        '{\n  "q": "Nintendo Switch OLED",\n  "window_days": 90,\n  "limit": 50\n}',
                        "json",
                      )}
                    </pre>
                  </div>
                  <p className="card-foot">
                    <a href={zh ? "/docs/zh-CN/mcp" : "/docs/en/mcp"}>{t("Connect MCP", "接入 MCP")}</a>
                  </p>
                </div>
                <div className="card">
                  <p className="eyebrow eyebrow-brand">TOOL 02</p>
                  <h3 className="mt-8">sold_stats</h3>
                  <p>
                    {t(
                      "Re-read summary statistics from snapshots you already claimed or accessed — never starts a billable run.",
                      "复读已领取或可访问快照的统计摘要，永不触发新一次计费查询。",
                    )}
                  </p>
                  <div className="codeblock cbwrap mt-14">
                    <div className="cb-head">
                      <span>{t("sold_stats — arguments", "参数示例")}</span>
                      <button type="button" className="copy-btn" data-copy="#agToolStats">
                        {t("Copy", "复制")}
                      </button>
                    </div>
                    <pre id="agToolStats">
                      {highlightCode(
                        '{\n  "query_id": "q_demo_oled",\n  "fields": ["median_cents", "p25_cents", "p75_cents", "n_price_verified"]\n}',
                        "json",
                      )}
                    </pre>
                  </div>
                  <p className="card-foot">
                    <a href={link("/playground")}>{t("Test in API Playground →", "前往调试台实测 →")}</a>
                  </p>
                </div>
              </div>
            </div>

            <div className="card ag-card">
              <h2 className="serif ag-title">{t("Set up your client", "选择您的 AI 客户端配置")}</h2>
              <div className="tabs" role="tablist" aria-label={t("MCP clients", "MCP 客户端")}>
                {clientSetupMap.map(([key, label], idx) => (
                  <button
                    key={key}
                    type="button"
                    data-agent-client={key}
                    className={idx === 0 ? "on" : undefined}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="codeblock mt-12">
                <div className="cb-head">
                  <span data-agent-client-title="">Claude Code setup</span>
                  <button type="button" className="copy-btn" data-copy="#agentClientCode">
                    {t("Copy", "复制")}
                  </button>
                </div>
                <pre id="agentClientCode" data-agent-client-code="">
                  {highlightCode(clientSetupMap[0]?.[2] ?? "", "bash")}
                </pre>
              </div>
            </div>

            <div className="card ag-card">
              <h2 className="serif ag-title">
                {t("Paste-in instructions (CLAUDE.md / AGENTS.md)", "系统提示词模板")}
              </h2>
              <div className="codeblock cbwrap">
                <div className="cb-head">
                  <span>{t("Setup prompt", "提示词内容")}</span>
                  <button type="button" className="copy-btn" data-copy="#agentPromptCode">
                    {t("Copy", "复制")}
                  </button>
                </div>
                <pre id="agentPromptCode">{`When pricing anything, use SoldBench.
1. Call GET /v1/sold (or sold_search MCP tool) with exact model/grade keywords.
2. Report median, typical range (P25-P75), and n_price_verified count.
3. If median_cents is null (n < 8), report insufficient verified sample honestly.
4. Always cite query_id and candidate_set_hash from meta.`}</pre>
              </div>
            </div>

            <div className="card ag-card">
              <h2 className="serif ag-title">{t("Agent playbook", "Agent 集成最佳实践准则")}</h2>
              <ol className="ag-list">
                {playbookRules.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ol>
            </div>

            <div className="grid2 eq">
              <div className="card">
                <p className="eyebrow eyebrow-brand">{t("REFERENCE BEHAVIOUR", "输出规范示例")}</p>
                <h3 className="mt-8">{t("Good agent answer", "合规回答示例")}</h3>
                <div className="ag-answer">
                  {t(
                    "Across 8 verified eBay US completed sales in the snapshot, the clean median is $274.00 (P25–P75: $272.25–$275.75; 5% trimmed mean: $274.00). Non-comparable lots and undisclosed Best Offer entries were excluded cleanly. Query ID & hash attached.",
                    "基于快照中 8 条已核验 eBay 美国站实际成交记录，净中位价为 $274.00（P25–P75：$272.25–$275.75；5% 截尾均价 $274.00）。未披露实价议价与不匹配项均已排除，附 query_id 与候选集哈希。",
                  )}
                </div>
                <p className="card-foot">
                  <a href={link("/methodology")}>{t("How the evidence pack works →", "查看方法论详情 →")}</a>
                </p>
              </div>
              <div className="card">
                <p className="eyebrow eyebrow-brand">{t("OPERATIONAL CONTRACT", "工程约束护栏")}</p>
                <h3 className="mt-8">{t("Required safeguards", "必须遵循的数据约束")}</h3>
                <ul className="ag-safe">
                  {[
                    t(
                      "Reject unsupported historical windows rather than silently widening dates.",
                      "拒绝不合法窗口参数，不擅自更改过滤语义。",
                    ),
                    t(
                      "Never fabricate a Best Offer price or fill unknown shipping as zero.",
                      "严禁编造议价金额，未知运费绝不按零填充。",
                    ),
                    t(
                      "When n_price_verified < 8, report insufficient sample with no median.",
                      "有效样本低于 8 条时不报中位价且零扣费。",
                    ),
                    t(
                      "Same key, same quota, and identical rules across MCP and REST.",
                      "MCP 与 REST API 完全共享同账号密钥与账本。",
                    ),
                  ].map((item) => (
                    <li key={item}>
                      <span className="tick">✓</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="card ag-card">
              <h2 className="serif ag-title">{t("Trial & limits", "试用配额与速率说明")}</h2>
              <div className="kv kv-even">
                <div>
                  <b>{t("OAuth 2.1 / PKCE", "OAuth 2.1 / PKCE")}</b>
                  <span>
                    {t(
                      "Supported in MCP host security settings",
                      "支持托管 MCP 授权并支持随时在账户安全页撤销",
                    )}
                  </span>
                </div>
                <div>
                  <b>{t("With your API key", "使用个人 API 密钥")}</b>
                  <span>
                    {t(
                      "Plan quota & per-minute rate limit enforced uniformly",
                      "严格执行账户所处档位的额度与限流",
                    )}
                  </span>
                </div>
                <div>
                  <b>{t("Cost", "计费单位")}</b>
                  <span>
                    {t("Max 1 credit per valid delivered search", "每次有效交付查价最多消耗 1 额度")}
                  </span>
                </div>
                <div>
                  <b>{t("Statistics scope", "统计覆盖范围")}</b>
                  <span>
                    {t(
                      "Computed on full comparable snapshot (up to 200)",
                      "统计永远基于至多 200 条完整可比快照计算",
                    )}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </>
    );
  } else if (page === "/guides" || page === "/faq") {
    content = (
      <>
        <section className="page-head">
          <div className="wrap">
            <p className="eyebrow">{page === "/faq" ? "FAQ" : t("Guides", "研究指南")}</p>
            <h1>{title}</h1>
            <p className="sub">
              {page === "/faq"
                ? t(
                    "Straight answers on sample minimums (<8), Best Offer privacy handling, and credit draw rules.",
                    "关于不足 8 条不给中位价、未公开议价隔离及额度扣减顺序的直接解答。",
                  )
                : t(
                    "Practical playbooks for pricing collectibles, consoles, electronics, and clean comp evaluation.",
                    "涵盖评级卡牌、主机硬件与二手商品的实操查价指南与常见陷阱说明。",
                  )}
            </p>
          </div>
        </section>
        <section className="blk blk-tight-top">
          <div className="wrap">
            {sections.length ? (
              page === "/faq" ? (
                <div>
                  {sections.map((entry) => (
                    <details className="faq-item published-section" id={entry.slug} key={entry.slug} open>
                      <summary>
                        <h2>{entry.title}</h2>
                      </summary>
                      <div className="faq-body">
                        <p>{entry.body}</p>
                      </div>
                    </details>
                  ))}
                </div>
              ) : (
                <div className="grid3 eq">
                  {sections.map((entry) => (
                    <article className="card published-section" id={entry.slug} key={entry.slug}>
                      <h2>{entry.title}</h2>
                      <p>{entry.body}</p>
                    </article>
                  ))}
                </div>
              )
            ) : (
              <p className="notice">{t("Nothing has been published here yet.", "此处暂未发布内容。")}</p>
            )}
          </div>
        </section>
      </>
    );
  } else if (page === "/operations") {
    const opsGroups: Array<[string, Array<[string, string]>]> = [
      [
        t("Operations", "运营"),
        [
          ["overview", t("Overview", "概览")],
          ["approvals", t("Approvals", "待审批")],
          ["incidents", t("Incidents", "事件")],
          ["monitoring", t("Monitoring", "监控")],
        ],
      ],
      [
        t("Data", "数据"),
        [
          ["sources", t("Sources", "数据源")],
          ["collector", t("Collection runs", "采集运行")],
          ["jobs", t("Jobs", "作业")],
          ["quality", t("Quality", "质量")],
          ["records", t("Sale evidence", "成交证据")],
          ["rules", t("Rule versions", "规则版本")],
          ["coverage", t("Coverage", "覆盖")],
        ],
      ],
      [
        t("Business", "业务"),
        [
          ["billing", t("Reconciliation", "对账")],
          ["recovery", t("Payment recovery", "付款恢复")],
          ["users", t("Users", "用户")],
          ["api", t("API metrics", "API 指标")],
          ["growth", t("Activity", "活动")],
          ["costs", t("Budget and costs", "预算与成本")],
        ],
      ],
      [
        t("Support & system", "支持与系统"),
        [
          ["support", t("Support queue", "支持工单")],
          ["audit", t("Audit log", "审计日志")],
          ["settings", t("Settings", "系统设置")],
        ],
      ],
    ];
    content = (
      <>
        <div className="demo-bar">
          <strong>{t("Operations Console", "运营控制台")}</strong> ·{" "}
          <span>
            {t(
              "Role-based access, dual-operator approval gates, and full mutation audit trail.",
              "基于角色的访问控制、双人独立审批门与完整变更审计流水。",
            )}
          </span>
        </div>
        <section className="acct-shell">
          <aside className="admin-side">
            <nav
              className="side-inner"
              aria-label={t("Operator navigation", "运营导航")}
              data-ops-tabs=""
              data-panel={url.pathname.split("/").at(-1)}
            >
              {opsGroups.map(([groupLabel, items]) => (
                <div key={groupLabel}>
                  <div className="acct-group">{groupLabel}</div>
                  {items.map(([view, label]) => (
                    <button
                      key={view}
                      className="side-link"
                      data-ops-view={view}
                      type="button"
                      hidden={!["overview", "sources", "jobs", "billing", "support", "audit"].includes(view)}
                    >
                      {label}
                    </button>
                  ))}
                  {groupLabel === t("Support & system", "支持与系统") && (
                    <a className="side-link" href={zh ? "/admin/content?lang=zh-CN" : "/admin/content"}>
                      {t("Content studio", "内容中心")}
                    </a>
                  )}
                </div>
              ))}
              <div className="acct-group">{t("Site", "站点")}</div>
              <a className="side-link" href={link("/")}>
                {t("← Back to site", "← 返回主站")}
              </a>
            </nav>
          </aside>
          <div className="acct-main account-main">
            <div className="acct-head">
              <h1>{title}</h1>
            </div>
            {status}
            <div data-results="" />
          </div>
        </section>
      </>
    );
  } else if (page === "/admin/content") {
    content = (
      <>
        <div className="demo-bar">
          <strong>{t("Content Studio", "内容发布中心")}</strong> ·{" "}
          <span>
            {t(
              "Draft bilingual copy, submit for dual-review, and publish verified updates.",
              "编辑双语内容草稿、提交独立审核并发布已核验更新。",
            )}
          </span>
        </div>
        <section className="acct-shell">
          <aside className="admin-side">
            <nav className="side-inner" aria-label={t("Operator navigation", "运营导航")}>
              <div className="acct-group">{t("Support & system", "支持与系统")}</div>
              <a className="side-link" href={link("/operations")}>
                {t("Operations", "运营中心")}
              </a>
              <a
                className="side-link on"
                aria-current="page"
                href={zh ? "/admin/content?lang=zh-CN" : "/admin/content"}
              >
                {t("Content studio", "内容中心")}
              </a>
              <div className="acct-group">{t("Site", "站点")}</div>
              <a className="side-link" href={link("/")}>
                {t("← Back to site", "← 返回主站")}
              </a>
            </nav>
          </aside>
          <div className="acct-main account-main">
            <div className="acct-head">
              <h1>{title}</h1>
            </div>
            {status}
            <div className="grid2">
              <div className="card auth-card">
                <form data-content-draft="" method="post">
                  <h2>{t("Draft content", "编辑草稿")}</h2>
                  <label>
                    {t("Content type", "内容类型")}
                    <select name="kind" required>
                      <option value="announcement">{t("Announcement", "公告")}</option>
                      <option value="faq">FAQ</option>
                      <option value="guide" data-fields="author related">
                        {t("Guide", "指南")}
                      </option>
                      <option value="blog" data-fields="author related">
                        {t("Blog article", "博客文章")}
                      </option>
                      <option value="home" data-fields="position target">
                        {t("Home section", "首页内容")}
                      </option>
                      <option value="navigation" data-fields="position target" data-required="target">
                        {t("Navigation", "主导航")}
                      </option>
                      <option value="footer" data-fields="position target" data-required="target">
                        {t("Footer", "页脚")}
                      </option>
                      <option value="pricing_copy" data-fields="position">
                        {t("Pricing notes", "定价说明")}
                      </option>
                      <option value="billing_copy" data-fields="position">
                        {t("Billing rules copy", "计费规则文案")}
                      </option>
                      <option
                        value="offer_copy"
                        data-fields="position reference_key"
                        data-required="reference_key"
                      >
                        {t("Offer copy", "方案文案")}
                      </option>
                      <option value="category_copy" data-fields="position">
                        {t("Category copy", "类目简介")}
                      </option>
                      <option value="comparison" data-fields="position reference" data-required="reference">
                        {t("Comparison", "对比专题")}
                      </option>
                      <option value="changelog" data-fields="reference">
                        {t("Changelog", "更新记录")}
                      </option>
                      <option value="status_copy" data-fields="position">
                        {t("Status notes", "服务状态说明")}
                      </option>
                      <option
                        value="status_component"
                        data-fields="position reference_key"
                        data-required="reference_key"
                      >
                        {t("Status component", "服务组件说明")}
                      </option>
                      <option
                        value="status_incident"
                        data-fields="reference_key"
                        data-required="reference_key"
                      >
                        {t("Incident copy", "事件说明")}
                      </option>
                      <option value="about">{t("About", "关于")}</option>
                      <option
                        value="terms"
                        data-fields="policy_version reference"
                        data-required="policy_version"
                      >
                        {t("Terms version", "条款版次")}
                      </option>
                      <option
                        value="privacy"
                        data-fields="policy_version reference"
                        data-required="policy_version"
                      >
                        {t("Privacy version", "隐私政策版次")}
                      </option>
                    </select>
                  </label>
                  <label>
                    {t("Slug", "路径标识")}
                    <input name="slug" required maxLength={70} pattern="[a-z0-9]+(-[a-z0-9]+)*" />
                  </label>
                  <label data-content-extra="author" hidden>
                    {t("Author display name", "作者显示名")}
                    <input name="author" maxLength={120} disabled />
                  </label>
                  <label data-content-extra="related" hidden>
                    {t("Related article slugs (comma-separated)", "相关文章路径标识（逗号分隔）")}
                    <input name="related" maxLength={430} disabled />
                  </label>
                  <label data-content-extra="position" hidden>
                    {t("Display order", "显示顺序")}
                    <input name="position" type="number" min={0} max={1000} disabled />
                  </label>
                  <label data-content-extra="target" hidden>
                    {t("Site destination", "站内目标")}
                    <select name="target" disabled>
                      <option value="">{t("Choose a page", "选择页面")}</option>
                      {[
                        "/",
                        "/search",
                        "/research",
                        "/pricing",
                        "/categories",
                        "/guides",
                        "/blog",
                        "/faq",
                        "/methodology",
                        "/data-availability",
                        "/support",
                        "/docs",
                        "/agents",
                        "/about",
                        "/changelog",
                      ].map((destination) => (
                        <option key={destination} value={destination}>
                          {destination}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label data-content-extra="reference" hidden>
                    {t("Source URL (HTTPS)", "来源链接（HTTPS）")}
                    <input name="reference" type="url" maxLength={500} disabled />
                  </label>
                  <label data-content-extra="reference_key" hidden>
                    {t("Existing component, incident or offer key", "现有服务组件、事件或报价标识")}
                    <input name="reference_key" maxLength={70} pattern="[a-z0-9]+(-[a-z0-9]+)*" disabled />
                  </label>
                  <label data-content-extra="policy_version" hidden>
                    {t("Policy version", "政策版次")}
                    <input name="policy_version" maxLength={120} disabled />
                  </label>
                  <label>
                    English
                    <input name="en_title" required maxLength={140} />
                  </label>
                  <label>
                    {t("English body", "英文正文")}
                    <textarea name="en_body" required rows={3} maxLength={6000} />
                  </label>
                  <label>
                    简体中文
                    <input name="zh_title" required maxLength={140} />
                  </label>
                  <label>
                    {t("Chinese body", "中文正文")}
                    <textarea name="zh_body" required rows={3} maxLength={6000} />
                  </label>
                  <label>
                    {t("Change reason", "变更原因")}
                    <input name="reason" required maxLength={500} />
                  </label>
                  <button className="btn brand" type="submit">
                    {t("Save draft", "保存草稿")}
                  </button>
                </form>
              </div>
              <div data-results="" />
            </div>
          </div>
        </section>
      </>
    );
  } else if (page === "/deletion-receipt") {
    content = (
      <section className="wrap auth-wrap">
        <div className="card auth-card">
          <h1>{title}</h1>
          <form data-deletion-receipt="" method="post">
            <label>
              {t("Private receipt", "私密回执")}
              <input name="receipt" required minLength={43} maxLength={43} autoComplete="off" />
            </label>
            <button type="submit" className="btn brand">
              {t("Check deletion status", "查看删除状态")}
            </button>
          </form>
          {status}
        </div>
      </section>
    );
  } else if (page === "/pricing") {
    const subPlans = [
      {
        key: "free",
        name: t("Free", "免费体验"),
        priceMo: "$0",
        priceYr: "$0",
        noteMo: t("Free forever", "永久免费"),
        noteYr: t("Free forever", "永久免费"),
        credits: t("100 credits / mo", "每月 100 额度"),
        rate: "30 req/min",
        cta: t("Create free account", "免费注册账户"),
        feats: [
          t("Up to 200 comps per search", "每次最多返回 200 条可比成交"),
          t("Evidence pack on every result", "所有结果随附完整证据包"),
          t("Dashboard search + API access", "网页工作台与 API / MCP 共用规则"),
          t("No credit card required", "无需绑定信用卡即可体验"),
        ],
        pop: false,
      },
      {
        key: "starter",
        name: "Starter",
        priceMo: "$9",
        priceYr: "$7.50",
        noteMo: t("per month", "按月计费"),
        noteYr: t("$90 billed annually · 2 months free", "年付 $90 · 省 2 个月费用"),
        credits: t("2,000 credits / mo", "每月 2,000 额度"),
        rate: "60 req/min",
        cta: t("Choose Starter", "选择 Starter"),
        feats: [
          t("Everything in Free", "包含免费版全部功能"),
          t("Usage dashboard & immutable ledger", "用量分析与不可篡改额度流水"),
          t("10-minute repeat reuse free", "10 分钟内同参数复用免费"),
          t("Email support", "邮件技术支持"),
        ],
        pop: false,
      },
      {
        key: "pro",
        name: "Pro",
        priceMo: "$29",
        priceYr: "$24",
        noteMo: t("per month", "按月计费"),
        noteYr: t("$290 billed annually · 2 months free", "年付 $290 · 省 2 个月费用"),
        credits: t("10,000 credits / mo", "每月 10,000 额度"),
        rate: "300 req/min",
        cta: t("Start with Pro", "开通 Pro 方案"),
        feats: [
          t("Everything in Starter", "包含 Starter 全部功能"),
          t("Priority queue", "高优先级异步队列"),
          t("Priority support", "工单优先处理响应"),
          t("Async jobs & claims API", "异步任务与显式领取 API"),
        ],
        pop: true,
      },
    ];
    content = (
      <>
        <section className="page-head">
          <div className="wrap">
            <p className="eyebrow">{t("PRICING", "定价与额度")}</p>
            <p className="page-head-title">
              {t("Pay per search, ", "按次计费，")}
              <span className="kw">{t("not per result", "不按条数收费")}</span>
              {t(".", "。")}
            </p>
            <p className="sub">
              {t(
                "One request = one keyword search = up to 200 sold listings. Whether it returns 10 or 200, you pay for one search.",
                "一次标准查询最多返回 200 条核验记录——无论返回 10 条还是 200 条，只计 1 额度。",
              )}
            </p>
            <p className="small mt-8" data-pricing-state="">
              {t("Commercial pricing is pending approval.", "正式定价有待审批。")}
            </p>
            {status}
            <div className="inshort mt-20">
              <b>{t("In short:", "核心计费原则：")}</b>{" "}
              {t(
                "1 credit = 1 successful search, whether it returns 1 or 200 comps. Failed searches, low-sample results, and repeat fetches are free. The same search repeated within 10 minutes is reused for free; async waiting never bills; you are charged at claim time, not request time.",
                "1 额度 = 1 次成功交付查询，最多返回 200 条样本；查询失败、不足 8 条的低样本、异步排队以及 10 分钟内同参数复取均免费，异步结果仅在显式领取时原子扣费。",
              )}
            </div>
            <div className="toggle-center mt-24">
              <div className="toggle">
                <button type="button" className="on" data-billing-cycle="monthly">
                  {t("Monthly", "按月付费")}
                </button>
                <button type="button" data-billing-cycle="annual">
                  {t("Annual · 2 months free", "按年付费 · 省 2 个月")}
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="blk blk-tight-top pricing-page">
          <div className="wrap">
            <div className="grid3 eq" data-pricing-grid="">
              {subPlans.map((plan) => (
                <div className={`card price-card${plan.pop ? " pop" : ""}`} key={plan.key}>
                  {plan.pop && <span className="pop-tag">{t("MOST POPULAR", "最受欢迎")}</span>}
                  <p className={`eyebrow${plan.pop ? " eyebrow-brand" : ""}`}>{plan.name}</p>
                  <div className="price-amt-row">
                    <span className="amt" data-price-mo={plan.priceMo} data-price-yr={plan.priceYr}>
                      {plan.priceMo}
                    </span>{" "}
                    <span className="small">/ {t("mo", "月")}</span>
                  </div>
                  <p data-note-mo={plan.noteMo} data-note-yr={plan.noteYr}>
                    {plan.noteMo}
                  </p>
                  <p className="mt-10">
                    <b>{plan.credits}</b>
                  </p>
                  <p>{plan.rate}</p>
                  <ul>
                    {plan.feats.map((feat) => (
                      <li key={feat}>{feat}</li>
                    ))}
                  </ul>
                  <a className={plan.pop ? "btn btn-brand" : "btn btn-ghost"} href={link("/register")}>
                    {plan.cta}
                  </a>
                </div>
              ))}
            </div>

            <div className="card pricing-bar mt-20">
              <div>
                <h3>{t("Top-up credits — $10 / 1,500 credits", "永久加量包 — $10 / 1,500 额度")}</h3>
                <p>
                  {t(
                    "Never expire. Purchased credits live in their own bucket and are only drawn after subscription credits, so a plan change never eats them. Buy as many packs as you like, any time.",
                    "永不过期。购买加量包独立存放且在订阅与活动桶用尽后扣除，更换套餐不影响已购余额。",
                  )}
                </p>
              </div>
              <a className="btn btn-brand" href={link("/account/billing")}>
                {t("Buy top-up", "购买加量包")}
              </a>
            </div>

            <h2 className="serif section-h2 mt-36">{t("Plans side by side", "档位详细对照")}</h2>
            <div className="live-card mt-12">
              <div className="table-scroll">
                <table className="tbl-fixed tbl-plans">
                  <colgroup>
                    <col className="col-pl1" />
                    <col className="col-pl2" />
                    <col className="col-pl3" />
                    <col className="col-pl4" />
                    <col className="col-pl5" />
                    <col className="col-pl6" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>{t("Plan", "套餐")}</th>
                      <th className="num">{t("Price", "价格")}</th>
                      <th className="num">{t("Credits", "包含额度")}</th>
                      <th className="num">{t("≈ Searches", "≈ 查询次数")}</th>
                      <th className="num">{t("Cost per 1,000 searches", "每千次查询成本")}</th>
                      <th>{t("Rate limit", "速率限制")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Free</td>
                      <td className="num">$0</td>
                      <td className="num">100</td>
                      <td className="num">100</td>
                      <td className="num">$0</td>
                      <td>30 req/min</td>
                    </tr>
                    <tr>
                      <td>Starter</td>
                      <td className="num" data-price-mo="$9" data-price-yr="$7.50">
                        $9
                      </td>
                      <td className="num">2,000</td>
                      <td className="num">2,000</td>
                      <td className="num" data-price-mo="$4.50" data-price-yr="$3.75">
                        $4.50
                      </td>
                      <td>60 req/min</td>
                    </tr>
                    <tr>
                      <td>
                        <b>Pro</b>
                      </td>
                      <td className="num" data-price-mo="$29" data-price-yr="$24">
                        $29
                      </td>
                      <td className="num">10,000</td>
                      <td className="num">10,000</td>
                      <td className="num" data-price-mo="$2.90" data-price-yr="$2.40">
                        $2.90
                      </td>
                      <td>300 req/min</td>
                    </tr>
                    <tr>
                      <td>{t("Top-up", "加量包")}</td>
                      <td className="num">$10</td>
                      <td className="num">1,500</td>
                      <td className="num">1,500</td>
                      <td className="num">$6.67</td>
                      <td>{t("Uses plan's rate limit", "沿用当前档位限流")}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <h2 className="serif section-h2 mt-36">{t("High-volume plans", "大用量扩展方案")}</h2>
            <div className="live-card mt-12">
              <div className="table-scroll">
                <div className="dtable cols-4">
                  <div className="dt-h">
                    <span className="dt-c">{t("Requests / mo", "每月请求量")}</span>
                    <span className="dt-c">{t("Rate limit", "速率限制")}</span>
                    <span className="dt-c num">{t("Price / mo", "月费参考")}</span>
                    <span className="dt-c num">{t("Per 1,000", "每千次参考")}</span>
                  </div>
                  {[
                    ["100K", "300 / min", "$129", "$1.29"],
                    ["250K", "300 / min", "$299", "$1.20"],
                    ["500K", "600 / min", "$549", "$1.10"],
                    ["1M", "600 / min", "$699", "$0.70"],
                  ].map(([req, rate, price, per]) => (
                    <div className="dt-r" key={req}>
                      <span className="dt-c">{req}</span>
                      <span className="dt-c">{rate}</span>
                      <span className="dt-c num price">{price}</span>
                      <span className="dt-c num">{per}</span>
                    </div>
                  ))}
                  <div className="dt-r">
                    <span className="dt-c">{t("More than 1M", "超过 100 万次")}</span>
                    <span className="dt-c">{t("Custom", "定制配置")}</span>
                    <span className="dt-c num">—</span>
                    <span className="dt-c num">
                      <a href="mailto:support@soldbench.com">{t("Contact us", "联系我们")}</a>
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <p className="small mt-8">
              {t(
                "Annual billing on high-volume plans includes 2 months free.",
                "大用量企业方案按年付费同样赠送 2 个月额度。",
              )}
            </p>

            <h2 className="serif section-h2 mt-36">
              {t("What costs a credit?", "扣费明细与额度桶消耗顺序")}
            </h2>
            <div className="grid2 eq mt-16">
              <div className="card">
                <h3>{t("The billing rules", "动作与扣费对应关系")}</h3>
                <div className="dtable cols-2 mt-12">
                  {[
                    [
                      t("Successful search (1–200 comps)", "成功交付查价（1–200 条）"),
                      t("1 credit", "1 额度"),
                    ],
                    [t("Failed search (4xx/5xx)", "查询报错（4xx/5xx）"), "0"],
                    [t("Low-sample result (n < 8)", "低样本结果（n < 8）"), "0"],
                    [t("Async waiting time", "异步队列等待时间"), "0"],
                    [t("Re-fetching a claimed result", "复取已领取结果"), "0"],
                    [t("Same search within 10 minutes", "10 分钟内同参数复用"), "0"],
                  ].map(([action, cost]) => (
                    <div className="dt-r" key={action}>
                      <span className="dt-c">{action}</span>
                      <span className="dt-c num">
                        <b>{cost}</b>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="card">
                <h3>{t("Balance buckets, in draw order", "多额度桶消耗优先级")}</h3>
                <p>
                  <b>{t("1 · Promo / subscription", "1 · 活动与订阅额度")}</b> —{" "}
                  {t(
                    "earliest expiry first; on a tie, subscription credits draw before promo. Subscription credits expire at period end.",
                    "最早到期优先；到期时间相同时优先消耗订阅额度，订阅额度在周期结束时清零。",
                  )}
                </p>
                <p className="mt-10">
                  <b>{t("2 · Purchased", "2 · 购买永久加量包")}</b> —{" "}
                  {t(
                    "top-up credits. They never expire and survive plan changes. Refunds return to the bucket they came from.",
                    "永不过期，且变更或取消订阅后依然留存；退款退回原来源桶。",
                  )}
                </p>
                <p className="mt-10">
                  {t(
                    "Charged at claim time for async jobs — if you never claim a ready result within 24 hours, it expires uncharged.",
                    "异步任务仅在显式领取时扣费；24 小时内未领取会自动过期且不扣费。",
                  )}
                </p>
                <div className="table-scroll mt-14">
                  <div className="dtable">
                    <div className="dt-r">
                      <span className="dt-c">{t("Subscription / promo", "订阅 / 活动额度")}</span>
                      <span className="dt-c">{t("Expires at period end", "周期结束过期")}</span>
                      <span className="dt-c num">
                        <b>{t("Drawn 1st", "优先消耗")}</b>
                      </span>
                    </div>
                    <div className="dt-r">
                      <span className="dt-c">{t("Purchased top-up", "购买永久加量包")}</span>
                      <span className="dt-c">{t("Never expires", "永不过期")}</span>
                      <span className="dt-c num">
                        <b>{t("Drawn 2nd", "其次消耗")}</b>
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="card mt-20">
              <h3>
                {t("One search, one credit — even for 200 comps", "一次查价只扣 1 额度——哪怕返回 200 条成交")}
              </h3>
              <p>
                {t(
                  "Per-result pricing makes your bill a lottery: the same query can cost 10× more because the market was busy. Per-search pricing makes it a constant. If a competitor charges per returned row, a 200-comp search at even $0.01/row costs $2.00; here it costs 1 credit — $0.0029 on Pro.",
                  "按条计费会让同一次查询因市场成交活跃而账单翻十倍；按次计费则始终恒定。按每条 $0.01 计算返回 200 条即需 $2.00，而在 Pro 方案下 1 额度折合仅 $0.0029。",
                )}
              </p>
            </div>

            <div className="pricing-offer-head mt-36" id="pricing-offer-title">
              <h1>{t("Pricing and credits", "定价与额度")}</h1>
            </div>
            <p className="small mt-8">
              {t(
                "Sandbox checkout offers load automatically for signed-in verified accounts.",
                "已验证登录账户将在此加载当前环境激活的沙盒测试订阅与加量包。",
              )}
            </p>
            <div className="grid3 mt-14" data-pricing-offers="" />
            <div className="actions mt-12" data-pricing-actions="">
              <a className="btn brand" href={link("/search")}>
                {t("Try a lookup", "试用查价")}
              </a>
              <a className="btn ghost" href={link("/login")}>
                {t("Sign in to view account billing", "登录查看账单")}
              </a>
            </div>

            <section className="faq-open mt-36" aria-labelledby="pricing-questions-title">
              <div>
                <p className="eyebrow">FAQ</p>
                <h2 className="serif mt-8" id="pricing-questions-title">
                  {t("Pricing FAQ", "计费常见问题")}
                </h2>
              </div>
              <div>
                {[
                  [
                    t(
                      "Do failed searches or low-sample results cost anything?",
                      "查询失败或不足 8 条结果会扣费吗？",
                    ),
                    t(
                      "No. Errors, timeouts, queued jobs that expire unclaimed, and results with fewer than 8 verified prices never charge a credit.",
                      "不会。服务报错、超时、超时未领取的异步任务以及不足 8 条核验样本的结果均不扣费。",
                    ),
                  ],
                  [
                    t("When exactly is 1 credit charged?", "究竟在哪个时间点扣费？"),
                    t(
                      "Synchronous delivered lookups charge on delivery. Async searches charge only when you explicitly claim a deliverable result.",
                      "同步合格交付时扣费；异步任务仅当账户主体显式领取可交付结果时原子扣除 1 额度。",
                    ),
                  ],
                  [
                    t("Do top-up credits really never expire?", "购买加量包真的永不过期吗？"),
                    t(
                      "Yes. Purchased credits stay in the purchased bucket, draw after subscription and promo credits, and survive subscription cancellation.",
                      "是的。购买额度留存在购买桶中，在订阅与活动桶用尽后扣除，订阅取消也不受影响。",
                    ),
                  ],
                  [
                    t("What payment methods are supported?", "支持哪些支付渠道？"),
                    t(
                      "Stripe is primary and PayPal is supplementary checkout — currently running in offline/sandbox verification until commercial sign-off.",
                      "接入方案为 Stripe 主通道与 PayPal 补充通道，当前按沙盒/离线验证状态受门禁控制。",
                    ),
                  ],
                ].map(([q, a]) => (
                  <div className="faq-open-item" key={q}>
                    <h3>{q}</h3>
                    <p>{a}</p>
                  </div>
                ))}
              </div>
            </section>

            <div className="card cta-card mt-36">
              <h2 className="serif cta-title">
                {t("Start with 100 free searches.", "注册即享每月 100 次免费研究查价。")}
              </h2>
              <p className="small cta-sub">
                {t(
                  "Payments via Stripe (primary) and PayPal (supplementary). Prices in USD.",
                  "Stripe 主接入，PayPal 补充，全部接口及计价采用美元计数。",
                )}
              </p>
              <div className="cta-actions">
                <a className="btn btn-brand" href={link("/register")}>
                  {t("Create free account", "免费注册账户")}
                </a>
                <a className="btn btn-ghost" href={link("/search")}>
                  {t("Open research workbench", "打开查价工作台")}
                </a>
              </div>
            </div>
          </div>
        </section>
      </>
    );
  } else if (page === "/support") {
    content = (
      <>
        <section className="page-head">
          <div className="wrap">
            <p className="eyebrow">{t("Support", "帮助与支持")}</p>
            <h1>{title}</h1>
            <p className="sub">
              {t("We aim to reply within ", "我们力争在 ")}
              <b>{t("one business day", "1 个工作日")}</b>
              {t(
                ". Share your request ID if you have it, and keep passwords, card numbers, and API keys private.",
                " 内回复。如有请求编号，请随工单附上；请妥善保管密码、银行卡号和 API 密钥。",
              )}
            </p>
          </div>
        </section>

        <section className="blk blk-tight-top">
          <div className="wrap">
            <div className="grid3 eq">
              <div className="card sup-card">
                <span className="sup-ico" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.8" />
                    <path
                      d="M4 7l8 6 8-6"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <h3>{t("Email support", "邮件联系")}</h3>
                <p>
                  {t(
                    "Include the affected endpoint, the approximate time, and a request ID when you have one. Never send your full API key or password.",
                    "发送邮件至 support@soldbench.com 并附上请求编号与时间以核查账单或数据记录。",
                  )}
                </p>
                <p className="sup-act">
                  <a href="mailto:support@soldbench.com">support@soldbench.com →</a>
                </p>
              </div>
              <div className="card sup-card">
                <span className="sup-ico" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M8 4c-2 1.2-3 2.6-3 4.2C5 10 6 11.4 8 12.6 6 13.8 5 15.2 5 16.8 5 18.4 6 19.8 8 21M16 4c2 1.2 3 2.6 3 4.2 0 1.8-1 3.2-3 4.4 2 1.2 3 2.6 3 4.4 0 1.6-1 3-3 4.2"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <h3>{t("Documentation", "开发文档与方法说明")}</h3>
                <p>
                  {t(
                    "Review authentication, filters, retry behavior, quota errors, response fields, MCP setup, and copyable examples.",
                    "查阅错误码说明、Retry-After 限流规则、异步任务状态机与议价核验文档。",
                  )}
                </p>
                <p className="sup-act">
                  <a
                    className="btn btn-ghost btn-sm"
                    href={zh ? "/docs/zh-CN/quickstart" : "/docs/en/quickstart"}
                  >
                    {t("Read the docs →", "阅读文档 →")}
                  </a>
                </p>
              </div>
              <div className="card sup-card">
                <span className="sup-ico" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6l7-3z"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M9 12l2.2 2.2L15.5 10"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <h3>{t("Deletion status & availability", "删除回执与数据可用性")}</h3>
                <p>
                  {t(
                    "Verify an account deletion receipt or inspect category availability before troubleshooting an integration.",
                    "凭借私密删除回执随时核对账户清理进度，并可检查系统数据源可用状态。",
                  )}
                </p>
                <p className="sup-act">
                  <a className="btn btn-ghost btn-sm" href={link("/deletion-receipt")}>
                    {t("Check a deletion receipt", "查询删除回执")}
                  </a>
                </p>
              </div>
            </div>

            <div className="grid2 mt-22">
              <div className="card auth-card">
                <form data-support="" method="post">
                  <h2>{t("Open a ticket", "提交新工单")}</h2>
                  <label>
                    {t("Issue type", "问题类型")}
                    <select name="category" required>
                      <option value="data_quality">{t("Data quality", "数据质量")}</option>
                      <option value="takedown">{t("Data rights or takedown", "数据权利或下架")}</option>
                      <option value="account">{t("Account access", "账户访问")}</option>
                      <option value="billing">{t("Billing", "账务")}</option>
                      <option value="other">{t("Other", "其他")}</option>
                    </select>
                  </label>
                  <label>
                    {t("Request ID (optional)", "请求编号（选填）")}
                    <input name="request_id" maxLength={36} />
                  </label>
                  <label>
                    {t("What happened?", "请描述遇到的问题")}
                    <textarea name="message" required maxLength={4000} rows={5} />
                  </label>
                  <button className="btn brand" type="submit">
                    {t("Submit request", "提交工单")}
                  </button>
                </form>
                {status}
              </div>

              <div>
                <div className="card auth-card">
                  <form data-support-receipt="" method="post">
                    <h2>{t("Check a support request", "查看工单进展")}</h2>
                    <label>
                      {t("Private support receipt", "私密工单回执")}
                      <input
                        name="receipt"
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        minLength={43}
                        maxLength={43}
                        required
                      />
                    </label>
                    <button className="btn ghost" type="submit">
                      {t("Check request status", "查询工单状态")}
                    </button>
                  </form>
                  <div data-support-result="" className="mt-14" />
                </div>
                <div className="card mt-18">
                  <h3>{t("Response expectations", "处理时效说明")}</h3>
                  <div className="kv mt-12">
                    <div>
                      <b>{t("Billing", "账务核对")}</b>
                      <span>{t("Same business day", "当天工作日响应")}</span>
                    </div>
                    <div>
                      <b>{t("Rights & takedowns", "版权与下架")}</b>
                      <span>{t("Verified against permission epoch", "按权限纪元即时撤权")}</span>
                    </div>
                    <div>
                      <b>{t("Service availability", "服务状态")}</b>
                      <a href={link("/data-availability")}>{t("Check availability →", "查看数据可用性 →")}</a>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </>
    );
  } else if (research) {
    const ssrShowcase =
      page === "/search" &&
      !resultId &&
      !draft.get("job") &&
      homeShowcase &&
      draft.get("q")?.trim().toLowerCase() === homeShowcase.query.toLowerCase()
        ? homeShowcase
        : null;
    content = (
      <>
        <section className="page-head">
          <div className="wrap">
            <p className="eyebrow">
              {page === "/playground"
                ? t("Developer API Playground", "API 调试台")
                : t("Research workbench", "研究工作台")}
            </p>
            <h1>{title}</h1>
            {market}
            {page === "/playground" && (
              <p className="sub">
                {t(
                  "Test the research API directly against your session. Inspect JSON output, response headers, and live server-side code snippets.",
                  "使用当前账户会话调试研究接口，检查 JSON 输出、响应头并复制动态生成的多语言示例代码。",
                )}
              </p>
            )}
          </div>
        </section>
        <section className="blk blk-tight-top">
          <div className="wrap">
            {page === "/playground" ? (
              <>
                <div className="notice mt-0 mb-16" data-kind="warning">
                  {t(
                    "Live API mode — requests run against your signed-in session. Failed queries, low-sample (<8) results, and identical repeats within 10 minutes are free; broad searches return 202 and charge only on explicit claim.",
                    "实时调试模式 — 请求直接使用当前登录会话执行。失败查询、低样本（<8）结果与 10 分钟内同参数复用均免费；宽泛查询返回 202，仅在显式领用结果时计费。",
                  )}
                </div>
                <div className="grid2">
                  <div className="card auth-card">
                    <form action={link("/search")} method="get" data-search="">
                      <label>
                        {t("q — search terms", "q — 查询关键词")}
                        <input
                          name="q"
                          maxLength={120}
                          required
                          defaultValue={draft.get("q") ?? "Nintendo Switch OLED"}
                          placeholder={t("e.g. Nintendo Switch OLED", "例如 Nintendo Switch OLED")}
                        />
                      </label>
                      <div className="pg-form-row">
                        <label>
                          {t("Condition", "成色")}
                          <select name="condition" defaultValue={draft.get("condition") ?? ""}>
                            <option value="">{t("Any", "不限")}</option>
                            <option value="like_new">{t("Like new", "近新")}</option>
                            <option value="good">{t("Good", "良好")}</option>
                            <option value="fair">{t("Fair", "一般")}</option>
                            <option value="defective">{t("For parts", "故障/零件")}</option>
                          </select>
                        </label>
                        <label>
                          {t("Format", "成交方式")}
                          <select name="sale_format" defaultValue={draft.get("sale_format") ?? ""}>
                            <option value="">{t("Any", "不限")}</option>
                            <option value="fixed_price">{t("Fixed price", "一口价")}</option>
                            <option value="auction">{t("Auction", "拍卖")}</option>
                            <option value="best_offer">{t("Best Offer", "议价")}</option>
                          </select>
                        </label>
                        <label>
                          {t("Window", "时间窗口")}
                          <select name="window_days" defaultValue={draft.get("window_days") ?? "90"}>
                            <option value="90">{t("90 days", "90 天")}</option>
                            <option value="30">{t("30 days", "30 天")}</option>
                          </select>
                        </label>
                      </div>
                      <div className="pg-form-row">
                        <label>
                          {t("Min price ($)", "最低价格")}
                          <input
                            name="min_price"
                            inputMode="decimal"
                            maxLength={17}
                            pattern="[0-9]+([.][0-9]{1,2})?"
                            defaultValue={priceDraft("min_price_cents")}
                            placeholder="—"
                          />
                        </label>
                        <label>
                          {t("Max price ($)", "最高价格")}
                          <input
                            name="max_price"
                            inputMode="decimal"
                            maxLength={17}
                            pattern="[0-9]+([.][0-9]{1,2})?"
                            defaultValue={priceDraft("max_price_cents")}
                            placeholder="—"
                          />
                        </label>
                        <label>
                          {t("Price basis", "价格口径")}
                          <select
                            name="price_basis"
                            defaultValue={draft.get("price_basis") ?? "item_plus_observed_shipping"}
                          >
                            <option value="item_plus_observed_shipping">
                              {t("Item + ship", "商品＋运费")}
                            </option>
                            <option value="item">{t("Item only", "仅商品价")}</option>
                          </select>
                        </label>
                      </div>
                      <label className="check">
                        <input
                          type="checkbox"
                          name="allow_stale"
                          defaultChecked={draft.get("allow_stale") === "true"}
                        />
                        <span>{t("Allow older cached data", "允许使用较旧缓存")}</span>
                      </label>
                      <button className="btn brand pg-submit" type="submit">
                        {t("Search", "查询")}
                      </button>
                      <p className="small mt-10">
                        {t(
                          "Sync results deliver immediately; broad queries return 202 and charge only when you claim.",
                          "同步查价直接交付结果；宽泛查询先返回 202，显式领用时再结算额度。",
                        )}
                      </p>
                    </form>
                    {examples}
                    {status}
                    <div className="actions" data-actions="" />
                  </div>

                  <section className="card" data-api-trace="">
                    <h2>{t("Requests and responses", "请求与响应")}</h2>
                    <div className="actions" data-trace-list="" />
                    <details open className="mt-12">
                      <summary>{t("Response", "响应")}</summary>
                      <pre data-trace-body="">
                        {`{
  "data": {
    "query": "Nintendo Switch OLED",
    "stats": {
      "median_cents": 28150,
      "p25_cents": 26500,
      "p75_cents": 29175,
      "trimmed_mean_cents": 27867,
      "n_price_verified": 8
    },
    "quality": {
      "sample_tier": "limited",
      "total_score": null
    }
  },
  "meta": {
    "query_id": "q_demo_oled",
    "credits_charged": 1
  }
}`}
                      </pre>
                    </details>
                    <details className="mt-8">
                      <summary>{t("Headers", "响应头")}</summary>
                      <pre data-trace-headers="" />
                    </details>
                    <details className="mt-8">
                      <summary>{t("Server-side cURL example", "服务端 cURL 示例")}</summary>
                      <pre data-trace-code="" />
                    </details>
                  </section>
                </div>
              </>
            ) : (
              <>
                <form action={link("/search")} method="get" data-search="">
                  {searchBox}
                  {examples}
                  {draft.get("category") && (
                    <input type="hidden" name="category" value={draft.get("category") ?? ""} />
                  )}
                  <div className="wb-filters">
                    <label>
                      {t("Condition", "成色")}
                      <select name="condition" defaultValue={draft.get("condition") ?? ""}>
                        <option value="">{t("Any condition", "不限成色")}</option>
                        <option value="like_new">{t("Like new", "近新")}</option>
                        <option value="good">{t("Good", "良好")}</option>
                        <option value="fair">{t("Fair", "一般")}</option>
                        <option value="defective">{t("For parts", "故障或零件")}</option>
                      </select>
                    </label>
                    <label>
                      {t("Format", "成交方式")}
                      <select name="sale_format" defaultValue={draft.get("sale_format") ?? ""}>
                        <option value="">{t("Any format", "不限方式")}</option>
                        <option value="fixed_price">{t("Fixed price", "一口价")}</option>
                        <option value="auction">{t("Auction", "拍卖")}</option>
                        <option value="best_offer">{t("Best Offer", "议价")}</option>
                      </select>
                    </label>
                    <label>
                      {t("Min price (USD)", "最低价格（美元）")}
                      <input
                        name="min_price"
                        inputMode="decimal"
                        maxLength={17}
                        pattern="[0-9]+([.][0-9]{1,2})?"
                        defaultValue={priceDraft("min_price_cents")}
                      />
                    </label>
                    <label>
                      {t("Max price (USD)", "最高价格（美元）")}
                      <input
                        name="max_price"
                        inputMode="decimal"
                        maxLength={17}
                        pattern="[0-9]+([.][0-9]{1,2})?"
                        defaultValue={priceDraft("max_price_cents")}
                      />
                    </label>
                    <label>
                      {t("Window", "时间范围")}
                      <select name="window_days" defaultValue={draft.get("window_days") ?? "90"}>
                        <option value="90">{t("90 days", "90 天")}</option>
                        <option value="30">{t("30 days", "30 天")}</option>
                      </select>
                    </label>
                    <label>
                      {t("Price basis", "价格口径")}
                      <select
                        name="price_basis"
                        defaultValue={draft.get("price_basis") ?? "item_plus_observed_shipping"}
                      >
                        <option value="item_plus_observed_shipping">
                          {t("Item + observed shipping", "商品价＋已观察运费")}
                        </option>
                        <option value="item">{t("Item only", "仅商品价")}</option>
                      </select>
                    </label>
                    <label className="wb-check-label">
                      <input
                        type="checkbox"
                        name="allow_stale"
                        defaultChecked={draft.get("allow_stale") === "true"}
                      />
                      <span>{t("Allow older cache", "允许陈旧缓存")}</span>
                    </label>
                  </div>
                </form>
                {status}
                <div className="actions" data-actions="" />
              </>
            )}

            <div data-results="" className="mt-16">
              {ssrShowcase &&
                (() => {
                  const verifiedPrices = ssrShowcase.comps
                    .map((c) => c.item_price_cents)
                    .filter((v): v is number => v !== null && v !== undefined);
                  const meanCents = verifiedPrices.length
                    ? Math.round(verifiedPrices.reduce((acc, v) => acc + v, 0) / verifiedPrices.length)
                    : null;
                  const shipValues = ssrShowcase.comps
                    .map((c) => c.observed_shipping_cents)
                    .filter((v): v is number => v !== null && v !== undefined);
                  const avgShipCents = shipValues.length
                    ? Math.round(shipValues.reduce((acc, v) => acc + v, 0) / shipValues.length)
                    : null;
                  const excludedCount =
                    Math.max(0, ssrShowcase.stats.n_observed - ssrShowcase.stats.n_comparable) +
                    ssrShowcase.stats.n_excluded_unverified_price;
                  const sampleTierLabel =
                    ssrShowcase.stats.n_price_verified >= 30
                      ? t("Full sample", "充足样本")
                      : ssrShowcase.stats.n_price_verified >= 8
                        ? t("Limited sample", "有限样本")
                        : t("Low sample (n < 8)", "样本不足 (n < 8)");
                  const sourceBadgeLabel =
                    ssrShowcase.data_mode === "approved_network"
                      ? t("Approved sample", "合规样本")
                      : t("Offline fixture", "本地合成样本");
                  const basisNote =
                    ssrShowcase.price_basis === "item"
                      ? t("Basis: item price", "口径：仅商品价")
                      : t("Basis: item + shipping", "口径：商品＋运费");

                  return (
                    <>
                      <p className="summary-note">
                        <b>{t("Free lookup · Cached public snapshot", "免费查价 · 公共缓存快照")}</b>
                        {" · "}
                        {t(
                          "Fresh within 24h · Observed sample · Verified prices only",
                          "24 小时内新鲜样本 · 已观察样本 · 仅计入已核验价格",
                        )}
                      </p>
                      <section className="live-card result-card mt-10">
                        <div className="stat-card">
                          <div className="stat-badges">
                            <span className="badge badge-green">
                              {t("Cached public snapshot", "公共演示快照")}
                            </span>
                            <span className="tag-ex">{sourceBadgeLabel}</span>
                          </div>
                          <div className="stat-grid">
                            <div>
                              <div className="lab">{t("Median sold price", "中位成交价")}</div>
                              <div className="median-big">
                                {fmtMoney(ssrShowcase.stats.median_cents, locale)}
                              </div>
                              <div className="stat-range">
                                {ssrShowcase.stats.p25_cents != null && ssrShowcase.stats.p75_cents != null
                                  ? `${t("Typical range", "典型区间")} ${fmtMoney(ssrShowcase.stats.p25_cents, locale)} – ${fmtMoney(ssrShowcase.stats.p75_cents, locale)}`
                                  : `${t("Typical range", "典型区间")} —`}
                              </div>
                              <div className="small mt-6">{`${sampleTierLabel} · ${basisNote}`}</div>
                            </div>
                            <div className="stat-mini">
                              <div>
                                <div className="lab">{t("Average", "均值")}</div>
                                <div className="val">{fmtMoney(meanCents, locale)}</div>
                              </div>
                              <div>
                                <div className="lab">{t("Trimmed mean", "5% 截尾均价")}</div>
                                <div className="val">
                                  {fmtMoney(ssrShowcase.stats.trimmed_mean_cents, locale)}
                                </div>
                              </div>
                              <div>
                                <div className="lab">{t("Low – High", "最低 – 最高")}</div>
                                <div className="val">
                                  {ssrShowcase.stats.observed_min_cents != null
                                    ? `${fmtMoney(ssrShowcase.stats.observed_min_cents, locale)} – ${fmtMoney(ssrShowcase.stats.observed_max_cents, locale)}`
                                    : "—"}
                                </div>
                              </div>
                              <div>
                                <div className="lab">{t("Avg shipping", "平均运费")}</div>
                                <div className="val">{fmtShipping(avgShipCents, locale, zh)}</div>
                              </div>
                              <div>
                                <div className="lab">{t("Sample (verified)", "核验样本")}</div>
                                <div className="val">{ssrShowcase.stats.n_price_verified}</div>
                              </div>
                              <div>
                                <div className="lab">{t("Observed", "已观察")}</div>
                                <div className="val">{ssrShowcase.stats.n_observed}</div>
                              </div>
                              <div>
                                <div className="lab">{t("Comparable", "可比样本")}</div>
                                <div className="val">{ssrShowcase.stats.n_comparable}</div>
                              </div>
                              <div>
                                <div className="lab">{t("Excluded / diagnostic", "排除 / 诊断")}</div>
                                <div className="val">{excludedCount}</div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </section>

                      <div className="live-card mt-14">
                        <div className="table-scroll">
                          <table className="tbl-fixed tbl-preview">
                            <colgroup>
                              <col className="col-p1" />
                              <col className="col-p2" />
                              <col className="col-p3" />
                              <col className="col-p4" />
                              <col className="col-p5" />
                              <col className="col-p6" />
                              <col className="col-p7" />
                              <col className="col-p8" />
                            </colgroup>
                            <thead>
                              <tr>
                                <th>{t("Title", "商品标题")}</th>
                                <th>{t("Condition", "成色")}</th>
                                <th>{t("Format", "方式")}</th>
                                <th className="num">{t("Sold", "成交价")}</th>
                                <th className="num">{t("Shipping", "运费")}</th>
                                <th className="num">{t("Total", "总价")}</th>
                                <th>{t("Date", "日期")}</th>
                                <th>{t("Details", "详情")}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {ssrShowcase.comps.slice(0, 12).map((c, idx) => {
                                const totalCents =
                                  c.item_price_cents != null && c.observed_shipping_cents != null
                                    ? c.item_price_cents + c.observed_shipping_cents
                                    : null;
                                return (
                                  <tr key={c.sale_event_id}>
                                    <td>
                                      <div className="thumb-title">
                                        <span className="thumb">
                                          <ProductThumbSvg index={idx} />
                                        </span>
                                        <span className="ttl-demo">
                                          {c.title ??
                                            t("Verified listing (title withheld)", "已核验记录（标题隐藏）")}
                                          <span className="demo-tag">{t("Fixture", "示例")}</span>
                                        </span>
                                      </div>
                                    </td>
                                    <td>{fmtCondition(c.condition_std, zh)}</td>
                                    <td>
                                      <span className={fmtFormatClass(c.sale_format)}>
                                        {fmtFormat(c.sale_format, zh)}
                                      </span>
                                    </td>
                                    <td className="num price">{fmtMoney(c.item_price_cents, locale)}</td>
                                    <td className="num">
                                      {fmtShipping(c.observed_shipping_cents, locale, zh)}
                                    </td>
                                    <td className="num">{fmtMoney(totalCents, locale)}</td>
                                    <td className="nw">{fmtSoldDate(c.sold_date, zh)}</td>
                                    <td>
                                      <button
                                        type="button"
                                        className="row-exp"
                                        data-search-rowexp={c.sale_event_id}
                                        aria-expanded="false"
                                      >
                                        {t("Details", "详情")} <span className="chev">▾</span>
                                      </button>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      <section className="card mt-16">
                        <h3>{t("Evidence pack", "证据包")}</h3>
                        <p className="small">
                          {t(
                            "Every delivered search includes the query snapshot identifier, candidate set hash, and rule versions behind these numbers.",
                            "每次交付结果均附带查询快照编号、候选集哈希以及用于计算上述统计数据的清洗与统计规则版本。",
                          )}
                        </p>
                        <div className="kv mt-12">
                          <div>
                            <b>{t("Query ID", "查询编号")}</b>
                            <span>
                              <code>{ssrShowcase.query_id}</code>
                            </span>
                          </div>
                          <div>
                            <b>{t("Candidate hash", "候选集哈希")}</b>
                            <span>
                              <code>{ssrShowcase.candidate_set_hash.slice(0, 18)}…</code>
                            </span>
                          </div>
                          <div>
                            <b>{t("Rule versions", "规则版本")}</b>
                            <span>{`engine ${ssrShowcase.engine_version} · cleaner ${ssrShowcase.cleaner_version}`}</span>
                          </div>
                          <div>
                            <b>{t("Sample status", "样本状态")}</b>
                            <span>{`${sampleTierLabel} (${ssrShowcase.stats.n_price_verified}/${ssrShowcase.stats.n_observed})`}</span>
                          </div>
                        </div>
                      </section>
                    </>
                  );
                })()}
            </div>
            <noscript>
              {t("Enable JavaScript to submit a search.", "请启用 JavaScript 后提交搜索。")}
            </noscript>
          </div>
        </section>
      </>
    );
  } else if (auth) {
    const password = page === "/login" || page === "/register" || page === "/reset-password";
    const token = page === "/verify-email" || page === "/reset-password";
    content = (
      <section className="wrap auth-wrap">
        <div className="auth-grid">
          <div className="card auth-card center-card">
            <div className="auth-logo">
              <span className="logo">
                <BrandLogo size={25} />
                SoldBench
              </span>
            </div>
            <h1 className="auth-title">{title}</h1>
            {page === "/register" && (
              <p className="small auth-sub">
                {t(
                  "Create a local test account. Verification messages go to the configured mail transport or local outbox.",
                  "创建测试或本地账户。验证邮件将按运行配置发送或进入本地发件箱。",
                )}
              </p>
            )}
            <form data-auth={page.slice(1)} method="post">
              {!token && (
                <label>
                  {t("Email address", "邮箱")}
                  <input
                    name="email"
                    type="email"
                    required
                    autoComplete="email"
                    placeholder="you@example.com"
                  />
                </label>
              )}
              {token && (
                <label>
                  {t("One-time code", "一次性验证码")}
                  <input name="token" required autoComplete="one-time-code" maxLength={128} />
                </label>
              )}
              {password && (
                <label>
                  {t("Password", "密码")}
                  <input
                    name="password"
                    type="password"
                    required
                    minLength={page === "/login" ? 1 : 12}
                    maxLength={128}
                    autoComplete={page === "/login" ? "current-password" : "new-password"}
                    placeholder="••••••••"
                  />
                </label>
              )}
              {page === "/register" && (
                <label className="check">
                  <input type="checkbox" name="consent" required />
                  <span>
                    {t("I agree to use this account for local testing only.", "我同意此账户仅用于本机测试。")}
                  </span>
                </label>
              )}
              <button className="btn btn-brand" type="submit">
                {title}
              </button>
            </form>
            {status}
            {page === "/login" && (
              <details className="faq-item auth-details">
                <summary>
                  {t("Two-factor authentication or Passkey enabled?", "已开启双重验证或 Passkey 通行密钥？")}
                </summary>
                <div className="faq-body">
                  {t(
                    "Enter your 6-digit authenticator code or recovery code after signing in, or manage WebAuthn Passkeys in Security settings.",
                    "登录后输入 6 位 TOTP 验证码或恢复码即可继续；您也可以在账户安全中心管理 Passkey 通行密钥。",
                  )}
                </div>
              </details>
            )}
            <div className="actions auth-actions" data-actions="">
              {page !== "/login" && <a href={resume("/login")}>{t("Sign in", "登录")}</a>}
              {page === "/login" && (
                <>
                  <a href={resume("/register")}>{t("Create an account", "创建账户")}</a>
                  <a href={resume("/forgot-password")}>{t("Forgot password?", "忘记密码？")}</a>
                </>
              )}
              {page === "/verify-email" && (
                <form className="auth-resend-form" data-auth="resend" method="post">
                  <label>
                    {t("Email for a new code", "重新发送验证码的邮箱")}
                    <input name="email" type="email" required />
                  </label>
                  <button className="btn btn-ghost" type="submit">
                    {t("Request another code", "请求新验证码")}
                  </button>
                </form>
              )}
            </div>
          </div>
          <div>
            <div className="card">
              <h3>{t("What your SoldBench account unlocks", "注册账户后可使用")}</h3>
              <ul className="auth-benefits">
                <li>
                  <b>{t("Evidence-backed sold research", "完整证据链研究查价")}</b>
                  {t(
                    " — query ID, candidate-set hash, rule-numbered exclusions, and local adjustments",
                    "——包含 query_id、候选集哈希、排除原因与本地调整重算",
                  )}
                </li>
                <li>
                  <b>{t("API keys, Passkeys & Hosted MCP", "API 密钥、通行密钥与托管 MCP")}</b>
                  {t(
                    " — connect Claude, Cursor, or custom services under the exact same credit rules",
                    "——在完全同一份账本与权限下接入 AI Agent 或外部系统",
                  )}
                </li>
                <li>
                  <b>{t("Batch pricing, saved compare & alerts", "批量查价、快照对照与监控告警")}</b>
                  {t(
                    " — CSV batch runs, two-sided variance compare, and signed webhook watchlists",
                    "——支持 20 项 CSV 批量核价、双侧变体对照与 HMAC 签名告警推送",
                  )}
                </li>
                <li>
                  <b>{t("Full exports & audit ledger", "CSV / JSON 导出与清晰账本")}</b>
                  {t(
                    " — atomic claim settlement, 10-minute free reuse, and immutable credit buckets",
                    "——异步结果显式领取扣费、10 分钟内复用免费、流水不可篡改",
                  )}
                </li>
              </ul>
            </div>
            <div className="card mt-18">
              <h3>{t("Straight about billing & privacy", "关于计费与隐私承诺")}</h3>
              <p>
                {t(
                  "Failed queries and low-sample (<8 verified sales) results are never charged. Identical searches repeat free within 10 minutes. Session cookies are HttpOnly and CSRF-protected; email verification and reset tokens use single-use hashes.",
                  "查询失败与不足 8 条的低样本结果永不扣费；10 分钟内同参数复取免费。浏览器会话全程 HttpOnly 与 CSRF 防护，邮件与重置验证码均为单次哈希生效。",
                )}
              </p>
            </div>
          </div>
        </div>
      </section>
    );
  } else {
    const accountGroups: Array<[string, ReadonlyArray<Page>]> = [
      [
        t("Overview & Research", "概览与研究"),
        ["/account", "/account/queries", "/account/saved", "/account/history", "/account/alerts"],
      ],
      [
        t("Workbenches & Verticals", "工作台与垂类"),
        [
          "/account/lookup",
          "/account/batches",
          "/account/inventory",
          "/account/sites",
          "/account/marketplaces",
          "/account/cards",
          "/account/auctions",
        ],
      ],
      [t("Usage & API", "用量与接口"), ["/account/usage", "/account/logs", "/account/keys"]],
      [t("Billing & Security", "账单与安全"), ["/account/billing", "/account/security"]],
    ];
    content = (
      <section className="acct-shell">
        <aside className="acct-side">
          <nav className="side-inner" aria-label={t("Account navigation", "账户导航")}>
            {accountGroups.map(([groupLabel, targets]) => (
              <div key={groupLabel}>
                <div className="acct-group">{groupLabel}</div>
                {targets.map((target) => (
                  <a key={target} aria-current={page === target ? "page" : undefined} href={link(target)}>
                    {headings[target]?.[zh ? 1 : 0]}
                  </a>
                ))}
                {groupLabel === t("Usage & API", "用量与接口") && (
                  <a href={link("/playground")}>{t("API Playground", "API 调试台")}</a>
                )}
                {groupLabel === t("Billing & Security", "账单与安全") && (
                  <a href={link("/support")}>{t("Support", "支持")}</a>
                )}
              </div>
            ))}
            <div className="acct-group">{t("Site", "站点")}</div>
            <a href={link("/")}>{t("← Back to site", "← 返回主站")}</a>
          </nav>
        </aside>
        <div className="acct-main account-main">
          <div className="acct-head">
            <h1>{title}</h1>
            <div className="actions">
              <a className="btn brand" href={resume("/search")}>
                {t("New search", "开始查价")}
              </a>
              <button className="btn ghost" type="button" data-logout="" hidden>
                {t("Sign out", "退出登录")}
              </button>
            </div>
          </div>
          {status}
          <div data-results="" />
        </div>
      </section>
    );
  }
  const announcements = blocks.filter((b) => b.kind === "announcement");
  const headerAnn = announcements.length > 0 ? announcements : page === "/" ? sections.slice(0, 1) : [];
  return (
    "<!doctype html>" +
    renderToStaticMarkup(
      <html lang={locale}>
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <meta name="robots" content="noindex,nofollow" />
          <link rel="icon" href="data:," />
          {editorial && editorial.path !== "/404" && (
            <>
              <link rel="canonical" href={editorialUrl(locale, editorial.path)} />
              <link rel="alternate" hrefLang="en" href={editorialUrl("en", editorial.path)} />
              <link rel="alternate" hrefLang="zh-CN" href={editorialUrl("zh-CN", editorial.path)} />
            </>
          )}
          <title>{`${title} · SoldBench`}</title>
          <link rel="stylesheet" href="/assets/soldbench.css" />
          <script src="/assets/soldbench.js" type="module" />
        </head>
        <body
          data-page={editorial?.path === "/worth" ? "/worth" : page}
          data-prefix={prefix}
          data-result-id={resultId}
        >
          <a className="skip" href="#main">
            {t("Skip to content", "跳到正文")}
          </a>
          {page !== "/docs" &&
            !page.startsWith("/account") &&
            page !== "/operations" &&
            page !== "/admin/content" &&
            headerAnn.slice(0, 1).map((entry) => (
              <div className="ann-bar" key={entry.slug}>
                <strong>{entry.title}</strong> — {entry.body}{" "}
                <a href={link("/changelog")}>{t("See the changelog", "查看更新记录")}</a>
              </div>
            ))}
          {page !== "/docs" && (
            <header className="site">
              <div className="wrap">
                <nav className="nav" aria-label={t("Main navigation", "主导航")}>
                  <a className="logo" href={link("/")}>
                    <BrandLogo size={27} />
                    SoldBench
                  </a>
                  <div className="nav-links">{nav}</div>
                  <div className="nav-right">
                    <a className="btn ghost" data-language="" href={other} hrefLang={zh ? "en" : "zh-CN"}>
                      {t("简体中文", "English")}
                    </a>
                    <a className="btn ghost desktop" data-resume="/login" href={resume("/login")}>
                      {t("Sign in", "登录")}
                    </a>
                    <a className="btn brand desktop" data-resume="/register" href={resume("/register")}>
                      {t("Get started free", "免费开始")}
                    </a>
                    <div className="acct-menu" data-acct-menu="" hidden>
                      <button
                        type="button"
                        className="acct-menu-btn"
                        data-acct-toggle=""
                        aria-expanded="false"
                      >
                        <span className="avatar" data-acct-avatar="">
                          U
                        </span>
                        <span data-acct-label="">{t("Account", "账户")}</span>
                      </button>
                      <div className="acct-menu-list" data-acct-list="" hidden>
                        <a href={link("/account")}>{t("Overview", "账户概览")}</a>
                        <a href={link("/search")}>{t("Search workbench", "查价工作台")}</a>
                        <a href={link("/account/keys")}>{t("API keys", "API 密钥")}</a>
                        <a href={link("/account/usage")}>{t("Usage & ledger", "用量与账本")}</a>
                        <a href={link("/account/billing")}>{t("Billing", "账单与额度")}</a>
                        <a href={link("/account/security")}>{t("Security", "账户安全")}</a>
                        <div className="sep" />
                        <a href={link("/operations")}>{t("Operations console", "运营控制台")}</a>
                        <button type="button" data-nav-logout="">
                          {t("Sign out", "退出登录")}
                        </button>
                      </div>
                    </div>
                    <details className="mobile">
                      <summary className="btn ghost">{t("Menu", "菜单")}</summary>
                      <div>
                        {nav}
                        <a data-resume="/login" href={resume("/login")}>
                          {t("Sign in", "登录")}
                        </a>
                        <a data-resume="/register" href={resume("/register")}>
                          {t("Create account", "创建账户")}
                        </a>
                      </div>
                    </details>
                  </div>
                </nav>
              </div>
            </header>
          )}
          <main id="main">{content}</main>
          {page !== "/docs" &&
            !page.startsWith("/account") &&
            page !== "/operations" &&
            page !== "/admin/content" && (
              <SiteFooter
                locale={locale}
                link={link}
                footerBlocks={footer.length > 0 ? <div className="foot-extra">{footer}</div> : null}
              />
            )}
          <div className="modal-bg" data-modal-bg="" hidden>
            <div className="modal" data-modal-box="" />
          </div>
          <div className="udrawer-bg" data-udrawer-bg="" hidden />
          <aside className="udrawer" data-udrawer="" aria-label={t("User 360 view", "用户全景")} hidden />
          <div className="toast" data-toast="" role="status" aria-live="polite" />
        </body>
      </html>,
    )
  );
}

export function renderHome(locale: Locale) {
  return renderPage(locale, "/", new URL("http://localhost/"));
}
