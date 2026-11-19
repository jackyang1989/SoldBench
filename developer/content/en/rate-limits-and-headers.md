# Rate limits and headers

Limits belong to the account. Requests through additional API keys do not create additional allowances. Upon `429`, wait at least the `Retry-After` number of seconds before a bounded retry. Keep at most one poll active per job and stop on a terminal result. A rate limit and a credit balance are separate checks.

## Request and response tracking

- Send `Authorization: Bearer` only from a trusted server with your API key. Never include a key in sample URLs or screenshots.
- Use the same `Idempotency-Key` for a repeated claim with the same query ID. Changes to the desired operation need a new key; on an ambiguous result read the original query or job first.
- Use `X-Request-ID` to correlate a request with the owner request log or support. Private response caching follows the route’s `Cache-Control` header.
- `meta.credits_charged` reports the charge for this response. `meta.query_total_credits_charged` records the current query’s charge. Reopening a delivered authorized result is free.

See [async jobs](/docs/en/async-jobs), [error recovery](/docs/en/errors-and-retries), and [service status](/status).
