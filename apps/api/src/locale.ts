import { type Locale, localeFrom } from "@soldbench/shared";

/**
 * Resolve preferred UI locale from explicit `soldbench_locale` cookie first,
 * falling back to `Accept-Language` and finally English.
 */
export function preferredLocale(cookieHeader?: string, acceptLanguage?: string): Locale {
  if (cookieHeader) {
    for (const part of cookieHeader.split(";")) {
      const idx = part.indexOf("=");
      if (idx === -1) continue;
      const name = part.slice(0, idx).trim();
      if (name !== "soldbench_locale") continue;
      const value = part.slice(idx + 1).trim();
      if (value === "zh-CN" || value === "en") return value;
    }
  }
  return localeFrom("/", acceptLanguage ?? "");
}
