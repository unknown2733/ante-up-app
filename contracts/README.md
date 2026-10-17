# Integration contract 0.1

Read the shared types, reference calculations, program code, and tests before
changing a wire or financial contract. The public setup guide is
[`docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md).

- `types.ts`: semantic wire types. Runtime validation and IDL/account layouts remain producers' work.
- `reference.mjs`: exact integer reference for core equations; not a complete protocol implementation.
- `fixtures/golden.json`: synthetic shared expected values (not external observations).
- `reference.test.mjs`: conservation and boundary checks.

Run without dependency installation: `node --test contracts/reference.test.mjs`.

Coordinate schema changes across API, web, indexer, and program consumers.
Consumer fixtures must label themselves as fixture data; unavailable live APIs
must not silently return fixture success.

EWMA recurrence precision verification, live adapters, runtime schema validation, Anchor execution, Solana account layouts and direct-call quota enforcement are not proven by these reference tests.
