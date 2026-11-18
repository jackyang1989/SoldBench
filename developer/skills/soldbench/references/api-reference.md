# SoldBench client reference

Local API base: `http://127.0.0.1:3000/v1`. Production target (not deployed): `https://api.soldbench.com/v1`. Bearer API key; `sold:read` for search/results/research, `jobs:read` for job status, `usage:read` for usage/request logs. Never combine Cookie and Bearer. Use the frozen `/openapi.json` for precise JSON schemas.

Implemented local routes:

| Method | Path relative to /v1 | Behavior |
|---|---|---|
| GET | /sold?q=... | 202; data.query_id, job_id, status. No charge. limit 1–200, default 50. |
| GET | /jobs/{id} | data.status queued/running/completed/failed/cancelled/expired; no result before claim. |
| POST | /jobs/{id}/cancel | Send the current job version in JSON and a stable Idempotency-Key. The local handler returns 204 with no body. On a lost reply or 409, GET the same job; the frozen 200 JobResponse and same-key replay are pending. |
| GET | /sold/{id} | Delivered/free result, or 409 result_not_claimed. The local adapter ignores the frozen sort parameter. |
| POST | /sold/{id}/claim | Explicit settlement; Idempotency-Key required. At most 1 credit. |
| GET | /sold/{id}/calculation-inputs | Complete permitted pricing input rows, independent of display limit. A date-only sale can appear as a UTC midnight placeholder without its precision. Read permitted comparable detail for the original date and zone before time analysis. |
| GET | /sold/{id}/diagnostics | Owner-only signed cursor pagination, size 1–100; decisions and withheld count. |
| GET | /sold/{id}/comps/{event_id} | Current permitted detail fields, missing/withheld states, controlled primary image. |
| POST | /sold/{id}/export | JSON body format=json/csv, view=authoritative/adjusted, optional excluded_sale_event_ids. Complete allowed inputs, 2000 rows/5 MiB maximum. |
| GET | /usage | Current allowance and ledger-derived usage. |
| GET | /requests | Owner logs, channel/operation/status filters, page_size and signed cursor. error_code is returned in rows. Readable for 30 days. |
| GET | /media/{image_id} | Private controlled image; rechecks current rights. No upstream image URL. |

Search supports q, marketplace=ebay_us, category, brand, model, condition, window_days, price_basis, limit, allow_stale, min_price_cents, max_price_cents, sale_format and attribute filters. In this local build, use category=cards_graded with attr_grading_company and attr_grade as separate parameters. The corresponding JSON attributes are grading_company and grade. Some frozen OpenAPI aliases differ from the runtime allowlist. GET /categories and GET /data-status remain contract-only. Use an owner session for query history under the frozen contract. Do not mix countries, currencies, capacities or models into a comparable estimate.

Result: data.stats.median_cents / p25_cents / p75_cents / n_price_verified; data.quality; data.supplemental_stats; data.comps. meta carries actual credits_charged, request_id, freshness, candidate hash and engine/parser/billing versions. Absence/null is not zero. A displayed reference price is not a verified accepted offer.

Errors use error.code/message/request_id/details. Retry 429 respecting Retry-After; retry temporary 5xx/network failures a bounded number of times. Do not blindly retry 400/401/402/403, insufficient_credits, quota_exceeded or forbidden. An unclaimed result is a state transition, not a generic retry. Stale requires allow_stale=true and is free; expired data cannot be sold as current.

MCP endpoint `/mcp` is outside /v1 and requires Bearer only. Stateless Streamable HTTP supports protocol 2026-07-28 and legacy 2025-11-25. No Cookie, OAuth discovery or persistent SSE subscription. One JSON-RPC request per HTTP request, <=128 KiB; reject batches. sold_search arguments: {action:"search",query:{q:"..."}}, {action:"status",job_id}, {action:"result",query_id}, or {action:"claim",query_id,idempotency_key}. sold_stats: {query_id}. Tools return text plus structuredContent; inspect isError before using it.

Check `quality.comparison_scope` and warning code `mixed_models` before presenting a model-specific price. Offer the returned model options as explicit filters where available. The aggregate is still based on the observed sample and a single model may contain multiple configurations.
