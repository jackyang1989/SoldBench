# API reference

Use the [OpenAPI document](/openapi.json) for parameters, response schemas, and stable error codes. Compare it with [local route status](/docs/implementation-status.json) to distinguish registered routes from planned operations. Route registration alone does not establish that a feature is enabled or verified. The [Postman collection](/soldbench.postman.json) leaves the API key empty and has no scripts that claim results.

## Research calls

- Submit a canonical search with `GET /v1/sold`, then poll the returned job. For eligible results, show the maximum fee and obtain confirmation before `POST /v1/sold/{id}/claim`.
- Fetch delivered results with `GET /v1/sold/{id}`. Use `GET /v1/sold/{id}/comps/{event_id}` for individual evidence and the supplied relative `/v1/media/{image_id}` URL for an authorized image.
- Use `GET /v1/sold/{id}/diagnostics` for exclusion reasons, `GET /v1/sold/{id}/calculation-inputs` for permitted full-sample inputs, or `POST /v1/sold/{id}/export` for the delivered snapshot.
- Check your requests with `GET /v1/requests` and your credit buckets and ledger with `GET /v1/usage`.

Explore the [browser Playground](/playground) or review [errors and safe retries](/docs/en/errors-and-retries) before integrating.
