import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { AuthService, localAuthSecrets } from "@soldbench/auth";
import { BillingService } from "@soldbench/billing";
import { normalizeQuery } from "@soldbench/core";
import { assertLocalDatabaseUrl, database, migrate, transaction } from "@soldbench/db";
import { PrivateMediaStore } from "@soldbench/media";
import { PublicResults, QueryService } from "@soldbench/query";
import { loadConfig } from "@soldbench/shared";
import { localDatabaseUrl } from "./local-db.mjs";

if (process.env.NODE_ENV === "production") {
  throw new Error("offline_dev_seed_only");
}

const config = loadConfig(process.env);
const url = process.env.DATABASE_URL ?? localDatabaseUrl();
assertLocalDatabaseUrl(url, [
  resolve(".local/postgres/socket"),
  ...(process.env.SOLDBENCH_TEST_SOCKET ? [process.env.SOLDBENCH_TEST_SOCKET] : []),
]);

const db = database(url);
const execFileAsync = promisify(execFile);

const CMS_SEED = [
  {
    kind: "announcement",
    slug: "evidence-pack-release",
    en: {
      title: "New: Evidence pack & distribution charts",
      body: "Every delivered search carries query_id, candidate_set_hash, rule-numbered exclusions, and honest gap-aware distribution charts.",
    },
    zh: {
      title: "上新：完整证据链与断档分布走势图",
      body: "每次已交付查价均携带 query_id、候选集摘要哈希、逐条排除规则及不补零连线的诚实价格走势。",
    },
    metadata: {},
  },
  {
    kind: "blog",
    slug: "evidence-based-sold-pricing",
    en: {
      title: "Why sold prices need an evidence pack behind them",
      body: "A bare median without sample size, exclusion reasons, or versioned matching rules hides whether a number rests on 3 sales or 30, or whether parts-only junk skewed the average.",
    },
    zh: {
      title: "为什么二手成交中位价必须附带可核查证据链",
      body: "只给一个光秃秃的中位价数字，却隐藏样本量、排除理由与清洗规则版本，用户无从分辨该报价是来自 3 条杂件还是 30 条严格可比成交。",
    },
    metadata: { author: "SoldBench Research" },
  },
  {
    kind: "blog",
    slug: "asking-vs-sold-prices",
    en: {
      title: "Asking prices vs. completed sold prices on eBay",
      body: "Active listing prices show what sellers hope to get; completed verified transactions capture actual market clearing prices while quarantining undisclosed Best Offers.",
    },
    zh: {
      title: "挂牌标价与真实已售成交价的本质差异",
      body: "在售标价只反映卖家心理预期；已核验成交价才代表买方真实掏钱意愿，并对未公开实价的议价订单严格隔离。",
    },
    metadata: { author: "SoldBench Research" },
  },
  {
    kind: "blog",
    slug: "reading-price-distributions",
    en: {
      title: "How to read a comp price distribution (IQR and trimmed mean)",
      body: "Type 7 P25–P75 interquartile bands reveal how tightly comps cluster around the median, while bimodal splits warn against mixing editions or conditions.",
    },
    zh: {
      title: "如何看懂可比成交的价格分布（IQR 与 5% 截尾均价）",
      body: "Type 7 P25–P75 四分位带宽能直观衡量成交集聚度；若呈现双峰分布，则说明样本可能横跨不同容量、版别或成色。",
    },
    metadata: { author: "SoldBench Research" },
  },
  {
    kind: "guide",
    slug: "quick-valuation-workflow",
    en: {
      title: "Five-step workflow to value electronics and cards safely",
      body: "Lock model and condition first, use 90-day window before loosening filters, verify whether n < 8 withheld a median, inspect Best Offer diagnostics, and export adjusted comps.",
    },
    zh: {
      title: "五步规范估值法：电子产品与评级卡牌实操流程",
      body: "先锁定型号与成色，优先采用 90 天窗口，留意 n < 8 不出中位数的诚实提示，核查 Best Offer 诊断表后导出权威/调整视图。",
    },
    metadata: { author: "SoldBench Guides" },
  },
  {
    kind: "guide",
    slug: "connecting-claude-cursor-mcp",
    en: {
      title: "Connect Claude Desktop or Cursor using Hosted MCP",
      body: "Configure OAuth 2.1/PKCE or a Bearer API key against /mcp so agents follow sold_search -> claim -> sold_stats without accidental duplicate billing.",
    },
    zh: {
      title: "通过托管 MCP 将 SoldBench 接入 Claude 与 Cursor",
      body: "使用 OAuth 2.1/PKCE 或 API Key 连接 /mcp，按 sold_search → 显式 claim → 免费复取 sold_stats 标准流程调用。",
    },
    metadata: { author: "SoldBench Guides" },
  },
  {
    kind: "comparison",
    slug: "compsniper",
    en: {
      title: "SoldBench vs. CompSniper",
      body: "Compares per-search flat billing (up to 200 comps), explicit rule-numbered exclusion logs, n < 8 suppression, and official Hosted MCP support.",
    },
    zh: {
      title: "SoldBench 与 CompSniper 对比",
      body: "对比按次计费封顶 200 条、逐条规则编号排除日志、不足 8 条置空护栏以及原生 REST + 托管 MCP 协议支持。",
    },
    metadata: { position: 1, reference: "https://soldbench.com/methodology" },
  },
  {
    kind: "comparison",
    slug: "soldcomps-io",
    en: {
      title: "SoldBench vs. SoldComps.io",
      body: "Contrasts transparent evidence packs, Best Offer undisclosed separation, and atomic claim billing against point-in-time scraping exports.",
    },
    zh: {
      title: "SoldBench 与 SoldComps.io 对比",
      body: "对照完整证据链哈希、Best Offer 未公开实价分层隔离与显式领取扣费机制。",
    },
    metadata: { position: 2, reference: "https://soldbench.com/methodology" },
  },
  {
    kind: "changelog",
    slug: "v1-40-runtime-convergence",
    en: {
      title: "OpenAPI 1.40.0 & End-to-End Live Runtime Convergence",
      body: "Delivered promo redemptions, versioned offer schedule, Stripe/PayPal adapters, Resend/SMTP mail worker, and approved_network collector/API readiness.",
    },
    zh: {
      title: "OpenAPI 1.40.0 与全栈线上运行态就绪收敛",
      body: "交付促销兑换台账、Stripe/PayPal 支付适配、Resend/SMTP 发信队列、显式代理出网及 approved_network 端到端管道。",
    },
    metadata: { reference: "https://soldbench.com/docs/en/changelog" },
  },
  {
    kind: "faq",
    slug: "faq-currency-shipping",
    en: {
      title: "Does SoldBench convert unknown shipping to $0?",
      body: "No. Unknown required shipping remains null and is excluded from item-plus-observed-shipping pricing.",
    },
    zh: {
      title: "未知运费会被 SoldBench 当作 0 元处理吗？",
      body: "不会。只有明确包邮才记录为 0 分；未知所需运费保持 null 并排除出含邮价统计。",
    },
    metadata: {},
  },
  {
    kind: "about",
    slug: "soldbench-overview",
    en: {
      title: "About SoldBench",
      body: "SoldBench is an evidence-backed sold-price research platform serving individual sellers, collectible dealers, resellers, developers, and AI agents with auditable eBay pricing workflows.",
    },
    zh: {
      title: "关于 SoldBench",
      body: "SoldBench 致力于为个人卖家、收藏品交易商、二手商家、开发者与 AI Agent 提供可核查、可复现的成交价研究与结构化 API 基础设施。",
    },
    metadata: {},
  },
];

async function runCollectorDemo(extraArgs = []) {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/collector-html-demo.mjs", "--http", ...extraArgs],
    {
      env: { ...process.env, DATABASE_URL: url, PUBLIC_FIXTURE_AGGREGATES: "true" },
      encoding: "utf8",
    },
  );
  return JSON.parse(stdout.trim());
}

async function ensureFixtureUser(c, email, auth, now) {
  const existing = (await c.query("SELECT id FROM users WHERE lower(email)=$1", [email.toLowerCase()]))
    .rows[0];
  if (existing) {
    await c.query(
      "UPDATE users SET status='active',email_verified_at=coalesce(email_verified_at,$2) WHERE id=$1",
      [existing.id, now],
    );
    return existing.id;
  }
  const inserted = (
    await c.query(
      "INSERT INTO users(email,password_hash,status,email_verified_at,free_anchor_at) VALUES($1,$2,'active',$3,$3) RETURNING id",
      [email, auth.crypto.hash("demo.fixture.password", randomUUID()), now],
    )
  ).rows[0];
  return inserted.id;
}

try {
  await migrate(db);

  // 1. Seed two local HTML demo sources (Nintendo Switch OLED + Nintendo Switch research set)
  const oledReport = await runCollectorDemo();
  const researchReport = await runCollectorDemo(["--research"]);

  await db.query(
    `UPDATE source_clearances
        SET permitted_fields=permitted_fields || '{"public_cache":["aggregate"],"public_share":["aggregate"]}'::jsonb
      WHERE id IN (SELECT source_clearance_id FROM sources WHERE id=ANY($1::uuid[]))`,
    [[oledReport.sourceId, researchReport.sourceId]],
  );

  // 2. Submit & claim public cache snapshot for Nintendo Switch OLED
  const auth = new AuthService(db, localAuthSecrets(resolve(config.localStateRoot)), config.origin);
  const billing = new BillingService(db);
  const media = new PrivateMediaStore(resolve(config.mediaRoot));
  const query = new QueryService(db, auth, billing, media, undefined, config.dataMode);
  const publicResults = new PublicResults(query);

  const publisherId = await transaction(db, async (c) => {
    const now = new Date();
    const uid = await ensureFixtureUser(c, "demo-publisher@soldbench.local", auth, now);
    await ensureFixtureUser(c, "demo-reviewer@soldbench.local", auth, now);
    return uid;
  });

  await billing.grant(publisherId, {
    kind: "promo",
    provider: "dev_seed",
    reference: `dev-seed-${Date.now()}`,
    amount: 20,
    expiresAt: new Date(Date.now() + 30 * 86400_000),
  });

  const apiSecret = auth.crypto.token("sb_k_");
  const keyRow = (
    await db.query(
      "INSERT INTO api_keys(user_id,name,key_hash,key_prefix,scopes) VALUES($1,$2,$3,$4,$5) RETURNING id",
      [
        publisherId,
        `dev-seed-${Date.now()}`,
        auth.crypto.hash("auth.api-key", apiSecret),
        apiSecret.slice(0, 12),
        ["sold:read", "jobs:read"],
      ],
    )
  ).rows[0];

  const identity = await auth.keyIdentity(apiSecret, "sold:read");
  const normalizedOled = normalizeQuery(new URLSearchParams({ q: "Nintendo Switch OLED", limit: "20" }));
  const submitted = await query.submit(identity, normalizedOled);
  for (let i = 0; i < 20; i++) {
    const row = (await db.query("SELECT compute_status FROM queries WHERE id=$1", [submitted.queryId]))
      .rows[0];
    if (row?.compute_status === "completed") break;
    await query.workOnce(`dev-seed-${keyRow.id}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const claimed = await query.result(
    identity,
    submitted.queryId,
    randomUUID(),
    true,
    `dev-seed-claim-${submitted.queryId}`,
  );
  const publishedCache = await publicResults.publishFixture(submitted.queryId);

  // 3. Seed idempotent bilingual published CMS items
  const cmsInserted = await transaction(db, async (c) => {
    const now = new Date();
    const authorId = await ensureFixtureUser(c, "demo-publisher@soldbench.local", auth, now);
    const reviewerId = await ensureFixtureUser(c, "demo-reviewer@soldbench.local", auth, now);
    let created = 0;
    for (const item of CMS_SEED) {
      const existing = await c.query("SELECT id FROM site_content_entries WHERE kind=$1 AND slug=$2", [
        item.kind,
        item.slug,
      ]);
      if (existing.rowCount) continue;
      const entry = (
        await c.query(
          "INSERT INTO site_content_entries(kind,slug,version,updated_at) VALUES($1,$2,1,$3) RETURNING id",
          [item.kind, item.slug, now],
        )
      ).rows[0];
      await c.query(
        "INSERT INTO site_content_revisions(entry_id,revision,body,metadata,state,author_id,reviewer_id,first_published_at,created_at) VALUES($1,1,$2,$3,'approved',$4,$5,$6,$6)",
        [
          entry.id,
          JSON.stringify({ en: item.en, "zh-CN": item.zh }),
          JSON.stringify(item.metadata),
          authorId,
          reviewerId,
          now,
        ],
      );
      await c.query(
        "UPDATE site_content_entries SET latest_revision=1,published_revision=1,published_at=$2 WHERE id=$1",
        [entry.id, now],
      );
      created++;
    }
    return created;
  });

  console.log(
    JSON.stringify({
      ok: true,
      mode: config.dataMode,
      oledQueryId: submitted.queryId,
      oledMedianCents: claimed.data.stats.median_cents,
      oledComps: claimed.data.comps.length,
      researchRecords: researchReport.recordEvidenceCount,
      publishedCache,
      cmsEntriesSeeded: cmsInserted,
    }),
  );
} finally {
  await db.end();
}
