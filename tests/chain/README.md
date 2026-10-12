# Chain verification plan

Runnable once Rust/Anchor/Solana are installed in WSL or Linux:

```sh
node --test contracts/reference.test.mjs
node --test tests/chain/encoding.test.mjs
cargo test -p ante_up_math
cargo check -p ante_up
anchor build
cd clients/chain && npm ci && npm run generate && npm run check && npm test
```

`ante_up_math` reads A's `contracts/fixtures/golden.json` and
`contracts/fixtures/price-boundaries.json` without editing them.
Additional Rust tests check curve split conservation and micro round trips,
zero-mark reserve retention, signed payout floor, fee conservation, Q held
through settlement, and claim movement without a second release.

`npm test` includes LiteSVM tests for the free lifecycle and the financial
cycle. The latter seeds a local tUSD mint and owner accounts, then calls the
compiled program for faucet, registration, curve buy/sell, graduation, spot
buy/sell, long and short Pro entry/close/claim, immutable maturity settlement,
and LP deposit/redemption. It checks actual SPL account balances, reserve
counters, mint authority revocation, cap rejection and repeat-claim rejection.
These tests load the
actual compiled program from `ANTE_UP_SBF_PATH` (or `target/deploy/ante_up.so`).
Without an SBF binary the test reports a skip. LiteSVM 1.6 has no Windows
native binding, so run this step on Linux after producing the `.so` there.
The generated event/account codec tests run on Windows without LiteSVM.

Additional local validator tests still required before integration:

- Concurrent `register_market` calls produce one market and charge only the
  successful payer's rent.
- Two wallet `open_free` calls at wallet/global limits serialize on the same
  writable admission account; only permitted entries succeed. Move clock
  across the exact 24-hour boundary and verify eviction.
- Direct program calls with no API cannot bypass the 3 open / 1 market / 6
  wallet day / 100 global day / 200 proof duty checks.
- Disabled gate and missing/stale data still allow existing `close_free`;
  it preserves N/A and releases only the concurrent slot.
- Valid zero exit records a negative 100% return; zero entry records N/A.
- `complete_proof` rejects an open record and repeat calls, and frees the duty
  only after the authorized external verifier calls it.
- A failed transaction rolls back all counters and PDA writes.

The financial LiteSVM case is source-ready but has not run on this Windows
host. A successful Linux run is required before claiming executable SPL
behavior. Concurrent races, token-account substitution, stale LP reset, and
malicious settlement publisher cases remain for local-validator validation.
