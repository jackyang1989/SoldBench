import type { Database } from "@soldbench/db";
import type { QueryService } from "@soldbench/query";
import type { Locale } from "@soldbench/shared";
import { type EditorialEntry, type EditorialView, renderPage } from "@soldbench/web";
import type { Context, Hono } from "hono";
import { readCatalog } from "./catalog.ts";
import { type PublishedSiteContent, publishedSiteContent } from "./site-content.ts";

type Env = { Variables: { requestId: string } };
const chrome = ["announcement", "navigation", "footer"] as const;
const builtinCompareSlugs = new Set(["compsniper", "soldcomps-io", "sold-comps-com", "watchcount"]);
const builtinCompareTitles: Record<string, string> = {
  compsniper: "CompSniper",
  "soldcomps-io": "SoldComps.io",
  "sold-comps-com": "sold-comps.com",
  watchcount: "WatchCount",
};
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const chineseCategories: Record<string, string> = {
  cards_graded: "评级卡牌",
  sneakers: "运动鞋",
  watches: "腕表",
  video_games: "电子游戏",
  gpu_hardware: "显卡硬件",
  collectibles: "收藏品",
};
const localized = (row: PublishedSiteContent, locale: Locale): EditorialEntry => ({
  slug: row.slug,
  ...row.body[locale],
  publishedAt: row.published_at.toISOString(),
  author: row.metadata.author,
  reference: row.metadata.reference,
});

export function siteBlocks(rows: PublishedSiteContent[], locale: Locale) {
  return rows
    .filter((row) => ["announcement", "home", "navigation", "footer", "blog"].includes(row.kind))
    .map((row) => ({ kind: row.kind, slug: row.slug, target: row.metadata.target, ...row.body[locale] }));
}

export function editorialNotFound(c: Context<Env>, locale: Locale) {
  c.header("Cache-Control", "no-store");
  return c.html(
    renderPage(locale, "/404", new URL(c.req.url), undefined, undefined, undefined, [], [], {
      title: locale === "en" ? "Page not found" : "找不到此页面",
      path: "/404",
    }),
    404,
  );
}

export function mountEditorial(app: Hono<Env>, db: Database, query?: QueryService) {
  app.get("/sitemap.xml", (c) =>
    c.body(
      '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n',
      200,
      {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex",
      },
    ),
  );
  for (const [locale, prefix] of [
    ["en", ""],
    ["zh-CN", "/zh-CN"],
  ] as const) {
    const t = (en: string, cn: string) => (locale === "en" ? en : cn);
    const render = (c: Context<Env>, view: EditorialView, rows: PublishedSiteContent[] = []) => {
      c.header("Cache-Control", "no-store");
      return c.html(
        renderPage(
          locale,
          "/editorial",
          new URL(c.req.url),
          undefined,
          undefined,
          undefined,
          [],
          siteBlocks(rows, locale),
          view,
        ),
      );
    };
    for (const [path, kind, title] of [
      ["/blog", "blog", t("Blog", "博客")],
      ["/guides", "guide", t("Research guides", "研究指南")],
      ["/alternatives", "comparison", t("Alternatives", "方案比较")],
      ["/compare", "comparison", t("Compare research tools", "对比研究工具")],
      ["/changelog", "changelog", t("Changelog", "更新记录")],
    ] as const) {
      app.get(prefix + path, async (c, next) => {
        if (path === "/changelog" && locale === "en") {
          c.header("Vary", "Accept");
          if (!c.req.header("Accept")?.includes("text/html")) return next();
        }
        const rows = query ? await publishedSiteContent(db, [kind, ...chrome]) : [];
        const indexPath = kind === "comparison" ? "/compare" : path;
        return render(
          c,
          {
            title,
            path,
            indexPath: path !== indexPath ? indexPath : undefined,
            entries: rows.filter((row) => row.kind === kind).map((row) => localized(row, locale)),
          },
          rows,
        );
      });
      if (path === "/changelog" || path === "/alternatives") continue;
      app.get(`${prefix}${path}/:slug`, async (c) => {
        const slug = c.req.param("slug");
        if (!query || slug.length > 70 || !slugPattern.test(slug)) return editorialNotFound(c, locale);
        const [entry] = await publishedSiteContent(db, kind, slug);
        if (!entry) {
          if (path === "/compare" && builtinCompareSlugs.has(slug)) {
            const rows = await publishedSiteContent(db, [...chrome]);
            return render(
              c,
              {
                title: `SoldBench vs ${builtinCompareTitles[slug] ?? slug}`,
                path: `/compare/${slug}`,
                indexPath: "/alternatives",
              },
              rows,
            );
          }
          return editorialNotFound(c, locale);
        }
        const rows = await publishedSiteContent(db, [kind, ...chrome]);
        const related = (entry.metadata.related ?? []).flatMap((candidate) => {
          const row = rows.find(
            (row) => row.kind === kind && row.slug === candidate && row.slug !== entry.slug,
          );
          return row ? [localized(row, locale)] : [];
        });
        return render(
          c,
          {
            title: entry.body[locale].title,
            path: `${path}/${slug}`,
            indexPath: path,
            current: localized(entry, locale),
            related,
          },
          rows.filter((row) => row.kind !== kind),
        );
      });
    }
    for (const [path, title] of [
      ["/about", t("About SoldBench", "关于 SoldBench")],
      ["/terms", t("Terms", "服务条款")],
      ["/privacy", t("Privacy", "隐私政策")],
      ["/help", t("Help", "帮助")],
      ["/worth", t("What is it worth?", "商品值多少钱？")],
    ] as const) {
      app.get(prefix + path, async (c) => {
        const rows = query
          ? await publishedSiteContent(db, path === "/about" ? ["about", ...chrome] : chrome)
          : [];
        const current = rows.find((row) => row.kind === "about");
        return render(c, { title, path, current: current ? localized(current, locale) : undefined }, rows);
      });
    }
    app.get(`${prefix}/categories/:category`, async (c) => {
      const id = c.req.param("category");
      if (!query || !/^[a-z0-9_]{1,70}$/.test(id)) return editorialNotFound(c, locale);
      const [catalog, rows] = await Promise.all([
        readCatalog(db, query),
        publishedSiteContent(db, ["category_copy", ...chrome]),
      ]);
      const record = catalog.find(
        (item) => item.category.id === id && item.status.freshness_state !== "forbidden",
      );
      if (!record) return editorialNotFound(c, locale);
      const copy = rows.find((row) => row.kind === "category_copy" && row.slug === id.replaceAll("_", "-"));
      return render(
        c,
        {
          title:
            copy?.body[locale].title ??
            (locale === "zh-CN" ? chineseCategories[id] : undefined) ??
            record.category.name,
          path: `/categories/${id}`,
          indexPath: "/categories",
          current: copy ? localized(copy, locale) : undefined,
          category: {
            id,
            windows: record.category.supported_windows,
            freshness: record.status.freshness_state,
            asOf: record.status.data_as_of,
          },
        },
        rows,
      );
    });
  }
}
