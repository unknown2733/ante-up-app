/** Preserve verified finalized Snapshot bytes before any future rent recovery. */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { open, link, mkdir, unlink, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KitFinalizedAccountReader } from '../services/indexer/src/repositories.ts';
import { TrustedSnapshotArchive } from '../services/indexer/src/snapshot-archive.ts';
import { snapshotViewFromGenerated, verifyPublishedSnapshot } from '../services/indexer/src/snapshot.ts';
import { findSnapshotPda, getMarketDecoder, getSnapshotDecoder, MARKET_DISCRIMINATOR, SNAPSHOT_DISCRIMINATOR } from '../clients/chain/dist/index.js';
import { canonical, hash as canonicalHash } from '../services/data/index.mjs';

const PROGRAM = 'FrMATpA81wUMYsZufQkew9K5MW2AC8rgdYQ2wUM6KDKr';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const kit = createRequire(new URL('../clients/chain/package.json', import.meta.url))('@solana/kit');
const matches = (data, discriminator) => Buffer.from(data.subarray(0, 8)).equals(Buffer.from(discriminator));
const check = (condition, code) => { if (!condition) throw new Error(code); };
const safeError = error => String(error?.message ?? error).replace(/https?:\/\/[^\s"'<>]+/g, '[RPC_URL_REDACTED]').slice(0, 180);

export async function buildArchive({ sourceDb, outPath, rpcFile, create = false, accounts, genesis,
  priorArchivePath, priorArchiveSha256, rpc: injectedRpc }) {
  check(Boolean(priorArchivePath) === Boolean(priorArchiveSha256), 'ARCHIVE_PRIOR_CONFIG_INCOMPLETE');
  check(!priorArchiveSha256 || /^[0-9a-f]{64}$/.test(priorArchiveSha256), 'ARCHIVE_PRIOR_HASH_INVALID');
  check(!priorArchivePath || resolve(priorArchivePath) !== resolve(outPath), 'ARCHIVE_PRIOR_OUTPUT_SAME');
  const endpoint = (await readFile(rpcFile, 'utf8')).trim();
  check(/^https:\/\//.test(endpoint), 'DEVNET_RPC_REQUIRED');
  const rpc = injectedRpc ?? kit.createSolanaRpc(endpoint);
  check((genesis ?? await rpc.getGenesisHash().send()) === DEVNET_GENESIS, 'DEVNET_GENESIS_MISMATCH');
  const prior = priorArchivePath ? new TrustedSnapshotArchive(priorArchivePath, priorArchiveSha256, PROGRAM) : undefined;
  const reader = accounts ?? new KitFinalizedAccountReader(endpoint, rpc, prior);
  const scan = await reader.scan(PROGRAM);
  const source = new DatabaseSync(sourceDb, { readOnly: true });
  let archive;
  const partial = `${outPath}.partial-${process.pid}`;
  let partialCreated = false;
  try {
    const eventRows = source.prepare("SELECT event_json FROM finalized_events WHERE cluster='devnet' AND program_id=? AND kind='snapshot'").all(PROGRAM);
    const events = new Map();
    for (const row of eventRows) {
      const event = JSON.parse(row.event_json);
      const key = event.snapshot?.chain?.address;
      check(event.finality === 'finalized' && event.kind === 'snapshot' && typeof key === 'string' && !events.has(key), 'ARCHIVE_EVENT_INVALID');
      events.set(key, event);
    }
    const markets = new Map(), seen = new Map();
    for (const row of scan.accounts) {
      if (!matches(row.data, MARKET_DISCRIMINATOR)) continue;
      const market = getMarketDecoder().decode(row.data);
      check(!markets.has(row.address), 'ARCHIVE_DUPLICATE_MARKET');
      markets.set(row.address, market.latestSequence);
    }
    const snapshots = scan.accounts.filter(row => matches(row.data, SNAPSHOT_DISCRIMINATOR));
    check(snapshots.length === events.size, 'ARCHIVE_EVENT_COUNT_MISMATCH');
    if (create) {
      await mkdir(dirname(outPath), { recursive: true });
      const handle = await open(partial, 'wx', 0o600);
      await handle.close();
      partialCreated = true;
      archive = new DatabaseSync(partial);
      archive.exec(`PRAGMA journal_mode=DELETE;
        CREATE TABLE snapshots(market TEXT NOT NULL,sequence TEXT NOT NULL,address TEXT NOT NULL,
          payload_hash TEXT NOT NULL,account_sha256 TEXT NOT NULL,account_data BLOB NOT NULL,
          event_json TEXT NOT NULL,candidate_json TEXT NOT NULL,
          PRIMARY KEY(market,sequence),UNIQUE(address));
        CREATE TABLE manifest(key TEXT PRIMARY KEY,value TEXT NOT NULL); BEGIN IMMEDIATE;`);
    }
    const insert = archive?.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?,?)');
    const digest = createHash('sha256');
    for (const row of snapshots.sort((a, b) => a.address.localeCompare(b.address))) {
      check(row.ownerProgramId === PROGRAM && row.data.length === 264, 'ARCHIVE_ACCOUNT_INVALID');
      const decoded = getSnapshotDecoder().decode(row.data);
      const market = String(decoded.market), sequence = decoded.sequence.toString();
      const [expectedPda] = await findSnapshotPda({ market: kit.address(market), sequence: decoded.sequence },
        { programAddress: kit.address(PROGRAM) });
      check(String(expectedPda) === row.address, 'ARCHIVE_PDA_MISMATCH');
      const payloadHash = Buffer.from(decoded.payloadHash).toString('hex');
      const event = events.get(row.address);
      check(event && event.snapshot.payloadHash === payloadHash && event.snapshot.payload.marketId === market &&
        event.snapshot.payload.sequence === sequence, 'ARCHIVE_EVENT_MISMATCH');
      const candidateRow = source.prepare('SELECT candidate_json FROM snapshot_candidates WHERE cluster=? AND program_id=? AND market_address=? AND sequence=? AND payload_hash=?')
        .get('devnet', PROGRAM, market, sequence, payloadHash);
      check(candidateRow, 'ARCHIVE_CANDIDATE_MISSING');
      const candidate = JSON.parse(candidateRow.candidate_json);
      check(canonicalHash(candidate) === payloadHash, 'ARCHIVE_CANDIDATE_HASH_MISMATCH');
      const view = snapshotViewFromGenerated(decoded, row.address, row.ownerProgramId);
      const verified = verifyPublishedSnapshot({ cluster: 'devnet', programId: PROGRAM,
        signature: event.signature, slot: event.slot, marketAddress: market, marketId: market,
        sequence, eventPayloadHash: payloadHash, candidate, account: view });
      check(verified.publishedAt === event.snapshot.publishedAt &&
        canonical(verified.payload) === canonical(event.snapshot.payload), 'ARCHIVE_VERIFICATION_MISMATCH');
      check(markets.has(market), 'ARCHIVE_MARKET_MISSING');
      const count = seen.get(market) ?? 0n;
      seen.set(market, count + 1n);
      const sha = createHash('sha256').update(row.data).digest('hex');
      digest.update(`${market}\0${sequence}\0${row.address}\0${payloadHash}\0${sha}\n`);
      insert?.run(market, sequence, row.address, payloadHash, sha, Buffer.from(row.data),
        JSON.stringify(event), candidateRow.candidate_json);
    }
    for (const [market, latest] of markets) check((seen.get(market) ?? 0n) === latest, 'ARCHIVE_SEQUENCE_INCOMPLETE');
    const result = { schemaVersion: 1, cluster: 'devnet', programId: PROGRAM, scanSlot: scan.slot,
      markets: markets.size, snapshots: snapshots.length, digest: digest.digest('hex'),
      parentArchiveSha256: priorArchiveSha256 ?? null };
    if (create) {
      archive.prepare('INSERT INTO manifest VALUES(?,?)').run('summary', JSON.stringify(result));
      archive.exec('COMMIT');
      archive.close(); archive = undefined;
      await link(partial, outPath); // Fails if an archive already exists; never overwrite.
      await unlink(partial); partialCreated = false;
    }
    return result;
  } finally {
    source.close();
    if (archive) { try { archive.exec('ROLLBACK'); } catch {} archive.close(); }
    if (partialCreated) await unlink(partial).catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [mode, sourceDb, outPath, rpcFile, priorArchivePath, priorArchiveSha256] = process.argv.slice(2);
  if (!['--plan', '--create'].includes(mode) || !sourceDb || !outPath || !rpcFile ||
      Boolean(priorArchivePath) !== Boolean(priorArchiveSha256)) {
    console.error('Usage: node scripts/export-snapshot-archive.mjs --plan|--create SOURCE_DB OUTPUT_DB RPC_URL_FILE [PRIOR_ARCHIVE_DB PRIOR_TRUSTED_SHA256]');
    process.exitCode = 2;
  } else {
    buildArchive({ sourceDb, outPath, rpcFile, create: mode === '--create', priorArchivePath, priorArchiveSha256 })
      .then(result => console.log(JSON.stringify(result)))
      .catch(error => { console.error(safeError(error)); process.exitCode = 1; });
  }
}
