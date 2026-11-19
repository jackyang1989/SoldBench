import type { Locale } from "@soldbench/shared";

export type DocsView = {
  current: { path: string; title: string; text: string };
  pages: { path: string; title: string }[];
  alternate: string;
};

function inline(text: string) {
  return text.split(/(`[^`]+`|\[[^\]]+\]\(\/[^)]+\))/g).map((part) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={part}>{part.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\((\/(?!\/)[a-zA-Z0-9._/?=&%#-]+)\)$/.exec(part);
    return link ? (
      <a key={part} href={link[2]}>
        {link[1]}
      </a>
    ) : (
      part
    );
  });
}

export function Documentation({ view, locale }: { view: DocsView; locale: Locale }) {
  const zh = locale === "zh-CN";
  const groups = [
    { label: zh ? "开始使用" : "Get started", pages: ["quickstart", "authentication", "integration-tools"] },
    {
      label: zh ? "成交研究" : "Sold-price research",
      pages: ["sold-search", "pricing-evidence", "async-jobs", "billing-and-credits"],
    },
    {
      label: zh ? "开发与运维" : "API and operations",
      pages: ["api-reference", "rate-limits-and-headers", "errors-and-retries", "mcp"],
    },
  ];
  const bySlug = new Map(view.pages.map((page) => [page.path.split("/").at(-1), page]));
  const blocks = view.current.text
    .trim()
    .split(/\n\s*\n/)
    .slice(1);
  return (
    <div className="wrap docs-layout">
      <aside className="docs-sidebar">
        <nav aria-label={zh ? "开发者文档" : "Developer documentation"}>
          {groups.map((group) => (
            <section className="docs-nav-group" key={group.label} aria-label={group.label}>
              <h2>{group.label}</h2>
              {group.pages.map((slug) => {
                const page = bySlug.get(slug);
                return (
                  page && (
                    <a
                      key={slug}
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
                aria-current={page.path === view.current.path ? "page" : undefined}
                href={page.path}
              >
                {page.title}
              </a>
            ))}
        </nav>
      </aside>
      <article className="docs-article">
        <p className="eyebrow">{zh ? "开发者文档" : "Developer documentation"}</p>
        <h1>{view.current.title}</h1>
        <form className="searchbox" data-docs-search="" action="/docs/search" method="get">
          <label className="sr-only" htmlFor="docs-query">
            {zh ? "搜索文档" : "Search documentation"}
          </label>
          <input
            required
            id="docs-query"
            name="q"
            maxLength={200}
            placeholder={zh ? "搜索接口、领取或错误码" : "Find an endpoint, claim, or error code"}
          />
          <input type="hidden" name="locale" value={locale} />
          <button className="btn brand" type="submit">
            {zh ? "搜索" : "Search"}
          </button>
        </form>
        <ul className="docs-search-results" data-docs-results="" aria-live="polite" hidden />
        {blocks.map((block) => {
          if (block.startsWith("```") && block.endsWith("```"))
            return (
              <pre key={block}>
                <code>{block.split("\n").slice(1, -1).join("\n")}</code>
              </pre>
            );
          if (block.startsWith("## ")) return <h2 key={block}>{block.slice(3)}</h2>;
          if (block.startsWith("- "))
            return (
              <ul key={block}>
                {block.split("\n").map((line) => (
                  <li key={line}>{inline(line.replace(/^- /, ""))}</li>
                ))}
              </ul>
            );
          return <p key={block}>{inline(block)}</p>;
        })}
      </article>
      <aside className="docs-sidebar">
        <nav aria-label={zh ? "集成资源" : "Integration resources"}>
          <a href={zh ? "/zh-CN/playground" : "/playground"}>{zh ? "API 调试台" : "API Playground"}</a>
          <a href="/openapi.json">OpenAPI</a>
          <a href="/.well-known/skills/soldbench/SKILL.md">Agent Skill</a>
          <a href="/soldbench.postman.json">Postman</a>
          <a href="/examples/sold.ts">TypeScript</a>
          <a href="/examples/sold.py">Python</a>
          <a href="/examples/sold.sh">cURL</a>
          <a href="/changelog">{zh ? "更新记录" : "Changelog"}</a>
          <a href="/status">{zh ? "服务状态" : "Service status"}</a>
          <a href="/docs/implementation-status.json">{zh ? "接口实现状态" : "API implementation status"}</a>
        </nav>
      </aside>
    </div>
  );
}
