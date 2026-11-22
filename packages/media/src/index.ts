import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import { AppError } from "@soldbench/shared";
import sharp from "sharp";
import { approvedImageUrl, type ImageCandidate, selectPrimaryImage } from "./primary.ts";

export {
  type AllowedInputImageMime,
  LOOKUP_IMAGE_MAX_BYTES,
  LOOKUP_IMAGE_MAX_DIMENSION,
  LOOKUP_IMAGE_MAX_PIXELS,
  type SanitizedLookupImage,
  sanitizeLookupImage,
} from "./lookup-image.ts";
export { approvedImageUrl, type ImageCandidate, selectPrimaryImage } from "./primary.ts";
export { decryptImageSourceUrl, encryptImageSourceUrl } from "./url-encryption.ts";

export const MEDIA_VERSION = "1.0.0";
export type ImageRights = {
  sourceId: string;
  permissionEpoch: number;
  mayCopy: boolean;
  mayDisplay: boolean;
  expiresAt: string;
};
export type ImageResponse = { status: number; contentType: string; bytes: Uint8Array };
export type ImageTransport = (url: string, signal: AbortSignal, maxBytes: number) => Promise<ImageResponse>;
export type PrimaryImage = {
  listingId: string;
  observationId: string;
  saleEventId: string;
  state: "available";
  hash: string;
  bytes: Buffer;
  mimeType: "image/webp";
  width: number;
  height: number;
  sourceId: string;
  permissionEpoch: number;
  retentionUntil: string;
};
function checkRights(rights: ImageRights | null, sourceId: string, now: string, epoch?: number): ImageRights {
  if (
    !Number.isFinite(Date.parse(now)) ||
    !rights ||
    rights.sourceId !== sourceId ||
    !rights.mayCopy ||
    !rights.mayDisplay ||
    !Number.isSafeInteger(rights.permissionEpoch) ||
    rights.permissionEpoch < 1 ||
    !Number.isFinite(Date.parse(rights.expiresAt)) ||
    Date.parse(rights.expiresAt) <= Date.parse(now) ||
    (epoch !== undefined && rights.permissionEpoch !== epoch)
  )
    throw new AppError("forbidden", 403, "Image permission is unavailable");
  return rights;
}
export async function collectPrimaryImage(
  input: {
    listingId: string;
    observationId: string;
    saleEventId: string;
    candidates: readonly ImageCandidate[];
    sourceId: string;
    hosts: readonly string[];
  },
  dependencies: {
    transport: ImageTransport;
    currentRights: () => ImageRights | null;
    now: () => string;
    tripSourceCircuit: (reason: "access_refused" | "challenge") => Promise<void>;
  },
): Promise<PrimaryImage> {
  if (!input.listingId || !input.observationId || !input.saleEventId)
    throw new AppError("invalid_parameter", 400, "Image listing evidence is required");
  const url = selectPrimaryImage(
    input.listingId,
    input.observationId,
    input.saleEventId,
    input.candidates,
    input.hosts,
  );
  if (!url) throw new AppError("not_found", 404, "Primary image candidate is missing");
  const rights = checkRights(dependencies.currentRights(), input.sourceId, dependencies.now());
  approvedImageUrl(url, input.hosts);
  const maxBytes = 5 * 1024 * 1024;
  const signal = AbortSignal.timeout(10000);
  const response = await dependencies.transport(url, signal, maxBytes);
  signal.throwIfAborted();
  if (response.status === 401 || response.status === 403) {
    await dependencies.tripSourceCircuit("access_refused");
    throw new AppError("source_unavailable", 503, "Source access was refused");
  }
  const contentType = response.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (
    contentType === "text/html" &&
    /captcha|challenge|verify you are human|robot check|sign in to continue/i.test(
      Buffer.from(response.bytes.subarray(0, 8192)).toString("utf8"),
    )
  ) {
    await dependencies.tripSourceCircuit("challenge");
    throw new AppError("source_unavailable", 503, "Source challenge detected");
  }
  if (response.status !== 200) throw new AppError("source_unavailable", 503, "Image request failed");
  if (
    !["image/jpeg", "image/png", "image/webp", "image/avif"].includes(contentType) ||
    response.bytes.byteLength === 0 ||
    response.bytes.byteLength > maxBytes
  )
    throw new AppError("invalid_parameter", 400, "Invalid image content");
  const image = sharp(response.bytes, { limitInputPixels: 40_000_000, failOn: "warning" });
  const metadata = await image.metadata();
  if (
    !metadata.format ||
    !["jpeg", "png", "webp", "heif"].includes(metadata.format) ||
    (metadata.pages ?? 1) > 1
  ) {
    throw new AppError("invalid_parameter", 400, "Unsupported or animated image");
  }
  const normalized = await image
    .rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });
  if (normalized.data.byteLength === 0 || normalized.data.byteLength > maxBytes)
    throw new AppError("invalid_parameter", 400, "Normalized image exceeds the storage byte limit");
  signal.throwIfAborted();
  const latest = checkRights(
    dependencies.currentRights(),
    input.sourceId,
    dependencies.now(),
    rights.permissionEpoch,
  );
  return {
    listingId: input.listingId,
    observationId: input.observationId,
    saleEventId: input.saleEventId,
    state: "available",
    hash: createHash("sha256").update(normalized.data).digest("hex"),
    bytes: normalized.data,
    mimeType: "image/webp",
    width: normalized.info.width,
    height: normalized.info.height,
    sourceId: input.sourceId,
    permissionEpoch: latest.permissionEpoch,
    retentionUntil: latest.expiresAt,
  };
}

export function imageIsReadable(
  image: Pick<PrimaryImage, "sourceId" | "permissionEpoch" | "retentionUntil">,
  current: ImageRights | null,
  now: string,
): boolean {
  return (
    Number.isFinite(Date.parse(now)) &&
    Boolean(
      current?.mayDisplay &&
        current.sourceId === image.sourceId &&
        current.permissionEpoch === image.permissionEpoch &&
        Date.parse(current.expiresAt) > Date.parse(now) &&
        Date.parse(image.retentionUntil) > Date.parse(now),
    )
  );
}

export function disabledNetworkImageTransport(): ImageTransport {
  return async () => {
    throw new AppError("collector_unavailable", 503, "Network image collection is disabled");
  };
}

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null;
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return null;
  return octets.reduce((value, part) => ((value << 8) | part) >>> 0, 0);
}
function ipv4In(address: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (base & mask);
}

/** Conservatively allow only publicly routable addresses for pinned image requests. */
export function isPublicImageAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const n = ipv4Number(address);
    if (n === null) return false;
    const blocked: Array<[number, number]> = [
      [0x00000000, 8],
      [0x0a000000, 8],
      [0x64400000, 10],
      [0x7f000000, 8],
      [0xa9fe0000, 16],
      [0xac100000, 12],
      [0xc0000000, 24],
      [0xc0000200, 24],
      [0xc0586300, 24],
      [0xc0a80000, 16],
      [0xc6120000, 15],
      [0xc6336400, 24],
      [0xcb007100, 24],
      [0xe0000000, 4],
      [0xf0000000, 4],
    ];
    return !blocked.some(([base, prefix]) => ipv4In(n, base, prefix));
  }
  // IPv6 remains disabled until the full special-purpose registry is modeled.
  return false;
}

function lookupPinned(addresses: readonly { address: string; family: number }[]) {
  return (
    hostname: string,
    _options: unknown,
    callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ) => {
    const selected = addresses.find((entry) => entry.family === 4) ?? addresses[0];
    if (!selected) {
      callback(Object.assign(new Error(`No approved address for ${hostname}`), { code: "ENOTFOUND" }), "", 0);
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

/**
 * Explicitly opt-in transport. Callers must only pass hosts from a current source
 * clearance; the request pins DNS, rejects redirects, bounds bytes/time, and never
 * changes accounts or network routes. It is not selected by offline defaults.
 */
export function guardedHttpsImageTransport(approvedHosts: readonly string[]): ImageTransport {
  return async (rawUrl, signal, maxBytes) => {
    const approvedUrl = approvedImageUrl(rawUrl, approvedHosts);
    const url = new URL(approvedUrl);
    if (maxBytes < 1 || maxBytes > 5 * 1024 * 1024)
      throw new AppError("forbidden", 403, "Image transport request is not permitted");
    if (signal.aborted) signal.throwIfAborted();
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await lookup(url.hostname, { all: true, verbatim: true });
    } catch {
      throw new AppError("source_unavailable", 503, "Image host could not be resolved");
    }
    if (addresses.length === 0 || addresses.some((entry) => !isPublicImageAddress(entry.address)))
      throw new AppError("forbidden", 403, "Image host resolved to a non-public address");
    signal.throwIfAborted();
    return await new Promise<ImageResponse>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, response?: ImageResponse) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        if (error !== undefined) reject(error);
        else if (response) resolve(response);
        else reject(new AppError("source_unavailable", 503, "Image request failed"));
      };
      const abort = () =>
        request.destroy(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      const request = https.request(
        {
          protocol: "https:",
          hostname: url.hostname,
          port: 443,
          method: "GET",
          path: `${url.pathname}${url.search}`,
          headers: { Accept: "image/avif,image/webp,image/png,image/jpeg", "User-Agent": "SoldBench/0.1" },
          lookup: lookupPinned(addresses) as never,
          signal,
          timeout: 10_000,
          maxHeaderSize: 16 * 1024,
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const contentType = response.headers["content-type"] ?? "";
          const declaredLength = Number(response.headers["content-length"] ?? 0);
          if (status >= 300 && status < 400) {
            response.destroy();
            finish(new AppError("source_unavailable", 503, "Image redirects are not followed"));
            return;
          }
          if (status !== 200) {
            response.destroy();
            finish(undefined, { status, contentType, bytes: new Uint8Array() });
            return;
          }
          if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
            response.destroy();
            finish(new AppError("invalid_parameter", 413, "Image exceeds byte limit"));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer | string) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.byteLength;
            if (size > maxBytes) {
              response.destroy(new AppError("invalid_parameter", 413, "Image exceeds byte limit"));
              return;
            }
            chunks.push(bytes);
          });
          response.on("end", () =>
            finish(undefined, { status, contentType, bytes: Buffer.concat(chunks, size) }),
          );
          response.on("error", (error) => finish(error));
        },
      );
      signal.addEventListener("abort", abort, { once: true });
      request.on("timeout", () =>
        request.destroy(new AppError("source_unavailable", 503, "Image request timed out")),
      );
      request.on("error", (error) => finish(error));
      request.end();
    });
  };
}
export { PrivateMediaStore } from "./private-store.ts";
