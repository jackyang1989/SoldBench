import { readFileSync } from "node:fs";
import type { Locale } from "@soldbench/shared";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type DocsView, Documentation } from "./developer.tsx";
import { Editorial, type EditorialView, editorialUrl } from "./editorial.tsx";
import { BrandLogo, HomeSections, type HomeShowcase, SiteFooter } from "./home.tsx";

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
      <a className={isNavOn("/categories") ? "on" : undefined} href={link("/categories")}>
        {t("Categories", "类目")}
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
        {t("Agents", "Agent")}
      </a>
      <a className={isNavOn("/alternatives") ? "on" : undefined} href={link("/alternatives")}>
        {t("Compare", "对比")}
      </a>
      <a className={isNavOn("/account") ? "on" : undefined} href={link("/account")}>
        {t("Dashboard", "账户")}
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
  } else if (page === "/categories" || page === "/data-availability") {
    content = (
      <>
        <section className="page-head">
          <div className="wrap">
            <p className="eyebrow">
              {page === "/categories" ? t("Categories", "开放类目") : t("Data availability", "数据可用性")}
            </p>
            <h1>{title}</h1>
            <p className="sub">
              {page === "/categories"
                ? t(
                    "Browse enabled eBay US research categories, supported time windows (30/90 days), and live source readiness.",
                    "浏览已开放的 eBay 美国站研究类目、支持的时间窗口（30/90 天）以及当前数据源可用状态。",
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
          </div>
        </section>
      </>
    );
  } else if (page === "/methodology") {
    const methods = [
      [
        "meth-comp",
        t("Comparable sales", "可比成交"),
        t(
          "Start with the market, requested window, model, edition or grade. Listings may appear more than once in the source. We deduplicate sale events before counting them. A conflicting model or version takes a record out of the comparable sample.",
          "先确定站点、查询窗口、型号、版本或评级。来源可能重复展示同一刊登，统计先按成交事件去重。型号或版本冲突的记录不进入可比样本。",
        ),
      ],
      [
        "meth-price",
        t("Verified price", "核验价格"),
        t(
          "An accepted Best Offer needs evidence of the actual paid price. If you select item plus observed shipping, the shipping amount must also be known. Unconfirmed prices and unknown shipping stay out of the corresponding price calculation.",
          "Best Offer 需有实际接受金额的证据。选择商品价加已观察运费时，所需运费也必须已知。未经核验的金额和未知的所需运费不会进入对应价格统计。",
        ),
      ],
      [
        "meth-median",
        t("Median and typical range", "中位价与典型区间"),
        t(
          "We use the complete qualified snapshot and integer cents. The typical range uses the 25th and 75th percentiles with Type 7 interpolation. The trimmed mean removes floor(5% × n) values from each end. A sample with fewer than eight verified prices has no central estimate.",
          "使用完整合格快照与整数分。典型区间为 Type 7 插值的第 25 与第 75 百分位。截尾均价从两端各去掉 floor(5% × n) 条。核验价格不足 8 条时不计算中心估计。",
        ),
      ],
      [
        "meth-cov",
        t("Coverage and exclusions", "覆盖与排除"),
        t(
          "The results show how many sales we observed, how many are comparable, and how many have a verified price for the selected basis. Use the date of the snapshot when citing results. The original and adjusted views are both available to export when your account has access.",
          "结果显示已观察、可比及符合所选口径的核验价格数量。引用时请附快照日期。有权访问完整样本的账户可导出原快照或调整视图。",
        ),
      ],
    ];
    content = (
      <>
        <section className="page-head">
          <div className="wrap">
            <p className="eyebrow">{t("Methodology", "方法论规范")}</p>
            <h1>{title}</h1>
            <div className="inshort mt-18">
              <b>{t("In short:", "核心摘要：")}</b>{" "}
              {t(
                "a SoldBench median comes only from verified, comparable completed sales in integer USD cents using Type 7 quantiles. Fewer than 8 verified sales never produce a center estimate.",
                "SoldBench 中位价仅基于核验且可比的实际成交记录（整数美元分），采用 Type 7 插值计算；不足 8 条有效成交绝不强行给出中心估计。",
              )}
            </div>
          </div>
        </section>
        <section className="blk blk-tight-top">
          <div className="wrap">
            <div className="docs-layout">
              <div className="otp">
                <h4>{t("On this page", "本页内容")}</h4>
                {methods.map(([id, heading], idx) => (
                  <a key={id} href={`#${id}`}>{`${idx + 1}. ${heading}`}</a>
                ))}
                <a href="#meth-layers">{`5. ${t("Price status layers", "价格可信度分层")}`}</a>
                <a href="#meth-rules">{`6. ${t("Exclusion rules", "清洗排除规则")}`}</a>
              </div>
              <article className="docs-body">
                {methods.map(([id, heading, copy]) => (
                  <section className="card mt-16 published-section" id={id} key={id}>
                    <h2>{heading}</h2>
                    <p>{copy}</p>
                  </section>
                ))}
                <section className="card mt-16" id="meth-layers">
                  <h2>{t("Price status layers", "价格可信度分层")}</h2>
                  <div className="dtable mt-12">
                    <div className="dt-h">
                      <span className="dt-c">{t("Layer", "价格层级")}</span>
                      <span className="dt-c">{t("Meaning", "含义")}</span>
                      <span className="dt-c">{t("In statistics?", "计入默认统计？")}</span>
                    </div>
                    <div className="dt-r">
                      <span className="dt-c">
                        <code>verified_actual</code>
                      </span>
                      <span className="dt-c">{t("Actual paid amount is known", "实际成交实付价已知")}</span>
                      <span className="dt-c">
                        <span className="badge badge-green">{t("Yes", "是")}</span>
                      </span>
                    </div>
                    <div className="dt-r">
                      <span className="dt-c">
                        <code>unknown_best_offer</code>
                      </span>
                      <span className="dt-c">
                        {t("Best Offer accepted; actual amount undisclosed", "议价成交但实际金额未公开")}
                      </span>
                      <span className="dt-c">
                        <span className="badge badge-gray">{t("Diagnostics only", "仅限诊断")}</span>
                      </span>
                    </div>
                    <div className="dt-r">
                      <span className="dt-c">
                        <code>listing_only</code>
                      </span>
                      <span className="dt-c">{t("Display / asking price only", "仅展示挂牌出价")}</span>
                      <span className="dt-c">
                        <span className="badge badge-gray">{t("Never", "永不计入")}</span>
                      </span>
                    </div>
                  </div>
                </section>
                <section className="card mt-16" id="meth-rules">
                  <h2>{t("Exclusion rules", "清洗排除规则")}</h2>
                  <div className="dtable cols-2 mt-12">
                    <div className="dt-h">
                      <span className="dt-c">{t("Reason", "规则与原因")}</span>
                      <span className="dt-c">{t("Handling", "处理方式")}</span>
                    </div>
                    {[
                      [
                        t(
                          "Hard attribute mismatch (grade, capacity, model, edition)",
                          "商品强属性冲突（评级、容量、型号、版本不匹配）",
                        ),
                        t("Excluded from comparable set", "移出可比样本集"),
                      ],
                      [
                        t(
                          "Multi-item lot, parts-only, or accessory listing",
                          "多件捆绑套装、仅零件或配件刊登",
                        ),
                        t("Excluded from comparable set", "移出可比样本集"),
                      ],
                      [
                        t("Duplicate observation of the same sale event", "同一成交事件重复观测"),
                        t("Deduplicated before statistics", "统计前自动归并去重"),
                      ],
                      [
                        t(
                          "Unknown Best Offer price or missing required shipping",
                          "议价实价未披露或缺少所需运费",
                        ),
                        t("Kept in diagnostics; never zero-filled", "留存诊断面板；绝不补零"),
                      ],
                    ].map(([rule, act]) => (
                      <div className="dt-r" key={rule}>
                        <span className="dt-c">{rule}</span>
                        <span className="dt-c">{act}</span>
                      </div>
                    ))}
                  </div>
                </section>
                <div className="actions mt-20">
                  <a className="btn brand" href={link("/search")}>
                    {t("Search sold prices", "查询成交价")}
                  </a>
                  <a className="btn ghost" href={link("/support")}>
                    {t("Report a data issue", "报告数据问题")}
                  </a>
                </div>
              </article>
              <aside className="docs-otp">
                <div className="card">
                  <h3>{t("Try the workbench", "试用研究工作台")}</h3>
                  <p className="small mt-8">
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
    content = (
      <>
        <section className="page-head">
          <div className="wrap">
            <div className="agents-hero-grid">
              <div>
                <p className="eyebrow">{t("AI & Agents", "AI 与 Agent 集成")}</p>
                <h1>{title}</h1>
                <p className="sub">
                  {zh ? (
                    <>
                      通过托管 MCP（OAuth 2.1/PKCE 或 API Key）或 REST API{" "}
                      <span className="mono">/v1/sold</span> 接入 Claude、Cursor
                      及自定义智能体工作流。完全复用同一规则、账本与计费约束。
                    </>
                  ) : (
                    <>
                      Connect Claude, Cursor, ChatGPT, or custom LLM workflows over Hosted MCP (
                      <span className="mono">/mcp</span> with OAuth 2.1/PKCE or API key) or REST (
                      <span className="mono">/v1/sold</span>). One rule set, one ledger, max 1 credit per
                      valid delivered search.
                    </>
                  )}
                </p>
                <div className="actions mt-24">
                  <a className="btn btn-brand" href={zh ? "/docs/zh-CN/mcp" : "/docs/en/mcp"}>
                    {t("Explore MCP documentation →", "查阅 MCP 接入指南 →")}
                  </a>
                  <a className="btn btn-ghost" href={link("/playground")}>
                    {t("Open Playground", "打开调试台")}
                  </a>
                  <a className="btn btn-ghost" href="/.well-known/skills/soldbench/SKILL.md">
                    {t("Agent Skill (SKILL.md)", "Agent Skill 规范")}
                  </a>
                </div>
              </div>
              <div className="codeblock cap">
                <div className="cb-head">
                  <span>{t("MCP · sold_search example", "MCP · sold_search 示例调用")}</span>
                  <button type="button" className="copy-btn" data-copy="#agentHeroCode">
                    {t("Copy", "复制")}
                  </button>
                </div>
                <pre id="agentHeroCode">{`{
  "tool": "sold_search",
  "arguments": {
    "q": "Nintendo Switch OLED",
    "window_days": 90,
    "limit": 50
  }
}

# Verified response invariants:
# - median_cents = null if n_price_verified < 8
# - quality.total_score = null (no fake composite)
# - query_id & candidate_set_hash included`}</pre>
              </div>
            </div>
          </div>
        </section>

        <section className="blk blk-tight-top">
          <div className="wrap ag-stack">
            <div className="grid3 eq">
              <article className="card">
                <p className="eyebrow">{t("Integration guide", "集成指令")}</p>
                <h2 className="mt-8">Agent Skill</h2>
                <p>
                  {t(
                    "Use the integration guide to generate a server-side client and handle async results and claims.",
                    "使用集成指南生成服务端客户端，并处理异步结果和显式领取。",
                  )}
                </p>
                <p className="card-foot">
                  <a href="/.well-known/skills/soldbench/SKILL.md">SKILL.md</a>
                </p>
              </article>
              <article className="card">
                <p className="eyebrow">{t("Model Context Protocol", "托管工具协议")}</p>
                <h2 className="mt-8">MCP</h2>
                <p>
                  {t(
                    "Connect a host to the local tool server. Query and read approved snapshots with the same account permissions and billing rules.",
                    "将宿主连接至本机工具服务。查询与读取获准快照时，沿用同一账户权限及计费规则。",
                  )}
                </p>
                <p className="card-foot">
                  <a href={zh ? "/docs/zh-CN/mcp" : "/docs/en/mcp"}>{t("Connect MCP", "接入 MCP")}</a>
                </p>
              </article>
              <article className="card">
                <p className="eyebrow">{t("Interactive testing", "在线调试")}</p>
                <h2 className="mt-8">REST API</h2>
                <p>
                  {t(
                    "Run the first synthetic query through the API Playground. Inspect actual status codes, response headers and request IDs.",
                    "通过 API 调试台运行首次合成查询，核对实际状态码、响应头和请求编号。",
                  )}
                </p>
                <p className="card-foot">
                  <a href={link("/playground")}>{t("Open Playground", "打开调试台")}</a>
                </p>
              </article>
            </div>

            <div className="card">
              <h2>{t("Ways to connect", "接入方式对照")}</h2>
              <div className="dtable mt-12">
                <div className="dt-h">
                  <span className="dt-c">{t("Method", "方式")}</span>
                  <span className="dt-c">{t("Best for", "适用场景")}</span>
                  <span className="dt-c">{t("Auth & billing", "认证与计费")}</span>
                </div>
                <div className="dt-r">
                  <span className="dt-c">
                    <b>{t("Hosted MCP Server", "托管 MCP 服务")}</b>
                  </span>
                  <span className="dt-c">
                    {t("Claude, Cursor & MCP hosts", "Claude / Cursor 等桌面客户端")}
                  </span>
                  <span className="dt-c">
                    {t(
                      "OAuth 2.1 / PKCE or Bearer key · 1 credit / search",
                      "OAuth 2.1/PKCE 或 API Key · 同口径扣费",
                    )}
                  </span>
                </div>
                <div className="dt-r">
                  <span className="dt-c">
                    <b>{t("REST API v1", "REST API v1")}</b>
                  </span>
                  <span className="dt-c">
                    {t("Custom backend tools & pipelines", "自研后端服务与批量工作流")}
                  </span>
                  <span className="dt-c">
                    {t("Bearer API key · async claim at 0 extra cost", "Bearer API Key · 支持显式领取")}
                  </span>
                </div>
                <div className="dt-r">
                  <span className="dt-c">
                    <b>{t("Machine-readable docs", "机器可读规范")}</b>
                  </span>
                  <span className="dt-c">OpenAPI, SKILL.md, llms.txt</span>
                  <span className="dt-c">{t("Public read-only specifications", "公开只读规范文档")}</span>
                </div>
              </div>
            </div>

            <div className="grid2 eq">
              <div className="card">
                <p className="eyebrow">{t("Reference answer", "规范回答示例")}</p>
                <h3 className="mt-8">{t("Paste-in system instruction", "系统提示词模板")}</h3>
                <div className="codeblock cbwrap mt-12">
                  <div className="cb-head">
                    <span>{t("Agent instructions", "Agent 指令模板")}</span>
                    <button type="button" className="copy-btn" data-copy="#agentPromptCode">
                      {t("Copy", "复制")}
                    </button>
                  </div>
                  <pre id="agentPromptCode">{`When pricing an item, query SoldBench before answering:
1. Call sold_search (or GET /v1/sold) with exact model/grade keywords.
2. Quote the clean median, P25–P75 range, and n_price_verified count.
3. If median_cents is null (n < 8), report insufficient verified sample honestly.
4. Cite query_id and data_as_of from meta.`}</pre>
                </div>
              </div>
              <div className="card">
                <p className="eyebrow">{t("Good behavior", "输出质量示例")}</p>
                <h3 className="mt-8">{t("Verified answer format", "符合规范的回答示例")}</h3>
                <div className="ag-answer">
                  {t(
                    "Across 8 verified eBay US completed sales in the snapshot, the clean median is $274.00 with a typical range of $272.25–$275.75 (5% trimmed mean $274.00). Conflicting bundles and undisclosed Best Offer amounts were isolated. Reference: query_id & candidate_set_hash attached.",
                    "基于该快照中 8 条已核验 eBay 美国站实际成交记录，净中位价为 $274.00，典型区间 $272.25–$275.75（5% 截尾均价 $274.00）。未核实议价与非同类样本已排除，附 query_id 与候选集哈希可供追溯。",
                  )}
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
    content = (
      <section className="wrap account-layout">
        <aside className="docs-sidebar">
          <nav aria-label={t("Operator navigation", "运营导航")}>
            <a href={link("/operations")}>{t("Operations", "运营中心")}</a>
            <a href={zh ? "/admin/content?lang=zh-CN" : "/admin/content"}>
              {t("Content studio", "内容中心")}
            </a>
          </nav>
        </aside>
        <div className="account-main">
          <h1>{title}</h1>
          {status}
          <div className="actions" data-ops-tabs="" data-panel={url.pathname.split("/").at(-1)}>
            {[
              ["overview", t("Overview", "概览")],
              ["users", t("Users", "用户")],
              ["approvals", t("Approvals", "待审批")],
              ["incidents", t("Incidents", "事件")],
              ["sources", t("Sources", "数据源")],
              ["jobs", t("Jobs", "作业")],
              ["billing", t("Reconciliation", "对账")],
              ["recovery", t("Payment recovery", "付款恢复")],
              ["support", t("Support queue", "支持工单")],
              ["audit", t("Audit log", "审计日志")],
              ["settings", t("Settings", "系统设置")],
              ["monitoring", t("Monitoring", "监控")],
              ["api", t("API metrics", "API 指标")],
              ["collector", t("Collection runs", "采集运行")],
              ["records", t("Sale evidence", "成交证据")],
              ["rules", t("Rule versions", "规则版本")],
              ["coverage", t("Coverage", "覆盖")],
              ["quality", t("Quality", "质量")],
              ["growth", t("Activity", "活动")],
              ["costs", t("Budget and costs", "预算与成本")],
            ].map(([view, label]) => (
              <button
                key={view}
                className="btn ghost"
                data-ops-view={view}
                type="button"
                hidden={!["overview", "sources", "jobs", "billing", "support", "audit"].includes(view ?? "")}
              >
                {label}
              </button>
            ))}
          </div>
          <div data-results="" />
        </div>
      </section>
    );
  } else if (page === "/admin/content") {
    content = (
      <section className="wrap workbench">
        <h1>{title}</h1>
        <a href={link("/operations")}>{t("Operations", "运营中心")}</a>
        {status}
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
                <option value="offer_copy" data-fields="position reference_key" data-required="reference_key">
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
                <option value="status_incident" data-fields="reference_key" data-required="reference_key">
                  {t("Incident copy", "事件说明")}
                </option>
                <option value="about">{t("About", "关于")}</option>
                <option value="terms" data-fields="policy_version reference" data-required="policy_version">
                  {t("Terms version", "条款版次")}
                </option>
                <option value="privacy" data-fields="policy_version reference" data-required="policy_version">
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
      </section>
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
    const illustrativePlans = [
      {
        name: t("Free", "免费体验"),
        price: "$0",
        per: t("/ mo", "/ 月"),
        credits: t("100 credits / mo", "每月 100 额度"),
        rate: "30 req/min",
        feats: [
          t("Up to 200 comps per search", "每次最多返回 200 条可比成交"),
          t("Full evidence pack included", "全部结果随附完整证据包"),
          t("Web workbench + API + MCP", "覆盖网页端、API 与 MCP"),
        ],
        pop: false,
      },
      {
        name: "Starter",
        price: "$9",
        per: t("/ mo", "/ 月"),
        credits: t("2,000 credits / mo", "每月 2,000 额度"),
        rate: "60 req/min",
        feats: [
          t("10-minute identical reuse free", "10 分钟内同参数复用免费"),
          t("Full CSV & JSON exports", "支持权威/调整双视图导出"),
          t("Saved snapshots & compare", "支持保存快照与双侧对比"),
        ],
        pop: false,
      },
      {
        name: "Pro",
        price: "$29",
        per: t("/ mo", "/ 月"),
        credits: t("10,000 credits / mo", "每月 10,000 额度"),
        rate: "300 req/min",
        feats: [
          t("Priority async queue & claim", "优先异步队列与显式领取"),
          t("Batch pricing & webhook alerts", "支持批量查价与 Webhook 告警"),
          t("Email & ticket priority SLA", "工单优先支持响应"),
        ],
        pop: true,
      },
      {
        name: t("Top-up", "永久加量包"),
        price: "$10",
        per: t("one-time", "一次性"),
        credits: t("1,500 credits", "1,500 额度"),
        rate: t("Never expires", "永久有效"),
        feats: [
          t("Stacks on any active tier", "可叠加至任意活跃套餐"),
          t("Drawn after subscription bucket", "在订阅与活动桶之后扣除"),
          t("Refunds return to same bucket", "退款原路径退回所属额度桶"),
        ],
        pop: false,
      },
    ];
    content = (
      <>
        <section className="page-head">
          <div className="wrap">
            <p className="eyebrow">{t("Pricing", "定价与额度")}</p>
            <h1>{title}</h1>
            <p className="sub">
              {t(
                "One valid delivered search costs at most one credit — whether returning 1 or 200 comps.",
                "符合条件的标准查价，在领取交付结果时最多扣除 1 个额度（每次最多返回 200 条）。",
              )}
            </p>
            {status}
            <div className="inshort mt-20">
              <b>{t("In short:", "计费规则速览：")}</b>{" "}
              {t(
                "waiting in an async queue, failed lookups, low-sample (<8 verified sales) results, and duplicate re-fetches within 10 minutes are all free. Credits settle atomically only when a deliverable result is claimed.",
                "异步等待、失败、不足 8 条的低样本结果以及 10 分钟内同参数复取均不扣费；异步任务仅在显式领取可交付结果时原子扣除 1 额度。",
              )}
            </div>
          </div>
        </section>

        <section className="blk blk-tight-top pricing-page">
          <div className="wrap">
            <h2 id="pricing-offer-title">{t("Plans and credit packs", "套餐与额度包")}</h2>
            <p className="mt-8" data-pricing-state="">
              {t("Commercial pricing is pending approval.", "正式定价有待审批。")}
            </p>
            <div className="grid3 mt-16" data-pricing-offers="" />
            <div className="actions mt-16" data-pricing-actions="">
              <a className="btn brand" href={link("/search")}>
                {t("Try a lookup", "试用查价")}
              </a>
              <a className="btn ghost" href={link("/login")}>
                {t("Sign in to view account billing", "登录查看账单")}
              </a>
            </div>

            <div className="mt-30">
              <p className="eyebrow">
                {t(
                  "Illustrative schedule (pending final commercial approval)",
                  "参考档位概览（待最终商业审批发布）",
                )}
              </p>
              <div className="grid4 eq mt-16">
                {illustrativePlans.map((plan) => (
                  <div className={`card price-card${plan.pop ? " pop" : ""}`} key={plan.name}>
                    {plan.pop && <span className="pop-tag">{t("MOST POPULAR", "最受欢迎")}</span>}
                    <p className={`eyebrow${plan.pop ? " eyebrow-brand" : ""}`}>{plan.name}</p>
                    <div className="price-amt-row">
                      <span className="amt">{plan.price}</span> <span className="small">{plan.per}</span>
                    </div>
                    <p>
                      <b>{plan.credits}</b> · {plan.rate}
                    </p>
                    <ul>
                      {plan.feats.map((feat) => (
                        <li key={feat}>{feat}</li>
                      ))}
                    </ul>
                    <a className={plan.pop ? "btn btn-brand" : "btn btn-ghost"} href={link("/register")}>
                      {t("Create account", "创建账户")}
                    </a>
                  </div>
                ))}
              </div>
            </div>

            <h2 className="mt-36">{t("Plans side by side", "档位详细对照")}</h2>
            <div className="live-card mt-12">
              <div className="table-scroll">
                <table className="mini-table">
                  <thead>
                    <tr>
                      <th>{t("Tier", "套餐")}</th>
                      <th className="num">{t("Indicative rate", "参考价格")}</th>
                      <th className="num">{t("Credits", "包含额度")}</th>
                      <th className="num">{t("Per 1,000 searches", "每千次参考单价")}</th>
                      <th>{t("Rate limit", "速率限制")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Free</td>
                      <td className="num">$0</td>
                      <td className="num">100</td>
                      <td className="num">$0.00</td>
                      <td>30 req/min</td>
                    </tr>
                    <tr>
                      <td>Starter</td>
                      <td className="num">$9</td>
                      <td className="num">2,000</td>
                      <td className="num">$4.50</td>
                      <td>60 req/min</td>
                    </tr>
                    <tr>
                      <td>
                        <b>Pro</b>
                      </td>
                      <td className="num">$29</td>
                      <td className="num">10,000</td>
                      <td className="num">$2.90</td>
                      <td>300 req/min</td>
                    </tr>
                    <tr>
                      <td>{t("Top-up pack", "加量包")}</td>
                      <td className="num">$10</td>
                      <td className="num">1,500</td>
                      <td className="num">$6.67</td>
                      <td>{t("Never expires", "永不过期")}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <h2 className="mt-36">{t("What costs a credit?", "扣费明细与额度桶消耗顺序")}</h2>
            <div className="grid2 eq mt-16">
              <div className="card">
                <h3>{t("The billing rules", "动作与扣费对应关系")}</h3>
                <div className="dtable cols-2 mt-12">
                  {[
                    [
                      t("Valid delivered search (1–200 comps)", "有效交付查价（最多 200 条）"),
                      t("1 credit", "1 额度"),
                    ],
                    [
                      t("Low-sample result (<8 verified prices)", "不足 8 条核验样本的低样本结果"),
                      t("0 credits", "0 额度（免费）"),
                    ],
                    [
                      t("Identical repeat within 10 minutes", "10 分钟内同 owner 同规范参数复取"),
                      t("0 credits", "0 额度（免费）"),
                    ],
                    [
                      t("Async job queueing, polling & expiry", "异步排队、轮询与未领取过期"),
                      t("0 credits", "0 额度（免费）"),
                    ],
                    [
                      t("Best Offer verification & stale consent", "Best Offer 后置核验与获准陈旧缓存"),
                      t("0 extra credits", "0 额外额度"),
                    ],
                  ].map(([action, cost]) => (
                    <div className="dt-r" key={action}>
                      <span className="dt-c">{action}</span>
                      <span className="dt-c num">{cost}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="card">
                <h3>{t("Balance buckets, in draw order", "多额度桶消耗优先级")}</h3>
                <p>
                  <b>{t("1 · Expiring buckets first", "1 · 有限期桶最早到期优先")}</b> —{" "}
                  {t(
                    "Promo and subscription credits draw in earliest-expiry order; on an identical expiry timestamp, subscription draws before promo.",
                    "促销桶与订阅桶均按最快到期优先扣除；若到期时间相同，优先消耗订阅额度。",
                  )}
                </p>
                <p className="mt-10">
                  <b>{t("2 · Purchased credits last", "2 · 购买加量包最后消耗")}</b> —{" "}
                  {t(
                    "Purchased credit packs never expire and survive subscription period-end cancellation.",
                    "购买的额度包长期有效，且订阅期末取消后购买桶依然可用。",
                  )}
                </p>
                <p className="mt-10">
                  {t(
                    "Credit ledger rows are append-only and immutable; eligible refunds return directly to the bucket originally charged.",
                    "流水只增不改；合规退款按原始扣费比例退回对应额度桶。",
                  )}
                </p>
              </div>
            </div>

            <div className="card mt-20">
              <h3>
                {t(
                  "One search, one credit — even for 200 comps",
                  "每次查价最多 1 额度——绝不按返回行数翻倍计费",
                )}
              </h3>
              <p>
                {t(
                  "Per-row billing turns every busy market into an unpredictable bill. SoldBench counts the search, not each individual comparable row inside the 200-item snapshot.",
                  "按行计费会让繁忙品类的账单成倍暴涨；SoldBench 只按次交付计费，单个合格快照内无论包含 10 条还是 200 条记录均只算 1 额度。",
                )}
              </p>
            </div>

            <section className="pricing-questions mt-30" aria-labelledby="pricing-questions-title">
              <h2 id="pricing-questions-title">{t("How credits work", "额度如何使用")}</h2>
              <dl>
                <div>
                  <dt>{t("What can I do for free?", "哪些操作免费？")}</dt>
                  <dd>
                    {t(
                      "Waiting for a result, failed searches, low-sample results, and eligible older results are free. Reopening or exporting an authorized result adds no charge.",
                      "等待、失败、低样本结果和获准查看的陈旧结果均免费。复取或导出获准的已交付结果不会再次扣费。",
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t("Where can I verify a charge?", "在哪里核对扣费？")}</dt>
                  <dd>
                    {t(
                      "Usage lists your credit buckets, expiry dates, and ledger entries. Billing shows the current order and payment status.",
                      "用量页列出额度桶、到期时间与流水。账单页可查看当前订单和付款状态。",
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t("What happens when I stop a subscription?", "取消续订后会怎样？")}</dt>
                  <dd>
                    {t(
                      "Period-end cancellation stops the next renewal. The current subscription remains available until the end of its period.",
                      "在期末取消将停止下次续费，本期权益可使用至当前周期结束。",
                    )}
                  </dd>
                </div>
              </dl>
            </section>

            <div className="card cta-card mt-30">
              <h2 className="serif cta-title">
                {t("Start testing in sandbox & offline mode", "在本地或沙盒环境开始测试")}
              </h2>
              <p className="small cta-sub">
                {t(
                  "Stripe primary payments, PayPal supplementary checkout, and immutable ledger accounting built into one flow.",
                  "内置 Stripe 主通道与 PayPal 补充通道校验、显式领取结算与不可变账本流水。",
                )}
              </p>
              <div className="cta-actions">
                <a className="btn btn-brand" href={link("/register")}>
                  {t("Create account", "创建账户")}
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
              {t(
                "Share the relevant request ID if you have it. Keep passwords, card numbers and API keys private.",
                "如有请求编号，请随工单附上。请妥善保管密码、银行卡号和 API 密钥。",
              )}
            </p>
          </div>
        </section>

        <section className="blk blk-tight-top">
          <div className="wrap">
            <div className="grid3 eq">
              <div className="card">
                <p className="eyebrow">{t("Direct contact", "邮件支持")}</p>
                <h3 className="mt-8">{t("Email support", "客服邮箱")}</h3>
                <p>
                  {t(
                    "Contact support@soldbench.com with your request ID for billing or data investigations.",
                    "发送邮件至 support@soldbench.com 并附上请求编号以核查账单或数据记录。",
                  )}
                </p>
                <p className="card-foot">
                  <a href="mailto:support@soldbench.com">support@soldbench.com →</a>
                </p>
              </div>
              <div className="card">
                <p className="eyebrow">{t("Self-service", "开发文档")}</p>
                <h3 className="mt-8">{t("Documentation", "接口与方法说明")}</h3>
                <p>
                  {t(
                    "Check error codes, Retry-After headers, async job states, and Best Offer verification docs.",
                    "查阅错误码说明、Retry-After 限流规则、异步任务状态机与议价核验说明。",
                  )}
                </p>
                <p className="card-foot">
                  <a href={zh ? "/docs/zh-CN/quickstart" : "/docs/en/quickstart"}>
                    {t("Read the docs →", "阅读文档 →")}
                  </a>
                </p>
              </div>
              <div className="card">
                <p className="eyebrow">{t("Privacy", "数据删除回执")}</p>
                <h3 className="mt-8">{t("Deletion status", "删除回执核验")}</h3>
                <p>
                  {t(
                    "Verify the current state of an account or data deletion request with your private receipt.",
                    "凭借私密删除回执令牌随时核对账户与数据清理进度。",
                  )}
                </p>
                <p className="card-foot">
                  <a href={link("/deletion-receipt")}>{t("Check a deletion receipt", "查询删除回执")}</a>
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
                  "Try the research API with your account session. Inspect the response and copy a server-side example.",
                  "使用当前账户会话调试研究接口，查看响应并复制服务端调用示例。",
                )}
              </p>
            )}
          </div>
        </section>
        <section className="blk blk-tight-top">
          <div className="wrap">
            <form action={link("/search")} method="get" data-search="">
              {searchBox}
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
                <label className="check">
                  <input
                    type="checkbox"
                    name="allow_stale"
                    defaultChecked={draft.get("allow_stale") === "true"}
                  />
                  {t("Allow older cached data", "允许使用较旧缓存")}
                </label>
              </div>
            </form>
            {examples}
            {status}
            <div className="actions" data-actions="" />
            {page === "/playground" && (
              <section className="card result-card" data-api-trace="">
                <h2>{t("Requests and responses", "请求与响应")}</h2>
                <div className="actions" data-trace-list="" />
                <details open className="mt-12">
                  <summary>{t("Response", "响应")}</summary>
                  <pre data-trace-body="">
                    {t("Run a search to inspect its response.", "提交查询后查看响应。")}
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
            )}
            <div data-results="" className="mt-16" />
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
    content = (
      <section className="wrap account-layout">
        <aside className="docs-sidebar">
          <nav aria-label={t("Account navigation", "账户导航")}>
            {(
              [
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
              ] as const
            ).map((target) => (
              <a key={target} aria-current={page === target ? "page" : undefined} href={link(target)}>
                {headings[target]?.[zh ? 1 : 0]}
              </a>
            ))}
            <a href={link("/support")}>{t("Support", "支持")}</a>
            <a href={link("/playground")}>{t("API Playground", "API 调试台")}</a>
          </nav>
        </aside>
        <div className="account-main">
          <h1>{title}</h1>
          {status}
          <div className="actions">
            <a className="btn brand" href={resume("/search")}>
              {t("New search", "开始查价")}
            </a>
            <button className="btn ghost" type="button" data-logout="" hidden>
              {t("Sign out", "退出登录")}
            </button>
          </div>
          <div data-results="" />
        </div>
      </section>
    );
  }
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
          <header className="site">
            {page === "/" &&
              sections.slice(0, 1).map((entry) => (
                <div className="ann-bar" key={entry.slug}>
                  <strong>{entry.title}</strong> — {entry.body}{" "}
                  <a href={link("/changelog")}>{t("See changelog", "查看更新记录")}</a>
                </div>
              ))}
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
                    {t("Get started", "开始使用")}
                  </a>
                  <div className="acct-menu" data-acct-menu="" hidden>
                    <button type="button" className="acct-menu-btn" data-acct-toggle="" aria-expanded="false">
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
          <main id="main">{content}</main>
          {!page.startsWith("/account") && page !== "/operations" && page !== "/admin/content" && (
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
