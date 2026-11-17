# Quickstart

This is a local offline engineering build. No live source or payment access is enabled. Run `npm run db:start` and `npm run developer:demo` in the repository. Export the variables from `.local/developer-demo.env` before starting `npm run dev`. Import the same file in a separate private shell, then run `node developer/examples/sold.ts --claim` (or Python/curl equivalents). The synthetic account cannot log in as a real customer.

The examples submit a search, poll a job, explicitly claim when allowed, and print median cents and verified sample size. Omit --claim to inspect the unpaid state. API base is http://127.0.0.1:3000/v1; soldbench.com / api.soldbench.com are future deployment targets. A 202 is queued work, not a charged successful price lookup. Read authentication, async-jobs and pricing-evidence before production integration.

Related: [Quickstart](/docs/en/quickstart), [OpenAPI](/openapi.json), [Skill](/.well-known/skills/soldbench/SKILL.md).
