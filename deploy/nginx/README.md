# Ante Up rate-limit response

The reviewed site uses an IP-keyed `ante_up_api` zone at 3 requests/second,
`burst=12 nodelay`, and `limit_req_status 429` for `/api/`. Keep that policy.
`ante-up-rate-limit-response.conf` changes only the rejection response to a
non-cacheable JSON `HTTP_RATE_LIMITED` error and `Retry-After: 5`. Five seconds
allows the current 12-request excess to drain at 3 requests/second. Reassess
that delay if the independently managed rate policy changes.

This edge error is distinct from API `RPC_RATE_LIMITED`, which returns 503.
Keep `proxy_intercept_errors` off: an upstream 429 must retain its original
body and retry interval. The real nginx fixture verifies that separation.

## Isolated validation

With Docker and an already installed Nginx Proxy Manager image:

```sh
python3 scripts/test-nginx-rate-response.py jc21/nginx-proxy-manager
```

This starts one ephemeral nginx container with `--network none`, no published
ports, no production mounts, a read-only filesystem, uid 1000 and no Linux
capabilities. Its only mount is the generated fixture directory. The fixture
uses the existing 3r/s and burst12 policy, verifies the previous HTML/no-header
response and the new JSON/5-second response, waits for recovery to 200, and
checks that an upstream 429 with a different body/Retry-After stays unchanged.
It never sends a request to the public site and never pulls an image. Reports
remain under `.runtime/nginx-rate-fixture` and only its own container is stopped.

## Reviewed integration procedure (not an automatic rollout)

Only the integration owner applies this after PR review:

1. Re-read the current **Ante Up only** site `/data/nginx/proxy_host/ante-up.conf`
   inside container `npm`. Preserve its bytes, SHA-256, owner and mode. Preserve
   any existing destination include before replacing it. The inspected baseline
   had one HTTPS server, two `server_name ante-up.fun;` directives (HTTP/HTTPS),
   and no `@ante_up_rate_limited` handler. Do not use a global text replacement
   across both servers or across other sites.
2. Copy the reviewed response snippet to
   `/data/nginx/custom/ante-up-rate-limit-response.conf` inside that container.
   Add exactly this line inside Ante Up's **HTTPS server block**, immediately
   after that block's `server_name ante-up.fun;`:

   ```nginx
   include /data/nginx/custom/ante-up-rate-limit-response.conf;
   ```

   Keep every existing zone, rate, burst, location, upstream, TLS and access
   rule unchanged. The site diff must contain only that include line; the new
   include must match this repository file. No other site includes it.
3. Run `docker exec npm nginx -t` before reloading. If it fails, restore the
   saved site/include without reloading. After a successful test, the owner
   runs `docker exec npm nginx -s reload`. Re-read `nginx -T` selectively to
   confirm the include is scoped to Ante Up and the rate directives are intact.
4. Read current service health and make at most one normal public API read.
   Do not intentionally exhaust the production bucket. Config/hash checks and
   the isolated nginx response test establish the rollout gate; a real live
   rejection response remains unobserved until a natural 429 occurs.

Rollback: restore the exact saved Ante Up site and previous include (or remove
the newly created include after removing its site reference), run `nginx -t`,
then reload. Preserve the rate policy and all unrelated configuration. This
response-only change requires no API, web, collector or monitor restart.
