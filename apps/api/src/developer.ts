import { readFileSync } from "node:fs";
import { AppError } from "@soldbench/shared";
import type { Hono } from "hono";

type Env = { Variables: { requestId: string } };
type Page = { path: string; locale: string; title: string; text: string };
type Asset = { body: string; contentType: string; etag: string };
let registry: { assets: Record<string, Asset>; pages: Page[] } | undefined;
export function mountDeveloper(app: Hono<Env>) {
  // Built from fixed repository inputs. No request path is ever used for filesystem reads.
  registry ??= JSON.parse(readFileSync(new URL("./developer/assets.json", import.meta.url), "utf8"));
  const data = registry;
  if (!data) throw new Error("developer_assets_missing");
  app.get("/docs", (c) => c.redirect("/docs/en/quickstart", 302));
  app.get("/docs/search", (c) => {
    const params = new URL(c.req.url).searchParams,
      q = params.get("q")?.trim().normalize("NFKC").toLocaleLowerCase() ?? "",
      locale = params.get("locale") ?? "en",
      limit = params.get("limit") ?? "10";
    if (
      [...params.keys()].some(
        (k) => !["q", "locale", "limit"].includes(k) || params.getAll(k).length !== 1,
      ) ||
      q.length < 1 ||
      q.length > 200 ||
      !["en", "zh-CN"].includes(locale) ||
      !/^[1-9]\d?$/.test(limit) ||
      Number(limit) > 20
    )
      throw new AppError(
        "invalid_parameter",
        400,
        "Use q (1–200 characters), locale en/zh-CN, and limit 1–20.",
      );
    const tokens = q.split(/\s+/),
      ranked = data.pages
        .filter((p) => p.locale === locale)
        .map((p) => {
          const title = p.title.normalize("NFKC").toLocaleLowerCase(),
            text = p.text.normalize("NFKC").toLocaleLowerCase();
          return {
            p,
            score: tokens.every((t) => text.includes(t))
              ? tokens.reduce((sum, t) => sum + (title.includes(t) ? 4 : 1), 0)
              : 0,
          };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score || a.p.path.localeCompare(b.p.path));
    return c.json({
      data: {
        locale,
        total: ranked.length,
        items: ranked.slice(0, Number(limit)).map(({ p }) => ({
          title: p.title,
          path: p.path,
          excerpt: p.text
            .replace(/^#.*\n/, "")
            .trim()
            .slice(0, 240),
        })),
      },
      meta: { credits_charged: 0 },
    });
  });
  for (const [path, asset] of Object.entries(data.assets))
    app.get(path, (c) => {
      c.header("Cache-Control", "public, max-age=300");
      c.header("ETag", asset.etag);
      c.header("Content-Type", asset.contentType);
      if (c.req.header("If-None-Match") === asset.etag) return c.body(null, 304);
      return c.body(asset.body);
    });
}
