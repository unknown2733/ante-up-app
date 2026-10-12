# Ante Up contributor instructions

Read README.md for current implementation and verification boundaries. Then read
docs/implementation/CONTRACT_V02.md and the relevant source/tests. Historical
design notes preserve earlier decisions; do not treat their old TBDs as current.

Preserve Live/Demo separation, wallet authorization, finalized-chain validation,
liability reservations and existing user data. Never place private credentials
in VITE_* inputs, commit operator keys, or claim simulated data is live evidence.

Use module lockfiles; no root npm workspace is configured. Run relevant tests
and report skipped native checks separately. Financial semantics require explicit
review against the shared contracts and program code.
