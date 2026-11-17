# Sold search and coverage

GET /v1/sold?q=Nintendo%20Switch%20OLED returns 202 with query_id and job_id. US eBay / USD is the only implemented search market. limit defaults to 50 (1–200); all center statistics use the complete snapshot. Filter strong model/capacity/version attributes before comparing. Changing limit changes canonical parameters; MCP's display cap does not. Missing fields are not fabricated. History coverage reflects retained permitted observations; a 90-day requested window is not 90 days of guaranteed coverage or all market sales. Three-year history and other platforms are not currently available.

Related: [Quickstart](/docs/en/quickstart), [OpenAPI](/openapi.json), [Skill](/.well-known/skills/soldbench/SKILL.md).
