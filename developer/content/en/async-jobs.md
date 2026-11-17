# Asynchronous delivery and claims

Search returns 202. Poll GET /v1/jobs/{job_id} with bounded waits. queued/running are not final; failed/cancelled/expired are final failures. completed does not imply settlement. GET /v1/sold/{query_id} returns free/delivered results; 409 result_not_claimed requires explicit consent before POST /v1/sold/{query_id}/claim with one stable Idempotency-Key. A claim costs at most one credit. Retry an uncertain claim with that same key or GET the existing result. Do not submit a second search as compensation. Job GET and repeated result GET are free. Results expire independently from job success; preserve expires_at.

Related: [Quickstart](/docs/en/quickstart), [OpenAPI](/openapi.json), [Skill](/.well-known/skills/soldbench/SKILL.md).
