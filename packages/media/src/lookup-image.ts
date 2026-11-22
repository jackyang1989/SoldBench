import { createHash } from "node:crypto";
import { AppError } from "@soldbench/shared";
import sharp from "sharp";

export const LOOKUP_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const LOOKUP_IMAGE_MAX_DIMENSION = 5000;
export const LOOKUP_IMAGE_MAX_PIXELS = 25_000_000;

export type AllowedInputImageMime = "image/jpeg" | "image/png" | "image/webp";

export type SanitizedLookupImage = {
  bytes: Buffer;
  sha256: string;
  mimeType: "image/webp";
  detectedInputMime: AllowedInputImageMime;
  width: number;
  height: number;
  originalHadExif: boolean;
  exifStripped: true;
};

function detectMagicImageMime(bytes: Uint8Array): AllowedInputImageMime | null {
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return "image/png";
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return null;
}

function normalizeDeclaredMime(declaredMime?: string): string | null {
  if (!declaredMime) return null;
  const normalized = declaredMime.split(";")[0]?.trim().toLowerCase() ?? "";
  return normalized || null;
}

function expectedSharpFormat(mime: AllowedInputImageMime): "jpeg" | "png" | "webp" {
  if (mime === "image/jpeg") return "jpeg";
  if (mime === "image/png") return "png";
  return "webp";
}

/**
 * Validate lookup upload magic bytes, pixel bounds, and EXIF/metadata removal.
 */
export async function sanitizeLookupImage(
  bytes: Uint8Array,
  declaredMime?: string,
): Promise<SanitizedLookupImage> {
  if (bytes.byteLength === 0 || bytes.byteLength > LOOKUP_IMAGE_MAX_BYTES)
    throw new AppError("invalid_parameter", 400, "Uploaded image must be between 1 byte and 5 MiB.");

  const detectedInputMime = detectMagicImageMime(bytes);
  if (!detectedInputMime)
    throw new AppError("invalid_parameter", 400, "Only valid JPEG, PNG, or WebP images are supported.");

  const declared = normalizeDeclaredMime(declaredMime);
  if (declared && declared !== detectedInputMime)
    throw new AppError("invalid_parameter", 400, "Declared image MIME type does not match file bytes.");

  try {
    const pipeline = sharp(Buffer.from(bytes), {
      limitInputPixels: LOOKUP_IMAGE_MAX_PIXELS,
      failOn: "warning",
    });
    const metadata = await pipeline.metadata();
    if (
      metadata.format !== expectedSharpFormat(detectedInputMime) ||
      !metadata.width ||
      !metadata.height ||
      metadata.width < 1 ||
      metadata.height < 1 ||
      metadata.width > LOOKUP_IMAGE_MAX_DIMENSION ||
      metadata.height > LOOKUP_IMAGE_MAX_DIMENSION ||
      metadata.width * metadata.height > LOOKUP_IMAGE_MAX_PIXELS ||
      (metadata.pages ?? 1) > 1
    ) {
      throw new AppError("invalid_parameter", 400, "Image exceeds pixel limits or uses unsupported framing.");
    }

    const normalized = await pipeline
      .rotate()
      .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });

    if (
      normalized.data.byteLength === 0 ||
      normalized.data.byteLength > LOOKUP_IMAGE_MAX_BYTES ||
      normalized.info.width < 1 ||
      normalized.info.height < 1 ||
      normalized.info.width > LOOKUP_IMAGE_MAX_DIMENSION ||
      normalized.info.height > LOOKUP_IMAGE_MAX_DIMENSION
    ) {
      throw new AppError("invalid_parameter", 400, "Sanitized image exceeds limits.");
    }

    const strippedMeta = await sharp(normalized.data, {
      limitInputPixels: LOOKUP_IMAGE_MAX_PIXELS,
    }).metadata();
    if (strippedMeta.exif || strippedMeta.xmp || strippedMeta.iptc)
      throw new AppError("invalid_parameter", 400, "Image metadata could not be stripped cleanly.");

    const originalHadExif = Boolean(
      (metadata.exif && metadata.exif.byteLength > 0) ||
        (metadata.xmp && metadata.xmp.byteLength > 0) ||
        (metadata.iptc && metadata.iptc.byteLength > 0),
    );

    return {
      bytes: normalized.data,
      sha256: createHash("sha256").update(normalized.data).digest("hex"),
      mimeType: "image/webp",
      detectedInputMime,
      width: normalized.info.width,
      height: normalized.info.height,
      originalHadExif,
      exifStripped: true,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("invalid_parameter", 400, "Invalid or unsafe image file.");
  }
}
