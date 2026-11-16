import { IntlMessageFormat } from "intl-messageformat";

export const locales = ["en", "zh-CN"] as const;
export type Locale = (typeof locales)[number];
export const en = {
  "nav.research": "Research",
  "nav.account": "Account",
  "nav.developers": "Developers",
  "home.title": "Know what it sold for.",
  "home.subtitle": "Research comparable sales, understand the price range, and inspect the evidence.",
  "search.label": "What are you researching?",
  "search.placeholder": "e.g. Game Boy Color Atomic Purple",
  "search.submit": "Research sold prices",
  "search.recent": "Recent {days} days",
  "data.demo": "Demo data",
  "data.offline": "Real data connection pending",
  "data.disclosure": "Sample results use synthetic records. Market data access is being prepared.",
  "results.median": "Median sold price",
  "results.range": "Middle 50% of verified prices",
  "results.sample": "{count, plural, one {# verified comparable} other {# verified comparables}}",
  "results.noImage": "Image unavailable",
  "results.insufficient": "Not enough verified prices",
  "auth.signIn": "Sign in",
  "auth.register": "Create account",
  "auth.email": "Email address",
  "auth.password": "Password",
  "common.error": "Something went wrong. Please try again.",
  "common.loading": "Loading…",
  "common.support": "Support",
  "common.method": "Methodology",
  "common.back": "Back to research",
  "status.ready": "Ready",
  "status.pending": "Pending",
} as const;
export type MessageKey = keyof typeof en;
export const zhCN: Record<MessageKey, string> = {
  "nav.research": "成交研究",
  "nav.account": "账户",
  "nav.developers": "开发者",
  "home.title": "了解真实成交价格。",
  "home.subtitle": "研究可比成交、了解价格区间，并逐条核查证据。",
  "search.label": "你想研究什么商品？",
  "search.placeholder": "例如 Game Boy Color Atomic Purple",
  "search.submit": "研究成交价格",
  "search.recent": "最近 {days} 天",
  "data.demo": "演示数据",
  "data.offline": "真实数据接入准备中",
  "data.disclosure": "示例结果使用合成记录，市场数据访问仍在准备中。",
  "results.median": "成交中位价",
  "results.range": "已核验价格的中间50%区间",
  "results.sample": "{count} 条已核验可比成交",
  "results.noImage": "暂无商品主图",
  "results.insufficient": "已核验价格样本不足",
  "auth.signIn": "登录",
  "auth.register": "创建账户",
  "auth.email": "邮箱地址",
  "auth.password": "密码",
  "common.error": "出现问题，请重试。",
  "common.loading": "加载中…",
  "common.support": "联系客服",
  "common.method": "统计方法",
  "common.back": "返回研究",
  "status.ready": "就绪",
  "status.pending": "待处理",
};
export function localeFrom(path: string, acceptLanguage = ""): Locale {
  if (path === "/zh-CN" || path.startsWith("/zh-CN/")) return "zh-CN";
  const preferences = acceptLanguage
    .split(",")
    .map((item, index) => {
      const [tag = "", quality] = item.trim().split(";q=");
      const weight = quality === undefined ? 1 : Number(quality);
      return { tag: tag.toLowerCase(), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((item) => item.weight > 0 && item.weight <= 1)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const preference of preferences) {
    if (["zh-cn", "zh-hans", "zh"].includes(preference.tag)) return "zh-CN";
    if (preference.tag === "en" || preference.tag.startsWith("en-")) return "en";
  }
  return "en";
}
export function message(
  locale: Locale,
  key: MessageKey,
  values: Record<string, string | number> = {},
): string {
  return String(new IntlMessageFormat((locale === "zh-CN" ? zhCN : en)[key], locale).format(values));
}
export function money(locale: Locale, cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("Invalid cents");
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    currencyDisplay: "symbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const wholeDollars = BigInt(cents) / 100n;
  const fractionalCents = String(BigInt(cents) % 100n).padStart(2, "0");
  return formatter
    .formatToParts(wholeDollars)
    .map((part) => (part.type === "fraction" ? fractionalCents : part.value))
    .join("");
}
