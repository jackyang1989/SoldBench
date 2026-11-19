# SoldBench engineering changelog

## 2026-11-19 — bilingual publication and offline payment recovery

The local operator content studio can review, publish, restore and withdraw bilingual announcements, FAQs and guides. Separate administrator sessions author and approve revisions. The published version is stored in PostgreSQL and shared across both languages. OpenAPI 1.19 also documents the fixture-only operator command for late payment confirmation. It preserves the original verified event and uses the existing settlement transaction and audit rules.

## 2026-11-19 — complete-snapshot ordering and sale date evidence

In the offline build, GET for an existing result accepts `sort=price_asc` and other OpenAPI orderings. It orders the complete permitted snapshot before the requested limit without changing the candidate hash, stats or charge. `sold_date` carries the frozen date precision in comp responses, calculation inputs and JSON exports. CSV appends `sold_date_timezone`. Consumers can keep reading legacy fields and use `sold_date` for calculations involving time. Job cancellation returns HTTP 200 with a JobResponse, using the original version and Idempotency-Key for replay within 24 hours. Research history requires the owner's browser session. The REST namespace remains `/v1`.

## 2026-11-18 — observed search context

OpenAPI 1.16 adds source-reported search counts with source timestamp, units and estimate status. Grouped observed shipping, seller aggregates and reported counts each require their own current field permission. Source-reported counts never contribute to verified samples or market coverage.

## 2026-11-18 — model scope on price samples

OpenAPI 1.15 adds optional structured model coverage to private search quality and research exports. Public views can show a generic mixed-model warning without the underlying labels. Existing statistics and charges keep their original meaning.

## 2026-11-18 — explicit comparable filters

OpenAPI 1.14 clarifies how explicit brand, model, category, condition and category attributes are checked. Missing and conflicting same-observation evidence exclude records from comparable prices. Detail can expose separately permitted plain-text description and defect notes. Resubmit legacy filtered searches that return a snapshot version conflict. Previously billed searches retain the ten-minute reuse guard.

## 2026-11-18 — offline payment lifecycle

Opt-in Stripe and PayPal fixtures support durable checkout intents, signed receipts, confirmation, subscription cycles, cancellation, refund/recovery and owner billing. OpenAPI 1.10 adds synthetic checkout status and versioned subscription cancellation. Real provider accounts remain inactive.

## 2026-11-17 — offline MCP and developer delivery

Stateless MCP shares query, claim, scope and source-right rules with REST. Official SDK client and raw HTTP integration tests cover engineering behavior; production host/client acceptance remains pending. Bilingual Markdown docs, local docs search, static Skill discovery, OpenAPI JSON, collection and runnable server-side examples use synthetic data only. No visual redesign or production deployment is claimed.

Research backend provides per-field evidence, full-snapshot diagnostics, adjusted/authoritative export and owner request auditing. Collector is fixture-only, supports controlled primary-image evidence, bounded loopback HTTP acquisition and maintenance. Actual eBay access and stable production collection are not validated.
