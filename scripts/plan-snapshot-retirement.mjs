/** Read-only preflight for a small, explicitly selected batch of old Snapshot PDAs. */
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ANTE_UP_PROGRAM_ADDRESS, getMarketDecoder, getSnapshotDecoder,
  MARKET_DISCRIMINATOR } from '../clients/chain/dist/index.js';
import { verifyArchive } from './verify-snapshot-archive.mjs';
import { retryRpcRead } from '../services/indexer/src/rpc-retry.ts';

const kit = createRequire(new URL('../clients/chain/package.json', import.meta.url))('@solana/kit');
const PROGRAM = String(ANTE_UP_PROGRAM_ADDRESS);
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const check = (condition, code) => { if (!condition) throw new Error(code); };
const base64Account = value => {
  check(value && String(value.owner) === PROGRAM && Array.isArray(value.data) &&
    value.data[1] === 'base64' && typeof value.data[0] === 'string', 'RETIRE_ACCOUNT_INVALID');
  return Buffer.from(value.data[0], 'base64');
};

export async function planSnapshotRetirement({ archivePath, expectedSha256, rpcFile, minAgeDays,
  limit = 8, onlyAddress, completedAddresses = new Set(),
  nowSeconds = Math.floor(Date.now() / 1000), rpc: injectedRpc }) {
  check(Number.isSafeInteger(minAgeDays) && minAgeDays >= 7 && minAgeDays <= 365 &&
    Number.isSafeInteger(limit) && limit >= 1 && limit <= 16 &&
    Number.isSafeInteger(nowSeconds) && nowSeconds > 0, 'RETIRE_PLAN_BOUNDS_INVALID');
  check(onlyAddress === undefined || kit.isAddress(onlyAddress), 'RETIRE_ADDRESS_INVALID');
  check(completedAddresses instanceof Set && [...completedAddresses].every(address => kit.isAddress(address)),
    'RETIRE_COMPLETED_ADDRESSES_INVALID');
  check(onlyAddress === undefined || !completedAddresses.has(onlyAddress), 'RETIRE_ADDRESS_ALREADY_COMPLETED');
  const verified = await verifyArchive({ archivePath, expectedSha256 });
  const endpoint = injectedRpc ? null : (await readFile(rpcFile, 'utf8')).trim();
  check(injectedRpc || /^https:\/\//.test(endpoint), 'DEVNET_RPC_REQUIRED');
  const rpc = injectedRpc ?? kit.createSolanaRpc(endpoint);
  check(await retryRpcRead(() => rpc.getGenesisHash().send()) === DEVNET_GENESIS, 'DEVNET_GENESIS_MISMATCH');
  const db = new DatabaseSync(archivePath, { readOnly: true });
  let rows;
  try { rows = db.prepare('SELECT market,sequence,address,account_data FROM snapshots').all(); }
  finally { db.close(); }
  const markets = new Map();
  for (const market of new Set(rows.map(row => row.market))) {
    const response = await retryRpcRead(() => rpc.getAccountInfo(kit.address(market),
      { commitment: 'finalized', encoding: 'base64' }).send());
    const data = base64Account(response.value);
    check(data.subarray(0, 8).equals(Buffer.from(MARKET_DISCRIMINATOR)), 'RETIRE_MARKET_INVALID');
    markets.set(market, getMarketDecoder().decode(data).latestSequence);
  }
  const minAgeSeconds = minAgeDays * 86_400;
  const eligible = rows.map(row => {
    const snapshot = getSnapshotDecoder().decode(row.account_data);
    return { market: row.market, sequence: row.sequence, address: row.address,
      publishedAt: Number(snapshot.publishedAt), latestSequence: markets.get(row.market) };
  }).filter(row => Number.isSafeInteger(row.publishedAt) && row.publishedAt > 0 &&
    BigInt(row.sequence) < row.latestSequence && nowSeconds - row.publishedAt >= minAgeSeconds)
    .sort((a, b) => a.publishedAt - b.publishedAt || a.address.localeCompare(b.address));
  const remaining = eligible.filter(row => !completedAddresses.has(row.address));
  const selected = onlyAddress ? remaining.filter(row => row.address === onlyAddress) : remaining.slice(0, limit);
  check(!onlyAddress || selected.length === 1, 'RETIRE_ADDRESS_NOT_ELIGIBLE');
  const batch = [];
  for (const row of selected) {
    const response = await retryRpcRead(() => rpc.getAccountInfo(kit.address(row.address),
      { commitment: 'finalized', encoding: 'base64' }).send());
    check(response.value, 'RETIRE_CANDIDATE_NOT_ON_CHAIN');
    const current = base64Account(response.value);
    const archived = rows.find(item => item.address === row.address);
    check(current.equals(Buffer.from(archived.account_data)), 'RETIRE_ARCHIVE_CHAIN_MISMATCH');
    batch.push({ market: row.market, sequence: row.sequence, address: row.address,
      publishedAt: row.publishedAt, latestSequence: row.latestSequence.toString(),
      refundableLamports: String(response.value.lamports) });
  }
  return { mode: 'READ_ONLY', archiveSha256: verified.fileSha256, archiveSnapshots: verified.snapshots,
    minAgeDays, eligibleByAge: eligible.length, completedExcluded: eligible.length - remaining.length,
    checkedOnChain: batch.length, batch };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [archivePath, expectedSha256, rpcFile, age, count, onlyAddress] = process.argv.slice(2);
  if (!archivePath || !expectedSha256 || !rpcFile || !age) {
    console.error('Usage: node scripts/plan-snapshot-retirement.mjs ARCHIVE_DB TRUSTED_SHA256 RPC_URL_FILE MIN_AGE_DAYS [BATCH_LIMIT] [SNAPSHOT_ADDRESS]');
    process.exitCode = 2;
  } else {
    planSnapshotRetirement({ archivePath, expectedSha256, rpcFile,
      minAgeDays: Number(age), limit: count === undefined ? 8 : Number(count), onlyAddress })
      .then(result => console.log(JSON.stringify(result)))
      .catch(error => { console.error(String(error?.message ?? error).replace(/https?:\/\/[^\s"'<>]+/g, '[RPC_URL_REDACTED]').slice(0, 120)); process.exitCode = 1; });
  }
}
