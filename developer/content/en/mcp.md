# MCP and Agent Skill

POST /mcp uses stateless Streamable HTTP with Bearer API key. Supports protocol 2026-07-28 and legacy 2025-11-25. No Cookie, OAuth or persistent subscription streams. Host must match configured origin; a supplied Origin must match exactly. Request <=128 KiB; JSON-RPC batches are disabled.

sold_search actions: search with query, status with job_id, result with query_id, claim with query_id and idempotency_key, and marketplace_preview with `{marketplace:"mercari_us", q}`. Claim requires explicit consent. sold_stats reads existing readable snapshots only. MCP shows <=20 comps; full statistics and REST query identity remain unchanged. Active listings in marketplace_preview stay isolated in active_listings and never enter sold_stats. Check structuredContent and isError, actual credits_charged and synthetic indicators.

Skill index: /.well-known/skills/index.json. Read SKILL.md and linked references before writing clients. Skill teaches integration; MCP executes tools. Neither implies source rights or permits silent spending. Configure any host explicitly using its own supported secret storage. Production target https://soldbench.com/mcp has not been deployed; local endpoint http://127.0.0.1:3000/mcp is the engineering endpoint.

Related: [Quickstart](/docs/en/quickstart), [OpenAPI](/openapi.json), [Skill](/.well-known/skills/soldbench/SKILL.md).
