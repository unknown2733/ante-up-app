# Public web wallet validation — 2026-10-12

## Verified scope

User-operated PC browser at https://ante-up.fun, with API and finalized Devnet readback. Exact wallet extension name is not yet confirmed. This is distinct from the earlier programmatic test-wallet run. See public evidence (private deployment evidence).

Wallet: `5xAC3XbcvYUEuf8fJorpH4U81qMAUejZAvQgBiuSBmwi`.

| Step | Result |
|---|---|
| Faucet | 1,000 tUSD; API FINALIZED, chain finalized, signed intent MATCH |
| Free open | solana; snapshot24; record `8YFtrhxJMMQwjKY8JXLfF9HonjaQHCFWUHtSvMw4BSoP` |
| Free close | snapshot27; CLOSED_RESULT; API FINALIZED, chain finalized, signed intent MATCH |
| Profile | 0 open, 1 valid closed; eligible for leaderboard |
| Result | Approximately −0.1705%; external-index score, not cash profit |
| SAS for this record | Not issued; proofId null |
| Paid chip buy/sell through PC UI | Not yet verified |
| Seeker + Seed Vault Wallet | Faucet + free open/close finalized; evidence below |
| Android + Phantom | User connection/signing pending |

The wallet already held approximately0.493 Devnet SOL. No SOL was sent to it by this validation. Faucet cooldown applies if the same wallet is used on another device.

## Issues found and action

1. Wallet-added compute-budget instructions caused exact-byte receipt comparison to reject successful faucet/open transactions. Bounded semantic receipt verification was implemented; existing signatures were reconciled without resubmission. API test suite39 passed/1 opt-in skipped; new regression5/5 and Linux typecheck passed.
2. User reported no popup and then `이미 처리 중입니다`. A prior browser wallet call was still active across route changes. After canceling pending wallet prompts and hard-refreshing, user signed close successfully. No browser console/provider error was captured, so the reason the provider promise remained unresolved is not established. No automatic retry/timeout reset was added.
3. Record detail had only a status label for close, no navigation to the actual market action. Added an explicit link, actual keyword lookup, and removed fixture-only warning from live record pages.
4. Explicit Phantom4001 cancellation had been classified as ambiguous; added the documented code alongside Wallet Standard4001000 in both free/financial paths. Unrecognized failures remain uncertain. Free retry regression verifies two separate user attempts, zero submit calls after rejections. Existing uncertainty/double-click tests remain passing. [Phantom error codes](https://docs.phantom.com/solana/errors).

Web checks: Windows and Linux16/16 relevant transaction/free/financial tests passed; TypeScript and Vite production build passed. This does not replace actual Seeker/Android testing. The web build still warns about a >500kB bundle.

## Deployment and limits

- API image `ante-up:wallet-receipt-20261012`, sha256 `b496cd19f23da8799ebf5bde918ff1cd36ae8ff414696576018bacc0d6007ebd`.
- Web image `ante-up:wallet-web-20261012`, sha256 `2e2f36b63ddfd9a0ce949cdcd62f075f86ef222bbc39b1b44bb35e104371908f`.
- Server source updated; Compose .env release is wallet-web-20261012. Only API/web were recreated; collector/indexer retain original always-on image.
- Temporary `ante-up-device-window` opened global free admission23:17:42 KST for one hour; timer requests close around00:17:42 next day. Verify the actual gate/close receipt before declaring it closed. Existing per-wallet/global limits remain enforced. This is not permanent public admission or an enabled general proof worker.
- .fun parent lookup at about23:26 KST returned jerry/pat Cloudflare, superseding the earlier delegation-pending result. Recursive caches and an actual dynamic WAN change remain separate checks.

Runtime helpers and key mounts stay server-side; this report includes no tokens, private keys or secret RPC URLs.

## Seeker authentication follow-up

User supplied 939RPDweeCfV1s39nND2KsARHesEvaH5MqhjxV5soKQv and confirmed Seed Vault app opens. Initially0 Devnet SOL/0tUSD; one0.05 Devnet SOL transfer finalized (4mE9N8Q48PSTWhnimU7tUz8qi55rJ8vT9Q1e7VwdeKZGqr66SiHcDuegYbAjifwfDWSiRKpAZixa87qXYWDLfNxy). This is fee preparation, not evidence of a completed mobile faucet.

User reported Wallet challenge is invalid or expired. The client compared the server's exact300-second challenge against device wall time, so even modest negative skew could reject a valid challenge. Actual phone clock offset was not measured. Added a shared server-anchored clock after successful, matching API envelopes; it advances with monotonic elapsed time and conservatively counts request duration. Old responses cannot move it backward. Free auth, financial quotes, UI expiry and financial instruction checks use it. Server/chain enforcement and existing TTLs are unchanged.

Windows/Linux21/21 relevant tests passed, including ±1hour device skew, elapsed expiry, stale response and existing transaction checks; TypeScript and production build passed. Web-only image ante-up:wallet-clock-20261012, sha256 fc8bcc552b0a39a3018eecbd95d2ef2d402c68b18d6629a8f1404d8a1b3b1ef0 supersedes wallet-web. Compose .env updated; other services unchanged. Immediate restart probe returned502; subsequent public200 serves index-CVQA3491.js. User was asked to refresh and retry on Seeker. Actual mobile completion remains pending.

## Seeker receipt recovery — 2026-10-13 00:08 KST

Seeker wallet 939RPDweeCfV1s39nND2KsARHesEvaH5MqhjxV5soKQv received 1,000 tUSD. Request d0869cd4-ceed-4d57-89b5-87c917d5b8fa finalized at slot510301240; signature 64fcSkdMeBeHgEi4ojds1SKuwbFgbjeZmebRMgnhmtWQxKoKtUGQtwRbb5vvKYWMCaaRRBpUqS3fYz2ysjsGqhFH. Actual receipt intent and wallet signature MATCH after correction. No additional mint or resend was used for recovery.

Seed Vault appended ComputeBudget limit/price after the application instructions. The earlier matcher allowed prefixes only, causing this successful transaction to be rejected and then incorrectly marked unsigned-expired by reconciliation. Fixed position-independent transaction-wide compute settings while retaining exact application instruction order/data/accounts, signer privileges, payer, blockhash, signature and priority-fee bounds. Expiry recovery now retains UNKNOWN for an unmatched same-blockhash receipt; mismatch does not establish non-execution. A subsequently verified receipt can repair an earlier unsigned expiry classification. Windows/Linux11 relevant tests and API typecheck passed.

Previous patch wallet-expiry-20261012 (sha256327d354f08f2d578a476e20770971f373640f35e11a949fe6b00a2971a465018) added bounded finalized expiry/history recovery and client recheck handling; API9/web19 tests passed then. Current API supersedes it with wallet-seeker-20261013, sha2566d2bef5b36c7ea445a23305c5e0e25c228215e7914fe5a99d70f27b2de5f20e1. Web remains wallet-expiry, bundle index-DhaW78tZ.js. Compose release points to wallet-seeker; only API recreated. Public HTTPS API and four services healthy. No chain redeploy or remote Git push.

Free entry succeeded without manual recovery: request7ca55040-3554-463e-b1d5-3a35c4bacce5, signature5EKH9oKm2xmmxFtYyLqtv1KpbcE6Cuw6BYHekEoCBFZLsEehgt2sFqu1xtEJFvDKP1wLEZG92bFTH41yQMAmQGVb, slot510303384, snapshot33. Record74S8WVFD8ypLcGPd9ydR3B8gvte6SFtZP73GPSpnYCUb is OPEN. Faucet + entry are actual Seeker user signatures, not a full mobile roundtrip yet. Close request1fd61e05-81e6-4142-a05f-342227ae83e5 had no matching finalized receipt at the first check and was expired; user requested a delayed recheck. Closure, SAS and Android+Phantom remain unverified. Admission timer remains unchanged; verify actual gate before reporting closure.


### Delayed recheck: Seeker full free roundtrip confirmed — 00:10:51 KST

A NEW close request5025dc81-4cd0-4e78-9c8a-7b48af8c121b is FINALIZED, with intent MATCH and no chain error. Signature33Hv93txUr3qJ3i4RXM16avPGefekKe5b5zsB2tbbtDXbKRMbUzJrFPLeLxGwC1ByhQNRcq3npmE6G4DEVVF3uLz, slot510304266. This does not mean the older expired request later landed. Entry snapshot33 → exit34; CLOSED_RESULT, zero open / one valid closed, leaderboard ELIGIBLE, approximately -0.00482%. ProofId is still null (SAS pending). See evidence/device-seeker-2026-10-13.json. Thus actual Seeker user faucet → free open → close is verified; Android+Phantom and paid-chip UI roundtrip remain pending. No transaction was resent by the diagnostic helpers.

## Android + Phantom and parallel integration — 2026-10-13

User-operated Android Phantom completed faucet → free open → close for wallet `39Rke1e9zfpBQQ5RnBBnaoPoUBz7HWYJseNinCLSPsCo`. The finalized readback at00:35:51KST confirms all three receipts MATCH. Faucet minted1,000tUSD; record `9tak3tGabXLeK5W7QQCCNv1CdN66qoayWFLBmc6CGhxv` is CLOSED_RESULT (snapshot38→39), with0open/1validclosed and leaderboard eligibility. SAS remains pending. Two additional unsigned prepared requests are not duplicate executed transactions. Evidence: Android readback (private deployment evidence).

The free-action UI could expose a new action after chain finality but before the profile projection caught up. Added a wallet/market-scoped session barrier, bounded profile refresh and explicit manual refresh. Root integrated mobile commit8c19008 and deployed bundle`index-58UjVaAz.js` with image`ante-up:parallel-qa-20261013` (sha256ae74fb6b83a0f11a4379dfcc3b0103ebdd9d32c5d5ea799586223abe8c22586b). Indexer now imports the separately owned synthetic QA candidate journal; the public registry remains unchanged. `deploy/compose.parallel.yml` is an additional Compose override for these two services; API/collector were not recreated.

Linux image build: evidence28+financial harness4=32passed; web29passed/1optionalHTTPtestskipped; indexer TypeScript and web build passed. Initial build commands failed on test temp-directory permissions and a nonexistent npm script; corrected build passed. Existing baseline full integration passed separately, with native gates skipped in that invocation. A separate Linux LiteSVM test used actual SBF SHA256`4afa5e5bc88de21954c7b02be6e2cc6b7a34fa86b33cfcb3af588adca7ec5419` and passed the full financial lifecycle including local-clock normal maturity, settlement, claim and LP window. This is not live weekly maturity verification.

Seeker USB/ADB was reconnected and authorized. Chrome readback showed no horizontal overflow at400×749. One authorized pending-request status check cleared the old faucet warning without a new payment. A1-token paid-chip quote succeeded (1.001101tUSD including fee); actual paid-chip signing remains in progress. Device access is confirmed, distinct from transaction completion.

### Seeker paid-chip issue investigation

Two user-approved1-token curve-buy attempts (`4d5a6523-e205-4c15-827f-5fd6b00f324a`, `51b5cfb2-bf74-4cca-8f31-6b8c650108f6`) did not land. After blockhash expiry and a complete bounded finalized payer history, reconciliation marked both FAILED/REQUOTE_REQUIRED with no signature. Their current simulations return QuoteExpired6009. That later simulation does **not** establish the original wallet failure cause. The first Chrome error was `The wallet session closed before a response was received (1001: WS server shutting down).`; the second remained AWAITING_SIGNATURE while the user reported a wallet error.

Read-only Windows PnP showed Seeker+ADB Interface OK, but QA ADB5038 intermittently returned no devices. A dedicated-server restart showed the device offline; reconnect did not restore it. No other ADB5037 server was present. A sandboxed ADB query also failed to reach the daemon, so device checks must run with the authorized host permissions. User was asked to toggle USB debugging and preserve the error screen. No relation between the wallet WebSocket error and ADB transport loss has been established. No automatic trade resend was added.

A follow-up UI patch adds a1-second quote countdown, focus refresh and disabled signing at expiry, retaining the original30-second economic deadline. The free-runtime integration harness was updated to observe the actual indexed profile before moving from finalized open to close. The initial full regression failure was this missing harness transition (186passed/1failed/2native skips); the corrected full Linux gate is being rerun.

### Final web gate and supervised evidence service

Corrected full Linux integration passed:187module/adapter/integration tests,2native tests skipped in this invocation; all30web tests passed; API/indexer/chain TypeScript and Vite build passed. Native financial SBF was checked separately above. Deployed web image`ante-up:mobile-qa-final-20261013`, sha256`61b6f6c2c88c551a96edcd0114dbf2ac11d7f25844598903e0029db7be2d1394`, public bundle`index-pduNsz8V.js`.

Four-record bounded evidence execution exited0 without OOM; all artifact upload receipts are saved. Actual Turbo balance fell35,739,806,542winc; local reservations36,878,969,507winc of60B. Receipts alone do not establish archival finality: parent-bundle inclusion/20confirmations, manifest and SAS remain pending. The Compose evidence service is now running healthy with the same ledger/receipts and exact four-record allowlist,15Bper-record/60Btotal/60Bdaily quote caps. Subsequent new records are not automatically admitted into this bounded proof run. The worker may complete SAS after required confirmation; no issuance is claimed yet.

Compose deployment uses `deploy/compose.yml` + `deploy/compose.parallel.yml` + `deploy/compose.evidence.yml`, with server `deploy/.env` and `deploy/evidence-budget.env`. Budget configuration contains caps and public record IDs only; private keys remain mounted from server secrets. Preserve the budget ledger on restart.

After the USB debugging toggle, Seeker returned to ADB device state and Chrome exposed the second error: `The wallet session encountered a transport error before a response was received.` Installed MWA code emits these errors from its phone-local WebSocket session. This is not evidence of a Cloudflare/backend WebSocket fault. Original signer-stage duration remains unmeasured; diagnostic timing is the next investigation step.

Temporary Android free-admission window was closed early after free-wallet QA completed, at2026-10-13 01:05:09KST. Close signature`ot3hpHx1YB2zvqJMjWfGeEgMyJEt4zDXXT4CHoYZEwMjcBcF1gDE7guq959UoNbk8azdidwN7N5onQPX2iHzxRD` FINALIZED; readback admissionOpen=false, outstanding4. This stops new free entries while preserving existing exits/proof processing and financial QA.

### Financial deadline investigation (separate from mobile transport)

Isolated live Pro QA reproduced QuoteExpired6009 when host wall time was1second ahead of Solana Clock and the harness chose wallNow+30: the program also rejects deadlines greater than chainNow+30. This explains a reproducible program rejection, but does not prove the cause of the earlier Seed Vault WebSocket failures. QA recovery preserved each original attempt, verified finalized blockhash expiry and missing signature/PDA state before issuing a new attempt. Chain-anchored deadlines passed the same program path. The live API also used wallNow+30, so a confirmed-Clock-bounded quote fix is in progress with unchanged on-chain deadline limits.

The web timing patch records only bounded local performance phase names, durations and remaining seconds; no addresses, request IDs, auth, transactions or error text. Independent finalized market/config reads are parallelized without caching or dropping validation. Deployment of this additional diagnostic patch will be recorded separately.

### 2026-10-13 01:17 KST — Clock correction and parallel finance completion

- Seeker ADB is authorized/online again (`SM02G4061933027`, `device`). The old Chrome request retained the MWA transport error; no new trade was submitted during reconnection checks.
- Actual Devnet financial QA finished with 35 finalized transactions. Curve/graduation/spot/LP and 5x long/short rising/falling closes were verified. Final assets/NAV 7275.722419 tUSD; external token quantity, spot liability reserve, Pro reserve, other reserve and open positions all zero. Locked LP shares 7100 remain. Audit evidence: `docs/qa/financial-devnet-20261013/`. Browser financial orders and live weekly maturity remain unverified.
- API quote expiry now uses fresh confirmed Clock: min(server quotedAt + 30, chain Clock + 29), with 5-second RPC and ±10-second skew guards. Existing financial account validation remains finalized. Actual readback found server one second ahead, producing 28 seconds server / 29 seconds chain remaining.
- Linux integration: 191 pass / 2 skipped (native gates), web 32 pass / 0 skipped; type checks/build passed. Previously recorded real SBF validation is separate. Image `ante-up:clock-timing-20261013`, sha256 `846b1cd9da01e407525c9274582be21e32418c88b540997ad9bac1b6f0b1c35b`, deployed API+web only. Public bundle `index-CWXc1vI4.js` confirmed.
- Independent web RPC checks now run concurrently; bounded local phase-duration marks exclude sensitive fields. This measures the next mobile attempt; the Clock fix does not establish the cause of the MWA transport failure.
- Collector/indexer/evidence continue unchanged. Four uploaded evidence jobs remain subject to Arweave inclusion/20-confirmation checks before SAS issuance.

### 01:21 KST — Seeker curve buy finalized

After authenticated recovery of the expired prior operation, the user approved request `14514234-4003-4851-8174-c062e84c1cbd`. Devnet/API FINALIZED; receipt MATCH; signature `xEvT37KTyedQnMg595vZA5WFirVwDgGc5kBnQantiCNM63HXUwwLLAFwPs2aDffA4d5wzTKE7V2kWMAxJE1D9rD`. Actual Seeker keyword balance1000000 atoms (1 token); tUSD balance998998899 atoms (998.998899). Paid1.001101tUSD matches the quote. Mobile timing: quote4,061ms, prepare2,521ms, verify834ms, wallet.start after13,922ms with17s remaining, wallet.response after37,937ms (wallet response24,015ms). Receipt arrival after quote expiry is not the execution time; actual finalized chain execution succeeded. Exact cause of the earlier transport failures remains unproven. Sale follow-up remains pending.

### 01:24 KST — Seeker curve sell finalized

User approved request `f629d390-47c8-41ed-8ccc-0fa2c477de7f`. Devnet/API FINALIZED and receipt MATCH; signature `vcP9TB4B9GnaTUi3h8XphofR7WiNsbccsJUT6CUjDyp64LkB9eT3w5EcPZrp1RASMnKN2pXNs7whQufK4uAE25j`. Received0.999099tUSD; actual ending tUSD999.997998 and keyword token0. Round-trip cost0.002002tUSD equals two0.001001 trade fees. Both buy and sell on Seeker/Chrome/Seed Vault are now proven by user approval, finalized receipt matching and actual balances. Sale quote3,246ms/prepare1,951ms/verify736ms; wallet.start19seconds before deadline. Final mobile display readback is separate from chain settlement.

### 01:30 KST — Pending wallet response recovery deployed

A real sell completed on chain while the native wallet promise stayed unresolved, leaving the app busy. Added bounded authenticated status reconciliation during wallet response wait. Uses the session captured before wallet invocation (no background login prompt), checks exact operation identity and terminal signature/verified unlanded-expiry semantics, preserves UNKNOWN/pending without automatic resend, and consumes late wallet responses without writing over later requests. Hanging signer/late resolution/late rejection/missing signature/unsigned expiry tests pass. Linux focused13/13, TypeScript and Vite pass; deployed web-only image `ante-up:wallet-reconcile-20261013` sha256 `15bfd22b266799b1caccc939d5226fce5408684df664631fa99efbedd9d03253`; public `index-DfsSq-tq.js` confirmed. Existing sale display recovery is checked separately; no new trade used for the patch.

01:31 KST actual Seeker readback: loaded `index-DfsSq-tq.js`; one existing-operation recheck cleared the sell pending/error/wallet-wait UI and enabled quote entry. No additional authentication or new transaction. Current device verification covers reload+recheck of the finalized sale; automatic recovery of a newly hanging signer is covered by targeted tests, not an additional live trade.
