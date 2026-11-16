export const quarantineReasons = [
  "page_content_type_invalid",
  "page_structure_invalid",
  "pagination_loop",
  "event_identity_conflict",
  "page_event_conflict",
  "page_evidence_invalid",
] as const;
export type QuarantineReason = (typeof quarantineReasons)[number];
/** Contains only controlled diagnostics, never raw response text or URLs. */
export class CollectorIntegrityError extends Error {
  constructor(
    readonly reason: QuarantineReason,
    readonly affectedEventId?: string,
  ) {
    super(reason);
    this.name = "CollectorIntegrityError";
  }
}
