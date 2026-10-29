/** Independently read back the finalized Snapshot archive before considering account retirement. */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSnapshotPda, getSnapshotDecoder } from '../clients/chain/dist/index.js';
import { snapshotViewFromGenerated, verifyPublishedSnapshot } from '../services/indexer/src/snapshot.ts';
import { canonical, hash as canonicalHash } from '../services/data/index.mjs';

const kit = createRequire(new URL('../clients/chain/package.json', import.meta.url))('@solana/kit');
const PROGRAM = 'FrMATpA81wUMYsZufQkew9K5MW2AC8rgdYQ2wUM6KDKr';
const hex = /^[0-9a-f]{64}$/;
const check = (condition, code) => { if (!condition) throw new Error(code); };

export async function verifyArchive({ archivePath, expectedSha256 }) {
  check(hex.test(expectedSha256 ?? ''), 'ARCHIVE_TRUSTED_SHA256_REQUIRED');
  const fileSha256 = createHash('sha256').update(await readFile(archivePath)).digest('hex');
  check(fileSha256 === expectedSha256, 'ARCHIVE_FILE_HASH_MISMATCH');
  const db = new DatabaseSync(archivePath, { readOnly: true });
  try {
    check(db.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok', 'ARCHIVE_SQLITE_INVALID');
    const manifestRows = db.prepare('SELECT key,value FROM manifest').all();
    check(manifestRows.length === 1 && manifestRows[0].key === 'summary', 'ARCHIVE_MANIFEST_INVALID');
    const summary = JSON.parse(manifestRows[0].value);
    check(summary.schemaVersion === 1 && summary.cluster === 'devnet' && summary.programId === PROGRAM &&
      /^(0|[1-9][0-9]*)$/.test(summary.scanSlot) && hex.test(summary.digest) &&
      (summary.parentArchiveSha256 === undefined || summary.parentArchiveSha256 === null ||
        hex.test(summary.parentArchiveSha256)) &&
      Number.isSafeInteger(summary.markets) && Number.isSafeInteger(summary.snapshots), 'ARCHIVE_MANIFEST_INVALID');
    // Export uses JavaScript localeCompare, which differs from SQLite byte ordering.
    const rows = db.prepare('SELECT market,sequence,address,payload_hash,account_sha256,account_data,event_json,candidate_json FROM snapshots').all()
      .sort((a, b) => a.address.localeCompare(b.address));
    const digest = createHash('sha256');
    const sequences = new Map();
    const addresses = new Set();
    for (const row of rows) {
      check(typeof row.market === 'string' && /^(?:[1-9][0-9]*)$/.test(row.sequence) &&
        typeof row.address === 'string' && hex.test(row.payload_hash) && hex.test(row.account_sha256) &&
        row.account_data instanceof Uint8Array && row.account_data.length === 264, 'ARCHIVE_ROW_INVALID');
      check(!addresses.has(row.address), 'ARCHIVE_DUPLICATE_ADDRESS');
      addresses.add(row.address);
      const accountSha = createHash('sha256').update(row.account_data).digest('hex');
      check(accountSha === row.account_sha256, 'ARCHIVE_ACCOUNT_HASH_MISMATCH');
      const decoded = getSnapshotDecoder().decode(row.account_data);
      const [pda] = await findSnapshotPda({ market: kit.address(row.market), sequence: BigInt(row.sequence) },
        { programAddress: kit.address(PROGRAM) });
      check(String(pda) === row.address && String(decoded.market) === row.market &&
        decoded.sequence.toString() === row.sequence, 'ARCHIVE_PDA_MISMATCH');
      const candidate = JSON.parse(row.candidate_json);
      const event = JSON.parse(row.event_json);
      check(canonicalHash(candidate) === row.payload_hash && candidate.marketId === row.market &&
        candidate.sequence === row.sequence, 'ARCHIVE_CANDIDATE_MISMATCH');
      check(event.kind === 'snapshot' && event.finality === 'finalized' &&
        event.snapshot?.chain?.address === row.address &&
        event.snapshot?.payloadHash === row.payload_hash &&
        event.snapshot?.signature === event.signature && event.snapshot?.slot === event.slot,
      'ARCHIVE_EVENT_MISMATCH');
      const view = snapshotViewFromGenerated(decoded, row.address, PROGRAM);
      const verified = verifyPublishedSnapshot({ cluster: 'devnet', programId: PROGRAM,
        signature: event.signature, slot: event.slot, marketAddress: row.market, marketId: row.market,
        sequence: row.sequence, eventPayloadHash: row.payload_hash, candidate, account: view });
      check(verified.publishedAt === event.snapshot.publishedAt &&
        canonical(verified.payload) === canonical(event.snapshot.payload) &&
        canonical(verified.chain) === canonical(event.snapshot.chain), 'ARCHIVE_VERIFICATION_MISMATCH');
      digest.update(`${row.market}\0${row.sequence}\0${row.address}\0${row.payload_hash}\0${accountSha}\n`);
      const seen = sequences.get(row.market) ?? new Set();
      check(!seen.has(row.sequence), 'ARCHIVE_DUPLICATE_SEQUENCE');
      seen.add(row.sequence); sequences.set(row.market, seen);
    }
    for (const seen of sequences.values()) {
      for (let sequence = 1n; sequence <= BigInt(seen.size); sequence++)
        check(seen.has(sequence.toString()), 'ARCHIVE_SEQUENCE_INCOMPLETE');
    }
    check(rows.length === summary.snapshots, 'ARCHIVE_COUNT_MISMATCH');
    // The export counts markets with no published snapshots too; those have no row here.
    check(sequences.size <= summary.markets, 'ARCHIVE_MARKET_COUNT_MISMATCH');
    check(digest.digest('hex') === summary.digest, 'ARCHIVE_DIGEST_MISMATCH');
    return { ...summary, fileSha256, integrity: 'ok' };
  } finally { db.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [archivePath, expectedSha256] = process.argv.slice(2);
  if (!archivePath || !expectedSha256) {
    console.error('Usage: node scripts/verify-snapshot-archive.mjs ARCHIVE_DB TRUSTED_SHA256');
    process.exitCode = 2;
  } else {
    verifyArchive({ archivePath, expectedSha256 })
      .then(result => console.log(JSON.stringify(result)))
      .catch(error => { console.error(String(error?.message ?? error).slice(0, 120)); process.exitCode = 1; });
  }
}
