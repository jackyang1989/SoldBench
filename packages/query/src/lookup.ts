import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { Identity } from "@soldbench/auth";
import { canonicalJson, normalizeQuery, queryParameters } from "@soldbench/core";
import { transaction } from "@soldbench/db";
import { PrivateMediaStore, sanitizeLookupImage } from "@soldbench/media";
import { AppError } from "@soldbench/shared";
import type { QueryService } from "./index.ts";

export const BARCODE_FORMATS = ["upc_a", "ean_13", "ean_8", "gtin_14", "isbn_13"] as const;
export type BarcodeFormat = (typeof BARCODE_FORMATS)[number];
export const DEFAULT_LOOKUP_CONFIDENCE_THRESHOLD = 0.7;
export const DEFAULT_LOOKUP_RETENTION_HOURS = 24;

export type LookupCandidateInput = {
  label: string;
  suggested_q: string;
  category?: string | null;
  brand?: string | null;
  model?: string | null;
  variant?: string | null;
  suggested_condition?: string | null;
  confidence: number;
  requires_confirmation?: boolean;
};

export type LookupRecognitionResult = {
  outcome: "matched" | "low_confidence" | "failed";
  candidates: LookupCandidateInput[];
  topConfidence: number | null;
  ambiguityReason: string | null;
  failureCode?: string | null;
};

export interface LookupRecognizer {
  readonly mode: "memory_fixture" | string;
  recognizeImage(input: {
    sha256: string;
    filename: string | null;
    width: number;
    height: number;
  }): Promise<LookupRecognitionResult>;
  recognizeBarcode(input: { barcode: string; format: BarcodeFormat }): Promise<LookupRecognitionResult>;
}

type SessionRow = {
  id: string;
  user_id: string;
  input_kind: "image" | "barcode";
  status:
    | "candidates_ready"
    | "fallback_text_required"
    | "confirmed"
    | "recognition_failed"
    | "expired"
    | "deleted";
  barcode_value: string | null;
  barcode_format: BarcodeFormat | null;
  detected_mime_type: string | null;
  image_sha256: string | null;
  image_width: number | null;
  image_height: number | null;
  image_bytes: number | null;
  original_had_exif: boolean;
  exif_stripped: boolean;
  storage_key: string | null;
  confidence_threshold: string | number;
  top_confidence: string | number | null;
  ambiguity_reason: string | null;
  fallback_to_text: boolean;
  failure_code: string | null;
  identification_credits_charged: number;
  confirmed_candidate_id: string | null;
  confirmed_query_id: string | null;
  confirmed_query_params: Record<string, unknown> | null;
  confirm_idempotency_key: string | null;
  confirm_request_hash: string | null;
  confirmed_at: Date | null;
  retention_expires_at: Date;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type CandidateRow = {
  id: string;
  session_id: string;
  user_id: string;
  rank: number;
  label: string;
  suggested_q: string;
  category: string | null;
  brand: string | null;
  model: string | null;
  variant: string | null;
  suggested_condition: string | null;
  confidence: string | number;
  requires_confirmation: boolean;
  created_at: Date;
};

function deny(code: string, status: number, message: string): never {
  throw new AppError(code, status, message);
}

/**
 * Validate UPC/EAN/GTIN/ISBN-13 digits and GS1 Modulo-10 check digit.
 */
export function validateBarcode(
  raw: string,
  requestedFormat?: BarcodeFormat,
): { value: string; format: BarcodeFormat } {
  const cleaned = raw.trim().replace(/[\s-]+/g, "");
  if (!/^\d{8,14}$/.test(cleaned))
    deny("invalid_parameter", 400, "Barcode must contain 8 to 14 digits after separators.");

  let format: BarcodeFormat;
  if (requestedFormat) {
    if (!BARCODE_FORMATS.includes(requestedFormat))
      deny("invalid_parameter", 400, "Unsupported barcode format.");
    const expectedLengths: Record<BarcodeFormat, number> = {
      upc_a: 12,
      ean_13: 13,
      ean_8: 8,
      gtin_14: 14,
      isbn_13: 13,
    };
    if (cleaned.length !== expectedLengths[requestedFormat])
      deny("invalid_parameter", 400, `Barcode length does not match ${requestedFormat}.`);
    if (requestedFormat === "isbn_13" && !/^97[89]/.test(cleaned))
      deny("invalid_parameter", 400, "ISBN-13 barcodes must start with 978 or 979.");
    format = requestedFormat;
  } else {
    if (cleaned.length === 8) format = "ean_8";
    else if (cleaned.length === 12) format = "upc_a";
    else if (cleaned.length === 13) format = /^97[89]/.test(cleaned) ? "isbn_13" : "ean_13";
    else if (cleaned.length === 14) format = "gtin_14";
    else deny("invalid_parameter", 400, "Unsupported barcode length; expected 8, 12, 13, or 14 digits.");
  }

  let sum = 0;
  for (let i = cleaned.length - 2, pos = 1; i >= 0; i--, pos++) {
    const digit = Number(cleaned[i]);
    sum += digit * (pos % 2 === 1 ? 3 : 1);
  }
  const expectedCheck = (10 - (sum % 10)) % 10;
  const actualCheck = Number(cleaned[cleaned.length - 1]);
  if (actualCheck !== expectedCheck)
    deny("invalid_parameter", 400, "Barcode failed GS1 check-digit validation.");

  return { value: cleaned, format };
}

/**
 * Deterministic offline recognizer for AT-067 fixture testing without network calls.
 */
export function createOfflineFixtureLookupRecognizer(): LookupRecognizer {
  return {
    mode: "memory_fixture",
    async recognizeImage(input) {
      const name = (input.filename ?? "").toLowerCase();
      if (/(fail|error|timeout)/.test(name)) {
        return {
          outcome: "failed",
          candidates: [],
          topConfidence: null,
          ambiguityReason: "recognizer_unavailable",
          failureCode: "provider_error",
        };
      }
      if (/(blur|unknown|low)/.test(name)) {
        return {
          outcome: "low_confidence",
          candidates: [
            {
              label: "Uncertain handheld game console",
              suggested_q: "Nintendo Game Boy",
              category: "video_games",
              confidence: 0.41,
              requires_confirmation: true,
            },
          ],
          topConfidence: 0.41,
          ambiguityReason: "low_confidence",
        };
      }
      if (/(multi|ambiguous|variant)/.test(name)) {
        return {
          outcome: "matched",
          candidates: [
            {
              label: "Nintendo Game Boy Color (CGB-001) - Teal",
              suggested_q: "Nintendo Game Boy",
              category: "video_games",
              brand: "Nintendo",
              model: "Game Boy Color",
              variant: "Teal",
              suggested_condition: "good",
              confidence: 0.85,
              requires_confirmation: true,
            },
            {
              label: "Nintendo Game Boy Advance (AGB-001) - Glacier",
              suggested_q: "Nintendo Game Boy",
              category: "video_games",
              brand: "Nintendo",
              model: "Game Boy Advance",
              variant: "Glacier",
              suggested_condition: "good",
              confidence: 0.79,
              requires_confirmation: true,
            },
          ],
          topConfidence: 0.85,
          ambiguityReason: "multiple_versions",
        };
      }
      return {
        outcome: "matched",
        candidates: [
          {
            label: "Nintendo Game Boy DMG-01 Handheld Console",
            suggested_q: "Nintendo Game Boy",
            category: "video_games",
            brand: "Nintendo",
            model: "DMG-01",
            variant: "Original Gray",
            suggested_condition: "good",
            confidence: 0.89,
            requires_confirmation: true,
          },
        ],
        topConfidence: 0.89,
        ambiguityReason: null,
      };
    },
    async recognizeBarcode(input) {
      if (input.barcode === "045496730017") {
        return {
          outcome: "matched",
          candidates: [
            {
              label: "Nintendo Game Boy Pocket (MGB-001) - Silver",
              suggested_q: "Nintendo Game Boy",
              category: "video_games",
              brand: "Nintendo",
              model: "Game Boy Pocket",
              variant: "Silver",
              suggested_condition: "good",
              confidence: 0.91,
              requires_confirmation: true,
            },
            {
              label: "Nintendo Game Boy DMG-01 Original Gray",
              suggested_q: "Nintendo Game Boy",
              category: "video_games",
              brand: "Nintendo",
              model: "DMG-01",
              variant: "Original Gray",
              suggested_condition: "good",
              confidence: 0.86,
              requires_confirmation: true,
            },
          ],
          topConfidence: 0.91,
          ambiguityReason: "multiple_versions",
        };
      }
      if (input.barcode === "045496710118" || input.barcode === "0045496710118") {
        return {
          outcome: "matched",
          candidates: [
            {
              label: "Nintendo Game Boy DMG-01 Handheld",
              suggested_q: "Nintendo Game Boy",
              category: "video_games",
              brand: "Nintendo",
              model: "DMG-01",
              variant: "Standard US",
              suggested_condition: "good",
              confidence: 0.94,
              requires_confirmation: true,
            },
          ],
          topConfidence: 0.94,
          ambiguityReason: null,
        };
      }
      return {
        outcome: "low_confidence",
        candidates: [],
        topConfidence: 0.25,
        ambiguityReason: "unmatched_barcode",
      };
    },
  };
}

function serializeCandidate(row: CandidateRow) {
  return {
    id: row.id,
    rank: row.rank,
    label: row.label,
    suggested_q: row.suggested_q,
    category: row.category,
    brand: row.brand,
    model: row.model,
    variant: row.variant,
    suggested_condition: row.suggested_condition,
    confidence: Number(row.confidence),
    requires_confirmation: row.requires_confirmation,
  };
}

function serializeSession(row: SessionRow, candidates: CandidateRow[]) {
  return {
    id: row.id,
    input_kind: row.input_kind,
    status: row.status,
    barcode_value: row.barcode_value,
    barcode_format: row.barcode_format,
    detected_mime_type: row.detected_mime_type,
    image_sha256: row.image_sha256,
    image_width: row.image_width,
    image_height: row.image_height,
    image_bytes: row.image_bytes,
    original_had_exif: row.original_had_exif,
    exif_stripped: row.exif_stripped,
    confidence_threshold: Number(row.confidence_threshold),
    top_confidence: row.top_confidence === null ? null : Number(row.top_confidence),
    ambiguity_reason: row.ambiguity_reason,
    fallback_to_text: row.fallback_to_text,
    failure_code: row.failure_code,
    identification_credits_charged: row.identification_credits_charged,
    sold_lookup_credit_policy: "up_to_1_credit_on_explicit_claim" as const,
    confirmed_candidate_id: row.confirmed_candidate_id,
    confirmed_query_id: row.confirmed_query_id,
    confirmed_query_params: row.confirmed_query_params,
    confirmed_at: row.confirmed_at?.toISOString() ?? null,
    retention_expires_at: row.retention_expires_at.toISOString(),
    deleted_at: row.deleted_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    candidates: candidates.map(serializeCandidate),
  };
}

function decodeImageBase64(raw: string): { bytes: Buffer; dataUriMime?: string } {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 8_000_000)
    deny("invalid_parameter", 400, "Image payload size is invalid.");
  let base64Body = trimmed;
  let dataUriMime: string | undefined;
  const dataPrefix = /^data:([^;,]+);base64,(.+)$/i.exec(trimmed);
  if (dataPrefix?.[1] && dataPrefix[2]) {
    dataUriMime = dataPrefix[1].trim().toLowerCase();
    base64Body = dataPrefix[2].trim();
  }
  const normalized = base64Body.replace(/\s+/g, "");
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized))
    deny("invalid_parameter", 400, "Invalid base64 image encoding.");
  return { bytes: Buffer.from(normalized, "base64"), ...(dataUriMime ? { dataUriMime } : {}) };
}

/**
 * Domain service for image upload and barcode lookup identification prior to confirmed sold search.
 */
export class LookupInputService {
  readonly mediaStore: PrivateMediaStore;
  readonly recognizer: LookupRecognizer;
  readonly mode: "memory_fixture" | "disabled";
  readonly confidenceThreshold: number;

  constructor(
    readonly query: QueryService,
    options?: {
      mediaRoot?: string;
      recognizer?: LookupRecognizer;
      mode?: "memory_fixture" | "disabled";
      confidenceThreshold?: number;
    },
  ) {
    this.mediaStore = new PrivateMediaStore(
      options?.mediaRoot ?? join(dirname(query.media.root), "user-lookup-uploads"),
    );
    this.recognizer = options?.recognizer ?? createOfflineFixtureLookupRecognizer();
    this.mode = options?.mode ?? "memory_fixture";
    this.confidenceThreshold = options?.confidenceThreshold ?? DEFAULT_LOOKUP_CONFIDENCE_THRESHOLD;
  }

  private assertRecognizerActive() {
    if (this.mode !== "memory_fixture" || this.recognizer.mode !== "memory_fixture") {
      deny(
        "source_unavailable",
        503,
        "External image/barcode recognition providers remain disabled in offline mode.",
      );
    }
  }

  private async expireIfDueLocked(session: SessionRow, now: Date): Promise<SessionRow> {
    if (session.status === "deleted" || session.status === "expired") return session;
    if (session.retention_expires_at > now) return session;
    const oldKey = session.storage_key;
    const updated = await transaction(this.query.db, async (c) => {
      const row = (
        await c.query<SessionRow>(
          `UPDATE lookup_sessions
           SET status='expired',storage_key=NULL,updated_at=$2
           WHERE id=$1 AND status NOT IN ('deleted','expired')
           RETURNING *`,
          [session.id, now],
        )
      ).rows[0];
      if (!row || !oldKey) return row ?? session;
      const refs = (
        await c.query<{ n: number }>("SELECT count(*)::int AS n FROM lookup_sessions WHERE storage_key=$1", [
          oldKey,
        ])
      ).rows[0];
      if ((refs?.n ?? 0) === 0) await this.mediaStore.remove(oldKey).catch(() => {});
      return row;
    });
    return updated;
  }

  private classifyOutcome(recognition: LookupRecognitionResult) {
    const candidates = recognition.candidates.slice(0, 10);
    const computedTop = candidates.length > 0 ? Math.max(...candidates.map((c) => c.confidence)) : null;
    const topConfidence = recognition.topConfidence ?? computedTop;
    let status: SessionRow["status"] = "candidates_ready";
    let fallbackToText = false;
    let ambiguityReason = recognition.ambiguityReason ?? null;
    let failureCode: string | null = null;

    if (recognition.outcome === "failed") {
      status = "recognition_failed";
      fallbackToText = true;
      ambiguityReason = ambiguityReason ?? "recognizer_unavailable";
      failureCode = recognition.failureCode ?? "recognition_failed";
    } else if (
      recognition.outcome === "low_confidence" ||
      candidates.length === 0 ||
      topConfidence === null ||
      topConfidence < this.confidenceThreshold
    ) {
      status = "fallback_text_required";
      fallbackToText = true;
      ambiguityReason = ambiguityReason ?? "low_confidence";
    }

    return { candidates, topConfidence, status, fallbackToText, ambiguityReason, failureCode };
  }

  private async insertSession(
    identity: Identity,
    params: {
      inputKind: "image" | "barcode";
      barcodeValue: string | null;
      barcodeFormat: BarcodeFormat | null;
      detectedMimeType: string | null;
      imageSha256: string | null;
      imageWidth: number | null;
      imageHeight: number | null;
      imageBytes: number | null;
      originalHadExif: boolean;
      exifStripped: boolean;
      storageKey: string | null;
      retentionHours: number;
      recognition: LookupRecognitionResult;
    },
  ) {
    const classified = this.classifyOutcome(params.recognition);
    return transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity);
      const expiresAt = new Date(now.getTime() + params.retentionHours * 3600000);
      const session = (
        await c.query<SessionRow>(
          `INSERT INTO lookup_sessions(
             user_id,input_kind,status,barcode_value,barcode_format,
             detected_mime_type,image_sha256,image_width,image_height,image_bytes,
             original_had_exif,exif_stripped,storage_key,confidence_threshold,top_confidence,
             ambiguity_reason,fallback_to_text,failure_code,identification_credits_charged,
             retention_expires_at,created_at,updated_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,0,$19,$20,$20)
           RETURNING *`,
          [
            identity.userId,
            params.inputKind,
            classified.status,
            params.barcodeValue,
            params.barcodeFormat,
            params.detectedMimeType,
            params.imageSha256,
            params.imageWidth,
            params.imageHeight,
            params.imageBytes,
            params.originalHadExif,
            params.exifStripped,
            params.storageKey,
            this.confidenceThreshold,
            classified.topConfidence,
            classified.ambiguityReason,
            classified.fallbackToText,
            classified.failureCode,
            expiresAt,
            now,
          ],
        )
      ).rows[0];
      if (!session) throw new Error("lookup_session_insert_failed");

      const insertedCandidates: CandidateRow[] = [];
      for (let i = 0; i < classified.candidates.length; i++) {
        const cand = classified.candidates[i];
        if (!cand) continue;
        const row = (
          await c.query<CandidateRow>(
            `INSERT INTO lookup_candidates(
               session_id,user_id,rank,label,suggested_q,category,brand,model,variant,
               suggested_condition,confidence,requires_confirmation,created_at
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             RETURNING *`,
            [
              session.id,
              identity.userId,
              i + 1,
              cand.label.slice(0, 160),
              cand.suggested_q.slice(0, 120),
              cand.category ?? null,
              cand.brand ?? null,
              cand.model ?? null,
              cand.variant ?? null,
              cand.suggested_condition ?? null,
              cand.confidence,
              cand.requires_confirmation ?? true,
              now,
            ],
          )
        ).rows[0];
        if (row) insertedCandidates.push(row);
      }

      return serializeSession(session, insertedCandidates);
    });
  }

  async createImageLookup(
    identity: Identity,
    input: {
      image_base64: string;
      mime_type?: string;
      filename?: string;
      retention_hours?: number;
    },
  ) {
    this.assertRecognizerActive();
    await transaction(this.query.db, (c) => this.query.owner(c, identity));
    const retentionHours = input.retention_hours ?? DEFAULT_LOOKUP_RETENTION_HOURS;
    if (!Number.isSafeInteger(retentionHours) || retentionHours < 1 || retentionHours > 24)
      deny("invalid_parameter", 400, "retention_hours must be an integer between 1 and 24.");

    const decoded = decodeImageBase64(input.image_base64);
    if (decoded.dataUriMime && input.mime_type && decoded.dataUriMime !== input.mime_type.toLowerCase())
      deny("invalid_parameter", 400, "Image data URL MIME mismatches declared mime_type.");

    const sanitized = await sanitizeLookupImage(decoded.bytes, input.mime_type ?? decoded.dataUriMime);
    const stored = await this.mediaStore.put(identity.userId, sanitized.bytes);
    const recognition = await this.recognizer.recognizeImage({
      sha256: sanitized.sha256,
      filename: input.filename?.trim().slice(0, 120) || null,
      width: sanitized.width,
      height: sanitized.height,
    });

    try {
      return await this.insertSession(identity, {
        inputKind: "image",
        barcodeValue: null,
        barcodeFormat: null,
        detectedMimeType: sanitized.mimeType,
        imageSha256: sanitized.sha256,
        imageWidth: sanitized.width,
        imageHeight: sanitized.height,
        imageBytes: sanitized.bytes.byteLength,
        originalHadExif: sanitized.originalHadExif,
        exifStripped: sanitized.exifStripped,
        storageKey: stored.key,
        retentionHours,
        recognition,
      });
    } catch (error) {
      await this.mediaStore.remove(stored.key).catch(() => {});
      throw error;
    }
  }

  async createBarcodeLookup(
    identity: Identity,
    input: {
      barcode: string;
      format?: BarcodeFormat;
      retention_hours?: number;
    },
  ) {
    this.assertRecognizerActive();
    await transaction(this.query.db, (c) => this.query.owner(c, identity));
    const retentionHours = input.retention_hours ?? DEFAULT_LOOKUP_RETENTION_HOURS;
    if (!Number.isSafeInteger(retentionHours) || retentionHours < 1 || retentionHours > 24)
      deny("invalid_parameter", 400, "retention_hours must be an integer between 1 and 24.");

    const verified = validateBarcode(input.barcode, input.format);
    const recognition = await this.recognizer.recognizeBarcode({
      barcode: verified.value,
      format: verified.format,
    });

    return this.insertSession(identity, {
      inputKind: "barcode",
      barcodeValue: verified.value,
      barcodeFormat: verified.format,
      detectedMimeType: null,
      imageSha256: null,
      imageWidth: null,
      imageHeight: null,
      imageBytes: null,
      originalHadExif: false,
      exifStripped: false,
      storageKey: null,
      retentionHours,
      recognition,
    });
  }

  async listSessions(identity: Identity) {
    const rows = await transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity);
      const sessions = (
        await c.query<SessionRow>(
          "SELECT * FROM lookup_sessions WHERE user_id=$1 ORDER BY created_at DESC, id ASC LIMIT 50",
          [identity.userId],
        )
      ).rows;
      return { now, sessions };
    });

    const out = [];
    for (const s of rows.sessions) {
      const session = await this.expireIfDueLocked(s, rows.now);
      const candidates = (
        await this.query.db.query<CandidateRow>(
          "SELECT * FROM lookup_candidates WHERE session_id=$1 AND user_id=$2 ORDER BY rank ASC",
          [session.id, identity.userId],
        )
      ).rows;
      out.push(serializeSession(session, candidates));
    }
    return out;
  }

  async getSession(identity: Identity, id: string) {
    const loaded = await transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity);
      const row = (
        await c.query<SessionRow>("SELECT * FROM lookup_sessions WHERE id=$1 AND user_id=$2", [
          id,
          identity.userId,
        ])
      ).rows[0];
      if (!row) deny("not_found", 404, "Lookup session not found.");
      const candidates = (
        await c.query<CandidateRow>(
          "SELECT * FROM lookup_candidates WHERE session_id=$1 AND user_id=$2 ORDER BY rank ASC",
          [id, identity.userId],
        )
      ).rows;
      return { now, row, candidates };
    });
    const session = await this.expireIfDueLocked(loaded.row, loaded.now);
    return serializeSession(session, loaded.candidates);
  }

  async confirmSession(
    identity: Identity,
    id: string,
    input: {
      candidate_id?: string;
      override_q?: string;
      category?: string | null;
      brand?: string | null;
      model?: string | null;
      condition?: string | null;
      window_days?: 30 | 90 | 180 | 365;
      price_basis?: "item" | "item_plus_observed_shipping";
      limit?: number;
      allow_stale?: boolean;
      sale_format?: "fixed_price" | "auction" | "best_offer";
    },
    idempotencyKey: string,
  ) {
    const key = idempotencyKey.trim();
    if (!key || key.length > 128) deny("invalid_parameter", 400, "Idempotency-Key header is required.");

    const requestHash = createHash("sha256").update(canonicalJson(input)).digest("hex");

    const prepared = await transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity);
      const session = (
        await c.query<SessionRow>("SELECT * FROM lookup_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE", [
          id,
          identity.userId,
        ])
      ).rows[0];
      if (!session) deny("not_found", 404, "Lookup session not found.");

      const candidates = (
        await c.query<CandidateRow>(
          "SELECT * FROM lookup_candidates WHERE session_id=$1 AND user_id=$2 ORDER BY rank ASC",
          [id, identity.userId],
        )
      ).rows;

      if (session.status === "deleted")
        deny("lookup_session_deleted", 410, "Lookup upload session has been deleted.");
      if (session.status === "expired" || session.retention_expires_at <= now)
        return { kind: "expired" as const, session, now };

      if (session.status === "confirmed") {
        if (session.confirm_idempotency_key === key && session.confirm_request_hash === requestHash) {
          const existingQuery = session.confirmed_query_id
            ? (
                await c.query<{
                  id: string;
                  compute_status: "queued" | "running" | "completed";
                  expires_at: Date | null;
                }>("SELECT id,compute_status,expires_at FROM queries WHERE id=$1 AND user_id=$2", [
                  session.confirmed_query_id,
                  identity.userId,
                ])
              ).rows[0]
            : null;
          const existingJob = session.confirmed_query_id
            ? (
                await c.query<{ id: string }>("SELECT id FROM query_jobs WHERE query_id=$1 LIMIT 1", [
                  session.confirmed_query_id,
                ])
              ).rows[0]
            : null;
          return {
            kind: "replay" as const,
            session: serializeSession(session, candidates),
            submission: {
              queryId: session.confirmed_query_id as string,
              jobId: existingJob?.id ?? null,
              reused: true,
              status: existingQuery?.compute_status ?? "queued",
              expiresAt: existingQuery?.expires_at?.toISOString() ?? null,
            },
          };
        }
        deny(
          "idempotency_conflict",
          409,
          "Lookup session has already been confirmed with different parameters or key.",
        );
      }

      const candidate = input.candidate_id
        ? candidates.find((cRow) => cRow.id === input.candidate_id)
        : undefined;
      if (input.candidate_id && !candidate)
        deny("invalid_parameter", 400, "Selected candidate does not belong to this lookup session.");

      const overrideQ = input.override_q?.trim();
      if (session.fallback_to_text && !overrideQ)
        deny(
          "invalid_parameter",
          400,
          "Recognition confidence is insufficient or failed; provide explicit override_q text search parameters.",
        );
      if (!candidate && !overrideQ)
        deny("invalid_parameter", 400, "Select a candidate or provide explicit override_q text search.");

      const switchingQuery = Boolean(overrideQ && candidate && overrideQ !== candidate.suggested_q);
      const qText = overrideQ || candidate?.suggested_q || "";
      const category =
        input.category !== undefined ? input.category : switchingQuery ? null : (candidate?.category ?? null);
      const brand =
        input.brand !== undefined ? input.brand : switchingQuery ? null : (candidate?.brand ?? null);
      const model =
        input.model !== undefined ? input.model : switchingQuery ? null : (candidate?.model ?? null);
      const condition =
        input.condition !== undefined
          ? input.condition
          : switchingQuery
            ? null
            : (candidate?.suggested_condition ?? null);

      const rawQuery: Record<string, unknown> = {
        q: qText,
        marketplace: "ebay_us",
        window_days: input.window_days ?? 90,
        price_basis: input.price_basis ?? "item_plus_observed_shipping",
        limit: input.limit ?? 50,
        allow_stale: input.allow_stale ?? false,
      };
      if (category) rawQuery.category = category;
      if (brand) rawQuery.brand = brand;
      if (model) rawQuery.model = model;
      if (condition) rawQuery.condition = condition;
      if (input.sale_format) rawQuery.sale_format = input.sale_format;

      const soldQuery = normalizeQuery(queryParameters(rawQuery));
      return {
        kind: "submit" as const,
        candidateId: candidate?.id ?? null,
        rawQuery,
        soldQuery,
      };
    });

    if (prepared.kind === "expired") {
      await this.expireIfDueLocked(prepared.session, prepared.now);
      deny("lookup_session_expired", 410, "Lookup session expired before confirmation.");
    }
    if (prepared.kind === "replay") {
      return { session: prepared.session, submission: prepared.submission, replayed: true };
    }

    const submission = await this.query.submit(identity, prepared.soldQuery);

    return transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity);
      const current = (
        await c.query<SessionRow>("SELECT * FROM lookup_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE", [
          id,
          identity.userId,
        ])
      ).rows[0];
      if (!current) deny("not_found", 404, "Lookup session not found.");
      const candidates = (
        await c.query<CandidateRow>(
          "SELECT * FROM lookup_candidates WHERE session_id=$1 AND user_id=$2 ORDER BY rank ASC",
          [id, identity.userId],
        )
      ).rows;
      if (current.status === "confirmed") {
        if (current.confirm_idempotency_key === key && current.confirm_request_hash === requestHash) {
          return {
            session: serializeSession(current, candidates),
            submission,
            replayed: true,
          };
        }
        deny(
          "idempotency_conflict",
          409,
          "Lookup session has already been confirmed with different parameters or key.",
        );
      }

      const updated = (
        await c.query<SessionRow>(
          `UPDATE lookup_sessions
           SET status='confirmed',confirmed_candidate_id=$3,confirmed_query_id=$4,
               confirmed_query_params=$5,confirm_idempotency_key=$6,confirm_request_hash=$7,
               confirmed_at=$8,updated_at=$8
           WHERE id=$1 AND user_id=$2
           RETURNING *`,
          [
            id,
            identity.userId,
            prepared.candidateId,
            submission.queryId,
            JSON.stringify(prepared.rawQuery),
            key,
            requestHash,
            now,
          ],
        )
      ).rows[0];
      if (!updated) throw new Error("lookup_session_confirm_failed");
      return { session: serializeSession(updated, candidates), submission, replayed: false };
    });
  }

  async deleteSession(identity: Identity, id: string) {
    const removal = await transaction(this.query.db, async (c) => {
      const now = await this.query.owner(c, identity);
      const existing = (
        await c.query<SessionRow>("SELECT * FROM lookup_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE", [
          id,
          identity.userId,
        ])
      ).rows[0];
      if (!existing) deny("not_found", 404, "Lookup session not found.");
      if (existing.status === "deleted") return { storageKey: null };

      await c.query(
        `UPDATE lookup_sessions
         SET status='deleted',storage_key=NULL,deleted_at=coalesce(deleted_at,$2),updated_at=$2
         WHERE id=$1 AND user_id=$3`,
        [id, now, identity.userId],
      );
      if (!existing.storage_key) return { storageKey: null };
      const refs = (
        await c.query<{ n: number }>("SELECT count(*)::int AS n FROM lookup_sessions WHERE storage_key=$1", [
          existing.storage_key,
        ])
      ).rows[0];
      return { storageKey: (refs?.n ?? 0) === 0 ? existing.storage_key : null };
    });

    if (removal.storageKey) {
      await this.mediaStore.remove(removal.storageKey);
    }
  }

  async sweepExpiredUploads(overrideNow?: Date) {
    const expiredKeys = await transaction(this.query.db, async (c) => {
      const now = overrideNow ?? (await this.query.now(c));
      const rows = (
        await c.query<{ id: string; storage_key: string | null }>(
          `SELECT id,storage_key FROM lookup_sessions
           WHERE retention_expires_at<=$1 AND status NOT IN ('deleted','expired')
           FOR UPDATE`,
          [now],
        )
      ).rows;
      if (rows.length) {
        await c.query(
          `UPDATE lookup_sessions
           SET status='expired',storage_key=NULL,updated_at=$2
           WHERE id = ANY($1::uuid[])`,
          [rows.map((r) => r.id), now],
        );
      }
      const uniqueKeys = [...new Set(rows.map((r) => r.storage_key).filter((k): k is string => Boolean(k)))];
      const toRemove: string[] = [];
      for (const storageKey of uniqueKeys) {
        const refs = (
          await c.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM lookup_sessions WHERE storage_key=$1",
            [storageKey],
          )
        ).rows[0];
        if ((refs?.n ?? 0) === 0) toRemove.push(storageKey);
      }
      return { expiredCount: rows.length, keys: toRemove };
    });

    for (const key of expiredKeys.keys) {
      await this.mediaStore.remove(key).catch(() => {});
    }
    return { expiredCount: expiredKeys.expiredCount, filesRemoved: expiredKeys.keys.length };
  }
}
