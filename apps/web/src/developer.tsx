import type { Locale } from "@soldbench/shared";
import { type CodeLang, highlightCode } from "./highlight.js";
import { BrandLogo } from "./home.js";

export type DocsView = {
  current: { path: string; title: string; text: string };
  pages: { path: string; title: string }[];
  alternate: string;
};

function inline(text: string) {
  return text.split(/(`[^`]+`|\[[^\]]+\]\(\/[^)]+\))/g).map((part, idx) => {
    const key = `${idx}:${part.slice(0, 16)}`;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={key}>{part.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\((\/(?!\/)[a-zA-Z0-9._/?=&%#-]+)\)$/.exec(part);
    return link ? (
      <a key={key} href={link[2]}>
        {link[1]}
      </a>
    ) : (
      part
    );
  });
}

function inferCodeLang(rawLang: string): CodeLang {
  const low = rawLang.toLowerCase();
  if (low.includes("py")) return "python";
  if (low.includes("ts") || low.includes("js")) return "ts";
  if (low.includes("json")) return "json";
  if (low.includes("sh") || low.includes("bash") || low.includes("curl")) return "bash";
  return "json";
}

function slugId(raw: string, index: number): string {
  const clean = raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return clean ? `sec-${clean}-${index}` : `sec-${index}`;
}

export function Documentation({ view, locale }: { view: DocsView; locale: Locale }) {
  const zh = locale === "zh-CN";
  const t = (en: string, cn: string) => (zh ? cn : en);
  const groups = [
    {
      label: t("GETTING STARTED", "开始使用"),
      pages: ["quickstart", "authentication", "integration-tools"],
      extras: [] as Array<[string, string]>,
    },
    {
      label: t("CORE", "核心接口"),
      pages: ["sold-search", "pricing-evidence", "async-jobs", "billing-and-credits"],
      extras: [] as Array<[string, string]>,
    },
    {
      label: t("REFERENCE", "接口参考"),
      pages: ["api-reference", "rate-limits-and-headers", "errors-and-retries"],
      extras: [] as Array<[string, string]>,
    },
    {
      label: t("AI & AGENTS", "AI 与智能体"),
      pages: ["mcp"],
      extras: [
        [t("Agent skill (SKILL.md)", "Agent Skill (SKILL.md)"), "/.well-known/skills/soldbench/SKILL.md"],
        [t("Agents playbook", "Agent 集成手册"), zh ? "/zh-CN/agents" : "/agents"],
        [t("API Playground", "API 调试台"), zh ? "/zh-CN/playground" : "/playground"],
      ] as Array<[string, string]>,
    },
    {
      label: t("RESOURCES", "更多资源"),
      pages: [] as string[],
      extras: [
        [t("Changelog", "更新记录"), zh ? "/zh-CN/changelog" : "/changelog"],
        ["OpenAPI 3.1", "/openapi.json"],
        [t("Service status", "服务状态"), "/status"],
        [t("Implementation status", "接口实现状态"), "/docs/implementation-status.json"],
      ] as Array<[string, string]>,
    },
  ];
  const bySlug = new Map(view.pages.map((page) => [page.path.split("/").at(-1), page]));
  const rawBlocks = view.current.text
    .trim()
    .split(/\n\s*\n/)
    .slice(1);

  const isQuickstart = view.current.path.endsWith("/quickstart");
  const headings: Array<{ id: string; text: string }> = [];
  let headingIdx = 0;
  let codeIdx = 0;
  let ledeUsed = isQuickstart;

  const renderedBlocks = rawBlocks.map((block) => {
    if (block.startsWith("```") && block.endsWith("```")) {
      const lines = block.split("\n");
      const rawLang = lines[0]?.slice(3).trim() || t("Example", "示例");
      const code = lines.slice(1, -1).join("\n");
      const codeId = `docCode${++codeIdx}`;
      return (
        <div className="codeblock cap mt-16" key={codeId}>
          <div className="cb-head">
            <span>{rawLang}</span>
            <button type="button" className="copy-btn" data-copy={`#${codeId}`}>
              {t("Copy", "复制")}
            </button>
          </div>
          <pre id={codeId}>
            <code>{highlightCode(code, inferCodeLang(rawLang))}</code>
          </pre>
        </div>
      );
    }
    if (block.startsWith("## ")) {
      const headingText = block.slice(3).trim();
      const id = slugId(headingText, ++headingIdx);
      headings.push({ id, text: headingText });
      return (
        <h2 id={id} key={id}>
          {headingText}
        </h2>
      );
    }
    if (block.startsWith("- ")) {
      return (
        <ul key={`list-${headingIdx}-${block.slice(0, 24)}`}>
          {block.split("\n").map((line) => (
            <li key={line}>{inline(line.replace(/^- /, ""))}</li>
          ))}
        </ul>
      );
    }
    let cls: string | undefined;
    if (!ledeUsed) {
      ledeUsed = true;
      cls = "docs-lede";
    }
    return (
      <p className={cls} key={`para-${headingIdx}-${codeIdx}-${block.slice(0, 24)}`}>
        {inline(block)}
      </p>
    );
  });

  const quickstartResponseJson = JSON.stringify(
    {
      data: {
        query: "Nintendo Switch OLED",
        stats: {
          median_cents: 27400,
          p25_cents: 27225,
          p75_cents: 27575,
          trimmed_mean_cents: 27400,
          n_price_verified: 8,
        },
        quality: { sample_tier: "limited", data_insufficient: false, total_score: null },
        meta: {
          query_id: "q_demo_oled",
          candidate_set_hash: "sha256:...",
          credits_charged: 1,
        },
      },
    },
    null,
    2,
  );

  if (isQuickstart) {
    headings.unshift(
      { id: "qs-1", text: t("Get your API key", "获取 API 密钥") },
      { id: "qs-2", text: t("Make your first request", "发起第一次请求") },
      { id: "qs-3", text: t("Read the result", "读取返回结果与证据") },
      { id: "qs-4", text: t("Local offline quickstart", "本地离线演练与脚本验证") },
    );
  }

  const quickstartExamples = {
    curl: `curl -sS -G "https://api.soldbench.com/v1/sold" \\\n  -H "Authorization: Bearer $SOLDBENCH_API_KEY" \\\n  --data-urlencode "q=Nintendo Switch OLED" \\\n  --data-urlencode "window_days=90" \\\n  --data-urlencode "limit=50"`,
    python: `import os\nimport requests\n\nresp = requests.get(\n    "https://api.soldbench.com/v1/sold",\n    headers={"Authorization": f"Bearer {os.environ['SOLDBENCH_API_KEY']}"},\n    params={"q": "Nintendo Switch OLED", "window_days": 90, "limit": 50},\n    timeout=30,\n)\nresp.raise_for_status()\nstats = resp.json()["data"]["stats"]\nprint(stats["median_cents"], stats["n_price_verified"])  # None when < 8`,
    ts: `const res = await fetch(\n  "https://api.soldbench.com/v1/sold?q=Nintendo+Switch+OLED&window_days=90&limit=50",\n  { headers: { Authorization: \`Bearer \${process.env.SOLDBENCH_API_KEY}\` } }\n);\nif (!res.ok) throw new Error(\`SoldBench \${res.status}\`);\nconst { data } = await res.json();\nconsole.log(data.stats.median_cents, data.stats.n_price_verified);`,
  };
  const currentIdx = view.pages.findIndex((p) => p.path === view.current.path);
  const prevPage = currentIdx > 0 ? view.pages[currentIdx - 1] : null;
  const nextPage = currentIdx >= 0 && currentIdx < view.pages.length - 1 ? view.pages[currentIdx + 1] : null;

  return (
    <div className="docs-shell docs-v2">
      <aside className="docs-side">
        <div className="docs-side-bar">
          <a className="docs-brand" href={zh ? "/zh-CN" : "/"}>
            <BrandLogo size={24} />
            <span>
              SoldBench <span className="docs-brand-sub">Docs</span>
            </span>
          </a>
          <button
            className="docs-menu-btn"
            type="button"
            data-docs-menu-btn=""
            aria-expanded="false"
            aria-label={t("Toggle documentation menu", "切换文档菜单")}
          >
            <span>{view.current.title}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M6 9l6 6 6-6"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        <div className="docs-side-panel">
          <form className="docs-search" data-docs-search="" action="/docs/search" method="get">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2.4" />
              <path d="M20.5 20.5L16.7 16.7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
            <label className="sr-only" htmlFor="docs-query">
              {t("Search documentation", "搜索文档")}
            </label>
            <input
              required
              id="docs-query"
              name="q"
              maxLength={200}
              autoComplete="off"
              placeholder={t("Search docs", "搜索文档")}
            />
            <input type="hidden" name="locale" value={locale} />
            <button className="docs-search-btn" type="submit">
              {t("Search", "搜索")}
            </button>
          </form>
          <ul className="docs-search-results" data-docs-results="" aria-live="polite" hidden />

          <nav className="docs-nav" aria-label={t("Developer documentation", "开发者文档")}>
            <div className="docs-site-links">
              <a href={zh ? "/zh-CN/pricing" : "/pricing"}>{t("Pricing", "定价")}</a>
              <a href={zh ? "/zh-CN/account" : "/account"}>{t("Dashboard", "用户中心")}</a>
            </div>
            {groups.map((group) => (
              <section className="docs-nav-group dnav-group" key={group.label} aria-label={group.label}>
                <h2>{group.label}</h2>
                {group.pages.map((slug) => {
                  const page = bySlug.get(slug);
                  return (
                    page && (
                      <a
                        key={slug}
                        className={page.path === view.current.path ? "on" : undefined}
                        aria-current={page.path === view.current.path ? "page" : undefined}
                        href={page.path}
                      >
                        {page.title}
                      </a>
                    )
                  );
                })}
                {group.extras.map(([label, href]) => (
                  <a key={href} href={href}>
                    {label}
                  </a>
                ))}
              </section>
            ))}
            {view.pages
              .filter(
                (page) => !groups.some((group) => group.pages.some((slug) => page.path.endsWith(`/${slug}`))),
              )
              .map((page) => (
                <a
                  key={page.path}
                  className={page.path === view.current.path ? "on" : undefined}
                  aria-current={page.path === view.current.path ? "page" : undefined}
                  href={page.path}
                >
                  {page.title}
                </a>
              ))}
          </nav>
        </div>
      </aside>

      <div className="docs-main">
        <div className="docs-main-in">
          <article className="docs-article docs-body">
            <div className="info-strip">
              <span>v1</span>
              <span>base URL https://api.soldbench.com/v1</span>
              <span>JSON over HTTPS</span>
              <span>Bearer auth</span>
              <a href="/openapi.json">OpenAPI spec</a>
              <a href="/.well-known/skills/soldbench/SKILL.md">Agent Skill</a>
            </div>
            <h1>{view.current.title}</h1>
            {isQuickstart && (
              <>
                <p className="docs-lede">
                  {t(
                    "Your first SoldBench API call takes under two minutes: get a key, send a GET /v1/sold request, and inspect the stats and evidence response.",
                    "不到两分钟完成第一次 SoldBench API 调用：生成密钥、发送 GET /v1/sold 请求并读取包含统计值与可验证证据的响应。",
                  )}
                </p>

                <h2 id="qs-1">1 · {t("Get your API key", "获取 API 密钥")}</h2>
                <p>
                  {t("Create an account and generate a key in ", "创建账户并在")}
                  <a href={zh ? "/zh-CN/account/keys" : "/account/keys"}>{t("API keys", "API 密钥")}</a>
                  {t(
                    ". Keys start with sb_k_ and are shown in full exactly once — store yours in an environment variable.",
                    "页面生成密钥。密钥以 sb_k_ 开头且仅完整显示一次，请妥善保存在环境变量中。",
                  )}
                </p>

                <h2 id="qs-2">2 · {t("Make your first request", "发起第一次请求")}</h2>
                <div className="codeblock doc-code mt-12">
                  <div className="cb-head">
                    <div className="api-tabs" role="tablist" aria-label={t("Example language", "示例语言")}>
                      <button type="button" className="on" data-doc-lang="curl">
                        cURL
                      </button>
                      <button type="button" data-doc-lang="python">
                        Python
                      </button>
                      <button type="button" data-doc-lang="ts">
                        JavaScript
                      </button>
                    </div>
                    <button type="button" className="copy-btn" data-doc-copy="">
                      {t("Copy", "复制")}
                    </button>
                  </div>
                  <pre data-doc-code="curl" id="qsCodeCurl">
                    <code>{highlightCode(quickstartExamples.curl, "bash")}</code>
                  </pre>
                  <pre data-doc-code="python" id="qsCodePython" hidden>
                    <code>{highlightCode(quickstartExamples.python, "python")}</code>
                  </pre>
                  <pre data-doc-code="ts" id="qsCodeTs" hidden>
                    <code>{highlightCode(quickstartExamples.ts, "ts")}</code>
                  </pre>
                </div>

                <h2 id="qs-3">3 · {t("Read the result", "读取返回结果与证据")}</h2>
                <p>
                  {t("Every response carries ", "每次响应均携带 ")}
                  <code>stats</code>
                  {t(
                    " (median, p25/p75 typical range, trimmed mean), ",
                    "（中位价、p25–p75 典型区间与截尾均价）、",
                  )}
                  <code>quality</code>
                  {t(" (with total_score: null and strict ", "（total_score 恒为 null，")}
                  <code>n &lt; 8</code>
                  {t(" suppression), and ", " 严格置空）以及 ")}
                  <code>meta</code>
                  {t(
                    " (query_id, candidate_set_hash, credits_charged).",
                    "（query_id、candidate_set_hash、credits_charged）。",
                  )}
                </p>
                <div className="codeblock mt-12">
                  <div className="cb-head">
                    <span>{t("JSON response", "JSON 响应示例")}</span>
                    <button type="button" className="copy-btn" data-copy="#qsRespJson">
                      {t("Copy", "复制")}
                    </button>
                  </div>
                  <pre id="qsRespJson">
                    <code>{highlightCode(quickstartResponseJson, "json")}</code>
                  </pre>
                </div>

                <h2 id="qs-4">{t("Local offline quickstart", "本地离线演练与脚本验证")}</h2>
              </>
            )}
            {renderedBlocks}

            {(prevPage || nextPage) && (
              <nav
                className={`docs-pager${prevPage && nextPage ? "" : " solo"}`}
                aria-label={t("Docs pagination", "文档翻页")}
              >
                {prevPage && (
                  <a className="prev" href={prevPage.path}>
                    <span className="dir">{t("← Previous", "← 上一篇")}</span>
                    <span className="ttl">{prevPage.title}</span>
                  </a>
                )}
                {nextPage && (
                  <a className="next" href={nextPage.path}>
                    <span className="dir">{t("Next →", "下一篇 →")}</span>
                    <span className="ttl">{nextPage.title}</span>
                  </a>
                )}
              </nav>
            )}
          </article>

          <aside className="docs-otp">
            {headings.length > 0 && (
              <div className="otp">
                <h4>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M9.5 5.5H20M9.5 12H20M9.5 18.5H20"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                    />
                    <path
                      d="M4 5.5h.01M4 12h.01M4 18.5h.01"
                      stroke="currentColor"
                      strokeWidth="3.4"
                      strokeLinecap="round"
                    />
                  </svg>
                  {t("On this page", "本页目录")}
                </h4>
                <div className="otp-list">
                  <span className="otp-fill" aria-hidden="true" />
                  {headings.map((h, i) => (
                    <a
                      key={h.id}
                      href={`#${h.id}`}
                      data-otp-target={h.id}
                      className={i === 0 ? "on" : undefined}
                    >
                      {`${i + 1}. ${h.text}`}
                    </a>
                  ))}
                </div>
              </div>
            )}
            <div className={headings.length > 0 ? "card mt-20" : "card"}>
              <h3>{t("Get a key", "获取 API 密钥")}</h3>
              <p>{t("100 free credits a month. No credit card.", "每月 100 免费额度，无需绑定信用卡。")}</p>
              <p className="mt-12">
                <a className="btn btn-brand btn-sm" href={zh ? "/zh-CN/register" : "/register"}>
                  {t("Get a free API key", "免费获取密钥")}
                </a>
              </p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
