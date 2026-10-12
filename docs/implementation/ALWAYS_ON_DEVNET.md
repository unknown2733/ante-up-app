# Home server continuous Devnet runtime

Verified 2026-10-12 21:55 KST. This is an internal running service, not a completed public/mobile launch.

## Running deployment

- Image: `ante-up:always-on-20261012`, image SHA `30634038519bf04170da6bb95fe0b17eda6c46ff3ed9854cb6986495b76ea0f9`.
- Release: `/srv/example-app/builds/always-on-20261012`; Compose file: `deploy/compose.yml`.
- Active durable state: **`/srv/example-app/builds/service-state`**. Old `runtime-state` is preserved historical smoke-test state; do not use it as the current collector database.
- Pre-migration backup: `/srv/example-app/builds/always-on-backup-20261012` (collection/candidates and SQLite backup). This is a one-time backup, not an off-host backup service.
- Secrets stay under `/srv/example-app/secrets`, mounted read-only per role. API/indexer get RPC only; collector additionally gets X token and publisher signer. No deployer/issuer/Turbo signer is mounted. Active state excludes old test-wallet private files.

| Service | Actual function | Exposure |
|---|---|---|
| collector | X Counts, validation/replay, Devnet publication, every 5 minutes | no listening port |
| indexer | finalized events, candidate/proof reconciliation, every 10 seconds | no listening port |
| API | real Devnet reads, authenticated transaction preparation | server loopback `127.0.0.1:18787` |
| web | built mobile web app and `/api` reverse proxy | server loopback `127.0.0.1:18088` |

All four containers report healthy. Docker is enabled at boot; `restart: unless-stopped`, file locks for collector/indexer, graceful collector shutdown, read-only images, non-root UID1000, bounded logs, memory/CPU limits are set. Health checks detect problems but Docker does not automatically restart a merely unhealthy process. Server reboot itself was not performed.

## Limits and failure behavior

- Only existing `solana` query is enabled: `("solana") lang:en -is:retweet`. No additional paid keywords or history bootstrap on restart.
- Existing persistent local cost reservation: $0.01/request, UTC day $10 and total initial $100. This is conservative configured accounting, not a measurement of the provider's invoice. One uninterrupted keyword is about 288 calls/$2.88 reserved per day.
- 5GiB active-state allowance; collection stops at 80% or host free storage below10GiB. This deployment threshold is an implementation setting, not a change to product economics. Unarchived raw data is not deleted. Disk/total-budget/SOL failures stop paid collection and remain visible in logs/health; restarting cannot reset the stored spend.
- Publisher must have at least0.01 Devnet SOL before a fresh paid request. Each snapshot currently reserves1,991,360 lamports of rent plus about5,000 transaction lamports: approximately0.575 Devnet SOL/day at288 snapshots. Rent is retained by accounts, not an X or real-money fee.
- Verified publisher balance0.11602548 SOL at21:55 KST: roughly4.4 hours above the stop threshold. Automated Devnet faucet failed; user top-up of2 test SOL requested. No mainnet funds or paid SOL purchase is involved.
- Pending/uncertain source requests are not blindly recharged. Single writer locks apply to this Compose deployment. Do not run old ad-hoc collectors/indexers against active state concurrently.

## Storage change

`FileCollectionState` and `FileCandidateRepository` accept old inline JSON and new content-addressed gzip history references. Original observation and replay JSON is recoverable without changes; canonical data/proof hashes are unchanged. Lazy replay loading avoids reading every historical input during each poll. Collection/candidate metadata reduced from about153MB to about31KB; shared compressed history was3MB after the second new poll. History still grows over time; this is not unlimited retention or an incremental Arweave upload implementation.

Use the repository classes to read replay inputs. Direct `JSON.parse` sees local reference markers. The indexer only consumes inline candidate metadata and does not need to inflate replay histories.

## Verification

- Linux: data33/33, indexer14/14, API34/35 (one opt-in HTTP test skipped); both service type checks passed.
- Final image: both type checks, history persistence test, mobile/web21/22 (one external HTTP fixture opt-in skipped). These overlap earlier coverage and are not summed as independent tests.
- Windows history test hit sandbox `EPERM` on rename; production Linux test passed. Windows portable write behavior is not claimed verified by that attempt.
- Actual X collection/publication advanced snapshot4→5→6→7. Restart did not repeat the28-day archive or duplicate a paid batch. On-chain snapshot sequence/hash equals real HTTP API output, zero pending publication at final check.
- Competing collector and indexer lock attempts were rejected.
- Actual old observations, four replay jobs and four snapshots compare equal after storage migration. Existing SAS remains `ISSUED` through the running web→API path.
- Evidence: final runtime (private deployment evidence), preservation and proof (private deployment evidence).

## Operation

```sh
cd /srv/example-app/builds/always-on-20261012/deploy
docker compose ps
docker compose logs --tail 30 collector indexer api
docker compose restart collector
```

Compose `.env` contains only release name, UID/GID, state and secret directory paths. Rebuild with `docker compose build`; recreate with `docker compose up -d --no-build`. No secret values belong in image build arguments or frontend variables. Future VPS migration requires copying active state including `.history`, SQLite with a safe backup/paused writers, secret files separately, and these environment paths.

## Next: ante-up.fun and mobile

- User selected and owns `ante-up.fun`. At verification DNS still resolved to216.40.34.41; requested root A→home server public192.0.2.10. Windows→home server HTTP ACME challenge route returned404, showing route reachability, not successful public certificate issuance.
- Existing Nginx Proxy Manager serves80/443. It was inspected but not modified. HTTPS vhost template is `deploy/nginx-ante-up.conf.example`; it is not installed. After DNS change, configure persistent ingress network, issue certificate, set renewal, run nginx validation/reload and verify public HTTPS/API. Do not expose raw API18787 or wallet files.
- Web build has `VITE_API_BASE_URL=/api`, fixtures disabled, Devnet, public browser RPC `https://api.devnet.solana.com`, MWA identity `https://ante-up.fun`. Helius secret URL is not bundled in the browser.
- Android MWA and Wallet Standard paths exist and passed code tests; actual phone connection/signing remains unverified. No installable app is created.
- New free admission remains closed. General evidence/SAS queue execution, visitor SOL/rent support and financial keeper operation are not silently enabled by this deployment. Existing records/proofs are readable; these remaining public-write readiness gates need completion before broad free-chip access.

This work did not redeploy the Solana program, raise budgets, add keywords, or push Git changes remotely.


## Follow-up — 2026-10-12 22:39 KST

Publisher top-up confirmed: balance2.09805824 Devnet SOL, approximately3.6 days at the current cadence. This supersedes the earlier4.4-hour funding limit. Four containers remained healthy for46 minutes; snapshot16, matching finalized/API hash, zero pending publications. Readback (private deployment evidence).

DNS remains216.40.34.41 under Hover nameservers; no AAAA record was returned. Connected browser tooling exposes MCP Apps only and cannot open an in-app browser, so Hover login is not accessible. User was asked to save @ A→192.0.2.10 in Hover. Permission to continue does not establish that DNS has changed. HTTPS issuance and phone signing remain pending; the existing proxy was not altered.


## Public HTTPS and dynamic IP follow-up — 2026-10-12 23:00 KST

User confirmed targets: Seeker + Seed Vault Wallet, Android + Phantom, and PC web. Hover root A now points to 192.0.2.10. Let's Encrypt certificate was issued and the custom vhost `/data/nginx/proxy_host/ante-up.conf` installed in existing NPM after nginx configuration validation. Certificate expires 2027-01-10 12:51:57 UTC. Public HTTP redirects301 to HTTPS; trusted HTTPS returns200; `/api/v1/markets` returns actual Devnet snapshot19 and existing proof endpoint returns ISSUED. All four services remain healthy. This is network/API validation, not browser rendering or wallet signing.

Dedicated external Docker network `ante_up_ingress` uses10.250.48.88/29 because default address pools were exhausted. Both web and npm are attached. Ante Up Compose and `/home/operator/npm/docker-compose.yml` persist the network; NPM original backup is `/home/operator/npm/docker-compose.yml.pre-ante-up-20261012`. Other proxy routes are preserved. Recreating on a new host requires creating the external network first, choosing a subnet that does not overlap that host's networks.

`deploy/renew-tls.sh` renews only ante-up.fun; user cron invokes it at03:17/15:17 UTC and logs to ante-up-tls. Custom vhost/certificate is managed outside NPM's UI database. Renewal dry-run started; Certbot selected a438-second random delay, so renewal simulation success is not yet claimed. Temporary ACME readiness marker was removed; actual challenge route is preserved.

Dynamic-IP findings: server LAN address192.168.0.48 is DHCP4 from192.168.0.1; reservation status is unknown. WAN static-IP contract cannot be inferred from LAN DHCP. No common DDNS systemd/container service was found. User then reported existing router DDNS `server.example.com`; server DNS resolution confirms it and ante-up.fun both resolve to192.0.2.10. This snapshot confirms matching resolution, not a tested WAN-change event. Current ante-up.fun A record does not follow DDNS automatically. No router/DDNS/DNS-provider migration has been applied. Root CNAME flattening via a provider such as Cloudflare is a proposal; preserve all DNS records if migrating. Router LAN reservation also remains to verify.

Public free admission stays closed. Actual mobile/PC signing and visitor SOL remain outstanding; connected UI tools are unavailable. Helius URL remains server-only.


## Cloudflare DNS migration preparation — 2026-10-12

User approved keeping registration/renewal at Hover and moving authoritative DNS to Cloudflare so the root follows `server.example.com`. This is approved direction, not a completed nameserver switch. No authenticated Cloudflare/Hover management connection is available; user was asked to add ante-up.fun on Free, review imported records and provide assigned nameservers before switching.

Authoritative ns1/ns2.hover.com readback: apex A192.0.2.10 TTL900; www A216.40.34.41 TTL900; NS ns1/ns2.hover.com. Apex AAAA/MX/TXT/CAA and _dmarc TXT returned no records; resolver DS query returned NOERROR/no answer. These targeted queries are not a full DNS zone export. Compare the Hover dashboard with Cloudflare's imported list before delegation.

Target apex record: CNAME @ -> server.example.com, DNS only (proxied=false), TTL Auto. Replace the imported apex A in Cloudflare, not the still-authoritative Hover A during preparation. Do not retain conflicting apex A/AAAA. Cloudflare flattens apex CNAME by default. Preserve unrelated records; do not import Hover's old apex NS as delegation. Existing www is still the previous destination and is not yet included in the app certificate/vhost; changing it to the app requires corresponding TLS/redirect configuration.

Assigned Cloudflare nameservers are not yet known. Once new authoritative records match, user changes Hover Overview > Nameservers to exactly the assigned pair. Validate NS propagation, flattened A against DDNS, HTTPS301/200, live API and proof reads. No domain transfer, tunnel, CDN proxy or application rebuild is needed for this DNS-only setup. DDNS and resolver TTLs can still create propagation delay after WAN changes.

Renewal follow-up: earlier Certbot dry-run completed exit0: all simulated renewals succeeded for ante-up.fun. HTTPS readback remains200. No further issuance is needed merely for DNS-only migration.

References: https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/ ; https://developers.cloudflare.com/dns/cname-flattening/set-up-cname-flattening/ ; https://support.hover.com/support/solutions/articles/201000064742-changing-your-domain-nameservers


## Nameserver switch readback — 2026-10-12 23:11 KST

User reported completion after showing Cloudflare DNS-only root CNAME to server.example.com and assigned jerry.ns.cloudflare.com / pat.ns.cloudflare.com. Both assigned authoritative servers return apex A192.0.2.10 (TTL300), matching DDNS. HTTPS200 and HTTP301 continue; public API snapshot22 is finalized/VALID; existing SAS is ISSUED. One request during publication returned snapshot=null while chain and indexer heads differed; subsequent local/public reads returned22. No DNS-related API outage was established.

However, both public resolvers1.1.1.1/8.8.8.8 and direct .fun parent servers64.96.1.1/64.78.205.1 still delegate to ns1.hover.com / ns2.hover.com (TTL900). This is not yet a verified Cloudflare delegation; it cannot be attributed solely to recursive cache because the parent still returns Hover. Registrar update may be pending or not saved. Ask for Hover Overview > Nameservers readback; do not claim migration complete or retry unrelated DNS mutations. Current site remains reachable through the old provider during transition.


Follow-up registrar screenshot confirms Hover saved exactly jerry.ns.cloudflare.com and pat.ns.cloudflare.com. No further user edit is needed. Recheck of both .fun parent servers and both public resolvers still returns Hover; status is registrar save verified, parent delegation pending. Both Cloudflare servers resolve to the DDNS address. Unrelated personal details from the screenshot are not retained.

## Real wallet follow-up — 2026-10-12 23:40 KST

PC user signed faucet1000 tUSD, free open and close; all three have matching intent and finalized API/chain receipts. See [device validation](DEVICE_WALLET_VALIDATION.md). Close result −0.1705%, snapshot24→27; SAS for this record is pending. API was patched to accept strictly bounded wallet compute-budget prefixes without relaxing program intent/signature checks. The web now links record detail to market close, distinguishes live evidence wording, and handles explicit Phantom cancellation.

Current API image: ante-up:wallet-receipt-20261012. Current web image: ante-up:wallet-web-20261012. Compose .env now chooses wallet-web-20261012; source patch files were copied into the release tree. Only these two roles were recreated; collector/indexer still use always-on-20261012. Four services healthy and public HTML loads index-BGwDKz1a.js. A first incremental Linux build lacked permission for Vite's cache; build stage was corrected to root and runtime returned to node. Subsequent Linux16 tests and production build passed.

Temporary global free-admission window opened23:17:42 KST for one hour via ante-up-device-window. Verify its actual close/gate around00:17:42; do not infer closure solely from the timer. Per-wallet/global limits and existing close rights remain. General proof worker is not enabled by this test. Seeker's supplied wallet received0.05 Devnet SOL for its zero-balance fee requirement, not mainnet funds; actual mobile signatures remain to verify.

At approximately23:26 KST .fun parent64.96.1.1 returned jerry.ns.cloudflare.com and pat.ns.cloudflare.com, superseding earlier delegation-pending status. Recursive caches and an actual WAN/DDNS change remain separate checks.

Seeker follow-up: latest web image is wallet-clock-20261012 (see DEVICE_WALLET_VALIDATION.md). All auth/quote/instruction expiry checks now share server-anchored monotonic time to avoid client wall-clock skew.21 relevant Windows/Linux tests and production build passed. One restart probe502 recovered to public200/newbundle; other services unchanged. User mobile retry pending.

2026-10-13: API wallet-seeker-20261013 supersedes earlier images; web remains wallet-expiry-20261012. See DEVICE_WALLET_VALIDATION.md for Seeker faucet/entry evidence, corrected compute suffix matching and expiry recovery. Four services healthy; temporary admission timer unchanged.
