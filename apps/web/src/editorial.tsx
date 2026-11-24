import type { Locale } from "@soldbench/shared";

export type EditorialEntry = {
  slug: string;
  title: string;
  body: string;
  publishedAt: string;
  author?: string;
  reference?: string;
};

export type EditorialView = {
  title: string;
  path: string;
  indexPath?: string;
  entries?: EditorialEntry[];
  current?: EditorialEntry;
  related?: EditorialEntry[];
  category?: {
    id: string;
    windows: number[];
    freshness: string;
    asOf: string | null;
  };
};

export const canonicalSite = "https://soldbench.com";
export const editorialUrl = (locale: Locale, path: string) =>
  `${canonicalSite}${locale === "zh-CN" ? "/zh-CN" : ""}${path}`;

function paragraphBlocks(text: string) {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((chunk) => <p key={chunk.trim()}>{chunk.trim()}</p>);
}

export function Editorial({ view, locale, query }: { view: EditorialView; locale: Locale; query?: string }) {
  const zh = locale === "zh-CN";
  const t = (en: string, cn: string) => (zh ? cn : en);
  const href = (path: string) => (zh ? "/zh-CN" : "") + path;
  const date = (at: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(at));
  const articleLink = (item: EditorialEntry) => href(`${view.indexPath ?? view.path}/${item.slug}`);
  const current = view.current;
  const category = view.category;

  if (view.path === "/404") {
    return (
      <section className="wrap workbench">
        <div className="card cta-card">
          <p className="eyebrow">404</p>
          <h1>{view.title}</h1>
          <p className="small mt-10">
            {t(
              "The requested route or snapshot does not exist or is no longer available.",
              "您访问的页面或快照不存在或已过期。",
            )}
          </p>
          <div className="cta-actions">
            <a className="btn brand" href={href("/")}>
              {t("Return home", "返回首页")}
            </a>
            <a className="btn ghost" href={href("/search")}>
              {t("Open research workbench", "打开查价工作台")}
            </a>
          </div>
        </div>
      </section>
    );
  }

  if (view.path === "/worth") {
    const popular = ["Nintendo Switch OLED", "Nintendo Switch", "Charizard PSA 10", "iPhone 15 Pro 256GB"];
    return (
      <>
        <section className="page-head">
          <div className="wrap">
            <p className="eyebrow">{t("Free public price check", "免费公共查价")}</p>
            <h1>
              {t("What's it ", "这件商品")}
              <span className="kw">{t("worth", "实际值多少钱")}</span>
              {t("?", "？")}
            </h1>
            <p className="sub">
              {t(
                "Check cached eBay US sold prices without creating an account (up to 5 free cached lookups per day).",
                "无需登录注册，即可查询公开缓存的 eBay 美国站已核验成交价（每日最多免费 5 次公共缓存）。",
              )}
            </p>
            <form className="searchbox mt-22" action={href("/search")} method="get" data-search="">
              <label className="sr-only" htmlFor="worth-product">
                {t("Product", "商品")}
              </label>
              <input
                id="worth-product"
                name="q"
                maxLength={120}
                required
                defaultValue={query}
                placeholder={t(
                  "Enter a brand and model, e.g. Nintendo Switch",
                  "输入品牌和型号，例如 Nintendo Switch",
                )}
              />
              <button type="submit" className="btn brand">
                {t("Check sold prices", "查成交价")}
              </button>
            </form>
            <div className="chips">
              <span className="lbl">{t("POPULAR", "常见查询")}</span>
              {popular.map((term) => (
                <a key={term} className="chip" href={`${href("/worth")}?${new URLSearchParams({ q: term })}`}>
                  {term}
                </a>
              ))}
            </div>
            <p className="small mt-12">
              {t("eBay US · USD · Synthetic demo", "eBay 美国站 · 美元 · 合成演示")}
            </p>
            <p className="notice" data-status="" aria-live="polite" hidden />
            <div data-actions="" className="actions" />
            <div data-results="" className="mt-16" />
          </div>
        </section>

        <section className="blk">
          <div className="wrap">
            <p className="eyebrow">{t("How it works", "工作流程")}</p>
            <div className="grid3 eq mt-18">
              {[
                [
                  t("1 · Query cached sales", "1 · 匹配公共快照"),
                  t(
                    "Looks up already-published authorized snapshots over completed eBay US transactions — never asking prices.",
                    "检索公开发布的已授权历史成交快照——严格排除尚未成交的挂牌出价。",
                  ),
                ],
                [
                  t("2 · Clean mismatches & Best Offers", "2 · 严格清洗与议价隔离"),
                  t(
                    "Bundles, conflicting models, and unverified Best Offer prices never silently bias the default median.",
                    "自动移除型号冲突与捆绑套装，未公开实际接受价的 Best Offer 不计入中位价。",
                  ),
                ],
                [
                  t("3 · Inspect full evidence", "3 · 透明核查所有依据"),
                  t(
                    "Every figure travels with sample counts, quantile dispersion, and rule-numbered exclusion records.",
                    "所有结果均附带样本量统计、四分位区间以及逐条核验或剔除理由。",
                  ),
                ],
              ].map(([heading, desc]) => (
                <div className="card" key={heading}>
                  <h3>{heading}</h3>
                  <p>{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="blk blk-tight-top">
          <div className="wrap">
            <p className="eyebrow">{t("Why it stays honest", "核心原则")}</p>
            <div className="grid4 eq mt-18">
              {[
                [
                  t("Sold, not listed", "只看实际成交"),
                  t(
                    "Asking prices measure seller hopes; verified completed transactions anchor value.",
                    "挂牌价代表卖家心理预期，核验后的已售出记录才是成交事实。",
                  ),
                ],
                [
                  t("Null below 8", "不足 8 条不给中位价"),
                  t(
                    "Fewer than 8 verified sales withhold median & IQR rather than guessing.",
                    "有效价格不足 8 条时中位价明确置空并告知观察区间。",
                  ),
                ],
                [
                  t("Same USD market", "统一 eBay US 口径"),
                  t(
                    "Single marketplace and currency (integer USD cents) with Type 7 quantiles.",
                    "基于 eBay US 美元整数分存储、Type 7 分位数统一计算。",
                  ),
                ],
                [
                  t("Need full live queries?", "需要实时全量研究？"),
                  t(
                    "Create a free account to search any query, save snapshots, and export CSV/JSON.",
                    "注册账户后可使用研究工作台、保存快照对比与完整导出。",
                  ),
                ],
              ].map(([heading, desc]) => (
                <div className="card" key={heading}>
                  <h3>{heading}</h3>
                  <p>{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </>
    );
  }

  if (view.path === "/alternatives" || view.path === "/compare") {
    const isAlt = view.path === "/alternatives";
    return (
      <>
        <section className="page-head">
          <div className="wrap">
            <div className="alt-hero-grid">
              <div>
                <p className="eyebrow">{t("Comparison & Alternatives", "替代方案与对比")}</p>
                <h1>
                  {isAlt
                    ? t("Sold data APIs compared — ", "成交数据平台对比 — ")
                    : t("Compare sold-price research tools ", "主流二手成交研究工具对照")}
                  {isAlt && <span className="kw">{t("with receipts", "看清规则与依据")}</span>}
                </h1>
                <p className="sub">
                  {t(
                    "Evaluating tools for sold comps research? Look closely at Best Offer honesty, low-sample rules, cache billing, and whether exclusions carry auditable reasons.",
                    "选择成交研究或数据接口时，请重点核实：议价未公开价是否混入、低样本如何处理、缓存复用是否扣费、以及每条剔除记录是否有清晰规则解释。",
                  )}
                </p>
                <div className="actions mt-24">
                  <a className="btn btn-brand" href={href("/search")}>
                    {t("Open SoldBench workbench →", "体验 SoldBench 工作台 →")}
                  </a>
                  <a className="btn btn-ghost" href={href("/methodology")}>
                    {t("Read methodology", "阅读定价方法论")}
                  </a>
                </div>
              </div>
              <aside className="alt-diff-card">
                <p className="eyebrow">{t("The SoldBench standard", "SoldBench 核心原则")}</p>
                <h2 className="mt-10">
                  {t("Five differences in the evidence pack", "可验证证据包的五项原则")}
                </h2>
                <ul className="alt-diff-list">
                  {[
                    t(
                      "Comparability before averaging — strong attributes checked first",
                      "先匹配强属性再求统计——绝不把差异型号混在一起求平均",
                    ),
                    t(
                      "Verified actuals separated from displayed-only Best Offer guesses",
                      "实付成交价与展示挂牌价严格分层，不猜未公开议价金额",
                    ),
                    t(
                      "Rule-numbered exclusions attached to every candidate row",
                      "每条剔除记录都附明确规则与原因，而非黑箱分数",
                    ),
                    t(
                      "No median below 8 verified sales — zero charge on insufficient data",
                      "少于 8 条核验样本绝不输出中位价且不收费",
                    ),
                    t(
                      "Identical rules across Web workbench, REST API, and Hosted MCP",
                      "网页工作台、REST API 与 MCP 服务完全共用同一准则与账本",
                    ),
                  ].map((item, idx) => (
                    <li key={item}>
                      <span className="alt-diff-num">{`0${idx + 1}`}</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </aside>
            </div>
          </div>
        </section>

        <section className="blk blk-tight-top">
          <div className="wrap">
            {view.entries?.length ? (
              view.entries.map((entry) => (
                <div className="alt-sec" key={entry.slug}>
                  <div>
                    <h2 className="serif">
                      <a href={articleLink(entry)}>{entry.title}</a>
                    </h2>
                    <p className="small mt-8">
                      {entry.author ? `${entry.author} · ` : ""}
                      <time dateTime={entry.publishedAt}>{date(entry.publishedAt)}</time>
                    </p>
                  </div>
                  <div>
                    <p>{entry.body.length > 360 ? `${entry.body.slice(0, 357)}…` : entry.body}</p>
                    <div className="why-box">
                      <p className="eyebrow">{t("Read breakdown", "查看详细对比")}</p>
                      <p className="mt-8">
                        <a href={articleLink(entry)}>
                          {t("Inspect full comparison notes →", "查看完整分析正文 →")}
                        </a>
                      </p>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <p className="notice">{t("Nothing has been published here yet.", "此处暂未发布内容。")}</p>
            )}
          </div>
        </section>
      </>
    );
  }

  if (view.path === "/changelog") {
    return (
      <>
        <section className="page-head">
          <div className="wrap">
            <p className="eyebrow">{t("Changelog", "更新日志")}</p>
            <h1>
              {t("What we ", "产品演进与")}
              <span className="kw">{t("shipped", "发布记录")}</span>
            </h1>
            <p className="sub">
              {t(
                "Engine versions, cleaner rule updates, REST/MCP additions, and compliance hardening.",
                "统计引擎、清洗规则版本演进、API / MCP 能力和交付合规改进记录。",
              )}
            </p>
          </div>
        </section>
        <section className="blk blk-tight-top">
          <div className="wrap">
            {view.entries?.length ? (
              <div className="chg-layout">
                <aside className="card">
                  <p className="eyebrow">{t("Versioning policy", "版本演进规范")}</p>
                  <p className="mt-8">
                    {t(
                      "Every query snapshot pins its engine_version and cleaner_version so historical comparisons remain reproducible.",
                      "每份查询快照均固化记录 engine_version 与 cleaner_version，历史计算始终可追溯复现。",
                    )}
                  </p>
                  <p className="mt-12">
                    <a href={href("/methodology")}>{t("How cleaner versions work →", "查看方法论说明 →")}</a>
                  </p>
                </aside>
                <div className="card">
                  {view.entries.map((entry) => (
                    <article className="chg-entry published-section" key={entry.slug}>
                      <div>
                        <strong>
                          <time dateTime={entry.publishedAt}>{date(entry.publishedAt)}</time>
                        </strong>
                        {entry.author && <p className="small mt-6">{entry.author}</p>}
                      </div>
                      <div>
                        <h2>{entry.title}</h2>
                        <div className="mt-8">{paragraphBlocks(entry.body)}</div>
                        {entry.reference && (
                          <p className="mt-8">
                            <a href={entry.reference} rel="noreferrer">
                              {t("Release reference", "发布参考")}
                            </a>
                          </p>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            ) : (
              <p className="notice">{t("Nothing has been published here yet.", "此处暂未发布内容。")}</p>
            )}
          </div>
        </section>
      </>
    );
  }

  const featuredEntry = !current && view.path === "/blog" && view.entries?.length ? view.entries[0] : null;
  const gridEntries = featuredEntry && view.entries ? view.entries.slice(1) : view.entries;

  return (
    <>
      <section className="page-head">
        <div className="wrap">
          {view.indexPath && (
            <p className="crumbs">
              <a href={href("/")}>{t("Home", "首页")}</a> /{" "}
              <a href={href(view.indexPath)}>{t("Back to the index", "返回目录")}</a>
            </p>
          )}
          <h1>{current?.title ?? view.title}</h1>
          {current && (
            <p className="small mt-8">
              {current.author && `${current.author} · `}
              <time dateTime={current.publishedAt}>{date(current.publishedAt)}</time>
            </p>
          )}
        </div>
      </section>

      <section className="blk blk-tight-top">
        <div className="wrap">
          {category && (
            <div className="card result-card">
              <div className="kv">
                <div>
                  <b>{t("Market", "站点")}</b>
                  <span>{t("eBay US · USD", "eBay 美国站 · 美元")}</span>
                </div>
                <div>
                  <b>{t("Supported windows", "支持的时间窗口")}</b>
                  <span>
                    {category.windows.length
                      ? category.windows.map((value) => t(`${value} days`, `${value} 天`)).join(" / ")
                      : "—"}
                  </span>
                </div>
                <div>
                  <b>{t("Data availability", "数据可用性")}</b>
                  <span>
                    {{
                      fresh: t("Available", "可用"),
                      stale_acceptable: t("Delayed", "延迟"),
                      expired: t("Expired", "已过期"),
                      never_observed: t("No observations yet", "暂无观测"),
                    }[category.freshness] ?? t("Unavailable", "不可用")}
                  </span>
                </div>
                {category.asOf && (
                  <div>
                    <b>{t("Last usable data", "最近可用数据")}</b>
                    <time dateTime={category.asOf}>{category.asOf}</time>
                  </div>
                )}
              </div>
              <p className="mt-18">
                <a
                  className="btn brand"
                  href={href(`/search?${new URLSearchParams({ category: category.id })}`)}
                >
                  {t("Search this category", "查询此类目")}
                </a>
              </p>
            </div>
          )}

          {current && (
            <article className="card published-section docs-body">
              {paragraphBlocks(current.body)}
              {current.reference && (
                <p className="mt-16">
                  <a href={current.reference} rel="noreferrer">
                    {t("Source and evidence", "来源与证据")}
                  </a>
                </p>
              )}
            </article>
          )}

          {featuredEntry && (
            <article className="card published-section">
              <p className="eyebrow">{t("Featured note", "精选专栏")}</p>
              <h2 className="mt-8">
                <a href={articleLink(featuredEntry)}>{featuredEntry.title}</a>
              </h2>
              <p className="small mt-6">
                {featuredEntry.author && `${featuredEntry.author} · `}
                <time dateTime={featuredEntry.publishedAt}>{date(featuredEntry.publishedAt)}</time>
              </p>
              <p className="mt-10">
                {featuredEntry.body.length > 260
                  ? `${featuredEntry.body.slice(0, 257)}…`
                  : featuredEntry.body}
              </p>
            </article>
          )}

          {gridEntries?.length ? (
            <div className={`grid3 eq${featuredEntry ? " mt-20" : ""}`}>
              {gridEntries.map((entry) => (
                <article key={entry.slug} className="card published-section">
                  <h2>
                    <a href={articleLink(entry)}>{entry.title}</a>
                  </h2>
                  <p className="small mt-6">
                    {entry.author && `${entry.author} · `}
                    <time dateTime={entry.publishedAt}>{date(entry.publishedAt)}</time>
                  </p>
                  <p className="mt-10">
                    {entry.body.length > 220 ? `${entry.body.slice(0, 217)}…` : entry.body}
                  </p>
                  <p className="card-foot">
                    <a href={articleLink(entry)}>{t("Read more →", "阅读全文 →")}</a>
                  </p>
                </article>
              ))}
            </div>
          ) : (
            view.entries && (
              <p className="notice">{t("Nothing has been published here yet.", "此处暂未发布内容。")}</p>
            )
          )}

          {view.related && view.related.length > 0 && (
            <nav className="card mt-20" aria-label={t("Related articles", "相关文章")}>
              <h2>{t("Related articles", "相关文章")}</h2>
              <ul className="mt-10">
                {view.related.map((entry) => (
                  <li key={entry.slug}>
                    <a href={articleLink(entry)}>{entry.title}</a>
                  </li>
                ))}
              </ul>
            </nav>
          )}

          {(view.path === "/terms" || view.path === "/privacy") && (
            <p className="notice">
              {t("The policy is pending separate publication approval.", "政策尚待独立批准和发布。")}
            </p>
          )}

          {view.path === "/help" && (
            <div className="grid3 eq mt-20">
              <div className="card">
                <h3>{t("Frequently asked questions", "常见问题")}</h3>
                <p>
                  {t(
                    "Answers on sample thresholds (<8), Best Offer isolation, and credits.",
                    "了解不足 8 条不给中位价、Best Offer 隔离及扣费说明。",
                  )}
                </p>
                <p className="card-foot">
                  <a href={href("/faq")}>{t("View FAQ →", "查看常见问题 →")}</a>
                </p>
              </div>
              <div className="card">
                <h3>{t("Research guides", "研究指南")}</h3>
                <p>
                  {t(
                    "Step-by-step guides on comparable selection, IQR spread, and clean evidence.",
                    "了解如何区分可比样本、阅读四分位区间并核对证据。",
                  )}
                </p>
                <p className="card-foot">
                  <a href={href("/guides")}>{t("Browse guides →", "浏览研究指南 →")}</a>
                </p>
              </div>
              <div className="card">
                <h3>{t("Submit or check a support request", "提交或查询工单")}</h3>
                <p>
                  {t(
                    "Open a data quality, takedown, billing, or account ticket with receipt tracking.",
                    "提交数据、权限、账单工单并通过私密回执跟踪进展。",
                  )}
                </p>
                <p className="card-foot">
                  <a href={href("/support")}>{t("Open support →", "进入帮助工单 →")}</a>
                </p>
              </div>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
