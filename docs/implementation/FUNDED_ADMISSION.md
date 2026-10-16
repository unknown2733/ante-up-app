# Funded free-chip admission — Devnet MVP

## Contract

The Admission PDA uses its original 1,032-byte allocation. The added
`funded_open_cap: u64` and `funded_open_count: u64` occupy 16 bytes of
previously zero-filled space; the account address and existing fields are
unchanged. Existing accounts decode as cap 0, count 0 immediately after the
program upgrade.

`open_free` rejects a request when count reaches cap and increments count
atomically with its existing per-wallet, daily and outstanding counters.
`close_free` and `complete_proof` remain available at cap and do not refund
an admission. Only the admin can call `raise_funded_open_cap`, and the cap
must increase. The transaction does not itself observe Turbo balance:
funding verification is an operator precondition.

The live API reads the finalized account and reports
`BUDGET_EXHAUSTED / FUNDED_PROOF_CAP` for a new chip when the cap is spent.
The chain check remains authoritative for concurrent entries.

## Operator procedure

1. Reconcile existing finalized closed records and proof jobs. Resolve any
   unproved backlog before enabling automatic discovery.
2. Verify the proof worker is healthy and automatic intake is active. Keep
   its budget guard close-only.
3. Run `scripts/raise-funded-admission.mjs <new-cumulative-cap>` for a
   read-only preflight. It reserves the maximum configured proof cost for
   **every** unused cap slot plus currently outstanding proof duties against
   total, daily and Turbo balances.
4. Run the same command with `--execute`. It journals the signed transaction
   before broadcast and requires finalized account readback. If the prior
   gate was closed, the same transaction reopens it after raising the funded
   cap. An uncertain journal must be reconciled before any new attempt.
5. Check finalized cap/count, public market capability and worker health.
   When the cap is spent, new admissions stop; existing chip exits and proofs
   continue.

The operator must raise the configured spending ceiling and actually fund
Turbo before increasing the cap beyond available reserve. Fee, storage and
provider behavior remain operational dependencies.

## 2026-10-16 Devnet verification

- Program ID: `FrMATpA81wUMYsZufQkew9K5MW2AC8rgdYQ2wUM6KDKr`.
- Compiled SBF: 695,152 bytes, SHA-256
  `931a7049f7885c52f94bb58e6d9c747ca0fd21986f334c4119961e6e1a4bec5c`.
- Upgrade signature:
  `2ooYSHXZ3xepSdyUxdQgBAgYst3jzXjTyYAPpPK1wVhgqMTroVYKxzHLCHpeqhVhNgrKWfQyy43s4MwkvbaMjC5W`.
  Finalized program slot: 511685867. The downloaded program data equals
  the compiled binary over its first 695,152 bytes; the remaining 8,168
  loader allocation bytes are zero.
- Existing finalized proof inventory before automatic intake: 8 numeric,
  1 N/A, 0 unproved. Automatic intake became healthy before the cap changed.
- Finalized cumulative cap: 1; count: 0 immediately after the change.
  Cap change signature:
  `2QfsQ4NPc94Zx93LDDim6YPt1ifXnxGNjhFwtFriDMdMfu49TxKGd6EKkL3bkj6FVqDAYfiBZ9q7WfmwXLGbpcLy`.
- Budget preflight: total reserved 80,823,248,142 / 100,000,000,000
  winc; daily reserved 43,513,214,654 / 60,000,000,000 winc; maximum
  one-new-proof reserve 15,000,000,000 winc. These are a dated snapshot,
  not a standing guarantee.
- Linux native chain tests: 17/17, including a new cap-exhaustion test;
  API: 76 passed, one existing skip; proof budget helper: 3/3.

Current free-chip capacity is one new admission across the eligible markets.
Additional visitors need new verified proof capacity and an admin cap raise.
The live financial markets and mobile wallet QA are separate work.
