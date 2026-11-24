import type { Locale } from "@soldbench/shared";

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
    { label: t("Get started", "开始使用"), pages: ["quickstart", "authentication", "integration-tools"] },
    {
      label: t("Sold-price research", "成交研究"),
      pages: ["sold-search", "pricing-evidence", "async-jobs", "billing-and-credits"],
    },
    {
      label: t("API and operations", "开发与运维"),
      pages: ["api-reference", "rate-limits-and-headers", "errors-and-retries", "mcp"],
    },
  ];
  const bySlug = new Map(view.pages.map((page) => [page.path.split("/").at(-1), page]));
  const rawBlocks = view.current.text
    .trim()
    .split(/\n\s*\n/)
    .slice(1);

  const headings: Array<{ id: string; text: string }> = [];
  let headingIdx = 0;
  let codeIdx = 0;

  const renderedBlocks = rawBlocks.map((block) => {
    if (block.startsWith("```") && block.endsWith("```")) {
      const lines = block.split("\n");
      const lang = lines[0]?.slice(3).trim() || t("Example", "示例");
      const code = lines.slice(1, -1).join("\n");
      const codeId = `docCode${++codeIdx}`;
      return (
        <div className="codeblock cap mt-16" key={codeId}>
          <div className="cb-head">
            <span>{lang}</span>
            <button type="button" className="copy-btn" data-copy={`#${codeId}`}>
              {t("Copy", "复制")}
            </button>
          </div>
          <pre id={codeId}>
            <code>{code}</code>
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
    return <p key={`para-${headingIdx}-${codeIdx}-${block.slice(0, 24)}`}>{inline(block)}</p>;
  });

  const currentIdx = view.pages.findIndex((p) => p.path === view.current.path);
  const prevPage = currentIdx > 0 ? view.pages[currentIdx - 1] : null;
  const nextPage = currentIdx >= 0 && currentIdx < view.pages.length - 1 ? view.pages[currentIdx + 1] : null;

  return (
    <div className="wrap docs-layout docs-v2">
      <aside className="docs-sidebar docs-nav">
        <nav aria-label={t("Developer documentation", "开发者文档")}>
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
      </aside>

      <article className="docs-article docs-body">
        <div className="info-strip">
          <span>v1</span>
          <span>https://api.soldbench.com/v1</span>
          <span>JSON over HTTPS</span>
          <span>Bearer auth</span>
          <a href="/openapi.json">OpenAPI</a>
          <a href="/.well-known/skills/soldbench/SKILL.md">Agent Skill</a>
        </div>
        <p className="eyebrow">{t("Developer documentation", "开发者文档")}</p>
        <h1>{view.current.title}</h1>
        <form className="searchbox mt-14" data-docs-search="" action="/docs/search" method="get">
          <label className="sr-only" htmlFor="docs-query">
            {t("Search documentation", "搜索文档")}
          </label>
          <input
            required
            id="docs-query"
            name="q"
            maxLength={200}
            placeholder={t("Find an endpoint, claim, or error code", "搜索接口、领取或错误码")}
          />
          <input type="hidden" name="locale" value={locale} />
          <button className="btn brand" type="submit">
            {t("Search", "搜索")}
          </button>
        </form>
        <ul className="docs-search-results mt-14" data-docs-results="" aria-live="polite" hidden />
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
            <h4>{t("On this page", "本页目录")}</h4>
            <div className="otp-list">
              {headings.map((h, i) => (
                <a key={h.id} href={`#${h.id}`}>
                  {`${i + 1}. ${h.text}`}
                </a>
              ))}
            </div>
          </div>
        )}
        <div className={`card${headings.length > 0 ? " mt-20" : ""}`}>
          <h3>{t("Integration resources", "集成工具与文件")}</h3>
          <div className="otp-list mt-10">
            <a href={zh ? "/zh-CN/playground" : "/playground"}>{t("API Playground", "API 调试台")}</a>
            <a href="/openapi.json">OpenAPI 3.1</a>
            <a href="/.well-known/skills/soldbench/SKILL.md">Agent Skill (SKILL.md)</a>
            <a href="/soldbench.postman.json">Postman</a>
            <a href="/examples/sold.ts">TypeScript</a>
            <a href="/examples/sold.py">Python</a>
            <a href="/examples/sold.sh">cURL</a>
            <a href={zh ? "/zh-CN/changelog" : "/changelog"}>{t("Changelog", "更新记录")}</a>
            <a href="/status">{t("Service status", "服务状态")}</a>
            <a href="/docs/implementation-status.json">{t("Implementation status", "接口实现状态")}</a>
          </div>
          <p className="mt-14">
            <a className="btn btn-brand btn-sm" href={zh ? "/zh-CN/register" : "/register"}>
              {t("Get started free", "免费创建账户")}
            </a>
          </p>
        </div>
      </aside>
    </div>
  );
}
