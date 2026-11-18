# Running examples

From the repository, use Node 22.18 or later within 22.x, Python 3 and curl. `npm run developer:demo` prepares only a local synthetic account/key and permitted synthetic collector evidence. Import the same private file before starting the API and query worker with `npm run dev`. The demo prints a private environment-file path, never its key. Source that file in a private shell. Do not commit it.

```sh
npm run db:start
npm run developer:demo
set -a
. .local/developer-demo.env
set +a
npm run dev
```

In a second private shell in the same repository, keep the same account, base and keyword, and run the three clients in one ten-minute reuse window.

```sh
set -a
. .local/developer-demo.env
set +a
node developer/examples/sold.ts --claim
python3 developer/examples/sold.py --claim
sh developer/examples/sold.sh --claim
```

Default keyword: Nintendo Switch OLED. On a fresh unpaid result, omitting --claim makes the examples stop with claim_required after the API returns result_not_claimed. Already delivered results can be read without --claim. --claim explicitly permits up to one synthetic credit; each client uses one stable random idempotency key for all retries. These examples never print keys and never report synthetic values as verified live market prices. Example files are served at /examples/sold.ts, /examples/sold.py and /examples/sold.sh.

MCP actions, in order:

```json
{"name":"sold_search","arguments":{"action":"search","query":{"q":"Nintendo Switch OLED"}}}
```

After polling sold_search(action=status,job_id) to completed, try action=result. If result_not_claimed, get caller consent, then action=claim with the returned query_id and one stable idempotency_key. Later sold_stats(query_id) and sold_search(action=result,query_id) are free. Do not use a new claim key on an uncertain network response.

Compare query_id and sample count across all three commands. With a new account, sufficient fresh samples and identical canonical input within ten minutes, expect one actual charge followed by two free reads. The demo default has 8 fixture records. The integration regression uses a separate 58-price fixture. A client's claim key is stable within one run. For recovery after a process restart, the integrating application must persist the original query ID, job ID, explicit consent and claim key, then GET the original result before retrying. Re-running a new search beyond the reuse window can create another billable result.

If a poll receives 429, honor Retry-After. The examples limit each temporary failure to three attempts and stop when the server asks to wait more than 30 seconds. A 503 for unavailable source coverage should be surfaced with request_id. Use an existing permitted historical snapshot only when the user asks for history. 402 leaves the ready result available to claim until expires_at. Use GET /v1/usage and GET /v1/requests to reconcile the result and actual credits.
