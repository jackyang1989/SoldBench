import { type Locale, message } from "@soldbench/shared";
import { renderToStaticMarkup } from "react-dom/server";

export function renderHome(locale: Locale): string {
  const t = (key: Parameters<typeof message>[1]) => message(locale, key);
  const prefix = locale === "zh-CN" ? "/zh-CN" : "";
  const title = `SoldBench — ${t("nav.research")}`;
  return (
    "<!doctype html>" +
    renderToStaticMarkup(
      <html lang={locale}>
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <title>{title}</title>
          <meta name="robots" content="noindex,nofollow" />
        </head>
        <body>
          <header>
            <a href={prefix || "/"}>SoldBench</a>
            <nav>
              <a href={`${prefix}/research`}>{t("nav.research")}</a>{" "}
              <a href={`${prefix}/account`}>{t("nav.account")}</a>{" "}
              <a href={locale === "en" ? "/zh-CN" : "/"}>{locale === "en" ? "简体中文" : "English"}</a>
            </nav>
          </header>
          <main>
            <p>{t("data.demo")}</p>
            <h1>{t("home.title")}</h1>
            <p>{t("home.subtitle")}</p>
            <form action={`${prefix}/research`} method="get">
              <label htmlFor="q">{t("search.label")}</label>
              <input id="q" name="q" required maxLength={120} placeholder={t("search.placeholder")} />
              <button type="submit">{t("search.submit")}</button>
            </form>
            <p>{t("data.disclosure")}</p>
          </main>
          <footer>
            <a href="mailto:support@soldbench.com">{t("common.support")}</a>
          </footer>
        </body>
      </html>,
    )
  );
}
