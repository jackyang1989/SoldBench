import { AppError } from "@soldbench/shared";

export function approvedImageUrl(raw: string, hosts: readonly string[]): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("invalid_parameter", 400, "Invalid image URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    !hosts.includes(url.hostname) ||
    /^\d+(?:\.\d+){3}$/.test(url.hostname) ||
    url.hostname.includes(":")
  ) {
    throw new AppError("forbidden", 403, "Image origin is not approved");
  }
  return url.href;
}

export type ImageCandidate = {
  listingId: string;
  observationId: string;
  saleEventId: string;
  role: "primary" | "gallery" | "advertisement";
  url: string;
  width?: number;
};
export function selectPrimaryImage(
  listingId: string,
  observationId: string,
  saleEventId: string,
  candidates: readonly ImageCandidate[],
  hosts: readonly string[],
): string | null {
  const primary = candidates.filter(
    (candidate) =>
      candidate.listingId === listingId &&
      candidate.observationId === observationId &&
      candidate.saleEventId === saleEventId &&
      candidate.role === "primary",
  );
  if (primary.length === 0) return null;
  const first = [...primary].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  if (!first) return null;
  if (
    primary.some(
      (candidate) =>
        candidate.width !== undefined && (!Number.isSafeInteger(candidate.width) || candidate.width <= 0),
    )
  )
    throw new AppError("invalid_parameter", 400, "Invalid primary image dimensions");
  return approvedImageUrl(first.url, hosts);
}
