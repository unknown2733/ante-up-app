# Records and proofs

Your [Activity](/me) lists active and past chips from actual Devnet records. Open a record to inspect the market, owner, entry and exit times, result state, and proof link. Public profiles and rankings use those records. Reference subjects have no participant activity or attestations.

## Record lifecycle

**Place chip** creates an open on-chain record after wallet authorization and finality. **Take back chip** closes it and fixes a result or N/A. A current reference while a chip is open is not final and is excluded from the completed leaderboard.

A finalized transaction may take time to appear in the read model. Check operation and chain state after a timeout before another action. A note written by a wallet owner is an attributed user note, not a SAS attestation or independent data validation.

## Share a result card

Open a finalized, closed chip record and choose **Create result card**. Preview a 1080 × 1080 card, then **Save PNG**, **Copy record link**, or **Share image** on a browser that supports sharing files. Creating a card requires no wallet signature and does not post anything automatically.

Cards show the subject, attention change, public wallet, placement/return times, Devnet label and proof status at capture time. N/A stays N/A; an active or unfinalized chip has no completed result card. Attention change is not a cash return. The image is a snapshot, not an attestation: open its public record to check current evidence, corrections or replacement proof. Local sample cards have no public record link. Temporary reference chart values are never used for result cards.

## Proof lifecycle

Proof preparation, evidence storage, confirmation, and SAS issuance are later steps. The proof page can show queued, uploaded, confirming, ready, issued, invalid, or replaced states. Missing or pending proof status never fabricates an issued attestation. A record's `proofId` points to its proof; it need not equal the record ID. A replacement has its own link.

An issued attestation binds a payload hash and evidence reference; it does not prove the external source data were true. This public snapshot contains proof code, while some worker and operations follow-ups remain outside the R2 baseline. Check each proof's current status.

## Read next

- [Chips](/docs/chips)
- [Data and pricing](/docs/data-pricing)
- [FAQ](/docs/faq)
