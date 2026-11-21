/** SQL projection for a collector job aliased as j, using a database or bound cutoff. */
export function artifactRetentionFields(cutoff: "now()" | "$2") {
  return `
    ((j.status IN ('queued','retry','running') AND
      (j.expires_at>${cutoff} OR (j.status='running' AND j.lease_until>${cutoff})))
      OR EXISTS(SELECT 1 FROM collector_image_jobs t WHERE t.source_id=j.source_id AND t.parent_job_id=j.id
          AND ((t.status='retry' AND t.expires_at>${cutoff}) OR (t.status='running' AND t.lease_until>${cutoff}))))
      AS pending_work,
    EXISTS(SELECT 1 FROM source_observations o WHERE o.source_id=j.source_id
      AND o.collector_run_id=j.collector_run_id AND o.retention_until>${cutoff}) AS current_evidence,
    (EXISTS(SELECT 1 FROM source_observations o WHERE o.source_id=j.source_id
      AND o.collector_run_id=j.collector_run_id)
     AND NOT EXISTS(SELECT 1 FROM source_observations o WHERE o.source_id=j.source_id
      AND o.collector_run_id=j.collector_run_id AND o.retention_until IS NULL)) AS known_evidence`;
}
