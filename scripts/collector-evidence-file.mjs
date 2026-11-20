import { digest, COLLECTOR_RUN_EVIDENCE_SCHEMA as schema } from "@soldbench/collector";
import { publishCollectorFile, readBoundedFile } from "./collector-fixture-file.mjs";

const limit = 8 * 1024 * 1024;

export async function exportEvidence(path, document) {
  const bytes = Buffer.from(JSON.stringify(document));
  if (bytes.length > limit) throw new Error("collector_evidence_size_limit");
  await publishCollectorFile(path, bytes);
  return { schema, exported: true, sha256: digest(bytes), slots: document.slots.length };
}

export async function verifyEvidence(path, expected, { sourceId, from, until }) {
  const bytes = await readBoundedFile(
    path,
    limit,
    "invalid_collector_evidence_file",
    "collector_evidence_file_changed",
  );
  if (digest(bytes) !== expected) throw new Error("collector_evidence_digest_mismatch");
  const document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (
    document?.schema !== schema ||
    document.mode !== "offline_fixture" ||
    document.onlineVerified !== false ||
    document.externalNetworkRequests !== 0 ||
    document.source_id !== sourceId ||
    document.window?.from !== `${from}T00:00:00.000Z` ||
    document.window?.until !== `${until}T00:00:00.000Z` ||
    !Array.isArray(document.slots)
  )
    throw new Error("collector_evidence_scope_mismatch");
  return { schema, verified: true, sha256: expected, slots: document.slots.length };
}
