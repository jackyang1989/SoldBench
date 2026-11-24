export * from "./config.ts";
export * from "./errors.ts";
export * from "./i18n.ts";
export * from "./regional-i18n.ts";
export * from "./runtime-policy.ts";

export const BRAND = "SoldBench";
export const VERSIONS = {
  normalizer: "1.1.0",
  engine: "1.2.0",
  cleaner: "1.1.0",
  billing: "1.1.0",
  translation: "1",
} as const;
