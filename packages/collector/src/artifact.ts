import { canonicalJson, instant } from "@soldbench/core";
import { digest, type FixtureResponse, FixtureTransport, parseFixturePage } from "./fixture.ts";
import { type HtmlProfile, parseHtmlPage, validateHtmlProfile } from "./html.ts";

export type FixtureArtifact = {
  schema: "soldbench.collector-artifact.v1";
  synthetic: true;
  sourceId: string;
  jobId: string;
  queryHash: string;
  asOf: string;
  htmlProfile?: HtmlProfile;
  frames: Array<{
    key: string;
    responses: Array<{
      status: number;
      contentType: string;
      bytesBase64: string;
      retryAfterSeconds?: number;
    }>;
  }>;
};
export function createFixtureArtifact(
  binding: Omit<FixtureArtifact, "schema" | "synthetic" | "frames">,
  frames: ReadonlyMap<string, readonly FixtureResponse[]>,
): FixtureArtifact {
  return {
    schema: "soldbench.collector-artifact.v1",
    synthetic: true,
    ...binding,
    frames: [...frames].map(([key, responses]) => ({
      key,
      responses: responses.map((response) => ({
        status: response.status,
        contentType: response.contentType,
        bytesBase64: Buffer.from(response.bytes).toString("base64"),
        ...(response.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: response.retryAfterSeconds }),
      })),
    })),
  };
}
export function loadFixtureArtifact(bytes: Uint8Array) {
  if (bytes.byteLength > 16 * 1024 * 1024) throw new Error("fixture_artifact_too_large");
  let artifact: FixtureArtifact;
  try {
    artifact = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("fixture_artifact_invalid_json");
  }
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (
    artifact?.schema !== "soldbench.collector-artifact.v1" ||
    artifact.synthetic !== true ||
    !uuid.test(artifact.sourceId) ||
    !uuid.test(artifact.jobId) ||
    !/^[a-f0-9]{64}$/.test(artifact.queryHash) ||
    !Array.isArray(artifact.frames) ||
    artifact.frames.length > 1000
  )
    throw new Error("fixture_artifact_invalid_shape");
  instant(artifact.asOf);
  const profile = artifact.htmlProfile === undefined ? undefined : validateHtmlProfile(artifact.htmlProfile);
  const frames = new Map<string, FixtureResponse[]>(),
    pageHashes = new Map<string, Set<string>>();
  for (const frame of artifact.frames) {
    if (
      !frame ||
      typeof frame.key !== "string" ||
      !/^(page:|image:)/.test(frame.key) ||
      frame.key.length > 2200 ||
      frames.has(frame.key) ||
      !Array.isArray(frame.responses) ||
      frame.responses.length < 1 ||
      frame.responses.length > 16
    )
      throw new Error("fixture_artifact_frame_invalid");
    const responses: FixtureResponse[] = [];
    for (const row of frame.responses) {
      if (
        !row ||
        !Number.isSafeInteger(row.status) ||
        row.status < 100 ||
        row.status > 599 ||
        typeof row.contentType !== "string" ||
        row.contentType.length > 160 ||
        typeof row.bytesBase64 !== "string" ||
        (row.retryAfterSeconds !== undefined &&
          (!Number.isSafeInteger(row.retryAfterSeconds) ||
            row.retryAfterSeconds < 1 ||
            row.retryAfterSeconds > 86400))
      )
        throw new Error("fixture_artifact_response_invalid");
      const raw = Buffer.from(row.bytesBase64, "base64"),
        max = frame.key.startsWith("page:") ? 1024 * 1024 : 5 * 1024 * 1024;
      if (raw.length > max || raw.toString("base64") !== row.bytesBase64)
        throw new Error("fixture_artifact_response_bytes_invalid");
      responses.push({
        status: row.status,
        contentType: row.contentType,
        bytes: raw,
        ...(row.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: row.retryAfterSeconds }),
      });
      if (
        frame.key.startsWith("page:") &&
        row.status === 200 &&
        row.contentType.split(";")[0]?.trim().toLowerCase() === (profile ? "text/html" : "application/json")
      ) {
        const cursor = frame.key.slice(5);
        const binding = {
          sourceId: artifact.sourceId,
          queryHash: artifact.queryHash,
          cursor,
          asOf: artifact.asOf,
        };
        if (profile) parseHtmlPage(raw, binding, profile);
        else parseFixturePage(raw, binding);
        const hashes = pageHashes.get(cursor) ?? new Set<string>();
        hashes.add(digest(raw));
        pageHashes.set(cursor, hashes);
      }
    }
    frames.set(frame.key, responses);
  }
  return {
    artifact,
    hash: digest(canonicalJson(artifact)),
    pageHashes,
    transport: new FixtureTransport(frames),
  };
}
