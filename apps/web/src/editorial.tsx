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

export function Editorial({ view, locale, query }: { view: EditorialView; locale: Locale; query?: string }) {
  const zh = locale === "zh-CN";
  const t = (en: string, cn: string) => (zh ? cn : en);
  const href = (path: string) => (zh ? "/zh-CN" : "") + path;
  const date = (at: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(at));
  const articleLink = (item: EditorialEntry) => href(`${view.indexPath ?? view.path}/${item.slug}`);
  const body = (text: string) => <p>{text}</p>;
  const current = view.current;
  const category = view.category;
  if (view.path === "/404")
    return (
      <section className="wrap workbench">
        <h1>{view.title}</h1>
        <a className="btn brand" href={href("/")}>
          {t("Return home", "返回首页")}
        </a>
      </section>
    );
  return (
    <section className="wrap workbench">
      {view.indexPath && <a href={href(view.indexPath)}>{t("Back to the index", "返回目录")}</a>}
      <h1>{current?.title ?? view.title}</h1>
      {category && (
        <div className="card result-card">
          <dl>
            <dt>{t("Market", "站点")}</dt>
            <dd>{t("eBay US · USD", "eBay 美国站 · 美元")}</dd>
            <dt>{t("Supported windows", "支持的时间窗口")}</dt>
            <dd>
              {category.windows.length
                ? category.windows.map((value) => t(`${value} days`, `${value} 天`)).join(" / ")
                : "—"}
            </dd>
            <dt>{t("Data availability", "数据可用性")}</dt>
            <dd>
              {{
                fresh: t("Available", "可用"),
                stale_acceptable: t("Delayed", "延迟"),
                expired: t("Expired", "已过期"),
                never_observed: t("No observations yet", "暂无观测"),
              }[category.freshness] ?? t("Unavailable", "不可用")}
            </dd>
            {category.asOf && (
              <>
                <dt>{t("Last usable data", "最近可用数据")}</dt>
                <dd>
                  <time dateTime={category.asOf}>{category.asOf}</time>
                </dd>
              </>
            )}
          </dl>
          <a className="btn brand" href={href(`/search?${new URLSearchParams({ category: category.id })}`)}>
            {t("Search this category", "查询此类目")}
          </a>
        </div>
      )}
      {view.path === "/worth" && (
        <>
          <form className="searchbox" action={href("/search")} method="get" data-search="">
            <label className="sr-only" htmlFor="worth-product">
              {t("Product", "商品")}
            </label>
            <input
              id="worth-product"
              name="q"
              maxLength={120}
              required
              defaultValue={query}
              placeholder={t("Enter a brand and model", "输入品牌和型号")}
            />
            <button type="submit" className="btn brand">
              {t("Check sold prices", "查成交价")}
            </button>
          </form>
          <p className="small">{t("eBay US · USD · Synthetic demo", "eBay 美国站 · 美元 · 合成演示")}</p>
          <p className="notice" data-status="" aria-live="polite" hidden />
          <div data-actions="" className="actions" />
          <div data-results="" />
        </>
      )}
      {current && (
        <article className="card result-card published-section">
          <p className="small">
            {current.author && `${current.author} · `}
            <time dateTime={current.publishedAt}>{date(current.publishedAt)}</time>
          </p>
          {body(current.body)}
          {current.reference && (
            <a href={current.reference} rel="noreferrer">
              {t("Source and evidence", "来源与证据")}
            </a>
          )}
        </article>
      )}
      {view.entries?.length ? (
        <div className="grid3">
          {view.entries.map((entry) => (
            <article key={entry.slug} className="card result-card published-section">
              <h2>
                {view.path === "/changelog" ? entry.title : <a href={articleLink(entry)}>{entry.title}</a>}
              </h2>
              <p className="small">
                {entry.author && `${entry.author} · `}
                <time dateTime={entry.publishedAt}>{date(entry.publishedAt)}</time>
              </p>
              {view.path === "/changelog" ? (
                body(entry.body)
              ) : (
                <p>{entry.body.length > 220 ? `${entry.body.slice(0, 217)}…` : entry.body}</p>
              )}
              {view.path === "/changelog" && entry.reference && (
                <a href={entry.reference} rel="noreferrer">
                  {t("Release reference", "发布参考")}
                </a>
              )}
            </article>
          ))}
        </div>
      ) : (
        view.entries && (
          <p className="notice">{t("Nothing has been published here yet.", "此处暂未发布内容。")}</p>
        )
      )}
      {view.related && view.related.length > 0 && (
        <nav aria-label={t("Related articles", "相关文章")}>
          <h2>{t("Related articles", "相关文章")}</h2>
          <ul>
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
        <ul>
          <li>
            <a href={href("/faq")}>{t("Frequently asked questions", "常见问题")}</a>
          </li>
          <li>
            <a href={href("/guides")}>{t("Research guides", "研究指南")}</a>
          </li>
          <li>
            <a href={href("/support")}>{t("Submit or check a support request", "提交或查询工单")}</a>
          </li>
        </ul>
      )}
    </section>
  );
}
