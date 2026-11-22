import { IntlMessageFormat } from "intl-messageformat";

export const REGIONAL_LOCALES = ["en", "zh-CN", "en-GB", "de"] as const;
export type RegionalLocale = (typeof REGIONAL_LOCALES)[number];

const enCatalog = {
  "site.heading": "Regional marketplace research (US / UK / DE)",
  "site.selector_label": "Marketplace site (explicit selection)",
  "site.locale_label": "Display language (never changes marketplace)",
  "site.mode_notice":
    "Changing display language never changes site, currency, timezone, statistics, or credits.",
  "site.currency_notice":
    "Native site prices are calculated strictly within one currency. Cross-currency conversion requires verified FX evidence.",
  "site.shipping_label": "Shipping",
  "site.tax_disclosure": "Sales tax is excluded unless explicitly observed on the listing.",
  "site.sample_insufficient": "Fewer than 8 verified sales ({count}); median remains unavailable (null).",
  "site.sample_limited": "Limited verified sample size ({count} comparable sales).",
  "site.sample_sufficient": "Sufficient verified sample size ({count} comparable sales).",
  "site.rights_revoked": "Source rights for this site are revoked or unverified.",
  "site.stale_notice": "Delayed snapshot; no credit is charged when viewing approved stale records.",
  "site.fx_unavailable": "Verified FX evidence is unavailable; comparable converted view withheld.",
  "site.fx_evidence_label": "Converted comparable view ({currency}) via {provider}",
  "site.legal_imprint": "SoldBench Terms & Data Sources Disclosure",
  "site.legal_privacy": "Privacy Policy & Source Rights Notice",
  "email.verify_subject": "Confirm your SoldBench email address",
  "email.verify_body":
    "Verify your account at {url}. This single-use link expires in {expiresMinutes} minutes.",
  "email.reset_subject": "Reset your SoldBench password",
  "email.reset_body":
    "Reset your password at {url}. This single-use link expires in {expiresMinutes} minutes.",
} as const;

export type RegionalMessageKey = keyof typeof enCatalog;

export const regionalMessages: Record<RegionalLocale, Record<RegionalMessageKey, string>> = {
  en: enCatalog,
  "zh-CN": {
    "site.heading": "区域市场站点研究（美国 / 英国 / 德国）",
    "site.selector_label": "目标市场站点（显式选择）",
    "site.locale_label": "界面展示语言（绝不自动切换站点）",
    "site.mode_notice": "切换展示语言绝不会改变站点、币种、时区、统计口径或额度扣费。",
    "site.currency_notice":
      "站点原生价格严格按单一币种独立统计；跨币种对照必须基于已验证汇率证据，绝不直接混算。",
    "site.shipping_label": "运费",
    "site.tax_disclosure": "美国站点除非观测到明确运费，否则不含消费税与未知运费。",
    "site.sample_insufficient": "已核验可比成交不足 8 条（{count} 条），中心统计保持空缺（null）。",
    "site.sample_limited": "有限已核验样本（{count} 条可比成交）。",
    "site.sample_sufficient": "已核验样本充足（{count} 条可比成交）。",
    "site.rights_revoked": "该站点的来源授权已被撤销或尚未通过审查。",
    "site.stale_notice": "当前为延迟快照；经您确认查看合格延迟结果不扣查询额度。",
    "site.fx_unavailable": "缺少有效汇率证据，不显示跨币种换算对照视图。",
    "site.fx_evidence_label": "按 {provider} 汇率证据换算的对照视图（{currency}）",
    "site.legal_imprint": "SoldBench 服务条款与数据来源声明",
    "site.legal_privacy": "隐私政策与来源授权撤回说明",
    "email.verify_subject": "请确认您的 SoldBench 邮箱地址",
    "email.verify_body": "请访问 {url} 完成账户邮箱验证，此单次链接将在 {expiresMinutes} 分钟后失效。",
    "email.reset_subject": "重置您的 SoldBench 账户密码",
    "email.reset_body": "请访问 {url} 重置您的密码，此单次链接将在 {expiresMinutes} 分钟后失效。",
  },
  "en-GB": {
    "site.heading": "Regional marketplace research (US / UK / DE)",
    "site.selector_label": "Marketplace site (explicit selection)",
    "site.locale_label": "Display language (never swaps marketplace)",
    "site.mode_notice":
      "Switching display language never alters your chosen marketplace, GBP currency, Europe/London timezone, or credits.",
    "site.currency_notice":
      "UK sold prices are evaluated strictly in GBP without mixing USD/EUR. Cross-currency views require verified FX evidence.",
    "site.shipping_label": "Postage & Packaging (P&P)",
    "site.tax_disclosure":
      "UK GBP figures follow observed listing VAT & P&P context; unknown P&P is never zero-filled.",
    "site.sample_insufficient": "Fewer than 8 verified sales ({count}); median stays null.",
    "site.sample_limited": "Limited verified sample size ({count} comparable UK sales).",
    "site.sample_sufficient": "Sufficient verified sample size ({count} comparable UK sales).",
    "site.rights_revoked": "Source rights for this marketplace site are revoked or unapproved.",
    "site.stale_notice": "Delayed snapshot; zero credits charged when viewing approved stale UK records.",
    "site.fx_unavailable": "Verified FX rate evidence unavailable; converted comparison is withheld.",
    "site.fx_evidence_label": "Indicative converted view ({currency}) using {provider}",
    "site.legal_imprint": "SoldBench UK Terms & Source Provenance Disclosure",
    "site.legal_privacy": "UK Privacy Notice & Rights Revocation Policy",
    "email.verify_subject": "Confirm your SoldBench email address (UK)",
    "email.verify_body":
      "Please verify your SoldBench account at {url}. This single-use link expires in {expiresMinutes} minutes.",
    "email.reset_subject": "Reset your SoldBench password",
    "email.reset_body":
      "Reset your SoldBench password at {url}. This single-use link expires in {expiresMinutes} minutes.",
  },
  de: {
    "site.heading": "Regionale Marktplatz-Recherche (US / UK / DE)",
    "site.selector_label": "Marktplatz-Standort (explizite Auswahl)",
    "site.locale_label": "Anzeigesprache (ändert niemals den Marktplatz)",
    "site.mode_notice":
      "Der Sprachwechsel ändert weder Marktplatz noch EUR-Währung, Europe/Berlin-Zeitzone oder Guthaben.",
    "site.currency_notice":
      "Preise werden streng innerhalb einer Währung berechnet; Währungswechsel erfordert nachweisbare Wechselkurs-Evidenz.",
    "site.shipping_label": "Versandkosten",
    "site.tax_disclosure":
      "Deutsche EUR-Preise orientieren sich an beobachteten Angaben (inkl. MwSt. / Versand sofern ausgewiesen); unbekannte Versandkosten bleiben null.",
    "site.sample_insufficient": "Weniger als 8 verifizierte Verkäufe ({count}); der Medianwert bleibt null.",
    "site.sample_limited": "Eingeschränkte verifizierte Stichprobe ({count} vergleichbare Verkäufe).",
    "site.sample_sufficient": "Ausreichende verifizierte Stichprobe ({count} vergleichbare Verkäufe).",
    "site.rights_revoked":
      "Quellenrechte für diesen Marktplatz wurden widerrufen oder sind nicht freigegeben.",
    "site.stale_notice": "Verzögerte Momentaufnahme; für freigegebene ältere Datensätze fallen 0 Credits an.",
    "site.fx_unavailable":
      "Keine gültige Wechselkurs-Evidenz vorhanden; umgerechnete Vergleichsansicht ausgeblendet.",
    "site.fx_evidence_label": "Umrechnung in Vergleichswährung ({currency}) über {provider}",
    "site.legal_imprint": "SoldBench Impressum, Nutzungsbedingungen & Quellenhinweis",
    "site.legal_privacy": "Datenschutzerklärung & Widerruf von Quellenrechten",
    "email.verify_subject": "Bitte bestätigen Sie Ihre SoldBench E-Mail-Adresse",
    "email.verify_body":
      "Bestätigen Sie Ihr Konto über {url}. Dieser einmalige Link ist {expiresMinutes} Minuten gültig.",
    "email.reset_subject": "SoldBench Passwort zurücksetzen",
    "email.reset_body":
      "Setzen Sie Ihr Passwort unter {url} zurück. Dieser einmalige Link läuft in {expiresMinutes} Minuten ab.",
  },
};

function placeholders(template: string): string[] {
  return [...new Set([...template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1] ?? ""))].sort();
}

/**
 * Enforce identical keys, non-empty strings, and matching ICU parameter placeholders across all regional locales.
 */
export function assertRegionalCatalogComplete() {
  const baseKeys = Object.keys(enCatalog).sort();
  for (const locale of REGIONAL_LOCALES) {
    const dict = regionalMessages[locale];
    const keys = Object.keys(dict).sort();
    if (JSON.stringify(keys) !== JSON.stringify(baseKeys)) {
      throw new Error(`regional_i18n_key_mismatch:${locale}`);
    }
    for (const key of baseKeys as RegionalMessageKey[]) {
      const text = dict[key];
      if (typeof text !== "string" || !text.trim()) {
        throw new Error(`regional_i18n_empty_value:${locale}:${key}`);
      }
      if (JSON.stringify(placeholders(text)) !== JSON.stringify(placeholders(enCatalog[key]))) {
        throw new Error(`regional_i18n_placeholder_mismatch:${locale}:${key}`);
      }
    }
  }
}

export function regionalMessage(
  locale: RegionalLocale,
  key: RegionalMessageKey,
  values: Record<string, string | number> = {},
): string {
  return String(new IntlMessageFormat(regionalMessages[locale][key], locale).format(values));
}

export function formatRegionalMoney(
  locale: RegionalLocale,
  minorUnits: number,
  currency: "USD" | "GBP" | "EUR",
): string {
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) throw new Error("Invalid minor currency units");
  const whole = BigInt(minorUnits) / 100n;
  const frac = String(BigInt(minorUnits) % 100n).padStart(2, "0");
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    currencyDisplay: "code",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
    .formatToParts(whole)
    .map((part) => (part.type === "fraction" ? frac : part.value))
    .join("");
}

export function formatRegionalDate(
  locale: RegionalLocale,
  isoTimestamp: string,
  timeZone: string,
  precision: "instant" | "day",
): string {
  const dt = new Date(isoTimestamp);
  if (!Number.isFinite(dt.getTime())) throw new Error("Invalid regional timestamp");
  const formatted = new Intl.DateTimeFormat(locale, {
    timeZone,
    dateStyle: "medium",
    ...(precision === "instant" ? { timeStyle: "short" } : {}),
  }).format(dt);
  return `${formatted} (${timeZone})`;
}
