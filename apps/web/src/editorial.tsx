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
    const providers = [
      {
        pinned: true,
        cat: "pinned",
        name: "SoldBench",
        sub: t("Cleaned comps with an evidence pack", "附带证据包与排除理由的可比成交样本"),
        perReq: "200",
        history: "30 / 90 days",
        bestOffer: t("Unknown actuals excluded", "未核实实价自动排除"),
        stats: t("Median · range · trimmed mean", "中位价 · 区间 · 截尾均价"),
        pricing: t("1 credit per search", "每次查价 1 额度"),
      },
      {
        pinned: false,
        cat: "api",
        name: "CompSniper",
        sub: t("Raw or AI-cleaned comps", "原始或 AI 清洗成交记录"),
        perReq: "240",
        history: t("Up to 3 years", "最长 3 年"),
        bestOffer: t("Listing price used", "使用挂牌标价替代"),
        stats: t("Median", "仅中位价"),
        pricing: t("Per search", "按次计费"),
      },
      {
        pinned: false,
        cat: "api",
        name: "SoldComps.io",
        sub: t("Direct sold-comps lookup and API", "直接查价与接口服务"),
        perReq: "100",
        history: "90 days",
        bestOffer: t("Hidden prices excluded", "隐藏实价不计入"),
        stats: t("Median · mean · min/max", "中位价 · 均值 · 最值"),
        pricing: t("20 credits + 1 per row", "20 额度起＋每行另计"),
      },
      {
        pinned: false,
        cat: "api",
        name: "sold-comps.com",
        sub: t("Sold data API — eBay, Mercari, Poshmark, TCGPlayer", "多平台成交数据源接口"),
        perReq: "240",
        history: "~90 days",
        bestOffer: t("True price, extra requests", "额外请求探测实价"),
        stats: t("None in dashboard search", "网页面板无聚合统计"),
        pricing: t("Per search", "按次计费"),
      },
      {
        pinned: false,
        cat: "api",
        name: "Soldgraph",
        sub: t("Listings API with job polling", "异步轮询成交列表接口"),
        perReq: "40–200",
        history: t("Recent eBay page", "近期页面快照"),
        bestOffer: t("Flag only", "仅标记"),
        stats: t("Not verified", "未核实"),
        pricing: t("Not verified", "未核实"),
      },
      {
        pinned: false,
        cat: "api",
        name: "CompsAPI",
        sub: t("eBay sold history API", "eBay 已售历史接口"),
        perReq: t("Not verified", "未核实"),
        history: t("1 year on entry plans", "入门套餐含 1 年"),
        bestOffer: t("Real accepted price", "实付接受价"),
        stats: t("Median", "中位价"),
        pricing: t("Not verified", "未核实"),
      },
      {
        pinned: false,
        cat: "api",
        name: "Trawl",
        sub: t("Stored eBay sales database", "存储式历史数据库检索"),
        perReq: t("Database lookup", "库表直查"),
        history: t("Years (US, UK)", "多年历史（美/英站）"),
        bestOffer: t("Not advertised", "未说明"),
        stats: t("Raw rows, no median", "原始记录无统计"),
        pricing: t("Not verified", "未核实"),
      },
      {
        pinned: false,
        cat: "research",
        name: "SerpApi",
        sub: t("General search API — sold filters dropped in 2026", "通用搜索接口"),
        perReq: "—",
        history: t("None for sold", "不支持已售过滤"),
        bestOffer: "—",
        stats: "—",
        pricing: t("Per search", "按次计费"),
      },
      {
        pinned: false,
        cat: "research",
        name: "Terapeak",
        sub: t("eBay Product Research, inside Seller Hub", "eBay 卖家中心内置分析"),
        perReq: "—",
        history: t("Up to 3 years", "最长 3 年"),
        bestOffer: t("Average sold price per listing", "单条平均成交价"),
        stats: t("Averages — dashboard only", "仅后台页面均值"),
        pricing: t("Bundled with eBay accounts", "随 eBay 卖家账号提供"),
      },
      {
        pinned: false,
        cat: "official",
        name: "Marketplace Insights",
        sub: t("eBay official API — Limited Release", "eBay 官方限量接口"),
        perReq: t("Not verified", "未核实"),
        history: "90 days",
        bestOffer: t("Not documented", "未说明"),
        stats: t("Not verified", "未核实"),
        pricing: t("Closed to new developers", "已停止开放或受限申请"),
      },
      {
        pinned: false,
        cat: "official",
        name: "Browse API",
        sub: t("eBay official API — active listings only", "仅限在售列表的官方接口"),
        perReq: "—",
        history: t("None for sold", "不含已售数据"),
        bestOffer: "—",
        stats: "—",
        pricing: t("Free (developer program)", "开发者免费权限"),
      },
      {
        pinned: false,
        cat: "research",
        name: t("Self-scraping", "自建爬虫解析"),
        sub: t("Build and maintain your own pipeline", "自主搭建并维护"),
        perReq: t("Custom", "自定义"),
        history: "~90 days",
        bestOffer: t("Asking price only", "通常只拿到标价"),
        stats: t("Build your own", "自行计算"),
        pricing: t("Proxies + upkeep", "代理及运维成本"),
      },
      {
        pinned: false,
        cat: "research",
        name: "Bright Data",
        sub: t("Proxy & scraping platform", "通用代理与抓取平台"),
        perReq: t("Custom parser", "需自写解析器"),
        history: "~90 days",
        bestOffer: t("Asking price only", "通常仅挂牌价"),
        stats: t("Raw data only", "仅原始数据"),
        pricing: t("Per record / usage", "按行/流量计费"),
      },
      {
        pinned: false,
        cat: "research",
        name: "Apify",
        sub: t("Community scraper actors", "社区第三方抓取脚本"),
        perReq: t("Varies by actor", "视 Actor 而定"),
        history: "~90 days",
        bestOffer: t("Varies by actor", "视 Actor 而定"),
        stats: t("Varies", "视实现而定"),
        pricing: t("Per run / usage", "按运行用量计费"),
      },
      {
        pinned: false,
        cat: "research",
        name: "WatchCount",
        sub: t("Free sold-price lookups", "免费基础查价网页"),
        perReq: "—",
        history: "—",
        bestOffer: t("Display only", "仅展示"),
        stats: t("None", "无统计"),
        pricing: t("Free", "免费"),
      },
    ];
    const publishedCompare = (view.entries ?? []).map((entry) => ({
      slug: entry.slug,
      name: entry.title,
      sub: date(entry.publishedAt),
      lede: entry.body.length > 360 ? `${entry.body.slice(0, 357)}…` : entry.body,
      url: articleLink(entry),
      bullets: [
        t(
          "Type 7 median, P25–P75 range, and 5% trimmed mean over verified actuals only",
          "严格基于已核验实际成交价计算 Type 7 中位价、P25–P75 与 5% 截尾均价",
        ),
        t(
          "Rule-numbered exclusions (R-01 to R-10) and complete snapshot hash",
          "逐条附带 R-01 至 R-10 排除规则与可复现快照哈希",
        ),
        t(
          "Zero charge on failures, low-sample (<8) results, and 10m repeat queries",
          "查询失败、不足 8 条的低样本以及 10 分钟内复用完全免费",
        ),
      ],
    }));
    const breakdowns = publishedCompare.length
      ? publishedCompare
      : [
          {
            slug: "compsniper",
            name: "CompSniper",
            sub: t("Raw or AI-cleaned comps, 3-year history", "多年历史记录、多平台覆盖"),
            lede: t(
              "The strongest incumbent on multi-marketplace breadth. Where it differs from SoldBench is Best Offer price semantics, cache-hit billing, and lack of per-row exclusion rule IDs.",
              "在多站点广度方面较强；差异在于 Best Offer 口径语义、缓存命中计费策略，以及每条记录是否附带编号可查的剔除原因。",
            ),
            url: "#altMatrix",
            bullets: [
              t(
                "Published Type 7 median, P25–P75 range, and 5% trimmed mean",
                "公开透明的 Type 7 中位价、P25–P75 区间及 5% 截尾均价",
              ),
              t(
                "Rule-numbered exclusions and complete inputs for independent recomputation",
                "带规则编号的排除明细，输入支持独立离线重算核对",
              ),
              t(
                "Undisclosed Best Offer amounts never enter default medians",
                "未公开实际接受价的议价订单永不污染默认中位价",
              ),
            ],
          },
          {
            slug: "soldcomps-io",
            name: "SoldComps.io",
            sub: t("Direct sold-comps lookup and API", "查价与接口服务"),
            lede: t(
              "Clean developer ergonomics, but per-row billing (20 credits + 1 per returned row) turns busy categories into unpredictable invoices and low-sample searches can still bill.",
              "开发者文档友好，但按返回条数计费会使高热度类目账单大幅波动；低样本情况也可能继续输出并扣费。",
            ),
            url: "#altMatrix",
            bullets: [
              t(
                "Predictable per-search billing — 1 credit for 1 to 200 comps",
                "可预期按次计费——1 至 200 条完整可比快照最多仅扣 1 额度",
              ),
              t(
                "No median below n = 8 verified sales, and zero credit charged",
                "少于 8 条有效核验成交绝不输出中位价且零扣费",
              ),
            ],
          },
        ];

    return (
      <>
        <section className="page-head">
          <div className="wrap">
            <div className="alt-hero-grid">
              <div>
                <p className="eyebrow">{t("COMPARISON · BENCHMARK DESIGN SPEC", "替代方案与对比")}</p>
                <h1>
                  {isAlt
                    ? t("eBay sold data APIs, compared — ", "成交数据平台对比 — ")
                    : t("Compare sold-price tools — ", "二手成交研究工具对照 — ")}
                  <span className="kw">{t("with the receipts", "看清规则与依据")}</span>.
                </h1>
                <p className="sub">
                  {t(
                    "Evaluating tools for sold comps research? Look closely at Best Offer honesty, low-sample rules, cache billing, and whether exclusions carry auditable reasons.",
                    "选择成交研究或数据接口时，请重点核实：议价未公开价是否混入、低样本如何处理、缓存复用是否扣费、以及每条剔除记录是否有清晰规则解释。",
                  )}
                </p>
                <div className="actions mt-20">
                  <a className="btn btn-brand" href={href("/search")}>
                    {t("Explore SoldBench research ↗", "体验 SoldBench 工作台 ↗")}
                  </a>
                  <a className="btn btn-ghost" href="#altMatrix">
                    {t("See the full matrix ↓", "查看完整对比矩阵 ↓")}
                  </a>
                </div>
                <p className="small mt-14">
                  {t(
                    "Competitor history and capacity summarize public specifications. Unknown or unverified items stay explicitly labeled.",
                    "竞品历史能力归纳自其公开资料；无法验证条目严格标记为未核实。",
                  )}
                </p>
              </div>
              <aside
                className="alt-diff-card"
                aria-label={t("The SoldBench difference", "SoldBench 核心原则")}
              >
                <p className="eyebrow">{t("WHY CHOOSE THIS APPROACH", "为什么采用此方法")}</p>
                <h2 className="alt-diff-title">
                  {t("The SoldBench difference", "SoldBench 证据标准的五项原则")}
                </h2>
                <ul className="alt-diff-list">
                  {[
                    t(
                      "Comparability, not keyword overlap",
                      "先匹配强属性再求统计——绝不把差异型号混在一起求平均",
                    ),
                    t(
                      "Verified realized price, not displayed-only guesses",
                      "实付成交价与展示挂牌价严格分层，不猜未公开议价金额",
                    ),
                    t(
                      "Exclusion reasons attached to each record",
                      "每条剔除记录都附明确规则与原因，而非黑箱分数",
                    ),
                    t(
                      "Publishable statistics gated by sample adequacy",
                      "少于 8 条核验样本绝不输出中位价且不收费",
                    ),
                    t(
                      "Audit-ready snapshots across web, REST and MCP",
                      "网页工作台、REST API 与 Hosted MCP 共用同一准则与账本",
                    ),
                  ].map((item, idx) => (
                    <li key={item}>
                      <span className="alt-diff-num">{`0${idx + 1}`}</span>
                      <span className="alt-diff-txt">{item}</span>
                    </li>
                  ))}
                </ul>
                <p className="alt-diff-note">
                  {t(
                    "Product design commitments, not claims of independently measured superiority.",
                    "以上为产品工程架构承诺，不作未实测的商业宣传。",
                  )}
                </p>
              </aside>
            </div>
          </div>
        </section>

        <section className="blk blk-tight-top" id="altMatrix">
          <div className="wrap">
            <p className="eyebrow">{t("SIDE BY SIDE", "横向一览")}</p>
            <h2 className="serif mt-10">{t("Every option at a glance", "主流方案逐项对照表")}</h2>
            <p className="small mt-10">
              {t(
                "Clean sold data removes accessories, parts, wrong models, and unverified Best Offer guesses before computing any median.",
                "纯净成交统计必须在计算中位价前移除配件故障件、型号冲突及未公开议价。",
              )}
            </p>
            <div className="alt-filter">
              {[
                ["all", t("All providers", "全部服务")],
                ["api", t("Sold-data APIs", "数据 API")],
                ["research", t("Research & tools", "研究工具")],
                ["official", t("Official eBay", "eBay 官方接口")],
              ].map(([cat, label], idx) => (
                <button key={cat} type="button" data-altfilter={cat} className={idx === 0 ? "on" : undefined}>
                  {label}
                </button>
              ))}
              <span className="small" data-altfilter-note="">
                {t(
                  "Showing 15 of 15 providers — SoldBench stays pinned in every view.",
                  "当前显示 15 / 15 项对照（SoldBench 始终置顶）。",
                )}
              </span>
            </div>

            <div className="live-card mt-14">
              <div className="table-scroll">
                <div className="dtable cols-6" id="altGlance">
                  <div className="dt-h">
                    <span className="dt-c">{t("Option", "方案")}</span>
                    <span className="dt-c">{t("Per request", "单次条数")}</span>
                    <span className="dt-c">{t("Sold history", "历史窗口")}</span>
                    <span className="dt-c">{t("Best Offer price", "议价实价口径")}</span>
                    <span className="dt-c">{t("Statistics", "统计指标")}</span>
                    <span className="dt-c">{t("Pricing", "计费方式")}</span>
                  </div>
                  {providers.map((p) => (
                    <div key={p.name} className={`dt-r${p.pinned ? " pin-row" : ""}`} data-cat={p.cat}>
                      <span className="dt-c">
                        <b>{p.name}</b>
                        {p.pinned && <span className="you-pill">{t("You are here", "当前产品")}</span>}
                        <br />
                        <span className="small">{p.sub}</span>
                      </span>
                      <span className="dt-c">{p.perReq}</span>
                      <span className="dt-c">{p.history}</span>
                      <span className="dt-c">{p.bestOffer}</span>
                      <span className="dt-c">{p.stats}</span>
                      <span className="dt-c">{p.pricing}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <p className="eyebrow mt-36">{t("HISTORY DECODED", "历史窗口深度解读")}</p>
            <h2 className="serif mt-10">
              {t(
                "Historical days matter. But context matters more.",
                "历史天数固然重要，口径与可信度更为关键",
              )}
            </h2>
            <div className="hist-grid">
              <div className="card">
                <h3>{t("Advertised / documented lookback", "公开历史窗口长度对照")}</h3>
                {[
                  ["CompSniper", "1,095 days", 1095],
                  ["Terapeak — eBay Product Research", "1,095 days", 1095],
                  ["Marketplace Insights", "90 days", 90],
                  ["SoldComps.io", "~90 days", 90],
                  [
                    "SoldBench (V1 plan)",
                    t("30 / 90 days (fixture/live gated)", "30 / 90 天（受门禁约束）"),
                    90,
                  ],
                ].map(([label, text, val]) => (
                  <div className="hist-row" key={String(label)}>
                    <div className="hist-top">
                      <b>{label}</b>
                      <span>{text}</span>
                    </div>
                    <progress className="hist-prog" max={1095} value={Number(val)} />
                  </div>
                ))}
                <p className="small mt-16">
                  {t(
                    "Bars use 1,095 days as a visual reference. Availability of long windows does not imply full market coverage or verified Best Offer accuracy.",
                    "进度条以 1,095 天为视觉标尺。较长历史窗口并不自动代表高覆盖度或议价实价已核验。",
                  )}
                </p>
              </div>
              <div className="card">
                <h3>{t("What a lookback window does not tell you", "单靠历史天数看不出的五个问题")}</h3>
                {[
                  [
                    t("Coverage", "样本覆盖度"),
                    t(
                      "Did the dataset observe most qualifying sales, or only a slice?",
                      "记录是接近全量成交，还是抽样碎片？",
                    ),
                  ],
                  [
                    t("Price semantics", "价格语义是否真实"),
                    t(
                      "Are accepted offers real paid amounts or listing asking prices?",
                      "Best Offer 是真实实付价，还是直接混用了挂牌出价？",
                    ),
                  ],
                  [
                    t("Comparability", "属性强匹配约束"),
                    t(
                      "Were wrong grades, editions, and lots filtered before stats?",
                      "统计前是否先剔除了评级错配、散装或捆绑套装？",
                    ),
                  ],
                  [
                    t("Freshness", "数据时效性状态"),
                    t(
                      "When were records last observed and disclosed to buyers?",
                      "最近观察时间戳是否随响应透出并标识陈旧状态？",
                    ),
                  ],
                  [
                    t("Rights", "来源与分发授权"),
                    t(
                      "Can the source be stored, cached, and audited cleanly?",
                      "数据抓取、留存、展示与导出是否受许可纪元门控？",
                    ),
                  ],
                ].map(([h, d]) => (
                  <div className="hist-callout" key={h}>
                    <b>{h}</b>
                    <span>{d}</span>
                  </div>
                ))}
              </div>
            </div>

            <h2 className="serif mt-36">{t("Where each alternative falls short", "各项方案差异详述")}</h2>
            {breakdowns.map((entry) => (
              <div className="alt-sec" key={entry.slug}>
                <div>
                  <h3 className="serif">
                    {entry.url.startsWith("#") ? entry.name : <a href={entry.url}>{entry.name}</a>}
                  </h3>
                  <p className="small mt-8">{entry.sub}</p>
                </div>
                <div>
                  <p>{entry.lede}</p>
                  <div className="why-box">
                    <p className="eyebrow">{t("WHY SOLDBENCH IS DIFFERENT", "SOLDBENCH 工程差异点")}</p>
                    <ul className="mt-10">
                      {entry.bullets.map((b) => (
                        <li key={b}>{b}</li>
                      ))}
                    </ul>
                    {!entry.url.startsWith("#") && (
                      <p className="mt-10">
                        <a href={entry.url}>{t("Inspect full comparison notes →", "查看完整分析正文 →")}</a>
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))}

            <h2 className="serif mt-36">{t("What would you actually pay?", "月度搜索成本模拟测算")}</h2>
            <div className="card mt-14">
              <div className="field">
                <label htmlFor="calcN">{t("Monthly searches", "每月查价次数")}</label>
                <input
                  id="calcN"
                  className="calc-range"
                  type="range"
                  min={100}
                  max={50000}
                  step={100}
                  defaultValue={2000}
                  data-calc-slider=""
                />
                <div className="small" id="calcNVal">
                  {t("2,000 searches / month", "每月 2,000 次查价")}
                </div>
              </div>
              <div className="grid3 eq mt-16">
                <div className="card calc-highlight">
                  <p className="eyebrow">SOLDBENCH</p>
                  <p id="calcSB" className="mt-8">
                    <b>$9</b> / mo · $0.005 per search
                  </p>
                  <p className="small">
                    {t(
                      "Free 100 · Starter $9/2,000 · Pro $29/10,000 · then $10 per 1,500 top-up",
                      "免费 100 · 入门 $9/2,000 · 专业 $29/10,000 · 加量包 $10/1,500",
                    )}
                  </p>
                </div>
                <div className="card">
                  <p className="eyebrow">COMPSNIPER</p>
                  <p id="calcCS" className="mt-8">
                    <b>$9</b> / mo · $0.005 per search
                  </p>
                  <p className="small">
                    {t(
                      "List tiers $9/2k, $29/10k, $79/50k — plus extra charges on cache hits and pages.",
                      "公开档位 $9/2k、$29/10k、$79/50k——不含缓存命中及翻页额外消耗。",
                    )}
                  </p>
                </div>
                <div className="card">
                  <p className="eyebrow">SOLDCOMPS.IO</p>
                  <p id="calcIO" className="mt-8">
                    <b>$29</b> / mo · $0.014 per search
                  </p>
                  <p className="small">
                    {t(
                      "20 credits + 1 per returned row (modeled at 50 rows/search average).",
                      "每次基础 20 额度＋每返回行 1 额度（按平均每次返回 50 条计算）。",
                    )}
                  </p>
                </div>
              </div>
              <p className="small mt-14" id="calcNote">
                {t(
                  "At 2,000 searches a month, per-row pricing grows directly with market listing volume rather than search count.",
                  "按行计费会导致市场成交越活跃时账单越高，而按次计费上限固定为 1 额度。",
                )}
              </p>
            </div>

            <div className="card cta-card mt-30">
              <h2 className="serif cta-title">
                {t("Judge us by the evidence pack.", "用可验证的证据包亲自核查结果。")}
              </h2>
              <p className="small cta-sub">
                {t(
                  "Start with 100 free monthly credits and inspect every exclusion rule and median locally.",
                  "免费账户每月 100 额度，现场检查中位价、四分位区间及排除明细。",
                )}
              </p>
              <div className="cta-actions">
                <a className="btn btn-brand" href={href("/register")}>
                  {t("Create free account", "免费创建账户")}
                </a>
                <a className="btn btn-ghost" href={href("/search")}>
                  {t("Try a search first", "前往工作台体验")}
                </a>
              </div>
            </div>
          </div>
        </section>
      </>
    );
  }

  if (view.path === "/changelog") {
    const rawEntries = (view.entries ?? []).map((entry) => ({
      slug: entry.slug,
      date: entry.publishedAt,
      tag: (entry.title.toLowerCase().includes("fix")
        ? "FIXED"
        : entry.title.toLowerCase().includes("update") || entry.title.toLowerCase().includes("hardening")
          ? "CHANGED"
          : "ADDED") as "ADDED" | "CHANGED" | "FIXED",
      title: entry.title,
      body: entry.body,
      ref: entry.reference,
      author: entry.author,
    }));
    const demoFallbacks =
      rawEntries.length >= 3
        ? []
        : [
            {
              slug: "sb-evidence-pack",
              date: "2026-11-18T00:00:00Z",
              tag: "ADDED" as const,
              title: t(
                "Evidence pack & candidate hash on every result",
                "所有查询结果标配证据包与候选集哈希",
              ),
              body: t(
                "Every delivered snapshot carries query_id, candidate_set_hash, engine/cleaner versions, and per-row exclusion reasons.",
                "每次交付快照均随附 query_id、candidate_set_hash、引擎与清洗版本号及逐条剔除理由。",
              ),
              ref: undefined,
              author: "SoldBench Core",
            },
            {
              slug: "sb-mcp-v1",
              date: "2026-11-16T00:00:00Z",
              tag: "ADDED" as const,
              title: t("Hosted MCP server & Agent Skill alignment", "托管 MCP 服务端与 Agent Skill 同源对齐"),
              body: t(
                "Expose sold_search and sold_stats with OAuth 2.1/PKCE or API keys sharing the exact domain billing rules.",
                "通过 OAuth 2.1/PKCE 或 API Key 提供 sold_search / sold_stats 工具，严格复用计费账本。",
              ),
              ref: undefined,
              author: "SoldBench Core",
            },
            {
              slug: "sb-best-offer-isolation",
              date: "2026-11-12T00:00:00Z",
              tag: "CHANGED" as const,
              title: t(
                "Five quality dimensions & Best Offer actual isolation",
                "五维样本质量评估与议价实价严格隔离",
              ),
              body: t(
                "Keep quality.total_score permanently null while exposing verifiable match, verifiability, sample, coverage, and recency fields.",
                "保持 quality.total_score 恒为 null，分别展示匹配度、核验占比、样本充分性、覆盖率与时效性维度。",
              ),
              ref: undefined,
              author: "SoldBench Core",
            },
          ];
    const items = [...rawEntries, ...demoFallbacks];
    const badgeCls = (tg: "ADDED" | "CHANGED" | "FIXED") =>
      tg === "ADDED" ? "badge badge-green" : tg === "FIXED" ? "badge badge-blue" : "badge badge-amber";
    const counts = {
      ALL: items.length,
      ADDED: items.filter((i) => i.tag === "ADDED").length,
      CHANGED: items.filter((i) => i.tag === "CHANGED").length,
      FIXED: items.filter((i) => i.tag === "FIXED").length,
    };

    return (
      <>
        <section className="page-head">
          <div className="wrap">
            <p className="eyebrow">{t("CHANGELOG", "更新日志")}</p>
            <h1>
              {t("What we ", "产品演进与")}
              <span className="kw">{t("shipped", "发布记录")}</span>
            </h1>
            <p className="sub">
              {t(
                "New filters, fields, integrations, and fixes. The API contract stays stable and versioned under /v1, newest changes first.",
                "统计引擎、清洗规则版本演进、API / MCP 能力和交付合规改进记录（最新变更置顶）。",
              )}
            </p>
          </div>
        </section>
        <section className="blk blk-tight-top">
          <div className="wrap">
            <p className="eyebrow">{t("RECENT HIGHLIGHTS", "近期重点更新")}</p>
            <div className="grid3 eq mt-16">
              {items.slice(0, 3).map((item) => (
                <div className="card" key={`hl-${item.slug}`}>
                  <div className="chg-hl-top">
                    <span className="chg-hl-date">
                      <time dateTime={item.date}>{date(item.date)}</time>
                    </span>
                    <span className={badgeCls(item.tag)}>{item.tag}</span>
                  </div>
                  <h3 className="mt-12">{item.title}</h3>
                  <p>{item.body.length > 160 ? `${item.body.slice(0, 157)}…` : item.body}</p>
                </div>
              ))}
            </div>

            <div className="chg-layout mt-36">
              <aside className="chg-side">
                <h2>{t("Full history", "完整版本流水")}</h2>
                <p className="small mt-8" data-chg-count="">
                  {t(
                    `Showing ${items.length} of ${items.length} entries · newest first`,
                    `共 ${items.length} 条记录 · 按发布时间倒序`,
                  )}
                </p>
                <div className="chg-filters">
                  {(["ALL", "ADDED", "CHANGED", "FIXED"] as const).map((tg, idx) => (
                    <button key={tg} type="button" className={idx === 0 ? "on" : undefined} data-clf={tg}>
                      <span>
                        {tg === "ALL"
                          ? t("All entries", "全部变更")
                          : tg === "ADDED"
                            ? t("Added", "新增能力")
                            : tg === "CHANGED"
                              ? t("Changed", "口径调整")
                              : t("Fixed", "缺陷修复")}
                      </span>
                      <span className="n">{counts[tg]}</span>
                    </button>
                  ))}
                </div>
                <div className="chg-note">
                  <b>{t("Versioning policy.", "版本兼容性说明：")}</b>{" "}
                  {t(
                    "Every query snapshot pins its engine_version and cleaner_version so historical comparisons remain reproducible.",
                    "每份查询快照均固化记录 engine_version 与 cleaner_version，历史计算始终可追溯复现。",
                  )}{" "}
                  <a href={href("/methodology")}>{t("Methodology →", "方法论 →")}</a>
                </div>
                <div className="chg-note mt-12">
                  <b>{t("Questions about a change?", "对更新有疑问？")}</b>{" "}
                  <a href={href("/support")}>{t("Open support page →", "联系支持中心 →")}</a>
                </div>
              </aside>
              <div className="card">
                {items.map((entry) => (
                  <article className="chg-entry published-section" data-cltag={entry.tag} key={entry.slug}>
                    <div>
                      <span className="chg-dm">
                        <time dateTime={entry.date}>{date(entry.date)}</time>
                      </span>
                      {entry.author && <span className="chg-dy">{entry.author}</span>}
                      <div className="mt-8">
                        <span className={badgeCls(entry.tag)}>{entry.tag}</span>
                      </div>
                    </div>
                    <div>
                      <h2>{entry.title}</h2>
                      <div className="mt-8">{paragraphBlocks(entry.body)}</div>
                      {entry.ref && (
                        <p className="mt-8">
                          <a href={entry.ref} rel="noreferrer">
                            {t("Release reference", "发布参考")}
                          </a>
                        </p>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </div>
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
