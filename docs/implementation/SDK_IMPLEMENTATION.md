# Accepted SDK implementation — 2026-10-12

User accepted official stack reuse and continued implementation. Contract 0.2 and product economics remain unchanged. No credentials are available; live providers, deployed execution and permanent upload must not be claimed.

## Shared boundaries

- B owns Anchor/IDL/Codama Kit client under clients/chain, program tests and portable build configuration. Compile first; never manufacture an IDL and label it generated. Keep generated artifacts reproducible. If native tools unavailable, attempt a workspace-local toolchain or provide tested dependency checks and portable build instructions.
- F owns apps/web: Wallet Standard + Kit signing boundary and Android MWA, preserve fixture mode and HTTP API. Do not rebuild economic math or fabricate live writes. Consume instruction/transaction bytes supplied by a typed boundary; reject wallet/cluster changes, expired requests and unsupported wallets explicitly.
- C/E owns services/data and services/evidence: real X Counts transport and budget-gated scheduler plus Turbo/SAS adapters, durable jobs. SDK calls only under explicit configured live execution. Keep injection boundaries for tests, missing/zero separation, receipt + inclusion + 20 confirmations, fail closed on mismatched evidence. No credentials or paid calls this phase.
- D owns services/api/indexer/keeper: persistent read projection/cursors and real RPC adapter, finalized-only reads, transaction request boundary; no endpoint may report successful chain writes when not submitted. External clients isolated from core. Do not decode custom program binary by hand; use B generated client when ready, otherwise a fail-closed decoder interface.
- A integrates source commits, resolves shared boundaries, tests real adapter encoding against the selected SDK, and maintains vault records. Each continuing session uses its OWN clone, fetches this integration repository and merges the SDK baseline first. No new threads, remote push or deployment. Commit only ownership paths plus HANDOFF role file.

## SDK decisions

Anchor + IDL/Codama Kit client; Kit + Wallet Standard + MWA mobile web; managed Devnet RPC; LiteSVM/Surfpool; SAS sas-lib; Turbo SDK; standard token program for test assets. Package versions must be confirmed against the registry and pinned in module lockfiles. No root workspace migration in parallel.

Phantom Connect and Meteora are not mandatory dependencies. Kora remains a follow-up candidate. User credentials absent; environment examples contain placeholders only. Free web path is first end-to-end target, monetary actions remain unavailable until real custody and liability transitions are implemented.
