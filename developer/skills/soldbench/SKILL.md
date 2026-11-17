---
name: soldbench
description: Build server-side clients for SoldBench sold-price research REST and MCP APIs, including asynchronous queries, explicit credit claims, verified prices, and controlled evidence. Use for SoldBench integrations, not for collecting eBay data or configuring a payment subscription.
---

# SoldBench

Read [API reference](references/api-reference.md) before choosing endpoints and [examples](references/examples.md) for working client flows. The complete frozen schema is `/openapi.json`; some schema operations remain contract-only. Current engineering uses synthetic offline fixtures. Do not describe them as live market evidence or imply that the production targets are deployed.

Use `SOLDBENCH_API_KEY` on the server only. Base URL defaults to `http://127.0.0.1:3000/v1` for local development; the future deployment target is `https://api.soldbench.com/v1`. Never log credentials or send them to a URL returned by the service. Construct known owner-resource paths using validated UUIDs, reject redirects, and bound timeouts/retries.

A search submits work without charging. Poll the job, then GET the result. A `result_not_claimed` response requires explicit caller agreement before POST claim with one stable `Idempotency-Key` (16–128 printable ASCII characters). At most one credit is charged for an effective query. Retry an uncertain claim with the same key or GET the result; do not start another search to compensate. Polling, errors, low samples, stale results, and already delivered results are free. Same-owner canonical query reuse is 10 minutes; language changes do not create another charged query.

Money is USD integer cents; unknown is null. Center estimates are null below 8 verified comparable samples. Statistics use the complete snapshot, not the number of displayed comps. Unknown Best Offer accepted prices are excluded from default actual-price statistics. Samples are observations, not total marketplace sales. Preserve quality, coverage, candidate hash, versions, freshness, and synthetic indicators when presenting results.

For MCP use only `sold_search` and `sold_stats`. `sold_search` requires an explicit action: search, status, result, or claim. `sold_stats` reads an existing readable query; it never silently creates or claims one. MCP displays at most 20 comps without changing the shared query identity or full statistics. An `isError` tool result is a failure even if HTTP is 200.

Read-only documentation and Skill discovery do not authorize spending credits. This Skill neither grants source access nor configures the user's MCP host automatically. Current data rights and key revocations are checked on every read, including images and exports.
