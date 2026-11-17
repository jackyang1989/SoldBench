# Errors, retries and audit

Use error.code, request_id and details. Honor Retry-After on 429; temporary 5xx/network failures allow a bounded retry. Stop on 400/401/402/403 and quota_exceeded. Stale requires explicit acceptance, is free and never passes as fresh. Expired or revoked data stays unavailable. SDK tool errors may use HTTP 200 with isError=true.

GET /v1/requests is owner-only, requires usage:read, and exposes 30-day request metadata, operation/channel, error code, actual credits and charge/ledger references. It excludes raw search strings, tokens, bodies and IPs. A successful funds transaction stays successful if a later audit write fails; inspect ledger and re-fetch instead of making another charge.

Related: [Quickstart](/docs/en/quickstart), [OpenAPI](/openapi.json), [Skill](/.well-known/skills/soldbench/SKILL.md).
