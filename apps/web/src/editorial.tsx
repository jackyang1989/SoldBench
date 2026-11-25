import type { Locale } from "@soldbench/shared";
import { highlightCode } from "./highlight.js";

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
            <div className="worth-hero-wrap">
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
                  <a
                    key={term}
                    className="chip"
                    href={`${href("/worth")}?${new URLSearchParams({ q: term })}`}
                  >
                    {term}
                  </a>
                ))}
              </div>
              <p className="small mt-12">
                {t("eBay US · USD · Synthetic demo", "eBay 美国站 · 美元 · 合成演示")}
              </p>
            </div>
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

        <section className="blk blk-tight-top">
          <div className="wrap">
            <div className="blk-head">
              <h2>{t("Browse values by category", "按品类浏览历史成交参考")}</h2>
            </div>
            <div className="grid3 eq mt-22">
              {[
                [
                  t("Graded cards", "评级卡牌"),
                  [
                    "Charizard PSA 10",
                    "Pokémon Base Set PSA 10",
                    "Graded Charizard 4/102",
                    "Blastoise PSA 10",
                  ],
                ],
                [
                  t("Sneakers", "潮流球鞋"),
                  ["Air Jordan 1 Retro High OG", "Nike Dunk Low", "New Balance 550", "Adidas Samba OG"],
                ],
                [
                  t("Watches", "经典腕表"),
                  ["Rolex Datejust", "Omega Speedmaster", "Seiko SKX007", "Tudor Black Bay 58"],
                ],
                [
                  t("Video games", "电子游戏与主机"),
                  ["Nintendo Switch OLED", "Game Boy Color CIB", "Pokémon Emerald GBA", "Super Mario 64 CIB"],
                ],
                [t("GPUs & hardware", "显卡与硬件"), ["RTX 4070", "RTX 3080 10GB", "RX 7800 XT", "RTX 4090"]],
                [
                  t("Collectibles", "潮流玩具与收藏"),
                  ["Funko Pop exclusive", "LEGO retired set", "First edition books", "Vintage Star Wars"],
                ],
              ].map(([catName, catQueries]) => (
                <div className="card" key={String(catName)}>
                  <h3>{catName}</h3>
                  <div className="worth-cats-links mt-10">
                    {(catQueries as string[]).map((qItem) => (
                      <a key={qItem} href={`${href("/worth")}?${new URLSearchParams({ q: qItem })}`}>
                        {qItem} →
                      </a>
                    ))}
                  </div>
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
    const fallbackBreakdowns = [
      {
        slug: "compsniper",
        name: "CompSniper",
        sub: t("Raw or AI-cleaned comps, 3-year history", "多年历史记录、多平台覆盖"),
        lede: t(
          "The strongest incumbent, and the one most sellers should shortlist against us: eBay in 8 countries plus TCGplayer, PSA, Grailed, Poshmark, Mercari, Depop and auction houses, up to 3 years of sold history, and a published 40-test blind comparison (their figure: 5.4% mismatch). Where it falls short is the fine print — its Best Offer median is computed on the listing price, cache hits and extra pages are charged (measured November 18), and its AI relevance filter hides rows without a per-row reason.",
          "多站点与三年历史方面最成熟的服务之一；核心差异在于细节：其 Best Offer 中位价采用挂牌标价计算、命中缓存与额外翻页同样计费，且 AI 筛选不给出逐条可核对的规则剔除依据。",
        ),
        url: href("/compare/compsniper"),
        bullets: [
          t(
            "Fuller statistics — a published Type 7 median, typical range and 5% trimmed mean, not a bare median",
            "更完整的统计口径——公开 Type 7 中位价、P25–P75 区间与 5% 截尾均价",
          ),
          t(
            "Evidence you can recompute: rule-numbered exclusions (R-01 to R-10) and the complete computation inputs",
            "支持离线重算验证：附带 R-01 至 R-10 编号剔除原因及完整输入快照",
          ),
          t(
            "Best Offer honesty: an undisclosed accepted price never enters default statistics",
            "Best Offer 诚实口径：未公开真实成交价绝不混入默认中位价",
          ),
          t(
            "No charges for cache hits, extra pages, failures or low-sample results",
            "10 分钟缓存复用、额外翻页、失败与不足 8 条的低样本均零扣费",
          ),
        ],
      },
      {
        slug: "soldcomps-io",
        name: "SoldComps.io",
        sub: t("Direct sold-comps lookup and API", "直连成交查询与开发者 API"),
        lede: t(
          "The developer-experience leader of the three: a polished API, an MCP server plus an Agent Skill, extra signals such as sell-through rate, and the most generous free tier here — 2,000 credits a month. Where it falls short is billing predictability: every search costs 20 credits plus 1 per returned row, so a busy market raises your bill. You also get 100 results per request instead of 200, flags instead of rule-level exclusion reasons, and a low-sample search that still publishes a median and charges you.",
          "开发者文档与工具生态出色；不足在于按「20＋每返回行 1 额度」计费导致热门品类费用波动、单次上限 100 条、仅附布尔标记而非规则编号解释，且低样本依然出中位价并扣费。",
        ),
        url: href("/compare/soldcomps-io"),
        bullets: [
          t(
            "Predictable per-search pricing — 1 credit per search, whether it returns 1 or 200 comps",
            "可预期按次计费——无论返回 1 条还是 200 条可比样本最多只计 1 额度",
          ),
          t(
            "Exclusion reasons down to rule IDs, not just flags",
            "每条排除记录明确对应 R-01 至 R-10 规则编号而非模糊标志位",
          ),
          t(
            "Low-sample results publish no median and charge nothing",
            "有效价格不足 8 条时强制置空不输出误导中位价且免收额度",
          ),
          t("200 results per request, not 100", "单次请求上限 200 条完整可比记录，覆盖更完整"),
        ],
      },
      {
        slug: "sold-comps-com",
        name: "sold-comps.com",
        sub: t("The old hand — fast, broad, and thin on analysis", "老牌数据通道，广度大但缺乏统计分析"),
        lede: t(
          "An established service with 240 results per request across 8 eBay sites plus Mercari, Poshmark and TCGPlayer, with bulk search and free exports. Where it falls short is analysis: in its signed-in dashboard, a search returns rows and facet filters — no median, no range, no aggregate statistics of any kind — and there is no MCP server or agent tooling. Its Best Offer answer, hydrateBoa, fetches the true price at extra requests per search.",
          "老牌高吞吐接口（单次 240 条覆盖多平台）；但在其网页面板仅展示明细列表与筛选，不提供中位价、四分位区间或聚合统计，也未提供 MCP 工具；探测 Best Offer 实价需额外收费请求。",
        ),
        url: href("/compare/sold-comps-com"),
        bullets: [
          t(
            "Actual aggregate statistics — a Type 7 median, typical range and trimmed mean on every result",
            "每次返回开箱即用的 Type 7 中位价、P25–P75 区间、5% 截尾均价与五维质量结构",
          ),
          t(
            "An evidence pack with the query hash, engine versions and per-row exclusion reasons",
            "附带候选集哈希、引擎/清洗版本号及逐条剔除理由的证据包",
          ),
          t(
            "An MCP server and agent tooling, metered exactly like REST",
            "原生 Hosted MCP 与 Agent Skill，严格复用与 REST 一致的账本和权限规则",
          ),
        ],
      },
      {
        slug: "watchcount",
        name: "WatchCount",
        sub: t("Free sold-price lookups for casual checking", "零门槛免费网页随手查价"),
        lede: t(
          "Free — no account, no key, nothing to bill — and fine for a one-off sanity check. Where it falls short is everything past that: no cleaned median, no statistics, no API or MCP access, and no evidence, exports or status page when a price actually matters.",
          "无需注册、完全免费，适合临时快速看一眼历史参考；但在需要严谨定价依据、库存批量核价、API / MCP 集成、结构化导出或可用性监测时均缺乏支持。",
        ),
        url: href("/compare/watchcount"),
        bullets: [
          t(
            "A cleaned, defensible median instead of raw listings",
            "基于清洗规则核验后的可辩护中位价，而非未去噪原始列表",
          ),
          t(
            "An API and MCP access for anything programmatic",
            "提供可编程 REST API 与 Hosted MCP 接口便于自动化集成",
          ),
          t("Evidence, exports and a status page", "具备完整证据包、CSV / JSON 导出与实时数据源状态面板"),
        ],
      },
    ];
    const fallbackSlugs = new Set(fallbackBreakdowns.map((b) => b.slug));
    const breakdowns = [...fallbackBreakdowns, ...publishedCompare.filter((p) => !fallbackSlugs.has(p.slug))];

    return (
      <>
        <section className="page-head">
          <div className="wrap">
            <div className="alt-hero-grid">
              <div>
                <p className="eyebrow">
                  {t("COMPARISON · CHECKED NOVEMBER 18, 2026", "对比 · 核查于 2026年11月18日")}
                </p>
                <h1>
                  {isAlt
                    ? t("eBay sold data APIs, compared — ", "eBay 成交数据接口对比 — ")
                    : t("Compare sold-price tools — ", "二手成交研究工具对照 — ")}
                  <span className="kw">{t("with the receipts", "附可验证依据")}</span>.
                </h1>
                <p className="sub">
                  {t(
                    "Every competitor fact on this page was checked on November 18, 2026 — public pages and signed-in dashboards, visited one by one. The SoldBench column is the V1 plan: this describes what V1 ships alongside offline fixture evidence.",
                    "本页每项竞品事实均于 2026 年 11 月 18 日逐一核对公开文档与登录工作台。SoldBench 列对应 V1 工程规划：展示已验证的产品能力与离线夹具口径，不作未实测的商业承诺。",
                  )}
                </p>
                <div className="alt-hero-actions">
                  <a className="btn btn-brand" href={href("/search")}>
                    {t("Explore SoldBench research ↗", "体验 SoldBench 研究工作台 ↗")}
                  </a>
                  <a className="btn btn-ghost" href="#altMatrix">
                    {t("See the full matrix ↓", "查看完整对比矩阵 ↓")}
                  </a>
                </div>
                <p className="alt-hero-note">
                  {t(
                    "Competitor history and capacity are provider claims, not independent SoldBench measurements. Our own production history is not yet qualified.",
                    "竞品历史窗口与容量来自服务商公开说明，而非独立第三方实测；SoldBench 自身生产历史窗口尚待商业放行验证。",
                  )}
                </p>
              </div>
              <aside
                className="alt-diff-card"
                aria-label={t("The SoldBench difference", "SoldBench 核心原则")}
              >
                <p className="eyebrow">{t("WHY CHOOSE THIS APPROACH", "为什么采用此方法")}</p>
                <h2 className="alt-diff-title">{t("The SoldBench difference", "SoldBench 核心设计差异")}</h2>
                <ul className="alt-diff-list">
                  {[
                    t("Comparability, not keyword overlap", "先强属性匹配再求统计，绝不混入不同型号或规格"),
                    t(
                      "Verified realized price, not displayed-only guesses",
                      "实付成交价与挂牌参考价严格分层，不猜未公开议价金额",
                    ),
                    t(
                      "Exclusion reasons attached to each record",
                      "每条剔除记录均附带规则编号（R-01 至 R-10）",
                    ),
                    t("Publishable statistics gated by sample adequacy", "有效样本不足 8 条强制置空且免费"),
                    t(
                      "Audit-ready snapshots across web, REST and MCP",
                      "网页工作台、REST API 与 Hosted MCP 共用同一快照与账本",
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
            <h2 className="serif mt-10">{t("Every option at a glance", "全部方案横向对照一览")}</h2>
            <p className="sub alt-sub-wide mt-10">
              {t(
                "Sold data means real completed-sale prices, not active asking prices. Clean sold data means accessories, parts, wrong models and junk matches are removed before you trust the median. This table is the breadth view: every option on the six basics. The per-competitor breakdowns further down cover the detail behind the finalists — how each one cleans, bills, proves and ships its data.",
                "真实成交数据是指已成交实价而非在售要价；纯净成交数据则在采信中位价前移除配件、残缺品与错配型号。此表先横向展示 15 种方案在六项基础维度上的表现，下文再对重点方案展开清洗、计费与证据拆解。",
              )}
            </p>
            <div className="alt-filter">
              {[
                ["all", t("All providers", "全部服务")],
                ["api", t("Sold-data APIs", "成交数据 API")],
                ["research", t("Research & tools", "研究工具与自建")],
                ["official", t("Official eBay", "eBay 官方接口")],
              ].map(([cat, label], idx) => (
                <button key={cat} type="button" data-altfilter={cat} className={idx === 0 ? "on" : undefined}>
                  {label}
                </button>
              ))}
              <span className="alt-filter-note" data-altfilter-note="">
                {t(
                  "Showing 15 of 15 providers — SoldBench stays pinned in every view.",
                  "当前显示 15 / 15 项对照——SoldBench 在所有视图始终置顶。",
                )}
              </span>
            </div>

            <div className="live-card mt-14">
              <div className="table-scroll">
                <div className="dtable alt-glance-table" id="altGlance">
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
            <p className="small mt-10">
              {t(
                "One SoldBench search returns up to 200 sold listings from eBay US, with statistics computed over the full comparable set — not just the rows shown.",
                "单次 SoldBench 请求返回最多 200 条 eBay US 成交样本，且所有统计值基于完整可比候选快照计算，而非仅按展示页条数截取。",
              )}
            </p>
            <p className="small mt-8">
              {t(
                'The wider rows — Soldgraph, CompsAPI, Trawl, SerpApi, Terapeak, eBay’s own APIs, self-scraping, Bright Data and Apify — are summarised from those providers’ public pages and CompSniper’s published comparison (checked November 2026). Cells we could not verify say "Not verified" rather than guess.',
                "其余服务商列概括自其公开文档与对比资料（2026 年 11 月核对）。无法独立核实的功能严格标记为「未核实」，不作猜测。",
              )}
            </p>

            <p className="eyebrow mt-36">{t("HISTORY DECODED", "历史窗口深度解读")}</p>
            <h2 className="serif mt-10">
              {t(
                "Historical days matter. But context matters more.",
                "历史天数固然重要，口径与上下文更为关键。",
              )}
            </h2>
            <p className="sub mt-10">
              {t(
                "History is a real buying criterion. This visual compares the stated ranges from the table above — checked November 18, 2026 — without silently presenting a source archive as complete marketplace history.",
                "历史深度是重要选型维度。下图对照各方案公开宣称的时间范围（2026 年 11 月 18 日核对），同时绝不把局部样本归档包装成全市场成交历史。",
              )}
            </p>
            <div className="hist-grid">
              <div className="card">
                <h3>{t("Advertised / documented lookback", "公开宣称或文档载明的回溯范围")}</h3>
                {[
                  ["CompSniper", t("1,095 days", "1,095 天"), 1095],
                  ["Terapeak — eBay Product Research", t("1,095 days", "1,095 天"), 1095],
                  ["Marketplace Insights", t("90 days", "90 天"), 90],
                  ["SoldComps.io", t("~90 days", "约 90 天"), 90],
                  ["SoldBench", t("Unverified · not launched", "尚未实测 · 未正式上线"), 0],
                ].map(([label, text, val]) => (
                  <div className="hist-row" key={String(label)}>
                    <div className="hist-top">
                      <b>{label}</b>
                      <span>{text}</span>
                    </div>
                    <progress className="hist-prog" max={1095} value={Number(val)} />
                  </div>
                ))}
                <p className="hist-note">
                  {t(
                    "Bars use 1,095 days as a visual reference. Availability is not a claim of full coverage. SoldBench has no qualified production historical window yet, so its bar stays empty rather than borrowing the V1 plan's 30 / 90-day windows as if they were measured history.",
                    "进度条以 1,095 天为视觉参考标尺。可回溯窗口不等于全量市场覆盖。SoldBench 尚未完成生产历史窗口验证，因此进度条留空展示，而不把 V1 规划的 30 / 90 天混同为实测历史。",
                  )}
                </p>
              </div>
              <div className="card">
                <h3>{t("What a lookback window does not tell you", "单靠历史天数看不出的五个问题")}</h3>
                {[
                  [
                    t("Coverage", "样本覆盖度"),
                    t(
                      "Did the dataset observe most relevant sales, or only a sample?",
                      "数据集是否观测了绝大多数相关成交，还是仅捕获局部抽样？",
                    ),
                  ],
                  [
                    t("Price semantics", "价格语义是否真实"),
                    t(
                      "Are realised accepted-offer amounts actually known, or is the listing price standing in for them?",
                      "Best Offer 是真实实付接受价，还是直接混用了挂牌出价？",
                    ),
                  ],
                  [
                    t("Comparability", "属性强匹配约束"),
                    t(
                      "Were wrong grade, edition, region and condition excluded before the price was calculated?",
                      "计算价格前是否已先排除不同评级、版本、地区与成色错配？",
                    ),
                  ],
                  [
                    t("Freshness", "数据时效状态"),
                    t(
                      "When were records last observed, and is the source stale?",
                      "记录最近一次观测于何时，是否存在延迟或陈旧？",
                    ),
                  ],
                  [
                    t("Rights", "采集与分发权限"),
                    t(
                      "Can the provider store and redistribute those records?",
                      "数据提供方是否具备抓取、留存、展示与导出相应字段的授权？",
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

            <h2 className="serif mt-36">
              {t("Where each alternative falls short", "各方案短板与 SoldBench 的工程应对")}
            </h2>
            <p className="sub mt-10">
              {t(
                "What each option leaves out, and what SoldBench does instead. Every claim below was verified in the same November 18 sweep as the table above.",
                "每款主要对比产品遗漏的关键环节，以及 SoldBench 对应的工程机制（与上表同日核验）。",
              )}
            </p>
            {breakdowns.map((entry) => (
              <div className="alt-sec" key={entry.slug}>
                <div>
                  <h3 className="serif">{entry.name}</h3>
                  <p className="alt-sub">{entry.sub}</p>
                </div>
                <div>
                  <p className="alt-lede">{entry.lede}</p>
                  <div className="why-box">
                    <p className="eyebrow">{t("WHY SOLDBENCH IS BETTER", "SOLDBENCH 核心优势")}</p>
                    <ul>
                      {entry.bullets.map((b) => (
                        <li key={b}>{b}</li>
                      ))}
                    </ul>
                  </div>
                  <p className="mt-14">
                    <a href={entry.url}>
                      {entry.name.toLowerCase().startsWith("soldbench vs")
                        ? t(`See the full ${entry.name} breakdown →`, `查看 ${entry.name} 完整对比 →`)
                        : t(
                            `See the full SoldBench vs ${entry.name} breakdown →`,
                            `查看 SoldBench 与 ${entry.name} 完整对比 →`,
                          )}
                    </a>
                  </p>
                </div>
              </div>
            ))}

            <h2 className="serif mt-36">{t("What would you actually pay?", "按月用量测算实际支出")}</h2>
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
                <div className="small calc-val" id="calcNVal">
                  {t("2,000 searches / month", "每月 2,000 次查价")}
                </div>
              </div>
              <div className="grid3 eq mt-16">
                <div className="card calc-highlight">
                  <p className="eyebrow">SOLDBENCH</p>
                  <p id="calcSB" className="calc-price">
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
                  <p id="calcCS" className="calc-price">
                    <b>$9</b> / mo · $0.005 per search
                  </p>
                  <p className="small">
                    {t(
                      "$0/100 · $9/2,000 · $29/10,000 · $79/50,000 · high-volume $129/$179/$299/$549 — plus a charge per extra page and per cache hit",
                      "$0/100 · $9/2,000 · $29/10,000 · $79/50,000 — 另加额外翻页与缓存命中计费",
                    )}
                  </p>
                </div>
                <div className="card">
                  <p className="eyebrow">SOLDCOMPS.IO</p>
                  <p id="calcIO" className="calc-price">
                    <b>$29</b> / mo · $0.014 per search
                  </p>
                  <p className="small">
                    {t(
                      "20 credits + 1 per returned row. Assumes an average of 50 rows per search — the more rows your searches return, the more you pay.",
                      "每次基础 20 额度＋每返回行 1 额度（按平均每次返回 50 条计算，返回越多费用越高）。",
                    )}
                  </p>
                </div>
              </div>
              <p className="calc-note" id="calcNote">
                {t(
                  "At 2,000 searches a month, per-row pricing costs $20 more than SoldBench — and the gap grows with every extra row a search returns, because per-row bills scale with the market's activity, not with your usage.",
                  "按每月 2,000 次计算，按行计费每月将多支出 $20——且返回样本越多差距越大。",
                )}
              </p>
              <p className="small mt-8">
                {t(
                  "sold-comps.com is not in the calculator: its homepage does not publish comparable per-tier request counts, and we do not model numbers we cannot cite.",
                  "sold-comps.com 未纳入计算器：其官网首页未公开可供直接对等测算的分档请求上限，我们不对无引用依据的数值作假设估算。",
                )}
              </p>
            </div>

            <div className="card mt-20">
              <h3>{t("How we checked", "核验方法与来源说明")}</h3>
              <p className="mt-8">
                {t(
                  'On November 18, 2026 we visited every competitor\'s public pages and signed-in dashboards and recorded what each product actually does — pricing pages, search results, billing behaviour (including a cache hit we let CompSniper charge us for), and documentation. Where we could not verify a claim, the table says "Not verified" instead of guessing.',
                  "2026 年 11 月 18 日，我们逐一查验了各对比产品的公开文档、定价说明与已登录控制台实际行为，对未能实际测试的功能如实标注为「未核实」。",
                )}
              </p>
              <p className="mt-8">
                {t(
                  "One discipline note: CompSniper publishes a 5.4% mismatch figure from its own 40-test blind study. We cite it as their number, with its source, and we do not invent a matching figure for SoldBench — our accuracy claim is different in kind: published rules, per-row exclusion reasons, and inputs you can recompute. Checked by the SoldBench team · Last review November 18, 2026 · Next sweep December 2026.",
                  "说明：CompSniper 公布过其自有 40 次盲测 5.4% 误判率，此处明确作为其公布数据引述；SoldBench 不自编对等百分比，而以公开规则、逐条排除依据和可重算输入保障透明核验。",
                )}
              </p>
            </div>

            <h2 className="serif mt-36">{t("Decision guide", "场景选型决策指南")}</h2>
            <div className="live-card mt-14">
              <div className="table-scroll">
                <table className="tbl-fixed tbl-decision">
                  <colgroup>
                    <col className="col-dec-1" />
                    <col className="col-dec-2" />
                    <col className="col-dec-3" />
                    <col className="col-dec-4" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>{t("You are…", "用户角色")}</th>
                      <th>{t("Your situation", "典型诉求")}</th>
                      <th>{t("Best fit", "推荐方案")}</th>
                      <th>{t("Why", "核心原因")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      [
                        t("A casual seller", "个人卖家"),
                        t("Pricing a handful of items a month", "每月仅评估少量闲置或转售商品"),
                        t("SoldBench free tier", "SoldBench 免费档"),
                        t(
                          "100 credits and 5 anonymous lookups a day cover it; every price comes with its evidence",
                          "每月 100 免费额度与每日 5 次匿名快照查价即可覆盖，且均附证据明细",
                        ),
                      ],
                      [
                        t("A collectibles dealer", "收藏品交易商"),
                        t(
                          "Grading-sensitive categories, disputes about price",
                          "对评级/版别极其敏感且常需自证定价",
                        ),
                        "SoldBench",
                        t(
                          "Rule-numbered exclusions (a PSA 9 never enters a PSA 10 median) and a recomputation-ready evidence pack",
                          "带编号规则剔除错配样本（PSA 9 绝不混入 PSA 10）并提供可离线重算的完整证据包",
                        ),
                      ],
                      [
                        t("A resale business", "二手转售商家"),
                        t("Pricing inventory at volume", "批量评估采购清单与库存价格"),
                        "SoldBench Pro",
                        t(
                          "Per-search pricing keeps the bill flat; bulk CSV batching stays capped and auditable",
                          "按次计费令高热度品类成本可预测；支持 20 项 CSV 批量查价与状态追溯",
                        ),
                      ],
                      [
                        t("A developer / agent builder", "开发者 / Agent 构建者"),
                        t("Wiring sold data into tools or agents", "将成交参考价接入工作流或 AI 智能体"),
                        t(
                          "SoldBench — or SoldComps.io for its Skill ecosystem",
                          "SoldBench（或按需对比 SoldComps.io）",
                        ),
                        t(
                          "SoldBench shares identical billing across REST & Hosted MCP and publishes complete Type 7 inputs & quality gates",
                          "REST 与 Hosted MCP 共用同一账本与权限，公开完整 Type 7 计算输入与质量阈值规则",
                        ),
                      ],
                      [
                        t("An enterprise SaaS", "跨站型 SaaS 企业"),
                        t("Multi-marketplace coverage today", "当下立即需要多国家多平台大历史归档"),
                        t("CompSniper, honestly", "可按需求评估 CompSniper"),
                        t(
                          "8 eBay countries plus six other marketplaces and 3 years of history — SoldBench V1 focuses on eBay US first",
                          "多站多平台历史窗口现成覆盖更广；SoldBench 首期专注打深 eBay US 单站严谨口径",
                        ),
                      ],
                      [
                        t("A professional data user", "专业数据使用者"),
                        t("Auditable inputs for models and reports", "为定价模型或审计报告提供可核验底数"),
                        "SoldBench",
                        t(
                          "Complete computation inputs and versions in every evidence pack; nothing else here offers recomputation",
                          "每次交付提供完整计算输入、版本与候选集哈希，支持独立复现中位价",
                        ),
                      ],
                    ].map(([who, sit, fit, why]) => (
                      <tr key={who}>
                        <td>
                          <b>{who}</b>
                        </td>
                        <td>{sit}</td>
                        <td>
                          <b>{fit}</b>
                        </td>
                        <td>{why}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <h2 className="serif mt-36">{t("The short version", "快速体验接口与工作台")}</h2>
            <p className="sub mt-10">
              <b className="calc-val">{t("No OAuth dance, no approval queue.", "无需繁琐审批队列。")}</b>{" "}
              {t(
                "One Bearer key, one call — median, typical range, trimmed mean and the evidence pack. ",
                "一个 Bearer 密钥、一次请求即可获取中位价、典型区间、截尾均价与完整证据包。",
              )}
              <b className="calc-val">
                {t("Live in about 5 minutes on a free key.", "免费注册即可在 5 分钟内跑通集成。")}
              </b>
            </p>
            <div className="grid2 mt-16">
              <div className="codeblock">
                <div className="cb-head">
                  <span>{t("One call, full statistics", "一次调用获取完整统计与证据")}</span>
                  <button type="button" className="copy-btn" data-copy="#altCurl">
                    {t("Copy", "复制")}
                  </button>
                </div>
                <pre id="altCurl">
                  <code>
                    {highlightCode(
                      'curl -H "Authorization: Bearer sb_live_..." \\\n  "https://api.soldbench.com/v1/sold?q=Nintendo+Switch+OLED"\n# median, p25–p75, trimmed mean, evidence pack — 1 credit',
                      "bash",
                    )}
                  </code>
                </pre>
              </div>
              <div className="card">
                <h3>{t("Try the workbench", "试用交互式研究工作台")}</h3>
                <p className="mt-8">
                  {t(
                    "The same statistics, computed live over the example datasets — filter them and watch the median, the exclusions and the evidence pack respond.",
                    "同一套统计引擎直接在浏览器中运行——调整成色或剔除样本即可实时观察中位价、区间与证据变化。",
                  )}
                </p>
                <p className="mt-14">
                  <a className="btn btn-brand" href={href("/search")}>
                    {t("Open the workbench", "打开研究工作台")}
                  </a>
                </p>
              </div>
            </div>

            <h2 className="serif mt-36">{t("FAQ", "常见问题")}</h2>
            <div className="mt-14">
              {[
                [
                  t(
                    "Is the SoldBench column live product or plan?",
                    "SoldBench 列对应已上线产品还是 V1 规划？",
                  ),
                  t(
                    "Plan — stated on the page. This offline engineering build validates V1 rules, API contracts, and evidence outputs against synthetic fixtures; competitor columns summarize public behaviour checked on November 18, 2026.",
                    "清晰标明为 V1 工程规划与当前离线夹具能力：计算口径、统计阈值与接口契约按产品规格编码实现；竞品列归纳自 2026 年 11 月 18 日公开页面与测试记录。",
                  ),
                ],
                [
                  t("Why does the Best Offer row matter?", "为什么 Best Offer 口径单独成行对比？"),
                  t(
                    "Because a median built on listing prices is not a sold-price median. If the accepted amount is undisclosed, the honest choices are excluding it from default statistics (us, SoldComps.io) or fetching the true price at extra cost (sold-comps.com) — not silently using the asking price.",
                    "因为混入挂牌要价算出的不是实际成交中位价。当议价实际接受价未知时，诚实做法是将其排除出默认统计（SoldBench、SoldComps.io）或单独探测实价，而不是悄悄把标价当作已售价格。",
                  ),
                ],
                [
                  t(
                    "Did you really get charged for a CompSniper cache hit?",
                    "CompSniper 命中缓存真的也会扣次数吗？",
                  ),
                  t(
                    "Yes — in our November 18 dashboard session, a repeat search served from cache in 31 ms still consumed one search. Their pagination likewise charges per page.",
                    "是的，在 2026 年 11 月 18 日的控制台实测中，31 ms 缓存命中的重复查询与翻页均会消耗搜索额度；而 SoldBench 同参数 10 分钟内复用完全免费。",
                  ),
                ],
                [
                  t("Why is SoldComps.io missing from some 'wins'?", "如何客观评价 SoldComps.io 的优缺点？"),
                  t(
                    "Its free tier (2,000 credits/mo) is genuinely the most generous, and its developer experience is excellent. It loses on billing predictability: 20 credits + 1 per row means a busy market raises your bill.",
                    "其每月 2,000 额度免费档及文档体验非常突出；但「20 基础额度＋每返回 1 行另计 1 额度」导致高供给品类账单按返回条数增长，不如固定每次封顶 1 额度稳定。",
                  ),
                ],
                [
                  t(
                    "Why does sold-comps.com show 'no statistics'?",
                    "为什么表格写 sold-comps.com 在面板无聚合统计？",
                  ),
                  t(
                    "Because in its signed-in dashboard, a search returns rows and facet filters — no median, no range, no aggregate of any kind. The API may differ; we report what we verified.",
                    "我们在其已登录工作台搜索中观察到接口返回明细行与分面过滤，未看到中位价、四分位区间等聚合统计指标；一切只报告实际观察到的页面能力。",
                  ),
                ],
                [
                  t(
                    "What does 'Not verified' mean in the table?",
                    "表中的「未核实 (Not verified)」代表什么？",
                  ),
                  t(
                    "We did not test that behaviour this round. Rather than repeat a marketing claim, we mark it unverified and re-check monthly.",
                    "表示本轮核对中未实地测试或公开文档未明确载明该项细节；我们避免转述未经验证的宣传口径，将其标注为未核实并按月复核。",
                  ),
                ],
                [
                  t(
                    "Can I recompute a SoldBench median myself?",
                    "我可以自己在离线环境复现 SoldBench 中位价吗？",
                  ),
                  t(
                    "Yes — that is the point of the evidence pack: candidate set, applied filters, rule outcomes and versions are all in the response, so the median is reproducible offline.",
                    "可以。每次交付结果都包含候选集、过滤后可比样本价格与规则排除记录，可按公开 Type 7 与两端各 floor(5%×n) 规则完全复现。",
                  ),
                ],
                [
                  t("When does this page update?", "对比矩阵多久复核更新一次？"),
                  t(
                    "Monthly, or when a competitor changes pricing or billing. The check date is printed at the top.",
                    "按月复核，或在竞品调整定价、配额及接口语义时同步更新，并在页面顶部标注最近核查日期。",
                  ),
                ],
              ].map(([q, a]) => (
                <details className="faq-item" key={q}>
                  <summary>{q}</summary>
                  <div className="faq-body">{a}</div>
                </details>
              ))}
            </div>

            <div className="card cta-card mt-30">
              <h2 className="serif cta-title">
                {t("Judge us by the evidence pack.", "用可验证的证据包亲自核查结果。")}
              </h2>
              <p className="small cta-sub">
                {t("100 free credits a month. No credit card.", "每月 100 免费额度，无需绑定信用卡。")}
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

  const compareData: Record<
    string,
    {
      name: string;
      verdict: [string, string];
      rows: Array<[[string, string], [string, string], [string, string]]>;
      they: Array<[string, string]>;
      us: Array<[string, string]>;
      faq: Array<[[string, string], [string, string]]>;
    }
  > = {
    compsniper: {
      name: "CompSniper",
      verdict: [
        "The strongest incumbent: widest coverage, longest history, a live product. SoldBench answers with fuller statistics, recomputation-grade evidence and billing that never charges for cache hits or pages.",
        "多站广度与三年历史方面最强的现有产品之一；SoldBench 则以完整统计口径、可离线重算的规则证据包以及对缓存命中/分页零扣费作为核心差异。",
      ],
      rows: [
        [
          ["Results per request", "单次返回条数"],
          ["200", "200 条"],
          ["240", "240 条"],
        ],
        [
          ["Median", "中位价口径"],
          ["Type 7 + p25–p75 + trimmed mean", "Type 7 中位价＋P25–P75＋5% 截尾均价"],
          ["Yes — Best Offer at listing price", "提供——未核实议价采用挂牌标价"],
        ],
        [
          ["Exclusion reasons", "剔除依据"],
          ["Per row, rule IDs R-01 to R-10", "逐条附规则编号 R-01 至 R-10"],
          ["AI relevance, no per-row reason", "AI 相关性判断，无逐条规则码"],
        ],
        [
          ["Cache hits", "缓存复用计费"],
          ["Free for 10 minutes", "10 分钟内同参数复用免费"],
          ["Charged (measured Nov 18)", "照常扣费（11月18日实测）"],
        ],
        [
          ["Pagination", "分页检索"],
          ["Re-fetch free", "已交付复取免费"],
          ["Charged per page", "按页单独扣费"],
        ],
        [
          ["Marketplaces", "支持市场"],
          ["eBay US (V1)", "eBay US（首期重点）"],
          ["8 eBay countries + 6 more", "8 个 eBay 站点＋6 平台"],
        ],
        [
          ["History", "历史窗口"],
          ["30 / 90 days", "30 / 90 天"],
          ["Up to 3 years", "最长 3 年"],
        ],
        [
          ["MCP", "AI MCP 接入"],
          ["2 tools, same metering", "2 个工具，严格同源计费"],
          ["7 tools, per-call charge", "7 个工具，按调用扣费"],
        ],
      ],
      they: [
        [
          "Coverage: eight eBay countries plus TCGplayer, PSA, Grailed, Poshmark, Mercari, Depop and auction houses",
          "覆盖广度：8 个 eBay 站点及 TCGplayer、PSA、Grailed、Poshmark、Mercari、Depop 与拍卖行",
        ],
        ["Three years of sold history", "最长 3 年历史成交档案"],
        [
          "A published blind-test figure (5.4% mismatch, their own 40-test study)",
          "公开发布的 40 次自测盲测报告（误判率 5.4%）",
        ],
        ["A live, mature product", "已在运营的成熟线上产品"],
      ],
      us: [
        [
          "Statistics: trimmed mean and typical range beside a published Type 7 median",
          "统计深度：除 Type 7 中位价外完整返回典型四分位区间与 5% 截尾均价",
        ],
        [
          "Evidence: complete inputs and rule-numbered exclusions — recompute any median",
          "证据透明：返回完整计算输入与逐条规则剔除原因，可独立离线重算",
        ],
        [
          "Billing: no charge for cache hits, pages, failures or low-sample results",
          "计费护栏：缓存复用、额外分页、失败与不足 8 条的低样本均不收费",
        ],
        [
          "Best Offer: undisclosed prices never enter default statistics",
          "议价严格隔离：未公开实付金额绝不作为成交价计入中位价",
        ],
      ],
      faq: [
        [
          ["Is CompSniper bad?", "CompSniper 本身存在问题吗？"],
          [
            "No — it is the benchmark we built against, and for multi-marketplace coverage today it is the right choice. This page exists because statistics, evidence and billing differ in ways a feature list hides.",
            "并不是——它是我们对齐研发的重要参照。若当下急需跨 8 国与多平台历史档案，CompSniper 覆盖更广；本对比聚焦于统计语义、逐条剔除透明度与缓存扣费差异。",
          ],
        ],
        [
          ["What is the listing-price Best Offer issue?", "为什么 Best Offer 用标价计算值得关注？"],
          [
            "When a Best Offer is accepted, eBay hides the amount. CompSniper's median uses the listing price for those sales (their documentation says so), which inflates the 'sold' median toward asking prices.",
            "议价成交被接收后实际成交额可能低于标价；若直接按原挂牌价计算中位价，会使统计整体向要价偏高漂移。",
          ],
        ],
        [
          ["Which is cheaper?", "两者在费用上差距大吗？"],
          [
            "At list prices the tiers look identical ($9/2,000, $29/10,000). The difference is behavioural: cache hits and pagination charges make real CompSniper bills higher than the tier math suggests.",
            "标牌月费完全相近（$9/2k、$29/10k），差异在于计费规则：缓存重复读取与翻页单独消耗额度会使实际月耗用量放大。",
          ],
        ],
      ],
    },
    "soldcomps-io": {
      name: "SoldComps.io",
      verdict: [
        "The developer-experience leader, with MCP plus an Agent Skill and a generous free tier. SoldBench answers with predictable per-search pricing and rule-level evidence.",
        "开发者文档、MCP 与 Agent Skill 体验突出且免费额度高；SoldBench 则主打按次封顶可预测计费、规则级排除理由与 <8 样本零收费护栏。",
      ],
      rows: [
        [
          ["Results per request", "单次条数"],
          ["200", "200 条"],
          ["100", "100 条"],
        ],
        [
          ["Pricing unit", "计费单位"],
          ["1 credit per search", "每次搜索封顶 1 额度"],
          ["20 credits + 1 per returned row", "20 基础额度＋每返回行 1 额度"],
        ],
        [
          ["Median", "中位价"],
          ["Type 7 + range + trimmed mean", "Type 7 中位价＋区间＋截尾均价"],
          ["Yes", "提供"],
        ],
        [
          ["Exclusion reasons", "剔除解释"],
          ["Per row, rule IDs", "逐条带规则编号"],
          ["Flags: lot / for_parts / replica / outlier", "布尔标签（lot / for_parts 等）"],
        ],
        [
          ["Low-sample policy", "低样本策略"],
          ["No median, no charge", "不足 8 条置空且不扣费"],
          ["Publishes and charges", "照常输出统计并扣费"],
        ],
        [
          ["Free tier", "免费额度"],
          ["100 credits/mo + anonymous lookups", "每月 100 额度＋每日 5 次匿名缓存查询"],
          ["2,000 credits/mo", "每月 2,000 额度"],
        ],
        [
          ["MCP", "MCP 支持"],
          ["2 tools", "2 个工具"],
          ["5 tools + Agent Skill", "5 个工具＋Agent Skill"],
        ],
        [
          ["Evidence", "证据能力"],
          ["Full pack with inputs", "完整可重算证据包"],
          ["Logs + stats endpoint", "日志＋统计接口"],
        ],
      ],
      they: [
        [
          "Developer experience: clean docs, MCP server and a published Agent Skill",
          "开发者体验：清晰文档、MCP 服务与 Agent Skill",
        ],
        ["Generous free tier — 2,000 credits a month", "慷慨免费额度：每月 2,000 credits"],
        ["Extra signals like sell-through rate", "附带售罄率等补充分析字段"],
      ],
      us: [
        [
          "Per-search pricing: the bill cannot grow because a search returned more rows",
          "固定按次封顶计费，不因返回条数较多而账单翻倍",
        ],
        ["Rule-numbered exclusion reasons on every row", "每条样本均附对应 R-01 至 R-10 排除编号"],
        ["Low-sample honesty: no median below n = 8, and no charge", "样本不足 8 条不给中位价且免扣额度"],
      ],
      faq: [
        [
          ["Why does per-row pricing matter?", "按返回条数计费为什么会影响预算？"],
          [
            "Because you do not control how many rows a search returns — the market does. A hot item in a busy week can double a per-row bill; a per-search bill cannot move.",
            "热销单品的成交列表往往充满 100+ 条结果，按条收费令成本受市场流动性波动；按次 1 额度封顶令单次请求费用完全可预测。",
          ],
        ],
        [
          ["Is 100 results per request a problem?", "单次 100 条与 200 条有多大区别？"],
          [
            "For common items, the tail beyond 100 is mostly noise — but for statistics you want the full comparable set, and 200 with rule-based cleaning beats 100 with flags.",
            "对于长尾高频商品，扩大到 200 条候选样本并在规则剔除后统一计入统计，有助于覆盖完整周期而不受 100 条截断偏差。",
          ],
        ],
        [
          ["Which free tier is better?", "两家免费档更推荐哪一种？"],
          [
            "Theirs, in raw credits. Ours adds 5 anonymous cached lookups a day with no account at all.",
            "从绝对额度数字看 SoldComps.io 更充足；SoldBench 另提供无需登录即可使用的每日 5 次公共快照查价。",
          ],
        ],
      ],
    },
    "sold-comps-com": {
      name: "sold-comps.com",
      verdict: [
        "An established, efficient data pipe: 240 rows a request across 8 eBay sites. What it does not do is analysis — no aggregate statistics in its dashboard search, no evidence pack, no MCP.",
        "老牌高吞吐数据管线（单次 240 条、覆盖多站点）；但它本身不做聚合分析——网页面板不返回中位价或分布区间，也无 MCP 工具。",
      ],
      rows: [
        [
          ["Results per request", "单次条数"],
          ["200", "200 条"],
          ["240", "240 条"],
        ],
        [
          ["Aggregate statistics", "聚合统计"],
          ["Full: median, range, trimmed mean", "完整中位价、四分位区间、截尾均价"],
          ["None in dashboard search", "工作台搜索无统计值"],
        ],
        [
          ["Median", "中位价"],
          ["Type 7, published method", "公开 Type 7 方法论"],
          ["—", "—"],
        ],
        [
          ["Evidence", "证据能力"],
          ["Full pack: hash, versions, reasons, inputs", "哈希、版本、逐条原因与输入"],
          ["Request history", "仅请求记录"],
        ],
        [
          ["MCP", "MCP 服务"],
          ["Yes — 2 tools", "支持（2 工具）"],
          ["Not advertised", "未公布"],
        ],
        [
          ["Exports", "导出"],
          ["CSV / JSON (signed-in)", "登录支持 CSV / JSON"],
          ["6 free exports", "6 次免费导出"],
        ],
        [
          ["Bulk search", "批量查询"],
          ["Available (20-item CSV workbench)", "支持 20 项 CSV 批量工作台"],
          ["Yes", "支持"],
        ],
        [
          ["Pricing", "入门定价"],
          ["$9 / 2,000 searches", "$9 / 2,000 次"],
          ["$9/mo entry (homepage)", "$9/月起"],
        ],
      ],
      they: [
        [
          "240 results per request across 8 eBay sites, plus Mercari, Poshmark and TCGPlayer",
          "8 个 eBay 站点及多平台支持，单次最高 240 条",
        ],
        ["Established bulk throughput pipeline", "成熟稳定的批量数据管道"],
        ["An established service with a long operating history", "较长运营周期的老牌服务"],
      ],
      us: [
        [
          "Statistics exist at all — median, range, trimmed mean, quality dimensions",
          "自带完整可验证统计值与五维样本质量评估",
        ],
        [
          "An evidence pack that makes every number auditable",
          "每项统计附带候选集哈希、清洗版本与逐条排除理由",
        ],
        ["MCP and agent tooling with the same billing as REST", "提供标准 Hosted MCP 接口并与 REST 共用账本"],
      ],
      faq: [
        [
          ["Is 'no statistics' fair?", "写「无聚合统计」客观吗？"],
          [
            "It is what we verified on November 18, 2026: the signed-in dashboard search returns rows and facets only. If their API computes aggregates, it is not surfaced where users search.",
            "此项严格描述 2026 年 11 月 18 日实测其已登录网页工作台所见功能——仅返回明细与筛选，无中位价等聚合结果展示。",
          ],
        ],
        [
          ["When would I pick sold-comps.com?", "什么场景下更适合选用 sold-comps.com？"],
          [
            "When you want raw rows in bulk across many eBay sites and you run your own statistics — it is an efficient pipe for exactly that.",
            "若你的团队已有完整的下游清洗与自建统计代码，只需要高效拉取多站原始列表，它是不错的数据源管道。",
          ],
        ],
        [
          ["What is hydrateBoa?", "什么是其文档中的 hydrateBoa？"],
          [
            "Their mechanism for fetching true Best Offer prices, at extra requests. It is the honest way to handle hidden prices — we exclude them from defaults instead, and say so.",
            "它是该平台消耗额外请求次数以获取 Best Offer 实际成交价的功能机制；SoldBench 在默认统计口径中先严格隔离未核验议价，再提供独立核验队列。",
          ],
        ],
      ],
    },
    watchcount: {
      name: "WatchCount",
      verdict: [
        "A free lookup tool for casual price checks. The moment you need a defensible number, an API, or evidence, you have outgrown it — that gap is exactly what SoldBench fills.",
        "适合零门槛随手查询单品；但一旦需要经得起争议或业务校验的中位价、API / MCP 集成与完整证据导出，SoldBench 正好弥补这段能力空白。",
      ],
      rows: [
        [
          ["Price", "价格"],
          ["Free tier, then per search", "免费额度＋按次计费"],
          ["Free", "免费"],
        ],
        [
          ["Cleaned median", "清洗后中位价"],
          ["Yes — rule-based, Type 7", "规则清洗＋Type 7"],
          ["No", "无"],
        ],
        [
          ["Evidence pack", "证据包"],
          ["Full", "完整提供"],
          ["No", "无"],
        ],
        [
          ["API", "编程接口"],
          ["REST + MCP", "REST + Hosted MCP"],
          ["No", "无"],
        ],
        [
          ["Results per request", "单次样本量"],
          ["200", "200 条"],
          ["—", "—"],
        ],
        [
          ["Exclusion reasons", "剔除解释"],
          ["Per row, rule IDs", "逐条带规则编号"],
          ["No", "无"],
        ],
        [
          ["Status page", "服务状态"],
          ["Yes", "具备状态面板"],
          ["—", "—"],
        ],
        [
          ["Billing surprises", "计费边界"],
          ["None — failures and low samples are free", "失败与不足 8 条零扣费"],
          ["None (it is free)", "完全免费"],
        ],
      ],
      they: [
        ["Completely free, no account and no key", "免登录免密钥、完全免费"],
        ["Instant for a one-off sanity check", "适合临时看一眼单个商品情况"],
      ],
      us: [
        [
          "A median you can defend — cleaned, verified, with its sample size",
          "可溯源、经过去噪核验的统计中位价与样本量披露",
        ],
        ["Programmatic access: REST, MCP, exports", "提供 REST API、Hosted MCP 与结构化导出"],
        [
          "Evidence and methodology a buyer, seller or auditor can inspect",
          "买家、商家和审计方可独立复查的方法论与完整依据",
        ],
      ],
      faq: [
        [
          ["Why not just use the free tool?", "已有免费网页，什么时候需要用 SoldBench？"],
          [
            "For a single casual check, do. For pricing inventory, settling a dispute or feeding a model, an uncleaned list of listings is not a price — it is homework.",
            "偶尔看一件商品完全可以用免费网页；但在为库存批次定价、应对交易估价争议或向程序/AI 提供数据时，必须要有严谨清洗和证据包。",
          ],
        ],
        [
          ["Does SoldBench have a free tier?", "SoldBench 也有免费额度吗？"],
          [
            "Yes: 100 credits a month, plus 5 anonymous cached lookups a day without an account.",
            "有：注册账户每月附带 100 免费额度，另加每日 5 次免登录公开快照查价。",
          ],
        ],
        [
          ["What does WatchCount do better?", "WatchCount 不可替代的优点是什么？"],
          [
            "Nothing to install, nothing to pay, nothing to learn. Simplicity is a real feature — it is just the only one.",
            "无需注册、零费用、零学习门槛，在非正式轻量查价场景下非常省事。",
          ],
        ],
      ],
    },
  };

  if (view.path.startsWith("/compare/")) {
    const slug = view.path.slice("/compare/".length);
    const cmp = compareData[slug];
    if (cmp) {
      return (
        <section className="blk blk-tight-top">
          <div className="wrap">
            <p className="crumbs">
              <a href={href("/alternatives")}>{t("Alternatives", "竞品方案对比")}</a> /{" "}
              {`SoldBench vs ${cmp.name}`}
            </p>
            <p className="eyebrow">
              {t("COMPARISON · CHECKED NOVEMBER 18, 2026", "对比 · 核查于 2026年11月18日")}
            </p>
            <h1 className="serif mt-10">{`SoldBench vs ${cmp.name}`}</h1>
            <p className="sub mt-10">{t(cmp.verdict[0], cmp.verdict[1])}</p>

            <div className="live-card mt-22">
              <div className="table-scroll">
                <table className="cmp-table tbl-fixed tbl-cmp-2col">
                  <colgroup>
                    <col className="col-cmp2-k" />
                    <col className="col-cmp2-v" />
                    <col className="col-cmp2-v" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th />
                      <th className="sb">
                        SoldBench <span className="you-pill">{t("You are here", "当前产品")}</span>
                      </th>
                      <th>{cmp.name}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cmp.rows.map(([k, usVal, themVal]) => (
                      <tr key={k[0]}>
                        <td>
                          <b>{t(k[0], k[1])}</b>
                        </td>
                        <td className="sb">{t(usVal[0], usVal[1])}</td>
                        <td>{t(themVal[0], themVal[1])}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="grid2 mt-22">
              <div className="card">
                <h3>{t(`Where ${cmp.name} wins`, `${cmp.name} 的优势`)}</h3>
                <ul className="cmp-list">
                  {cmp.they.map((item) => (
                    <li key={item[0]}>{t(item[0], item[1])}</li>
                  ))}
                </ul>
              </div>
              <div className="card">
                <h3>{t("Where SoldBench wins", "SoldBench 的核心优势")}</h3>
                <ul className="cmp-list">
                  {cmp.us.map((item) => (
                    <li key={item[0]}>{t(item[0], item[1])}</li>
                  ))}
                </ul>
              </div>
            </div>

            <h2 className="serif mt-36">{t("FAQ", "常见问题")}</h2>
            <div className="mt-14">
              {cmp.faq.map(([q, a]) => (
                <details className="faq-item" key={q[0]}>
                  <summary>{t(q[0], q[1])}</summary>
                  <div className="faq-body">{t(a[0], a[1])}</div>
                </details>
              ))}
            </div>

            <div className="card cta-card mt-30">
              <h2 className="serif cta-title">
                {t("See the evidence pack for yourself.", "亲自核查每次输出的完整证据包。")}
              </h2>
              <div className="cta-actions">
                <a className="btn btn-brand" href={href("/search")}>
                  {t("Try the workbench", "试用研究工作台")}
                </a>
                <a className="btn btn-ghost" href={href("/alternatives")}>
                  {t("All comparisons", "返回全部对比")}
                </a>
              </div>
            </div>
          </div>
        </section>
      );
    }
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

  if (!current && view.path === "/guides") {
    const guideItems =
      view.entries && view.entries.length > 0
        ? view.entries.map((entry) => ({
            slug: entry.slug,
            title: entry.title,
            desc: entry.body.length > 180 ? `${entry.body.slice(0, 177)}…` : entry.body,
            meta: `${entry.author ? `${entry.author} · ` : ""}${date(entry.publishedAt)}`,
            to: articleLink(entry),
            action: t("Read guide →", "阅读指南 →"),
          }))
        : [
            {
              slug: "how-to-find-sold-comps",
              title: t("How to Find Sold Comps", "如何查找可验证的已售样本"),
              desc: t(
                "The working method: query, clean, verify — and how to tell a real comp from a listing in disguise.",
                "实操查价流程：从强属性构造查询、清洗杂音，到区分真实成交与在售挂牌。",
              ),
              meta: t("6 min read · Nov 2026", "约 6 分钟 · 2026年11月"),
              to: href("/methodology"),
              action: t("Read methodology →", "查看方法论 →"),
            },
            {
              slug: "how-many-comps",
              title: t("How Many Sold Comps Do You Need?", "需要多少条样本才够可信？"),
              desc: t(
                "Why the answer is a threshold, not a vibe: n < 8, 8–29, and 30+ mean different things.",
                "n < 8、8–29 与 30+ 三档阈值的统计学依据：为何不足 8 条必须隐藏中位价。",
              ),
              meta: t("5 min read · Nov 2026", "约 5 分钟 · 2026年11月"),
              to: href("/methodology"),
              action: t("See threshold rules →", "查看样本规则 →"),
            },
            {
              slug: "sold-vs-active",
              title: t("Sold Comps vs Active Listings", "已售成交价 vs 在售挂牌价"),
              desc: t(
                "Asking prices measure seller hope. Sold prices measure the market. When each one helps.",
                "挂牌价反映卖家预期，成交价才反映真实买方支付意愿。",
              ),
              meta: t("4 min read · Nov 2026", "约 4 分钟 · 2026年11月"),
              to: href("/search"),
              action: t("Open workbench →", "打开工作台 →"),
            },
            {
              slug: "why-no-median",
              title: t("Why Your Median Has No Price Sometimes", "为何部分查询返回空值中位价"),
              desc: t(
                "The n < 8 rule in practice — why thin markets report the observed range without fabricating a median.",
                "以 Game Boy Color 等小样本商品为例，说明低样本不扣费与范围披露原则。",
              ),
              meta: t("4 min read · Nov 2026", "约 4 分钟 · 2026年11月"),
              to: href("/worth"),
              action: t("Try price check →", "体验免费查价 →"),
            },
            {
              slug: "reading-evidence",
              title: t("Reading the Evidence Pack", "如何核验每条结果附带的证据包"),
              desc: t(
                "query_id, candidate hashes, rule-numbered exclusions (R-01 to R-10) — a complete field guide.",
                "逐字段解读 query_id、candidate_set_hash 与 R-01 至 R-10 剔除日志。",
              ),
              meta: t("7 min read · Nov 2026", "约 7 分钟 · 2026年11月"),
              to: href("/search?q=Nintendo+Switch+OLED"),
              action: t("Inspect live snapshot →", "查看示例快照 →"),
            },
            {
              slug: "pricing-inventory",
              title: t("Pricing a Whole Inventory", "批量库存 SKU 的分层核价工作流"),
              desc: t(
                "Batch pricing without batch errors: n≥30 auto-pricing, limited-sample checks, and review queues.",
                "将批量商品按样本充足度自动分桶：足量直出、有限抽检、低样本人工复核。",
              ),
              meta: t("8 min read · Nov 2026", "约 8 分钟 · 2026年11月"),
              to: href("/pricing"),
              action: t("See batch & plans →", "查看定价方案 →"),
            },
          ];

    return (
      <>
        <section className="page-head">
          <div className="wrap">
            <p className="eyebrow">{t("GUIDES", "研究指南")}</p>
            <h1>{t("Pricing, explained", "二手成交定价实战指南")}</h1>
            <p className="sub">
              {t(
                "Short, practical guides from the people who built the methodology.",
                "由方法论与数据引擎作者编写的简明实操指南。",
              )}
            </p>
          </div>
        </section>
        <section className="blk blk-tight-top">
          <div className="wrap">
            <div className="grid3 eq">
              {guideItems.map((g) => (
                <article className="card" key={g.slug}>
                  <h3>
                    <a href={g.to}>{g.title}</a>
                  </h3>
                  <p>{g.desc}</p>
                  <p className="small mt-10">{g.meta}</p>
                  <p className="card-foot">
                    <a href={g.to}>{g.action}</a>
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>
      </>
    );
  }

  if (!current && view.path === "/blog") {
    const blogPosts =
      view.entries && view.entries.length > 0
        ? view.entries.map((entry, idx) => ({
            slug: entry.slug,
            title: entry.title,
            desc: entry.body.length > 220 ? `${entry.body.slice(0, 217)}…` : entry.body,
            meta: `${entry.author ? `${entry.author} · ` : ""}${date(entry.publishedAt)}`,
            cat: idx === 0 ? t("FEATURED", "精选") : t("ARTICLE", "文章"),
            to: articleLink(entry),
          }))
        : [
            {
              slug: "price-from-evidence",
              title: t("Price From Evidence: A Method, Not a Guess", "用证据定价：可复现的方法而非直觉估算"),
              desc: t(
                "A repeatable order of operations for turning past sales into a price you can defend — whether you price one item or two hundred.",
                "无论评估单件藏品还是两百件库存，一套始终如一的强属性过滤、清洗与中位数检验顺序。",
              ),
              meta: t("Nov 18, 2026 · 6 min read", "2026年11月18日 · 约 6 分钟"),
              cat: t("METHOD", "方法论"),
              to: href("/methodology"),
            },
            {
              slug: "sold-vs-asking-price",
              title: t(
                "Sold Price vs Asking Price: Two Numbers, Two Questions",
                "已售实价与挂牌要价：两个完全不同的问题",
              ),
              desc: t(
                "Asking prices measure hope and strategy; sold prices measure what buyers actually paid.",
                "在售列表反映卖家博弈心理与锚定效应；已完结成交记录才反映市场真实清理价。",
              ),
              meta: t("Nov 13, 2026 · 5 min read", "2026年11月13日 · 约 5 分钟"),
              cat: t("PRICING", "定价口径"),
              to: href("/alternatives"),
            },
            {
              slug: "reading-a-price-distribution",
              title: t("How to Read a Price Distribution", "如何阅读价格分布与双峰信号"),
              desc: t(
                "The median is a location, not the story. Spread, shape, and bimodal humps tell you when filters are missing.",
                "中位价只是集中位置；四分位宽窄、右偏长尾和双峰结构往往揭示了未拆分版本。",
              ),
              meta: t("Nov 9, 2026 · 6 min read", "2026年11月9日 · 约 6 分钟"),
              cat: t("STATISTICS", "分布统计"),
              to: href("/search?q=Nintendo+Switch+OLED"),
            },
            {
              slug: "what-makes-a-comp-trustworthy",
              title: t("What Makes a Comp Trustworthy?", "一条值得采信的成交样本需要满足什么？"),
              desc: t(
                "Five checks every comparable sale has to pass before it earns a place in your median.",
                "同款同成色、实付价格可知、时间有效、事件去重、剔除记录可审计。",
              ),
              meta: t("Nov 4, 2026 · 5 min read", "2026年11月4日 · 约 5 分钟"),
              cat: t("METHOD", "样本核验"),
              to: href("/methodology"),
            },
          ];
    const feat = blogPosts[0];
    const rest = blogPosts.slice(1);

    return (
      <>
        <section className="page-head">
          <div className="wrap">
            <p className="eyebrow">{t("BLOG", "专栏博客")}</p>
            <h1>{t("Notes on pricing with evidence", "用证据定价的方法笔记")}</h1>
            <p className="sub">
              {t(
                "Method, judgement and the statistics behind sold prices — written to stay useful after the market moves.",
                "围绕方法论、可比判断与成交分布统计的常青笔记，不依赖短期行情预测。",
              )}
            </p>
          </div>
        </section>
        <section className="blk blk-tight-top">
          <div className="wrap">
            {feat && (
              <article className="card published-section">
                <p className="eyebrow">{`${t("LATEST", "最新精选")} · ${feat.cat}`}</p>
                <h2 className="mt-8">
                  <a href={feat.to}>{feat.title}</a>
                </h2>
                <p className="mt-10">{feat.desc}</p>
                <p className="small mt-10">{feat.meta}</p>
              </article>
            )}
            <div className="grid3 eq mt-20">
              {rest.map((post) => (
                <article className="card published-section" key={post.slug}>
                  <p className="eyebrow">{post.cat}</p>
                  <h3 className="mt-8">
                    <a href={post.to}>{post.title}</a>
                  </h3>
                  <p className="mt-8">{post.desc}</p>
                  <p className="small mt-10">{post.meta}</p>
                  <p className="card-foot">
                    <a href={post.to}>{t("Read more →", "阅读全文 →")}</a>
                  </p>
                </article>
              ))}
            </div>
            <p className="small mt-18">
              {t("Looking for step-by-step material? The ", "想查看分步实操流程？欢迎阅读 ")}
              <a href={href("/guides")}>{t("research guides", "研究指南")}</a>
              {t(" teach the working method.", "了解一线研究与工程判断顺序。")}
            </p>
          </div>
        </section>
      </>
    );
  }

  if (view.path === "/about" || view.path === "/privacy" || view.path === "/terms") {
    const meta =
      view.path === "/about"
        ? {
            eyebrow: t("ABOUT", "关于我们"),
            heading: t("About SoldBench", "关于 SoldBench"),
            sub: t(
              "What this service is, who it is for, and how it makes its numbers.",
              "了解 SoldBench 的定位、服务对象以及统计与证据包生成原则。",
            ),
            sections: [
              [
                t("What SoldBench is", "SoldBench 是什么"),
                t(
                  "SoldBench is a sold-price data service for eBay US. It collects completed sales, cleans them with a published rule set, and returns defensible statistics — the median sold price, the typical range, quality dimensions, and the evidence behind every number — through a web workbench, a REST API, and an MCP server.",
                  "SoldBench 是面向 eBay US 成交价研究的平台，通过公开规则对已完结成交记录进行强属性清洗、统计计算，并通过网页工作台、REST API 和托管 MCP 服务返回附带证据包的区间统计结果。",
                ),
              ],
              [
                t("Who it is for", "服务对象"),
                t(
                  "Resellers pricing inventory, collectors verifying what an item sells for before bidding, and developers and agents that need an auditable sold price. Below 8 verified comparable prices, no center statistic is published — only the observed range and reason.",
                  "服务二手商家批量定盘、收藏交易者出价核查以及开发者与 AI Agent 集成场景。有效核验可比成交少于 8 条时绝不强行给出中心均值，仅如实反馈已观察区间与原因。",
                ),
              ],
              [
                t("What SoldBench is not", "能力与免责边界"),
                t(
                  "SoldBench is not affiliated with eBay Inc. Prices represent historical completed observations under stated windows and modes — not appraisals, authentication, or guaranteed future resale value.",
                  "SoldBench 与 eBay Inc. 无隶属或背书关系。全部价格数值仅反映特定时间窗口和来源模式下的历史成交观察事实，不构成真伪鉴定、资产评估或未来售价担保。",
                ),
              ],
              [
                t("Contact", "联系我们"),
                t(
                  "Target production endpoints: https://soldbench.com · API https://api.soldbench.com/v1 · MCP https://soldbench.com/mcp · Support support@soldbench.com.",
                  "规划服务入口：网站 https://soldbench.com · API https://api.soldbench.com/v1 · MCP https://soldbench.com/mcp · 客服 support@soldbench.com。",
                ),
              ],
            ],
          }
        : view.path === "/privacy"
          ? {
              eyebrow: t("PRIVACY", "隐私政策"),
              heading: t("Privacy policy", "隐私政策"),
              sub: t(
                "What we collect, what we never collect, and how account deletion works.",
                "说明收集的数据范围、不采集项以及账户删除与审计留存机制。",
              ),
              sections: [
                [
                  t("What we collect", "收集的信息"),
                  t(
                    "Account email and Argon2 password hash; API usage and search parameter records required for billing ledgers, 10-minute deduplication, and owner history; and payment confirmations/references from Stripe (primary) and PayPal (supplementary) without storing card numbers.",
                    "账户邮箱与加密口令哈希；用于账本结算、10 分钟去重与研究历史回看的查询日志；以及来自 Stripe / PayPal 的支付回执参考编号（绝不保存完整银行卡号）。",
                  ),
                ],
                [
                  t("What we never collect or sell", "不采集与不出售"),
                  t(
                    "We do not sell personal data, run third-party ad trackers, or feed customer query histories into advertising profiles. Operations views mask user emails and keep API secrets one-time display / hash-only.",
                    "不出售用户个人数据，不使用跨站广告追踪 Cookie；运营控制台脱敏展示账户标识，API 密钥仅在创建时完整显示一次并仅以安全哈希落库。",
                  ),
                ],
                [
                  t("Retention & deletion", "数据留存与删除回执"),
                  t(
                    "You can request account deletion from Security settings or submit a deletion receipt inquiry on Support. Legally retained financial records are masked without retaining raw credential or query secrets.",
                    "用户可在账户安全中心发起注销删除，并通过私密回执查询清理进展；依法必须留存的财务对账记录会与可读身份及查询明文脱敏隔离。",
                  ),
                ],
              ],
            }
          : {
              eyebrow: t("TERMS", "服务条款"),
              heading: t("Terms of service", "服务条款"),
              sub: t(
                "Rules for accounts, credits, API metering, and acceptable use.",
                "规范账户安全、额度结算边界、研究口径披露及可接受使用规则。",
              ),
              sections: [
                [
                  t("Credits and billing", "额度与计费口径"),
                  t(
                    "One valid delivered search consumes at most 1 credit regardless of returning 1 or 200 comps. Failures, low-sample (<8 verified) lookups, async polling, and 10-minute identical repeats are free. Purchased top-up credits never expire and are drawn after expiring subscription or promo buckets.",
                    "每次成功交付的标准查询最多扣除 1 额度（最多含 200 条记录）；查询失败、低样本（<8）、异步排队轮询及 10 分钟内同参数复用免费。购买的永久加量包永不过期且在订阅/活动桶用尽后扣除。",
                  ),
                ],
                [
                  t("Rights & revocation", "来源权限与撤权机制"),
                  t(
                    "Delivery is checked continuously against current source clearances and permission epochs across web, exports, shares, and primary images.",
                    "网页研究、导出文件、外链分享及主图读取均实时校验当前来源授权与权限纪元，撤权后即刻停止分发。",
                  ),
                ],
                [
                  t("About the data", "数据口径说明"),
                  t(
                    "Results represent observed samples from stated marketplaces and modes (currently local offline fixture mode until live clearances are signed), not total marketplace volume.",
                    "查询结果反映指定平台与当前模式下的有效样本统计（当前处于离线演示模式），不代表平台全市场总销量。",
                  ),
                ],
              ],
            };

    return (
      <>
        <section className="page-head">
          <div className="wrap">
            <p className="eyebrow">{meta.eyebrow}</p>
            <h1>{meta.heading}</h1>
            <p className="sub">{meta.sub}</p>
          </div>
        </section>
        <section className="blk blk-tight-top">
          <div className="wrap">
            <div className="legal-wrap">
              <article className="card published-section docs-body">
                {current ? (
                  <>
                    <div>
                      <h2>{current.title}</h2>
                      {paragraphBlocks(current.body)}
                    </div>
                    {view.path === "/about" &&
                      !current.body.includes("\n\n") &&
                      meta.sections.slice(1).map(([heading, body]) => (
                        <div key={heading}>
                          <h2>{heading}</h2>
                          <p>{body}</p>
                        </div>
                      ))}
                  </>
                ) : (
                  meta.sections.map(([heading, body]) => (
                    <div key={heading}>
                      <h2>{heading}</h2>
                      <p>{body}</p>
                    </div>
                  ))
                )}
                {(view.path === "/terms" || view.path === "/privacy") && (
                  <p className="notice mt-16">
                    {t("The policy is pending separate publication approval.", "政策尚待独立批准和发布。")}
                  </p>
                )}
              </article>
              <p className="small mt-18">
                {t("See also:", "延伸阅读：")} <a href={href("/about")}>{t("About", "关于")}</a> ·{" "}
                <a href={href("/privacy")}>{t("Privacy", "隐私政策")}</a> ·{" "}
                <a href={href("/terms")}>{t("Terms", "服务条款")}</a> ·{" "}
                <a href={href("/methodology")}>{t("Methodology", "方法论")}</a>
              </p>
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
