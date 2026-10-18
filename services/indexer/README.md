# Finalized chain indexer

Node 24, SQLite WAL, and exact `@solana/kit@8.4.0` are used. The Kit transport reads finalized signatures, transactions, and block signature order. The single-process poller stores paginated scan state before decoding, then commits finalized events, current projections, and the head cursor in one SQLite transaction. A missing transaction, missing decoder, historical gap, conflicting event, or unresolved sparse event leaves the cursor behind for retry.

Build B's generated client before running decoder tests or polling:

```text
npm ci --prefix clients/chain
npm run build --prefix clients/chain
npm ci --prefix services/indexer
npm run check --prefix services/indexer
npm test --prefix services/indexer
```

`src/generated-decoder.ts` reads Anchor `Program data:` only inside the expected program invocation frame and uses B's generated event codecs. Open/close events carry historical record points; the current record projection requires an OPEN before CLOSE and keeps the original entry signature. `ProofCompleted` carries a payload hash, so a `ProofResolver` must map `(record address, payload hash)` to a public proof ID. `SnapshotPublished` carries only market, sequence, and payload hash; a `SnapshotResolver` must return the immutable C candidate and B Snapshot account. The verifier recomputes the canonical candidate hash and checks market, versions, formula, data, admission, and owner identity. The resolver must fetch and verify the account PDA and owner from finalized RPC evidence. These resolvers are not configured in the included CLI; encountering those events stops indexing without publishing a partial read model.

`npm run poll:once --prefix services/indexer` requires `ANTE_UP_CLUSTER`, `ANTE_UP_PROGRAM_ID`, `ANTE_UP_RPC_URL`, and `ANTE_UP_INDEX_DB`. No RPC URL or keys are bundled, and the CLI is not run by tests.

The poller now constructs the generated decoder and SQLite backed resolvers by default; `ANTE_UP_DECODER_MODULE` is an optional override. `ANTE_UP_CANDIDATES_PATH` imports C's `FileCandidateRepository` JSON, including pre-finality publication jobs, and `ANTE_UP_PROOFS_PATH` imports E's compact `jobs.json.index.json` proof-link handoff before polling. The full `jobs.json` recovery journal must stay with the evidence worker because its raw content can grow large enough to exhaust the indexer heap. The candidate is keyed by market PDA, sequence and canonical hash. The resolver fetches the immutable Snapshot PDA with finalized Kit RPC, checks owner and discriminator, then compares all account fields and candidate hash. A proof event resolves `(record PDA, payload hash)` to E's public proof ID. Missing inputs stop cursor advancement. These JSON paths are local artifacts, not API keys.

Artifact files are refreshed before **every** `pollOnce` call, including retries of a pending finalized event. A missing file can appear later without restarting the indexer. `npm run poll:follow --prefix services/indexer` keeps one poller running; `ANTE_UP_POLL_INTERVAL_MS` sets its interval from 1 to 300 seconds (default 5). A missing candidate or proof leaves the cursor pending, and a later poll retries it after refresh. `poll:once` retains the one-cycle behavior.

The SQLite projection is suitable for one local writer. Production still needs resolver implementations, observation/evidence storage binding, catch-up and monitoring policy, and live RPC validation before read-model exposure. Auth nonces, API operations, and keeper attempts remain separate in-memory boundaries.
