# Integration contract 0.1

Read `../docs/implementation/A_CONTRACT.md` and `MVP_SPEC.md` before implementing.

- `types.ts`: semantic wire types. Runtime validation and IDL/account layouts remain producers' work.
- `reference.mjs`: exact integer reference for core equations; not a complete protocol implementation.
- `fixtures/golden.json`: synthetic shared expected values (not external observations).
- `reference.test.mjs`: conservation and boundary checks.

Run without dependency installation: `node --test contracts/reference.test.mjs`.

Schema changes belong to integration owner A. B/C/D/F must submit compatibility proposals rather than changing this directory independently. Consumer fixtures must label themselves as fixture data; unavailable live APIs must not silently return fixture success.

EWMA recurrence precision verification, live adapters, runtime schema validation, Anchor execution, Solana account layouts and direct-call quota enforcement are not proven by these reference tests.
