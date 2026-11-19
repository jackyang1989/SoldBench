# Integration tools and account security

Start with the [TypeScript example](/examples/sold.ts), [Python example](/examples/sold.py), or [cURL example](/examples/sold.sh). Read their [quickstart](/docs/en/quickstart) for startup and explicit claim. On failure, keep the query ID, job ID, request ID and claim key until you can determine the original outcome. Use the [API contract](/openapi.json) for generated clients.

## Account security

From [Account security](/account/security), enroll a time-based authenticator, verify the code, and store the one-time recovery codes privately. Recent authentication may be required for sensitive actions. Keep browser session credentials separate from server-side API keys.

## Agents and MCP

Use the [Agent Skill](/.well-known/skills/soldbench/SKILL.md) to teach a coding agent the integration contract. Use [MCP](/docs/en/mcp) to give an authorized assistant tools to search and read results. Confirm any potentially chargeable claim before invoking it. See the [developer changelog](/changelog) for implementation changes.
