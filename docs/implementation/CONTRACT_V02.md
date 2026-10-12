# Common contract revision 0.2 — integration corrections

This addendum supersedes conflicting technical details in A_CONTRACT.md. Existing economic/product decisions remain unchanged. The user authorized the integration corrections on 2026-10-12. This is a pre-release coordinated migration: wire schemaVersion remains `0.1`; all components must consume this contract revision together. No old deployed clients exist. Each owner imports the A commit before changing its owned files.

## API / web

- HTTP fixture responses are legitimate development responses. The web client may accept them only when explicitly configured to allow fixture transport and must continue displaying fixture mode. Never relabel fixture as devnet. Strict live modes reject fixture.
- GET `/v1/leaderboard?period=7d|all` returns Envelope<LeaderboardPage>. Rows have status ELIGIBLE; held wallets are excluded and returned separately. No-result wallets do not get ranked rows.
- GET `/v1/proofs/:proofId` returns Envelope<ProofStatus|null>. URL IDs must be encoded/decoded once. FreeRecord.proofId is the reference; no assumption that proofId equals recordId. A missing proof is null, not a fabricated issued record. The web uses this same ID for replacement links.
- PublicProfile read responses may enrich the record projection with shared OpenPreview[]. These are current reference returns, never finalized scores. UNAVAILABLE carries null return; stale/unfinalized/invalid snapshots cannot produce REFERENCE. Missing enrichment must not invent a current return.
- Non-executable quote/prepare results use explicit `kind: notExecutable`; no fake unsigned transaction or success signature. Shared PreparedTransaction describes the executable boundary. Keep the existing operation/finality rules.
- Executable preparation additionally binds wallet, cluster (`localnet` or `devnet`), programId, expiresAt (UTC seconds) and recordId (free-record PDA). A close request names its existing record; an open builder derives a new record before returning the preparation. The client compares intended action/market/record and actual decoded instructions, not only these metadata fields. No silent wallet/network switch or expired signing. A wallet submission is not finality; operation reconciliation must match the actual signature and action.
- For local cross-origin integration choose an explicit web development proxy or an origin allowlist; never turn a transport failure into fixture fallback.

## Free-flow runtime connection — 2026-10-12

- POST `/v1/auth` retains the wallet/cluster challenge. POST `/v1/auth/session` accepts `{wallet,cluster,nonce,signature}` (base64 Ed25519 signature of the exact challenge message) and returns `Envelope<WalletSession>`. Consume each nonce at most once even under concurrent requests. The opaque bearer token is scoped to that wallet and cluster, lasts at most 15 minutes, is hashed in server storage, and stays only in browser memory. Clear it on wallet/network change. This avoids a new wallet approval for each operation poll.
- Authenticated calls use `Authorization: Bearer <token>`. Legacy one-shot signed headers may remain supported. POST `/v1/transactions/prepare` uses the existing ActionBody and PreparedTransaction. Only implemented free open/close actions can be executable; money paths remain explicitly unsupported.
- POST `/v1/operations/:requestId/submit` accepts `OperationSubmission`. Authenticated GET `/v1/operations/:requestId?wallet=...` checks the same wallet/cluster. A reported signature is a claim, not finality: reconcile the chain transaction against the stored prepared message and record/action identity before marking success. Never let a caller attach another wallet's transaction to its operation.
- Store operation identity and prepared intent durably before returning executable bytes; duplicate request IDs with conflicting intent are rejected. Retries resume the same operation. An ambiguous send/timeout is UNKNOWN and does not trigger automatic creation or resubmission of a new position.
- Free record closure remains on-chain finality dependent; proof completion is a later asynchronous operation. Pending archival or SAS issuance must not masquerade as a failed or unexecuted close.

- In real localnet/devnet wire DTOs, `MarketView.id`, `SnapshotCandidate.marketId`, `FreeRecord.marketId`, and `SnapshotRef.marketId` are the market PDA base58 address. Registration's 32-byte `market_id` seed, keyword and aliases remain registry fields, distinct from this public address. Candidate producers and event consumers must agree before hashing or publishing. Fixture IDs remain fixture-only.

## Live wallet receipt compatibility — 2026-10-12

Receipt comparison permits a wallet to prepend only bounded ComputeBudget setComputeUnitLimit/setComputeUnitPrice instructions. Preserve message version, blockhash, fee payer, original account identities and privileges, instruction order/data/accounts; reject lookup-table changes, other instructions, duplicate settings and extra signers. Limit is at most 1,400,000 CU and 1,000,000 lamports added priority fee. Verify the wallet signature over the actual message. Exact prepared messages remain supported. Amounts, recipients and program intent cannot change.

Explicit rejection codes4001000 (Wallet Standard) and4001 (Phantom) leave signing unexecuted and permit a new user-initiated attempt; generic/network errors remain UNKNOWN. A hung wallet promise is not proof of rejection or non-broadcast. Never silently resend it.

## Observation selection and recovery

- Every calculation has an as-of instant (`computedAt`). Use only observations received and validated no later than that instant. Latest analytical recomputation must be explicitly separated from historical trade/settlement replay. Persist actually used versions/hashes; never alter finalized results silently.
- Classify input usage: initialHistory, first, gapFill, correction. Only changes to an existing valid count are ordinary corrections subject to bucketEnd+24h. A missing value is not zero or a finalized count and may be filled after that deadline under recovery validation. Conflicting same-revision content is rejected. Audit ignored revisions.
- Accepted data remain DataStatus VALID when valid, even while new admission is RECOVERING. Exit/claim permissions use existing rules and valid data; admission does not blanket-pause exits.
- Regular collection is every 300 seconds. Recovery requires TWO distinct successful regular poll batches with advancing dataThrough, at least one regular interval apart. One batch with many minute buckets counts once. Replayed IDs, same interval rereads, bootstrap and bulk backfill do not count as two regular polls. Invalid/low activity breaks the streak. Persist PollBatch identity and RecoveryState across restart.
- A previously open market enters BLOCKED on low activity, invalid data or outage. First qualifying regular recovery => RECOVERING/count1; second => OPEN/count2, subject to capital/operator gates. Bootstrap readiness follows the existing preparation rule and cannot manufacture two recovery observations. Do not reset the outage emergency clock merely on a retry or partial backfill. A complete valid recovery ends the outage; admission may still be recovering.
- SnapshotCandidate includes queryHash and admission. Data publisher authenticates those values; B enforces admissible state and sequence/version binding, D/F display capabilities accordingly. Existing allowed free-chip behavior in preparing markets remains governed by its own capability rules.

## Identity and state projection

- Formula version is exactly `h3-d7-q12-v1`; B fixed [u8;16] encoding is ASCII plus trailing zero bytes, reject nonzero padding or unknown value. Hashes are lower-case 64 hex in transport and decoded 32 bytes on chain. queryHash travels with queryVersion through candidate, published snapshot and evidence.
- Chain market identity is cluster/program/address. B owns account/PDA layout and publishes a mapping/client and generated IDL when build succeeds. Snapshot sequence is a monotonic u64 per market; chain signatures/slots must come from the actual accepted transaction.
- Event dedup key is cluster/program/signature/eventIndex. Current FreeRecord projection key is cluster/program/recordId. Do not return the event log as current records. Reduce canonical finalized events in chain order, preserve terminal result, and apply proof links without counting a new selection. Supply transaction order or explicit record revision when slot alone is ambiguous; never silently sort competing transitions by arrival time.
- The initial implementation uses B's atomic on-chain admission counters for free limits. D's preflight is advisory; direct program calls must obey the same limits. Source availability/storage gates must also be bound to on-chain operator policy before public admission.

## Exact arithmetic

- Q12 activities and token amounts are u64 inputs (0..18446744073709551615). Formula input validation still requires positive denominators and graduation ratio <5. Price and maximum outputs must fit u64 or reject explicitly.
- `pg*dg*min(s,5*d)` can need 192 bits although each input fits u64. Use exact U256 or demonstrably equivalent full-width mul/div. Do not reject valid supported inputs merely because an intermediate u128 overflows; do not truncate by dividing early.
- Compute 5*d in a sufficiently wide type. Maximum reservation rounds up; price rounds down once at the end. Return consistent errors for invalid denominators, precision underflow and unsupported output range.
- Port ALL `contracts/fixtures/price-boundaries.json` vectors as well as golden.json to Rust. These include constant-ratio scaled activity, u64 boundary and genuine zero. JS BigInt is the reference, not evidence of executable chain safety.

## Evidence and storage

- QUEUED can have null payloadHash/manifestRef. READY_TO_ISSUE and ISSUED require nonnull payloadHash, complete manifestRef and verified references; enforce this at runtime. INVALID/REPLACED retain original evidence when available.
- Upload raw/calculation artifacts, construct canonical ProofPayload using their refs, freeze its bytes/hash, upload that final manifest, verify manifest AND every artifact's exact content/inclusion/20 parent confirmations, then issue SAS binding payloadHash and manifestRef. Manifest never includes its own locator/hash. Job retry/status metadata is outside hashed payload.
- ProofStatus.manifestRef locates the exact manifest; downloadable bytes must hash to payloadHash. Public proof retrieval must work without relying solely on the local job file.
- Normal confirmation polling is distinct from failed transmission. Failure retries use accepted 5/15/60-minute progression; 24h unresolved transfer/storage pressure gates new affected admissions while preserving existing close and evidence obligations. A single worker or durable lease prevents concurrent issue attempts; adapters reconcile uncertain outcomes with an idempotency key before issuing again.

## Integration evidence required

1. D real HTTP fixture API consumed by F (markets/profile/leaderboard/proof/null and replacement).
2. C single recovery poll remains closed; second distinct poll opens. Missing beyond24h fills, future validation is excluded from historical replay, versions survive replay.
3. D open->close and duplicate/out-of-order events produce one current record and one completed score.
4. B full-width vectors pass actual Rust tests; separately report Anchor build/IDL and validator availability.
5. E persisted job restart verifies final manifest; failed transfer vs confirmation wait and duplicate issue are checked.

Fixtures may prove the integration contract but never claim live X, deployed Solana, real SAS/Arweave, or real asset transfers.

The deployed web uses a shared API-anchored clock for auth/quote/prepared deadlines, UI expiry and financial instruction checks. Observe validated matching envelopes only, include full request duration conservatively, advance via monotonic elapsed time, and never move backward on old replies. Device wall time is only a pre-sync fallback; server and on-chain expiration checks remain authoritative. No TTL was extended.

Wallet receipt compatibility (2026-10-13): permit bounded ComputeBudget limit/price anywhere while preserving all application instruction order/data/accounts and payer/blockhash/signatures. Unsigned expired recovery requires finalized invalid lifetime and complete bounded payer history; any unmatched same-lifetime receipt retains UNKNOWN. FAILED with null signature and REQUOTE_REQUIRED is allowed only for established non-execution, and a later verified receipt can repair the classification. Client clears only unsigned terminal requote outcomes, never a known unresolved signature.
