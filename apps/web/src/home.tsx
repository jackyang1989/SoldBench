import type { DataMode, Locale } from "@soldbench/shared";
import type { ReactNode } from "react";

export type HomeShowcaseComp = {
  sale_event_id: string;
  title: string | null;
  condition_std: string | null;
  sale_format: string;
  item_price_cents: number | null;
  observed_shipping_cents: number | null;
  price_usd_cents: number;
  sold_date: { precision: string; value?: string; timeZone?: string | null };
  sale_price_status: "verified_actual";
};

export type HomeShowcase = {
  query_id: string;
  query: string;
  window_days: number;
  price_basis: string;
  candidate_set_hash: string;
  data_as_of: string;
  engine_version: string;
  cleaner_version: string;
  data_mode: DataMode;
  stats: {
    n_observed: number;
    n_comparable: number;
    n_price_verified: number;
    n_excluded_unverified_price: number;
    sold_last_30d_observed: number;
    buy_it_now_verified_count: number;
    best_offer_verified_count: number;
    best_offer_displayed_only_count: number;
    median_cents: number | null;
    p25_cents: number | null;
    p75_cents: number | null;
    trimmed_mean_cents: number | null;
    observed_min_cents: number | null;
    observed_max_cents: number | null;
  };
  quality: Record<string, unknown>;
  comps: HomeShowcaseComp[];
};

type SiteBlock = { slug: string; title: string; body: string; kind: string; target?: string };
type PublishedSection = { slug: string; title: string; body: string };

function fmtMoney(cents: number | null | undefined, locale: Locale): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "—";
  return new Intl.NumberFormat(locale === "zh-CN" ? "en-US" : "en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function fmtSoldDate(soldDate: HomeShowcaseComp["sold_date"], zh: boolean): string {
  if (soldDate.precision === "day" && soldDate.value) return soldDate.value;
  if (soldDate.precision === "instant" && soldDate.value) return soldDate.value.slice(0, 10);
  return zh ? "未知" : "Unknown";
}

function fmtCondition(std: string | null, zh: boolean): string {
  switch (std) {
    case "new":
      return zh ? "全新" : "New";
    case "like_new":
      return zh ? "近新" : "Like new";
    case "good":
      return zh ? "良好" : "Good";
    case "fair":
      return zh ? "一般" : "Fair";
    case "defective":
      return zh ? "故障/零件" : "For parts";
    default:
      return "—";
  }
}

function fmtShipping(cents: number | null | undefined, locale: Locale, zh: boolean): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return zh ? "未知" : "Unknown";
  if (cents === 0) return zh ? "免运费" : "Free";
  return fmtMoney(cents, locale);
}

function fmtFormat(fmt: string, zh: boolean): string {
  switch (fmt) {
    case "fixed_price":
      return zh ? "一口价" : "Fixed price";
    case "auction":
      return zh ? "拍卖" : "Auction";
    case "best_offer":
      return zh ? "议价" : "Best Offer";
    default:
      return fmt || "—";
  }
}

function fmtFormatClass(fmt: string): string {
  switch (fmt) {
    case "auction":
      return "badge badge-amber";
    case "best_offer":
      return "badge badge-gray";
    default:
      return "badge badge-green";
  }
}

export function BrandLogo({ size = 27 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.4" />
      <circle cx="12" cy="12" r="3.4" fill="currentColor" />
      <path d="M12 1v5M12 18v5M1 12h5M18 12h5" stroke="currentColor" strokeWidth="2.4" />
    </svg>
  );
}

export function HomeSections({
  locale,
  link,
  searchBox,
  examples,
  market,
  status,
  sections,
  blocks,
  homeShowcase,
}: {
  locale: Locale;
  link: (path: string) => string;
  searchBox: ReactNode;
  examples: ReactNode;
  market: ReactNode;
  status: ReactNode;
  sections: PublishedSection[];
  blocks: SiteBlock[];
  homeShowcase: HomeShowcase | null;
}) {
  const zh = locale === "zh-CN";
  const t = (en: string, cn: string) => (zh ? cn : en);
  const docsSlug = (slug: string) => `/${zh ? "docs/zh-CN" : "docs/en"}/${slug}`;

  const categories = [
    {
      id: "cards",
      name: t("Trading & graded cards", "集换与评级卡牌"),
      blurb: t(
        "PSA, BGS and CGC sales separated strictly by grading company and grade — never mixing a PSA 9 into a PSA 10.",
        "按评级机构与分数严格隔离 PSA、BGS 与 CGC 成交样本——绝不把 PSA 9 混入 PSA 10。",
      ),
      popular: ["Charizard PSA 10", "Pokemon Base Set", "Shohei Ohtani PSA 10", "Lorcana Enchanted"],
    },
    {
      id: "games",
      name: t("Video games & consoles", "电子游戏与主机"),
      blurb: t(
        "Console models, storage variants and complete-in-box listings cleanly separated from loose cartridges or broken hardware.",
        "精准区分主机版本、容量与盒装成色，排除散盘、破损故障件与多件捆绑。",
      ),
      popular: ["Nintendo Switch OLED", "Game Boy Color CIB", "PlayStation 5 Slim", "Pokemon Emerald"],
    },
    {
      id: "electronics",
      name: t("Phones & hardware", "手机与硬件"),
      blurb: t(
        "Storage tier, carrier lock and parts-only exclusions checked before statistics are computed.",
        "计算中位价前先行校对容量、锁版状态与配件故障排除规则。",
      ),
      popular: ["iPhone 15 Pro 256GB", "RTX 4070", "MacBook Air M2", "Steam Deck OLED"],
    },
    {
      id: "watches",
      name: t("Watches", "机械与收藏腕表"),
      blurb: t(
        "Reference numbers, box-and-papers context and hidden Best Offer prices isolated from the verified center.",
        "跟踪型号编号与盒证信息，未核实议价自动隔离出默认统计口径。",
      ),
      popular: ["Rolex Datejust 36mm", "Omega Speedmaster", "Seiko SKX007", "Tudor Black Bay 58"],
    },
    {
      id: "sneakers",
      name: t("Sneakers", "潮流球鞋"),
      blurb: t(
        "Deadstock vs pre-owned separated with full buyer-paid price visibility where shipping is reported.",
        "清晰分离全新与二手样本，并结合已观察运费透明计算总成本区间。",
      ),
      popular: ["Air Jordan 1 Retro High", "Nike Dunk Low", "New Balance 550", "Adidas Samba OG"],
    },
    {
      id: "collectibles",
      name: t("Collectibles", "潮流玩具与收藏品"),
      blurb: t(
        "Consistent eBay US USD statistics and auditable snapshots with no undisclosed listing-price mixing.",
        "基于单一市场 eBay 美国站（USD）形成可复现、可引用的核验样本快照。",
      ),
      popular: ["LEGO retired sets", "Funko Pop exclusive", "Vintage Star Wars", "First edition books"],
    },
  ];

  const apiSampleQuery = homeShowcase?.query ?? "Nintendo Switch OLED";
  const qRaw = homeShowcase?.quality ?? {};
  const conciseQuality = homeShowcase
    ? {
        sample_tier:
          typeof qRaw.sample_tier === "string"
            ? qRaw.sample_tier
            : homeShowcase.stats.n_price_verified >= 30
              ? "sufficient"
              : homeShowcase.stats.n_price_verified >= 8
                ? "limited"
                : "insufficient",
        quality_status: typeof qRaw.quality_status === "string" ? qRaw.quality_status : "limited_sample",
        data_insufficient: homeShowcase.stats.n_price_verified < 8,
        total_score: null,
      }
    : {
        data_insufficient: true,
        quality_status: "insufficient_sample",
        total_score: null,
      };
  const apiJsonPreview = JSON.stringify(
    homeShowcase
      ? {
          query: homeShowcase.query,
          stats: {
            median_cents: homeShowcase.stats.median_cents,
            p25_cents: homeShowcase.stats.p25_cents,
            p75_cents: homeShowcase.stats.p75_cents,
            trimmed_mean_cents: homeShowcase.stats.trimmed_mean_cents,
            observed_min_cents: homeShowcase.stats.observed_min_cents,
            observed_max_cents: homeShowcase.stats.observed_max_cents,
            n_price_verified: homeShowcase.stats.n_price_verified,
          },
          quality: conciseQuality,
          meta: {
            query_id: homeShowcase.query_id,
            candidate_set_hash: homeShowcase.candidate_set_hash,
            engine_version: homeShowcase.engine_version,
            cleaner_version: homeShowcase.cleaner_version,
            data_mode: homeShowcase.data_mode,
            credits_charged: 1,
          },
        }
      : {
          query: apiSampleQuery,
          stats: {
            median_cents: null,
            p25_cents: null,
            p75_cents: null,
            n_price_verified: 0,
            n_comparable: 0,
          },
          quality: conciseQuality,
          meta: {
            note: t(
              "No public snapshot cached yet — run dev:seed or submit an authenticated query.",
              "暂未发布公共示例快照——运行 dev:seed 或登录后提交查价即可生成实测响应。",
            ),
          },
        },
    null,
    2,
  );

  const previewStats = homeShowcase?.stats;
  const previewPrices = (homeShowcase?.comps ?? [])
    .map((c) => c.item_price_cents)
    .filter((v): v is number => v !== null && Number.isSafeInteger(v));
  const previewMeanCents =
    previewStats && previewStats.n_price_verified >= 8 && previewPrices.length > 0
      ? Math.round(previewPrices.reduce((sum, v) => sum + v, 0) / previewPrices.length)
      : null;
  const previewShipValues = (homeShowcase?.comps ?? [])
    .map((c) => c.observed_shipping_cents)
    .filter((v): v is number => v !== null && Number.isSafeInteger(v));
  const previewAvgShipCents =
    previewShipValues.length > 0
      ? Math.round(previewShipValues.reduce((sum, v) => sum + v, 0) / previewShipValues.length)
      : null;
  const sampleTierLabel = !previewStats
    ? t("No snapshot", "暂无快照")
    : previewStats.n_price_verified >= 30
      ? t("Full sample", "充足样本")
      : previewStats.n_price_verified >= 8
        ? t("Limited sample", "有限样本")
        : t("Below minimum", "不足 8 条最低样本");
  const sourceBadgeLabel =
    homeShowcase?.data_mode === "approved_network"
      ? t("Approved sample", "合规样本")
      : t("Offline fixture", "本地合成样本");
  const publishedCmsFaqs = sections
    .filter((entry) => entry.slug.startsWith("faq-"))
    .map((entry) => [entry.title, entry.body] as const);
  const homeFaqs: (readonly [string, string])[] = [
    ...publishedCmsFaqs,
    [
      t("Why are fewer than 8 verified sales returning null?", "为什么核验价格少于 8 条时中位价显示为空？"),
      t(
        "A center metric computed from 2–7 sales misleads pricing decisions. SoldBench strictly withholds median/IQR/trimmed mean below 8 verified prices, shows observed rows honestly, and never charges a credit.",
        "不足 8 条有效成交计算的中心统计误差极大。SoldBench 严守规则，不足 8 条时中位价、典型区间与截尾均价置空并说明原因，仅诚实列出已观察价格且绝不扣费。",
      ),
    ],
    [
      t("How are Best Offer and unknown shipping handled?", "未公开实价的 Best Offer 与未知运费如何处理？"),
      t(
        "Undisclosed Best Offer accepted amounts never enter default averages or medians, and unknown shipping is never filled with zero. Both remain auditable in diagnostics.",
        "未披露实际接受价的 Best Offer 仅出现在诊断与展示层，不计入默认统计；未知所需运费绝不按零填充，保持可核查。",
      ),
    ],
    [
      t("When is 1 credit deducted?", "什么时候才会扣除 1 个查询额度？"),
      t(
        "Waiting in the async queue, rate-limited polls, low-sample (<8) results, and duplicate re-fetches within 10 minutes are all free. For async jobs, 1 credit settles atomically only when you explicitly claim a deliverable result.",
        "异步排队、轮询、失败、不足 8 条的低样本结果及 10 分钟内同参数复取均免费；异步任务仅在您显式点击领取可交付结果时原子扣除 1 额度。",
      ),
    ],
    [
      t(
        "Do web research, REST API, and MCP share one rule set?",
        "网页端、REST API 与 MCP 是否共用同一规则与额度？",
      ),
      t(
        "Yes. Web, REST API (`/v1/sold`), and MCP (`sold_search` / `sold_stats`) call the same single domain Query & Billing services and share identical cleaning, evidence hashes, and credit buckets.",
        "是的。网页研究台、REST API（`/v1/sold`）与 MCP 工具（`sold_search` / `sold_stats`）严格复用同一套查询、清洗、权限与计费领域服务。",
      ),
    ],
  ];

  const pricingPreviewPlans = [
    {
      name: t("Free", "免费体验"),
      price: "$0",
      sub: t("100 credits / mo · 30 req/min", "每月 100 额度 · 30 次/分"),
      feats: [
        t("Up to 200 comps per search", "每次查价最多返回 200 条可比样本"),
        t("Evidence pack on every result", "所有结果附带完整证据包"),
        t("Dashboard & API access", "支持网页工作台与 API 调用"),
      ],
      cta: t("Compare plans →", "对比套餐 →"),
      pop: false,
    },
    {
      name: "Starter",
      price: "$9",
      sub: t("2,000 credits / mo · 60 req/min", "每月 2,000 额度 · 60 次/分"),
      feats: [
        t("Everything in Free", "包含免费版全部能力"),
        t("10-minute identical reuse free", "10 分钟内同参数复用免费"),
        t("Full CSV & JSON exports", "支持完整权威/调整视图导出"),
      ],
      cta: t("Compare plans →", "对比套餐 →"),
      pop: false,
    },
    {
      name: "Pro",
      price: "$29",
      sub: t("10,000 credits / mo · 300 req/min", "每月 10,000 额度 · 300 次/分"),
      feats: [
        t("Batch lookup & Saved comparisons", "批量查价工作台与已保存对照"),
        t("Async queue & explicit claim", "高并发异步队列与显式领取"),
        t("MCP hosts + alerts support", "Hosted MCP 集成与监控告警"),
      ],
      cta: t("Compare plans →", "对比套餐 →"),
      pop: true,
    },
    {
      name: t("Top-up", "永久加量包"),
      price: "$10",
      sub: t("1,500 credits · Never expires", "1,500 额度 · 永久有效"),
      feats: [
        t("Stacks on any active plan", "可叠加至任意订阅套餐"),
        t("Drawn only after subscription", "订阅桶消耗完毕后再启用"),
        t("Refunds return to same bucket", "退款原路径退回对应额度桶"),
      ],
      cta: t("Compare plans →", "对比套餐 →"),
      pop: false,
    },
  ];

  const heroRows = homeShowcase?.comps.slice(0, 5) ?? [];

  return (
    <>
      {blocks
        .filter((row) => row.kind === "home")
        .map((row) => (
          <section className="wrap published-section pt-20" key={row.slug}>
            <div className="notice">
              <strong>{row.title}</strong>
              <p className="mt-6">{row.body}</p>
              {row.target && (
                <p className="mt-8">
                  <a href={link(row.target)}>{t("Learn more", "了解更多")}</a>
                </p>
              )}
            </div>
          </section>
        ))}

      {/* Section 1: Hero + Live Example/Authorized Cache Card */}
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
                "查看可比成交、了解价格区间，并核查每个结果背后的证据与排除规则。",
              )}
            </p>
            <form action={link("/search")} method="get" data-search="">
              {searchBox}
            </form>
            {examples}
            <p className="hero-worth-link">
              <a href={link("/worth")}>
                {t(
                  "Quick anonymous check on What's it worth? (5 free cached lookups / day) →",
                  "先逛「商品值多少钱」？匿名游客每日可免费试用 5 次公共缓存 →",
                )}
              </a>
            </p>
            {market}
            {status}
            <div className="actions" data-actions="" />
          </div>
          <div>
            <div data-results="" />
            <aside className="live-card" data-hero-showcase="" hidden={!homeShowcase}>
              <div className="live-head">
                <span className="t">
                  {homeShowcase
                    ? `${t("PUBLIC SNAPSHOT · ", "公共快照 · ")}${homeShowcase.query}`
                    : t("Comparable sales", "可比成交")}
                </span>
                <span className="tag-ex">{sourceBadgeLabel}</span>
              </div>
              <div className="table-scroll">
                <table className="mini-table">
                  <colgroup>
                    <col className="col-title" />
                    <col className="col-price" />
                    <col className="col-date" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>{t("Title", "商品")}</th>
                      <th className="num">{t("Price", "价格")}</th>
                      <th>{t("Date", "日期")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {heroRows.map((comp) => (
                      <tr key={comp.sale_event_id}>
                        <td>
                          {comp.title ?? t("Verified listing (title withheld)", "已核验样本（标题隐藏）")}
                        </td>
                        <td className="num price">{fmtMoney(comp.item_price_cents, locale)}</td>
                        <td className="nw">{fmtSoldDate(comp.sold_date, zh)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="median-strip">
                <div>
                  <span className="lab">{t("Clean median", "净中位价")}</span>
                  <strong>{fmtMoney(previewStats?.median_cents, locale)}</strong>
                </div>
                <div>
                  <span className="lab">{t("Typical range", "典型区间")}</span>
                  <strong>
                    {previewStats?.p25_cents != null
                      ? `${fmtMoney(previewStats.p25_cents, locale)} – ${fmtMoney(previewStats.p75_cents, locale)}`
                      : "—"}
                  </strong>
                </div>
                <div>
                  <span className="lab">{t("Sample", "核验样本")}</span>
                  <strong>{`${previewStats?.n_price_verified ?? 0} ${t("verified", "条")}`}</strong>
                </div>
              </div>
            </aside>
            <aside className="live-card" data-hero-empty="" hidden={Boolean(homeShowcase)}>
              <div className="live-head">
                <span className="t">{t("Comparable sales", "可比成交")}</span>
                <span className="badge">{t("Offline workspace", "离线工作区")}</span>
              </div>
              <div className="table-scroll">
                <table className="mini-table">
                  <colgroup>
                    <col className="col-title" />
                    <col className="col-price" />
                    <col className="col-date" />
                  </colgroup>
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
                  <span className="lab">{t("Median", "中位价")}</span>
                  <strong>—</strong>
                </div>
                <div>
                  <span className="lab">{t("Typical range", "典型区间")}</span>
                  <strong>—</strong>
                </div>
                <div>
                  <span className="lab">{t("Verified sample", "核验样本")}</span>
                  <strong>—</strong>
                </div>
              </div>
            </aside>
          </div>
        </div>
      </section>

      {/* Section 2: Category Coverage */}
      <section className="blk blk-tight-top">
        <div className="wrap">
          <div className="blk-head">
            <p className="eyebrow">{t("Category coverage", "类目覆盖")}</p>
            <h2>
              {t(
                "One search across the categories resellers actually price",
                "一次搜索，覆盖转售与收藏高频核心类目",
              )}
            </h2>
          </div>
          <div className="tabs tabs-row" role="tablist" aria-label={t("Categories", "类目")}>
            {categories.map((cat, idx) => (
              <button
                key={cat.id}
                type="button"
                role="tab"
                className={idx === 0 ? "on" : ""}
                aria-selected={idx === 0 ? "true" : "false"}
                data-home-cat-tab={cat.id}
              >
                {cat.name}
              </button>
            ))}
          </div>
          {categories.map((cat, idx) => (
            <div className="card" key={cat.id} data-home-cat-panel={cat.id} hidden={idx !== 0}>
              <h3>{cat.name}</h3>
              <p>{cat.blurb}</p>
              <div className="chips mt-14">
                <span className="lbl">{t("POPULAR", "常见检索")}</span>
                {cat.popular.map((term) => (
                  <a
                    className="chip"
                    key={term}
                    href={`${link("/search")}?${new URLSearchParams({ q: term })}`}
                  >
                    {term}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Section 3: The API */}
      <section className="blk band">
        <div className="wrap">
          <div className="blk-head">
            <p className="eyebrow">{t("The API", "开发者接口")}</p>
            <h2>
              {t("One endpoint. Clean JSON, ", "统一接口。纯净结构化响应，")}
              <span className="kw">{t("with evidence", "附完整可追溯证据")}</span>
              {t(".", "。")}
            </h2>
            <p>
              {t(
                "Every response carries cleaned statistics, explicit sample counts, and evidence metadata — query_id, candidate_set_hash, engine and cleaner versions — traceable back to each qualifying transaction.",
                "每次响应都同步返回清洗后的分位统计、明确样本计数，以及 query_id、candidate_set_hash、引擎与清洗版本号等完整证据元数据。",
              )}
            </p>
          </div>
          <div className="grid2 api-grid">
            <div className="codeblock cap">
              <div className="cb-head">
                <div className="api-tabs" role="tablist" aria-label={t("API language", "示例代码语言")}>
                  {(["curl", "python", "node", "mcp"] as const).map((lang, idx) => (
                    <button key={lang} type="button" className={idx === 0 ? "on" : ""} data-api-tab={lang}>
                      {lang === "curl"
                        ? "cURL"
                        : lang === "python"
                          ? "Python"
                          : lang === "node"
                            ? "Node"
                            : "MCP"}
                    </button>
                  ))}
                </div>
                <button type="button" className="copy-btn" data-copy="#homeApiCode">
                  {t("Copy", "复制")}
                </button>
              </div>
              <pre
                id="homeApiCode"
                data-api-code="curl"
              >{`# 1 credit per valid delivered search (up to 200 comps)
curl -sS -G "https://api.soldbench.com/v1/sold" \\
  -H "Authorization: Bearer $SOLDBENCH_API_KEY" \\
  --data-urlencode "q=${apiSampleQuery}" \\
  --data-urlencode "window_days=90" \\
  --data-urlencode "limit=50"

# Headers tell you cost before reading the body:
#   X-Request-Id:        req_9f42ac71be
#   X-Credits-Charged:   1
#   X-Quota-Remaining:   99

# Low-sample (<8), failures, and 10m repeats are free.
# Wide jobs run async and settle only at explicit claim:
curl -sS -X POST "https://api.soldbench.com/v1/sold" \\
  -H "Authorization: Bearer $SOLDBENCH_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"q":"${apiSampleQuery}","window_days":90,"limit":50}'

curl -sS -X POST "https://api.soldbench.com/v1/jobs/{job_id}/claim" \\
  -H "Authorization: Bearer $SOLDBENCH_API_KEY"`}</pre>
            </div>
            <div className="codeblock cap">
              <div className="cb-head">
                <span>{t("Response · Evidence attached", "响应体 · 附带证据元数据")}</span>
                <button type="button" className="copy-btn" data-copy="#homeApiResp">
                  {t("Copy", "复制")}
                </button>
              </div>
              <pre id="homeApiResp">{apiJsonPreview}</pre>
            </div>
          </div>
          <div className="grid4 eq mt-20">
            {[
              [
                t("Raw or cleaned", "原始与清洗双视图"),
                t(
                  "Inspect authoritative statistics or apply local exclusions without mutating verified snapshots.",
                  "同时查看权威统计与局部调整结果，清洗版本随每份快照固化可查。",
                ),
              ],
              [
                t("200 comps per search", "每次最多 200 条"),
                t(
                  "One request settles at most 1 credit for up to 200 comparables — never billed per returned listing.",
                  "每次有效查价最多扣 1 额度即可返回多达 200 条记录，按次计费而非按条计费。",
                ),
              ],
              [
                t("Evidence in every response", "每次结果自带证据"),
                t(
                  "query_id, candidate_set_hash, exclusion reasons, and field permissions travel with every stat.",
                  "query_id、候选集摘要哈希、排除原因编号与字段权限校验随结果下发。",
                ),
              ],
              [
                t("Works in Claude & Cursor", "原生支持 Claude 与 Cursor"),
                t(
                  "Hosted MCP server with OAuth 2.1/PKCE or API key — sharing identical billing and permission rules.",
                  "支持 OAuth 2.1/PKCE 与 API Key 的托管 MCP 服务，共用完全一致的计费与权限规则。",
                ),
              ],
            ].map(([title, desc]) => (
              <div className="card" key={title}>
                <h3>{title}</h3>
                <p>{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Section 4: Dashboard Search Interactive Preview */}
      <section className="blk">
        <div className="wrap">
          <div className="blk-head">
            <p className="eyebrow">{t("Dashboard search", "浏览器研究台")}</p>
            <h2>
              {t("Search, review, and export ", "无需写代码，直接筛选、复核并导出")}
              <span className="kw">{t("without code", "可辩护价格")}</span>
            </h2>
            <p>
              {t(
                "The same domain engine directly in the browser. Filter condition or format and inspect the live authorized public snapshot.",
                "浏览器内复用完全相同的领域统计内核。现场筛选成色与成交方式，实时重算中位价并核查明细。",
              )}
            </p>
          </div>
          <div className="home-frow" data-home-filter-bar="">
            <div className="field field-grow">
              <label htmlFor="homePreviewQ">{t("Search", "关键词")}</label>
              <input id="homePreviewQ" value={homeShowcase?.query ?? apiSampleQuery} readOnly />
            </div>
            <div className="field field-sel">
              <label htmlFor="homePreviewCond">{t("Condition", "成色")}</label>
              <select id="homePreviewCond" data-home-cond="">
                <option value="">{t("Any", "不限")}</option>
                <option value="new">{t("New", "全新")}</option>
                <option value="like_new">{t("Like new", "近新")}</option>
                <option value="good">{t("Good", "良好")}</option>
                <option value="fair">{t("Fair", "一般")}</option>
                <option value="defective">{t("For parts", "故障/零件")}</option>
              </select>
            </div>
            <div className="field field-sel">
              <label htmlFor="homePreviewFormat">{t("Format", "成交方式")}</label>
              <select id="homePreviewFormat" data-home-format="">
                <option value="">{t("Any format", "不限方式")}</option>
                <option value="fixed_price">{t("Fixed price", "一口价")}</option>
                <option value="auction">{t("Auction", "拍卖")}</option>
                <option value="best_offer">{t("Best Offer", "议价")}</option>
              </select>
            </div>
            <fieldset className="seg" aria-label={t("Preview view", "预览视图")}>
              <button type="button" className="on" data-home-view="table">
                {t("Table", "表格")}
              </button>
              <button type="button" data-home-view="json">
                JSON
              </button>
              <button type="button" data-home-csv="">
                {t("Export CSV", "导出 CSV")}
              </button>
            </fieldset>
          </div>

          <div className="stat-card mt-14" data-home-stats="">
            <div className="stat-badges">
              <span className="badge badge-green">{t("Interactive preview", "交互预览")}</span>
              <span className="tag-ex">{sourceBadgeLabel}</span>
            </div>
            <div className="stat-grid">
              <div>
                <div className="lab">{t("Median sold price", "中位成交价")}</div>
                <div className="median-big">{fmtMoney(previewStats?.median_cents, locale)}</div>
                <div className="stat-range">
                  {previewStats?.p25_cents != null
                    ? `${t("Typical range", "典型区间")} ${fmtMoney(previewStats.p25_cents, locale)} – ${fmtMoney(previewStats.p75_cents, locale)}`
                    : `${t("Typical range", "典型区间")} —`}
                </div>
                <div className="small mt-6">
                  {`${sampleTierLabel} · ${t("Basis: item price", "口径：仅商品价")}`}
                </div>
              </div>
              <div className="stat-mini">
                <div>
                  <div className="lab">{t("Average", "均值")}</div>
                  <div className="val">{fmtMoney(previewMeanCents, locale)}</div>
                </div>
                <div>
                  <div className="lab">{t("Trimmed mean", "5% 截尾均价")}</div>
                  <div className="val">{fmtMoney(previewStats?.trimmed_mean_cents, locale)}</div>
                </div>
                <div>
                  <div className="lab">{t("Low – High", "最低 – 最高")}</div>
                  <div className="val">
                    {previewStats?.observed_min_cents != null
                      ? `${fmtMoney(previewStats.observed_min_cents, locale)} – ${fmtMoney(previewStats.observed_max_cents, locale)}`
                      : "—"}
                  </div>
                </div>
                <div>
                  <div className="lab">{t("Avg shipping", "平均运费")}</div>
                  <div className="val">{fmtShipping(previewAvgShipCents, locale, zh)}</div>
                </div>
                <div>
                  <div className="lab">{t("Sample (verified)", "核验样本")}</div>
                  <div className="val">{previewStats ? String(previewStats.n_price_verified) : "—"}</div>
                </div>
                <div>
                  <div className="lab">{t("Observed", "已观察")}</div>
                  <div className="val">{previewStats ? String(previewStats.n_observed) : "—"}</div>
                </div>
                <div>
                  <div className="lab">{t("Comparable", "可比样本")}</div>
                  <div className="val">{previewStats ? String(previewStats.n_comparable) : "—"}</div>
                </div>
                <div>
                  <div className="lab">{t("Excluded / diagnostic", "排除 / 诊断")}</div>
                  <div className="val">
                    {previewStats
                      ? String(
                          Math.max(0, previewStats.n_observed - previewStats.n_comparable) +
                            previewStats.n_excluded_unverified_price,
                        )
                      : "—"}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="live-card mt-14" data-home-preview="">
            {homeShowcase && homeShowcase.comps.length > 0 ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{t("Listing", "商品标题")}</th>
                      <th>{t("Condition", "成色")}</th>
                      <th>{t("Format", "方式")}</th>
                      <th className="num">{t("Sold", "成交价")}</th>
                      <th className="num">{t("Shipping", "运费")}</th>
                      <th>{t("Date", "日期")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {homeShowcase.comps.slice(0, 8).map((comp) => (
                      <tr key={comp.sale_event_id}>
                        <td>
                          {comp.title ?? t("Verified listing (title withheld)", "已核验记录（标题隐藏）")}
                        </td>
                        <td>{fmtCondition(comp.condition_std, zh)}</td>
                        <td>
                          <span className={fmtFormatClass(comp.sale_format)}>
                            {fmtFormat(comp.sale_format, zh)}
                          </span>
                        </td>
                        <td className="num price">{fmtMoney(comp.item_price_cents, locale)}</td>
                        <td className="num">{fmtShipping(comp.observed_shipping_cents, locale, zh)}</td>
                        <td className="nw">{fmtSoldDate(comp.sold_date, zh)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty">
                {t(
                  "No public showcase snapshot is currently active. Sign in to run a search or publish a demo snapshot via npm run dev:seed.",
                  "当前暂无公开演示快照。您可登录后运行查价，或在本机运行 npm run dev:seed 灌入演示快照。",
                )}
              </div>
            )}
          </div>
          <p className="small mt-12">
            {homeShowcase
              ? `${t("Preview snapshot:", "演示快照：")} ${homeShowcase.query} (${homeShowcase.comps.length} ${t("verified comps shown", "条核验样本")}). `
              : ""}
            <a href={link("/search")}>{t("Open the full research workbench →", "打开完整研究工作台 →")}</a>
          </p>
        </div>
      </section>

      {/* Section 5: Why SoldBench */}
      <section className="blk">
        <div className="wrap">
          <div className="blk-head">
            <p className="eyebrow">{t("Why SoldBench", "为什么选择 SoldBench")}</p>
            <h2>
              {t("A price you can ", "可审计、可辩护的成交参考，")}
              <span className="kw">{t("audit", "而不是拍脑袋估价")}</span>
              {t(", not just quote.", "")}
            </h2>
          </div>
          <div className="grid3 eq mt-24">
            {[
              [
                t("Evidence pack", "完整可验证证据包"),
                t(
                  "Every query carries its query_id, candidate-set hash, engine & cleaner versions, requested-vs-applied filter echo, and rule-numbered exclusions.",
                  "每次查询均附 query_id、候选集哈希、引擎与清洗版本号、请求与实际过滤回显及每条剔除理由。",
                ),
                link("/methodology"),
                t("How the evidence pack works →", "查看方法论详情 →"),
              ],
              [
                t("Price credibility", "价格可信度纪律"),
                t(
                  "Verified actual vs display prices strictly layered, unknown shipping preserved as null, and fewer than 8 verified prices never produce a median.",
                  "严分实付成交价与展示挂牌价；未知运费不写零；不足 8 条核验样本绝不强算中位价。",
                ),
                link("/methodology"),
                t("Read credibility rules →", "查看可信度规范 →"),
              ],
              [
                t("1 credit, honestly counted", "诚实透明计费"),
                t(
                  "A valid delivered search settles 1 credit whether returning 1 or 200 comps. Failures, low-sample results, waits, and 10-minute re-fetches are free.",
                  "有效交付每次最多 1 额度；排队等待、失败、低样本与 10 分钟内复用全部免费。",
                ),
                link("/pricing"),
                t("Inspect billing rules →", "查看计费规则 →"),
              ],
            ].map(([title, desc, href, cta]) => (
              <div className="card" key={title}>
                <h3>{title}</h3>
                <p>{desc}</p>
                <p className="card-foot">
                  <a href={href}>{cta}</a>
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Section 6: Who Prices with SoldBench */}
      <section className="blk">
        <div className="wrap">
          <div className="blk-head">
            <p className="eyebrow">{t("Built for people who price things", "适用对象")}</p>
            <h2>{t("Who prices with SoldBench", "谁在使用 SoldBench 定价")}</h2>
          </div>
          <div className="grid4 eq mt-24">
            {[
              [
                t("Resellers & flippers", "专业二手与转售商家"),
                t(
                  "Price inventory acquisitions in seconds, export clean comps, and track batch buy lists.",
                  "几秒钟给出收购定价参考，支持批量核价与对比可比依据。",
                ),
                link("/guides"),
              ],
              [
                t("Collectors & traders", "收藏品与评级卡交易商"),
                t(
                  "Grade-sensitive comparisons that separate raw, graded, and Best Offer unknowns automatically.",
                  "严格区分散卡、评级分数与版本，自动隔离未公开实价的议价订单。",
                ),
                link("/categories"),
              ],
              [
                t("Developers", "开发者与 SaaS 团队"),
                t(
                  "Single clean REST & MCP contract backed by deterministic hashes, TypeScript/Python/curl SDK samples.",
                  "统一 REST 与 MCP 契约，附稳定哈希与 TypeScript / Python / cURL 示例。",
                ),
                docsSlug("quickstart"),
              ],
              [
                t("Market research", "专业数据与研究团队"),
                t(
                  "Auditable snapshots with retention windows, permission tracking, and authoritative vs adjusted CSV export.",
                  "拥有留存周期、来源权责可追溯与权威/调整双视图导出的研究级快照。",
                ),
                link("/methodology"),
              ],
            ].map(([title, desc, href]) => (
              <div className="card" key={title}>
                <h3>{title}</h3>
                <p>{desc}</p>
                <p className="card-foot">
                  <a href={href}>{t("Learn more →", "了解更多 →")}</a>
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Section 7: Pricing Summary */}
      <section className="blk band">
        <div className="wrap">
          <div className="blk-head">
            <p className="eyebrow">{t("Pricing preview", "定价方案预览")}</p>
            <h2>
              {t("Pay per search, ", "按查价次计费，")}
              <span className="kw">{t("not per result", "不按返回条数收费")}</span>
              {t(".", "。")}
            </h2>
            <p>
              {t(
                "Illustrative schedule below is pending final commercial sign-off — check the Pricing page for active sandbox offers.",
                "以下为待商业批准的方案概览，具体有效沙盒或正式报价以「定价」页实际接口为准。",
              )}
            </p>
          </div>
          <div className="grid4 eq mt-24">
            {pricingPreviewPlans.map((plan) => (
              <div className="card price-card" key={plan.name}>
                {plan.pop && <span className="pop-tag">{t("MOST POPULAR", "最受欢迎")}</span>}
                <p className="eyebrow">{plan.name}</p>
                <div className="amt price-amt-row">{plan.price}</div>
                <p>{plan.sub}</p>
                <ul>
                  {plan.feats.map((feat) => (
                    <li key={feat}>{feat}</li>
                  ))}
                </ul>
                <a className="mini-cta" href={link("/pricing")}>
                  {plan.cta}
                </a>
              </div>
            ))}
          </div>
          <p className="mt-20">
            <a className="btn btn-brand" href={link("/pricing")}>
              {t("Full pricing →", "查看完整定价 →")}
            </a>
          </p>
        </div>
      </section>

      {/* Latest CMS Articles if published */}
      {blocks.some((row) => row.kind === "blog") && (
        <section className="blk">
          <div className="wrap">
            <div className="blk-head">
              <p className="eyebrow">{t("Latest articles", "最新文章")}</p>
              <h2>{t("Guides & pricing notes", "研究实战与数据解读")}</h2>
            </div>
            <div className="grid3 mt-20">
              {blocks
                .filter((row) => row.kind === "blog")
                .slice(0, 3)
                .map((row) => (
                  <article className="card" key={row.slug}>
                    <h3>
                      <a href={link(`/blog/${row.slug}`)}>{row.title}</a>
                    </h3>
                    <p>{row.body.length > 140 ? `${row.body.slice(0, 137)}…` : row.body}</p>
                  </article>
                ))}
            </div>
            <p className="mt-16">
              <a href={link("/blog")}>{t("All articles →", "浏览全部文章 →")}</a>
            </p>
          </div>
        </section>
      )}

      {/* Section 8: FAQ */}
      <section className="blk">
        <div className="wrap">
          <div className="blk-head">
            <p className="eyebrow">FAQ</p>
            <h2>{t("Questions, answered straight", "常见问题直答")}</h2>
          </div>
          <div className="mt-22">
            {homeFaqs.map(([q, a]) => (
              <details className="faq-item" key={q}>
                <summary>{q}</summary>
                <div className="faq-body">{a}</div>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Section 9: Final CTA */}
      <section className="blk cta-final">
        <div className="wrap">
          <div className="card cta-card">
            <h2 className="serif cta-title">
              {t("Ready for evidence-backed sold prices?", "准备好使用可追溯的成交价格研究了吗？")}
            </h2>
            <p className="small cta-sub">
              {t(
                "Create a local test account, inspect the Playground, or connect Claude/Cursor over MCP.",
                "立即创建账户、在调试台实测接口，或通过 MCP 接入您的 AI 工作流。",
              )}
            </p>
            <div className="cta-actions">
              <a className="btn btn-brand" href={link("/register")}>
                {t("Get started free", "免费创建账户")}
              </a>
              <a className="btn btn-ghost" href={docsSlug("quickstart")}>
                {t("Read the docs", "阅读开发文档")}
              </a>
              <a className="btn btn-ghost" href={link("/agents")}>
                {t("Connect to Claude", "接入 Claude / Cursor")}
              </a>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

export function SiteFooter({
  locale,
  link,
  footerBlocks,
}: {
  locale: Locale;
  link: (path: string) => string;
  footerBlocks: ReactNode;
}) {
  const zh = locale === "zh-CN";
  const t = (en: string, cn: string) => (zh ? cn : en);
  const docsSlug = (slug: string) => `/${zh ? "docs/zh-CN" : "docs/en"}/${slug}`;

  const columns: Array<{ heading: string; links: Array<[string, string]> }> = [
    {
      heading: t("PRODUCT", "产品功能"),
      links: [
        [t("Search workbench", "查价工作台"), link("/search")],
        [t("Pricing", "定价方案"), link("/pricing")],
        [t("API Playground", "API 调试台"), link("/playground")],
        [t("Support", "帮助与工单"), link("/support")],
        [t("Changelog", "更新记录"), link("/changelog")],
        [t("Service status", "服务状态"), "/status"],
      ],
    },
    {
      heading: t("RESOURCES", "研究资源"),
      links: [
        [t("Methodology", "价格研究方法"), link("/methodology")],
        [t("Guides", "研究指南"), link("/guides")],
        [t("Blog", "博客专栏"), link("/blog")],
        [t("Categories", "开放类目"), link("/categories")],
        [t("Data availability", "数据可用性"), link("/data-availability")],
        [t("What's it worth?", "商品值多少钱"), link("/worth")],
      ],
    },
    {
      heading: t("COMPARE", "方案对比"),
      links: [
        [t("Alternatives overview", "替代方案总览"), link("/alternatives")],
        [t("Compare tools", "竞品工具对比"), link("/compare")],
        [t("FAQ", "常见问题"), link("/faq")],
        [t("Help center", "帮助中心"), link("/help")],
      ],
    },
    {
      heading: t("DEVELOPERS", "开发者"),
      links: [
        [t("Quickstart", "快速开始"), docsSlug("quickstart")],
        [t("API reference", "API 接口参考"), docsSlug("api-reference")],
        [t("MCP & Agents", "MCP 与 Agent"), link("/agents")],
        [t("Agent Skill", "Agent Skill"), "/.well-known/skills/soldbench/SKILL.md"],
        ["OpenAPI", "/openapi.json"],
        ["llms.txt", "/llms.txt"],
      ],
    },
    {
      heading: t("ACCOUNT", "账户中心"),
      links: [
        [t("Overview", "账户概览"), link("/account")],
        [t("Sign in", "登录"), link("/login")],
        [t("Create account", "注册账户"), link("/register")],
        [t("Usage & ledger", "用量与账本"), link("/account/usage")],
        [t("API keys", "API 密钥"), link("/account/keys")],
        [t("Billing", "账单与套餐"), link("/account/billing")],
      ],
    },
    {
      heading: t("LEGAL & OPS", "合规与运营"),
      links: [
        [t("About", "关于 SoldBench"), link("/about")],
        [t("Privacy policy", "隐私政策"), link("/privacy")],
        [t("Terms of service", "服务条款"), link("/terms")],
        [t("Deletion receipt", "删除回执查询"), link("/deletion-receipt")],
        [t("Operations console", "运营控制台"), link("/operations")],
      ],
    },
  ];

  return (
    <footer className="site">
      <div className="wrap">
        <div className="foot-brand">
          <a className="logo" href={link("/")}>
            <BrandLogo size={24} />
            SoldBench
          </a>
          <span className="tag">
            {t(
              "eBay sold-price evidence for resellers, collectors, and AI agents.",
              "面向个人卖家、收藏品交易商、商家与 AI Agent 的可验证成交价格研究平台。",
            )}
          </span>
        </div>
        <div className="foot-grid">
          {columns.map((col) => (
            <div key={col.heading}>
              <h4>{col.heading}</h4>
              {col.links.map(([label, href]) => (
                <a key={href + label} href={href}>
                  {label}
                </a>
              ))}
            </div>
          ))}
        </div>
        {footerBlocks}
        <div className="foot-base">
          <span>© SoldBench · soldbench.com</span>
          <span>
            {t(
              "Sample numbers disclose their source mode and never conceal missing or unverified fields.",
              "页面样本清晰披露数据模式，永不隐瞒缺失字段或未核验价格。",
            )}
          </span>
        </div>
      </div>
    </footer>
  );
}
