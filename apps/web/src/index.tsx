import { readFileSync } from "node:fs";
import type { Locale } from "@soldbench/shared";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type DocsView, Documentation } from "./developer.tsx";

export const webCss = readFileSync(new URL("../src/site.css", import.meta.url), "utf8");
export const webClient = readFileSync(new URL("../src/site.js", import.meta.url), "utf8");

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
  "/account/usage",
  "/account/logs",
  "/account/keys",
  "/playground",
  "/support",
  "/categories",
  "/data-availability",
] as const;
type Page = (typeof webPages)[number] | "/results" | "/share" | "/docs";
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
  for (const key of ["result", "job"]) {
    const value = url.searchParams.get(key);
    if (value && uuid.test(value)) draft.set(key, value);
  }
  if (resultId) draft.set("result", resultId);
  const query = draft.size ? `?${draft}` : "";
  const resume = (path: string) => link(path) + query;
  const other = docs
    ? docs.alternate
    : page === "/share"
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
    "/account/usage": ["Usage", "用量"],
    "/account/logs": ["Request logs", "请求日志"],
    "/account/keys": ["API keys", "API 密钥"],
    "/playground": ["API Playground", "API 调试台"],
    "/categories": ["Research categories", "研究类目"],
    "/data-availability": ["Data availability", "数据可用性"],
    "/share": ["Shared price research", "分享的成交研究"],
    "/support": ["Support", "支持"],
  };
  const title = docs?.current.title ?? t(...(headings[page] ?? ["Search sold prices", "查询成交价"]));
  const nav = (
    <>
      <a href={link("/search")}>{t("Search", "查价")}</a>
      <a href={link("/categories")}>{t("Categories", "类目")}</a>
      <a href={zh ? "/docs/zh-CN/quickstart" : "/docs/en/quickstart"}>{t("Docs", "文档")}</a>
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
  if (page === "/") {
    content = (
      <>
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
      </>
    );
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
              ["/account", "/account/queries", "/account/usage", "/account/logs", "/account/keys"] as const
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
          <title>{`${title} · SoldBench`}</title>
          <link rel="stylesheet" href="/assets/soldbench.css" />
          <script src="/assets/soldbench.js" type="module" />
        </head>
        <body data-page={page} data-prefix={prefix} data-result-id={resultId}>
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
          </footer>
        </body>
      </html>,
    )
  );
}

export function renderHome(locale: Locale) {
  return renderPage(locale, "/", new URL("http://localhost/"));
}
