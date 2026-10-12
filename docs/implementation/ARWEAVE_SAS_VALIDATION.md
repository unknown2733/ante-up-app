# Arweave / SAS live validation — 2026-10-12

## Current boundary

**Completed at 2026-10-12 21:22 KST.** Raw Counts responses, calculation/replay inputs and the result manifest passed receipt signatures, parent transaction signatures/data roots, ANS-104 item signatures, exact canonical-content hashes and the **20-confirmation minimum**. The worker issued at a minimum of **22 confirmations**, finalized SAS and protocol completion, and linked the record in the indexer. A separate verifier without signing/upload keys confirmed all claims and queried the real HTTP API through the web client: `VERIFIED_FINALIZED`, `ISSUED`, matching SAS ID and proof hash.

Target finalized free record: `CjbpsPJJyqKBxoAmUcMTet5HNXz6hQxeeHquAN4afJTN`, snapshot3 → snapshot4, CLOSED_RESULT, +0.02515197%. The separate N/A record is outside this run.

The server worker `ante-up-evidence-validation` completed successfully and exited. During normal confirmation waiting it resumed the durable job every five minutes. It issued SAS only after the storage and semantic gates, then submitted `completeProof`, imported the proof into the indexer, and checked finalized SAS claims and the protocol hash. Any actual verification error stops this runner; it does not skip the gate.

Evidence: worker final readback (private deployment evidence), independent chain + HTTP verification (private deployment evidence), SAS submission (private deployment evidence).

- SAS attestation: `DN2EiezD8DZFuspcDxjMXxf2iDnujpQPXjpwcb1MuVzE`.
- SAS finalized transaction: `46WQeVdrxu3pzfbqVCChyWF57GShsR8MnEjkERyBQPhYek3zYvgvxVBnuAMM6mbg8xDYSucQgDv86VCwth357iQP`.
- Protocol finalized completion: `4MEfkcK8p1YpYDTQf4ANXAjE1jeZUJvnSwXBaK8RhCAjvzwYdctVto41q2fFPcZLdqUcpscpo1tGGbsRf2W3ynZv`.
- No additional Arweave charge during confirmation waiting/restarts: balance remained `1,169,149,925,311 winc` at the final preflight.

## Public identifiers

| Item | Address / ID |
| --- | --- |
| Arweave uploader | `EQn0YOvg1UAJMRCYwvejTD0_VZRqu4BZGoltRPTGMbA` |
| Devnet program | `FrMATpA81wUMYsZufQkew9K5MW2AC8rgdYQ2wUM6KDKr` |
| SAS issuer | `9WYPtXD1C4CJmsRcN6LaG5frQdvhKpyQuL4RxiZcSRdu` |
| Finalized SAS credential | `4fzmAuhPs9gxqCauNLRfwKAMT4WHahyybetxPBYj7jxB` |
| Finalized SAS schema | `CsvxMDQnV16g1tmMsUexzG6h1srAbG2EbTno2jGn9H3p` |
| Calculation artifact | `kn0PKZR1QdhpdWBjyHeyP2vNmrkZ2jhuB47NGT3yMaY` |
| Initial raw artifact | `qpijWidnn3tCm4ImjxOIYgqwgACGfnEuwpq2DGhENzU` |
| Follow-up raw artifact | `bJMP0uq_RMZnnYdpAuM3ilCcNGFgsCdEdE3lNy_YQSU` |
| Follow-up raw artifact | `kDMMbPK5ELPJ_BnXEacXL_c4NgSWcu83MiQEQAv-FV0` |
| Manifest | `XRa1ySG57iccScTDyarePB7IZQJZK73HJpV3xo3CEaw` |
| Manifest / protocol proof hash | `c60b96a6d2d3b54a5570f725ebdba3921bdaee4b1c90407d54c4ecd0b422aaf4` |

Calculation parent: `B6CV9mBGWAWhZA0t8h8CrB1l73tMwG-P7eC_8zLvQk0`. Raw-artifact parent: `XZIpjWNufXLd5uOmKiNC15BmkYgb0-KCSBc4e0JgFmo`. Manifest parent: `rqXouqcE7K5bTm8q0mfSlb4e0i4C-hx2p369VT2ypbc`.

Historical follow-up at 20:41 KST: worker state `CONFIRMING`, minimum confirmations **1**, no error. The manifest parent/content checks had passed; SAS submission and protocol completion were then null. This wait is now resolved.

SAS schema is one Borsh string (`layout=[12]`, field `claims`) containing canonical JSON. The codec now includes the required four-byte little-endian length. This validation freezes expiry `1823339312` in its job; this is a test configuration, not a new product-wide expiry decision.

## Storage and cost measurements

| Artifact | Canonical JSON bytes | Stored bytes |
| --- | ---: | ---: |
| Entry + exit calculation inputs | 31,067,776 | 693,263 |
| Initial 28-day raw response | 7,016,560 | 527,381 |
| Follow-up response | 1,912 | 1,912 |
| Follow-up response | 607 | 607 |
| Total, excluding manifest | **38,086,855** | **1,223,163** |

Large artifacts use lossless gzip (`application/gzip`, not HTTP Content-Encoding). The content hash always identifies the original canonical JSON. Verification decompresses and compares those exact bytes. Tiny artifacts remain JSON. This preserves the full source and replay history while reducing storage by about 96.8%.

After funding, balance was `1,193,725,632,763 winc`; after accepted uploads it was `1,169,149,925,311 winc`. No invoice amount is inferred. The difference is `24,575,707,452 winc`, including a duplicate calculation upload during receipt-persistence debugging.

At the sampled live quote, the required compressed packet plus a 16KB manifest allowance costs about 15.9 billion winc, around $0.10 of purchasing power using the contemporaneous $5 top-up quote (not a receipt for actual dollars spent). Remaining credits cover roughly 73 similarly sized full packets, or around 130 calculation-only packets when raw artifacts are already shared. These are size-based estimates, not guaranteed monthly capacity. A 300-record scenario is roughly 367MB / $30 at the current full-packet size; reusing all raw artifacts reduces this toward 208MB / $17. History growth and price changes can increase it.

The current validation archives a full replay history per record. Before increasing usage, shared calculation checkpoints/deltas need implementation and measurement; five-minute API polling does not imply re-uploading the whole 38MB history every five minutes. X API fees, RPC fees and Devnet account rent are separate.

## Corrections found in the real connection

1. Turbo SDK responses contain helper/undefined fields unsuitable for strict canonical serialization. JSON receipt normalization and a content-hash receipt cache now run before engine journaling.
2. Two calculation item IDs were accepted before the original receipt journal succeeded. The unused duplicate is `WPZbYwHoWbJiCCvk9ahkBrvLhFOyytblDuOeheQQBDg`. It remains permanently stored; no deletion/refund is claimed. The original signed item was independently recovered and submitted byte-for-byte to recover its genuine receipt, charged `0 winc`. Subsequent runs reuse that receipt and ID.
3. The real gateway does not expose the previously expected verification/inclusion headers. The live runner now uses independent bounded full-bundle verification, rather than interpreting `x-ar-io-trusted` as inclusion evidence.
4. The pinned arbundles string-ID accessor selects the wrong offset. Our inclusion parser validates header lengths, unique IDs and full bundle extent, selects the exact item bytes, and verifies their signature and ID independently.

The receipt cache prevents replaying known accepted uploads. Follow-up implementation adds `upload-journal.mjs`: signed ANS-104 bytes are saved and fsynced before transport, and an uncertain response is retried using the exact same bytes/ID. A restart test simulates service acceptance followed by response loss, confirms identical replay, rejects changed input, and confirms no third transport call after receipt persistence. Existing receipts are reused unchanged. The final restarted validation worker used this configuration but needed no new uploads; real response loss was not deliberately induced. A partial/corrupt local file fails closed. Cross-process leases and storage durability beyond local fsync remain operational work.

Mutable parent status responses now request no-cache/no-store with a per-check query parameter. The live status endpoint advertised 120-second caching, and cached replies lagged fresh queries. Immutable item bytes still receive full signature/hash verification; the confirmation requirement was not reduced.

## Verification and trust boundary

Initial Windows and Linux evidence suites: **23 passed, 0 failed, 0 skipped**. Follow-up Linux suite including response-loss recovery: **24 passed, 0 failed, 0 skipped**; the added recovery test also passed locally. The final status-cache change and journal path passed four targeted Linux tests. Tests include a locally signed real Arweave transaction/bundle, corrupted data-root rejection, maximum-size rejection, SAS Borsh decoding, service receipt tampering, compression round-trip and 19-confirmation manifest blocking.

Real source replay and the four artifact signatures/hash/inclusion checks passed. At the read-only check, calculation parent had 8 confirmations, raw parent 1, and the manifest parent was pending. These are observations, not final status.

`receipt.mjs` pins service address `JNC6vBhjHY1EPwV3pEeNmrsgFMxH5d38_LHsZ7jful8` and receipt version 0.2.0. Fee/cache fields are outside the signed transcript. `inclusion.mjs` verifies Arweave parent signature/data root and the selected ANS-104 item. Parent confirmation status still relies on the Arweave node response; this is not a locally validated chain node. Full bundles above 64MiB fail closed; decompressed content is capped at 128MiB. A range/Merkle-proof implementation remains necessary for larger bundles.

## Durable execution and handoff

Server code: `/srv/example-app/builds/4b658eb`.
State: `/srv/example-app/builds/runtime-state/live-smoke/evidence/`.

- `jobs.json`: immutable proof payload, artifacts, receipts, retries, SAS/completion journals.
- `runtime.json`: credential/schema and frozen expiry.
- `preflight.json`: latest cost/size/balance measurement.
- `receipts/`: content-hash keyed accepted receipts.
- `storage-verification.json`: read-only content/inclusion checks.
- `result.json`: latest worker status.
- `sas-submission.json`, `final-readback.json`: created only when those stages execute.

`scripts/prove-devnet.mjs` requires explicit execution opt-in, Devnet genesis, secret **file paths**, record ID and upload budget. `--follow` resumes this job until completion or a real error. `scripts/verify-arweave-storage.mjs` is read-only and requires no private key. `scripts/recover-turbo-receipt.mjs` is deliberately restricted to the already accepted item above.

`scripts/verify-devnet-proof.mjs` is a separate verifier requiring only the RPC URL file, record ID and live state directory. It derives the expected SAS PDA; checks finalized program ownership, issuer/credential/schema/expiry and exact claims; compares the protocol proof hash and indexer link; then starts an ephemeral loopback API and queries it through the real web HTTP client. It does not mount payer, issuer or uploader keys. It reports `PENDING` or `SAS_FINALIZED` until the entire completion chain is available. `ANTE_UP_VERIFY_REPORT` optionally stores its report.

Secrets remain on the server and outside Git. Collection and public admission remain stopped/closed. Public HTTPS, real mobile-wallet UI, the second N/A proof and the complete live financial flow are not validated by this run.
