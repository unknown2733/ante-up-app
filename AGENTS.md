# Ante Up contributor instructions

Read README.md and docs/DEVELOPMENT.md before changing the app. Use the relevant
source, shared contracts, and tests as the implementation reference. Product
articles in docs/product/ describe the public user experience.

Preserve observed versus illustrative data provenance, wallet authorization,
finalized-chain validation, liability reservations, and existing user data.
Never place private credentials in VITE_* inputs or commit operator keys.
Never claim simulated data is live evidence.

Use module lockfiles; there is no root npm workspace. Run relevant tests and
report skipped native checks separately. Review financial changes against the
shared contracts and program code.
