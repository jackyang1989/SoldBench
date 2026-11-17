# Authentication and keys

Send Authorization: Bearer with a server-side SOLDBENCH_API_KEY. Never expose it in browser JavaScript, URLs, screenshots or logs. sold:read covers queries/results/research; jobs:read covers polling; usage:read covers usage and request logs. Owner isolation applies to every query and job. Revoke compromised keys; creation/rotation reveals the new key only once. Replaying rotation returns metadata without revealing it again. Do not mix Cookie and Bearer. Web writes use same-origin CSRF; MCP accepts no Cookie. See OpenAPI for implemented auth endpoints and recent-auth/TOTP requirements.

Related: [Quickstart](/docs/en/quickstart), [OpenAPI](/openapi.json), [Skill](/.well-known/skills/soldbench/SKILL.md).
