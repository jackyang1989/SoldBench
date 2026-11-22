import { readFileSync } from "node:fs";
import type { Locale } from "@soldbench/shared";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type DocsView, Documentation } from "./developer.tsx";
import { Editorial, type EditorialView, editorialUrl } from "./editorial.tsx";

export type { EditorialEntry, EditorialView } from "./editorial.tsx";

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
  const nav = (
    <>
      {navigation}
      <a href={link("/search")}>{t("Search", "查价")}</a>
      <a href={link("/categories")}>{t("Categories", "类目")}</a>
      <a href={link("/pricing")}>{t("Pricing", "定价")}</a>
      <a href={zh ? "/docs/zh-CN/quickstart" : "/docs/en/quickstart"}>{t("Docs", "文档")}</a>
      <a href={link("/agents")}>{t("Agents", "Agent")}</a>
      <a href={link("/account")}>{t("Dashboard", "账户")}</a>
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
      <>
        {sections.length > 0 && (
          <section className="wrap site-announcements" aria-label={t("Announcements", "公告")}>
            {sections.map((entry) => (
              <div className="notice" key={entry.slug}>
                <strong>{entry.title}</strong>
                <p>{entry.body}</p>
              </div>
            ))}
          </section>
        )}
        {blocks
          .filter((row) => row.kind === "home")
          .map((row) => (
            <section className="wrap published-section" key={row.slug}>
              <h2>{row.title}</h2>
              <p>{row.body}</p>
              {isDestination(row.target) && <a href={link(row.target)}>{t("Learn more", "了解更多")}</a>}
            </section>
          ))}
        <section className="hero">
          <div className="wrap hero-grid">
            <div>
              <p className="eyebrow">{t("Comparable sales research", "可比成交研究")}</p>
              <h1>
                {t("eBay sold prices, with the ", "eBay 成交价，附")}
                <span className="kw">{t("evidence", "可核查的证据")}</span>
                {t(" to back them.", "。")}
              </h1>
              <p className="sub">
                {t(
                  "Research comparable sales, understand the price range, and inspect the evidence behind each result.",
                  "查看可比成交、了解价格区间，并核查每个结果背后的证据。",
                )}
              </p>
              <form action={link("/search")} method="get" data-search="">
                {searchBox}
              </form>
              {examples}
              {market}
              {status}
              <div className="actions" data-actions="" />
            </div>
            <div>
              <div data-results="" />
              <aside className="live-card" data-hero-empty="">
                <div className="live-head">
                  <span>{t("Comparable sales", "可比成交")}</span>
                  <span className="badge">{t("Offline workspace", "离线工作区")}</span>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>{t("Title", "商品")}</th>
                        <th className="num">{t("Price", "价格")}</th>
                        <th>{t("Date", "日期")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td colSpan={3} className="empty">
                          {t(
                            "Search to see whether a cached result is available.",
                            "提交搜索，检查是否有可用的缓存结果。",
                          )}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div className="median-strip">
                  <div>
                    <b>{t("Median", "中位价")}</b>
                    <strong>—</strong>
                  </div>
                  <div>
                    <b>{t("Typical range", "典型区间")}</b>
                    <strong>—</strong>
                  </div>
                  <div>
                    <b>{t("Verified sample", "核验样本")}</b>
                    <strong>—</strong>
                  </div>
                </div>
              </aside>
            </div>
          </div>
        </section>
        <section className="band">
          <div className="wrap">
            <div className="blk-head">
              <p className="eyebrow">{t("Research workflow", "研究流程")}</p>
              <h2>{t("Search, review, and verify.", "从查价到核查证据。")}</h2>
            </div>
            <div className="grid3">
              <div className="card">
                <h3>{t("Price range", "价格区间")}</h3>
                <p>
                  {t(
                    "Review the median and typical range when the verified sample supports them.",
                    "在核验样本充足时查看中位价和典型区间。",
                  )}
                </p>
              </div>
              <div className="card">
                <h3>{t("Sale evidence", "成交证据")}</h3>
                <p>
                  {t(
                    "Inspect the comparable records and images available to your account.",
                    "核查账户有权读取的成交记录和主图。",
                  )}
                </p>
              </div>
              <div className="card">
                <h3>{t("Developer integration", "开发者集成")}</h3>
                <p>
                  {t(
                    "Use the shared result contract in REST and MCP.",
                    "通过 REST 和 MCP 使用同一结果契约。",
                  )}
                </p>
                <a href={zh ? "/docs/zh-CN/quickstart" : "/docs/en/quickstart"}>
                  {t("Quickstart", "快速开始")}
                </a>
              </div>
            </div>
          </div>
        </section>
        {blocks.some((row) => row.kind === "blog") && (
          <section className="wrap workbench">
            <h2>{t("Latest articles", "最新文章")}</h2>
            <div className="grid3">
              {blocks
                .filter((row) => row.kind === "blog")
                .slice(0, 3)
                .map((row) => (
                  <article className="card" key={row.slug}>
                    <h3>
                      <a href={link(`/blog/${row.slug}`)}>{row.title}</a>
                    </h3>
                  </article>
                ))}
            </div>
            <a href={link("/blog")}>{t("All articles", "全部文章")}</a>
          </section>
        )}
      </>
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
      <section className="wrap workbench">
        <h1>{title}</h1>
        {market}
        <div className="actions">
          <a className="btn ghost" href={link(page === "/categories" ? "/data-availability" : "/categories")}>
            {page === "/categories"
              ? t("Data availability", "数据可用性")
              : t("Research categories", "研究类目")}
          </a>
        </div>
        {status}
        <div className="grid3" data-results="" />
      </section>
    );
  } else if (page === "/methodology") {
    const methods = [
      [
        t("Comparable sales", "可比成交"),
        t(
          "Start with the market, requested window, model, edition or grade. Listings may appear more than once in the source. We deduplicate sale events before counting them. A conflicting model or version takes a record out of the comparable sample.",
          "先确定站点、查询窗口、型号、版本或评级。来源可能重复展示同一刊登，统计先按成交事件去重。型号或版本冲突的记录不进入可比样本。",
        ),
      ],
      [
        t("Verified price", "核验价格"),
        t(
          "An accepted Best Offer needs evidence of the actual paid price. If you select item plus observed shipping, the shipping amount must also be known. Unconfirmed prices and unknown shipping stay out of the corresponding price calculation.",
          "Best Offer 需有实际接受金额的证据。选择商品价加已观察运费时，所需运费也必须已知。未经核验的金额和未知的所需运费不会进入对应价格统计。",
        ),
      ],
      [
        t("Median and typical range", "中位价与典型区间"),
        t(
          "We use the complete qualified snapshot and integer cents. The typical range uses the 25th and 75th percentiles with Type 7 interpolation. The trimmed mean removes floor(5% × n) values from each end. A sample with fewer than eight verified prices has no central estimate.",
          "使用完整合格快照与整数分。典型区间为 Type 7 插值的第 25 与第 75 百分位。截尾均价从两端各去掉 floor(5% × n) 条。核验价格不足 8 条时不计算中心估计。",
        ),
      ],
      [
        t("Coverage and exclusions", "覆盖与排除"),
        t(
          "The results show how many sales we observed, how many are comparable, and how many have a verified price for the selected basis. Use the date of the snapshot when citing results. The original and adjusted views are both available to export when your account has access.",
          "结果显示已观察、可比及符合所选口径的核验价格数量。引用时请附快照日期。有权访问完整样本的账户可导出原快照或调整视图。",
        ),
      ],
    ];
    content = (
      <section className="wrap workbench">
        <h1>{title}</h1>
        {methods.map(([heading, copy]) => (
          <article key={heading} className="card result-card published-section">
            <h2>{heading}</h2>
            <p>{copy}</p>
          </article>
        ))}
        <div className="actions">
          <a className="btn brand" href={link("/search")}>
            {t("Search sold prices", "查询成交价")}
          </a>
          <a className="btn ghost" href={link("/support")}>
            {t("Report a data issue", "报告数据问题")}
          </a>
        </div>
      </section>
    );
  } else if (page === "/agents") {
    content = (
      <section className="wrap workbench">
        <h1>{title}</h1>
        <div className="grid3">
          <article className="card">
            <h2>Agent Skill</h2>
            <p>
              {t(
                "Use the integration guide to generate a server-side client and handle async results and claims.",
                "使用集成指南生成服务端客户端，并处理异步结果和显式领取。",
              )}
            </p>
            <a href="/.well-known/skills/soldbench/SKILL.md">SKILL.md</a>
          </article>
          <article className="card">
            <h2>MCP</h2>
            <p>
              {t(
                "Connect a host to the local tool server. Query and read approved snapshots with the same account permissions and billing rules.",
                "将宿主连接至本机工具服务。查询与读取获准快照时，沿用同一账户权限及计费规则。",
              )}
            </p>
            <a href={zh ? "/docs/zh-CN/mcp" : "/docs/en/mcp"}>{t("Connect MCP", "接入 MCP")}</a>
          </article>
          <article className="card">
            <h2>REST API</h2>
            <p>
              {t(
                "Run the first synthetic query through the API Playground. Inspect actual status codes, response headers and request IDs.",
                "通过 API 调试台运行首次合成查询，核对实际状态码、响应头和请求编号。",
              )}
            </p>
            <a href={link("/playground")}>{t("Open Playground", "打开调试台")}</a>
          </article>
        </div>
      </section>
    );
  } else if (page === "/guides" || page === "/faq") {
    content = (
      <section className="wrap workbench">
        <h1>{title}</h1>
        {sections.length ? (
          sections.map((entry) => (
            <article className="card result-card published-section" id={entry.slug} key={entry.slug}>
              <h2>{entry.title}</h2>
              <p>{entry.body}</p>
            </article>
          ))
        ) : (
          <p className="notice">{t("Nothing has been published here yet.", "此处暂未发布内容。")}</p>
        )}
      </section>
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
    content = (
      <section className="wrap workbench pricing-page">
        <h1>{title}</h1>
        <p className="lede">
          {t(
            "An eligible standard search costs up to one credit when you claim the result.",
            "符合条件的标准查价，在领取结果时最多扣 1 个额度。",
          )}
        </p>
        {status}
        <section aria-labelledby="pricing-offer-title">
          <h2 id="pricing-offer-title">{t("Plans and credit packs", "套餐与额度包")}</h2>
          <p data-pricing-state="">{t("Commercial pricing is pending approval.", "正式定价有待审批。")}</p>
          <div className="grid3" data-pricing-offers="" />
          <div className="actions" data-pricing-actions="">
            <a className="btn brand" href={link("/search")}>
              {t("Try a lookup", "试用查价")}
            </a>
            <a className="btn ghost" href={link("/login")}>
              {t("Sign in to view account billing", "登录查看账单")}
            </a>
          </div>
        </section>
        <section className="pricing-questions" aria-labelledby="pricing-questions-title">
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
      </section>
    );
  } else if (page === "/support") {
    content = (
      <section className="wrap auth-wrap">
        <div className="card auth-card">
          <h1>{title}</h1>
          <p>
            {t(
              "Share the relevant request ID if you have it. Keep passwords, card numbers and API keys private.",
              "如有请求编号，请随工单附上。请妥善保管密码、银行卡号和 API 密钥。",
            )}
          </p>
          <form data-support="" method="post">
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
          <div data-support-result="" />
        </div>
      </section>
    );
  } else if (research) {
    content = (
      <section className="wrap workbench">
        <p className="eyebrow">{t("Research workbench", "研究工作台")}</p>
        <h1>{title}</h1>
        {market}
        {page === "/playground" && (
          <p>
            {t(
              "Try the research API with your account session. Inspect the response and copy a server-side example.",
              "使用当前账户会话调试研究接口，查看响应并复制服务端调用示例。",
            )}
          </p>
        )}
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
            <details open>
              <summary>{t("Response", "响应")}</summary>
              <pre data-trace-body="">
                {t("Run a search to inspect its response.", "提交查询后查看响应。")}
              </pre>
            </details>
            <details>
              <summary>{t("Headers", "响应头")}</summary>
              <pre data-trace-headers="" />
            </details>
            <details>
              <summary>{t("Server-side cURL example", "服务端 cURL 示例")}</summary>
              <pre data-trace-code="" />
            </details>
          </section>
        )}
        <div data-results="" />
        <noscript>{t("Enable JavaScript to submit a search.", "请启用 JavaScript 后提交搜索。")}</noscript>
      </section>
    );
  } else if (auth) {
    const password = page === "/login" || page === "/register" || page === "/reset-password";
    const token = page === "/verify-email" || page === "/reset-password";
    content = (
      <section className="wrap auth-wrap">
        <div className="card auth-card">
          <h1>{title}</h1>
          {page === "/register" && (
            <p>
              {t(
                "Create a local test account. Verification messages go to the local test outbox.",
                "创建本机测试账户。验证邮件进入本机测试发件箱。",
              )}
            </p>
          )}
          <form data-auth={page.slice(1)} method="post">
            {!token && (
              <label>
                {t("Email address", "邮箱")}
                <input name="email" type="email" required autoComplete="email" />
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
                />
              </label>
            )}
            {page === "/register" && (
              <label className="check">
                <input type="checkbox" name="consent" required />
                {t("I agree to use this account for local testing only.", "我同意此账户仅用于本机测试。")}
              </label>
            )}
            <button className="btn brand" type="submit">
              {title}
            </button>
          </form>
          {status}
          <div className="actions" data-actions="">
            {page !== "/login" && <a href={resume("/login")}>{t("Sign in", "登录")}</a>}
            {page === "/login" && (
              <>
                <a href={resume("/register")}>{t("Create an account", "创建账户")}</a>
                <a href={resume("/forgot-password")}>{t("Forgot password?", "忘记密码？")}</a>
              </>
            )}
            {page === "/verify-email" && (
              <form data-auth="resend" method="post">
                <label>
                  {t("Email for a new code", "重新发送验证码的邮箱")}
                  <input name="email" type="email" required />
                </label>
                <button className="btn ghost" type="submit">
                  {t("Request another code", "请求新验证码")}
                </button>
              </form>
            )}
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
            <div className="wrap">
              <nav className="nav" aria-label={t("Main navigation", "主导航")}>
                <a className="logo" href={link("/")}>
                  <svg width={27} height={27} viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.4" />
                    <circle cx="12" cy="12" r="3.4" fill="currentColor" />
                    <path d="M12 1v5M12 18v5M1 12h5M18 12h5" stroke="currentColor" strokeWidth="2.4" />
                  </svg>
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
          <footer className="wrap">
            <a href={link("/")}>SoldBench</a>
            <p>{t("Comparable sales research and pricing evidence.", "可比成交研究与价格证据。")}</p>
            <a href={link("/support")}>{t("Support", "支持")}</a>
            <a href={link("/data-availability")}>{t("Availability", "数据可用性")}</a>
            <a href={link("/guides")}>{t("Guides", "指南")}</a>
            <a href={link("/methodology")}>{t("Methodology", "价格研究方法")}</a>
            <a href={link("/faq")}>FAQ</a>
            <a href={link("/blog")}>{t("Blog", "博客")}</a>
            <a href={link("/worth")}>{t("What is it worth?", "商品值多少钱？")}</a>
            <a href={link("/alternatives")}>{t("Alternatives", "方案比较")}</a>
            <a href={link("/changelog")}>{t("Changelog", "更新记录")}</a>
            <a href={link("/about")}>{t("About", "关于")}</a>
            <a href={link("/help")}>{t("Help", "帮助")}</a>
            <a href={link("/terms")}>{t("Terms", "条款")}</a>
            <a href={link("/privacy")}>{t("Privacy", "隐私")}</a>
            {footer}
          </footer>
        </body>
      </html>,
    )
  );
}

export function renderHome(locale: Locale) {
  return renderPage(locale, "/", new URL("http://localhost/"));
}
