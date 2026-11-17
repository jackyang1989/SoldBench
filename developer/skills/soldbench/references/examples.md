# Running examples

From the repository, use Node 22.18+, Python 3 and curl. `npm run developer:demo` prepares only a local synthetic account/key and permitted synthetic collector evidence; Import the same private file before starting the API and query worker with `npm run dev`. The demo prints a private environment-file path, never its key. Source that file in a private shell. Do not commit it.

```sh
npm run db:start
npm run developer:demo
set -a
. .local/developer-demo.env
set +a
npm run dev
# Import the same private file in a second private shell before running a client.
node developer/examples/sold.ts --claim
python3 developer/examples/sold.py --claim
sh developer/examples/sold.sh --claim
```

Default keyword: Nintendo Switch OLED. Omit --claim to stop at result_not_claimed rather than consent to settlement. --claim explicitly permits up to one synthetic credit; each client uses one stable random idempotency key for all retries. These examples never print keys and never report synthetic values as verified live market prices. Example files are served at /examples/sold.ts, /examples/sold.py and /examples/sold.sh.

MCP actions, in order:

```json
{"name":"sold_search","arguments":{"action":"search","query":{"q":"Nintendo Switch OLED"}}}
```

After polling sold_search(action=status,job_id) to completed, try action=result. If result_not_claimed, get caller consent, then action=claim with the returned query_id and one stable idempotency_key. Later sold_stats(query_id) and sold_search(action=result,query_id) are free. Do not use a new claim key on an uncertain network response.
