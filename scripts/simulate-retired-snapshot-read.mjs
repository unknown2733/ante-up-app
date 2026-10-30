/** Read-only Devnet rehearsal: hide one still-live Snapshot RPC account and recover it from a trusted archive. */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANTE_UP_PROGRAM_ADDRESS } from '../clients/chain/dist/index.js';
import { KitFinalizedAccountReader } from '../services/indexer/src/repositories.ts';
import { TrustedSnapshotArchive } from '../services/indexer/src/snapshot-archive.ts';
import { verifyArchive } from './verify-snapshot-archive.mjs';

const kit = createRequire(new URL('../clients/chain/package.json', import.meta.url))('@solana/kit');
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const check = (condition, code) => { if (!condition) throw new Error(code); };
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));

export function hideAccountFromReads(rpc, hiddenAddress) {
  return new Proxy(rpc, {
    get(target, property) {
      const original = Reflect.get(target, property);
      if (!['getAccountInfo', 'getProgramAccounts'].includes(property) ||
        typeof original !== 'function') return original;
      return (...args) => ({
        send: async (...sendArgs) => {
          const response = await original.apply(target, args).send(...sendArgs);
          if (property === 'getAccountInfo' && String(args[0]) === hiddenAddress)
            return { ...response, value: null };
          if (property === 'getProgramAccounts')
            return { ...response, value: response.value.filter(row =>
              String(row.pubkey) !== hiddenAddress) };
          return response;
        }
      });
    }
  });
}

export async function simulateRetiredSnapshotRead({ archivePath, expectedSha256, rpcFile,
  hiddenAddress, rpc: injectedRpc }) {
  check(kit.isAddress(hiddenAddress) && /^[0-9a-f]{64}$/.test(expectedSha256 ?? ''),
    'SIMULATED_RETIRE_INPUT_INVALID');
  const programId = String(ANTE_UP_PROGRAM_ADDRESS);
  const verified = await verifyArchive({ archivePath, expectedSha256 });
  check(verified.programId === programId, 'SIMULATED_RETIRE_PROGRAM_MISMATCH');
  const archive = new TrustedSnapshotArchive(archivePath, expectedSha256, programId);
  const archived = await archive.get(hiddenAddress);
  check(archived?.ownerProgramId === programId, 'SIMULATED_RETIRE_NOT_ARCHIVED');
  const endpoint = injectedRpc ? null : (await readFile(rpcFile, 'utf8')).trim();
  check(injectedRpc || /^https:\/\//.test(endpoint), 'DEVNET_RPC_REQUIRED');
  const rpc = injectedRpc ?? kit.createSolanaRpc(endpoint);
  check(await rpc.getGenesisHash().send() === DEVNET_GENESIS, 'DEVNET_GENESIS_MISMATCH');
  const direct = await rpc.getAccountInfo(kit.address(hiddenAddress),
    { commitment: 'finalized', encoding: 'base64' }).send();
  check(direct.value?.owner === programId && Array.isArray(direct.value.data) &&
    direct.value.data[1] === 'base64' &&
    same(Buffer.from(direct.value.data[0], 'base64'), archived.data),
  'SIMULATED_RETIRE_ARCHIVE_CHAIN_MISMATCH');
  const reader = new KitFinalizedAccountReader(endpoint ?? 'https://injected.invalid',
    hideAccountFromReads(rpc, hiddenAddress), archive);
  check(await reader.get(hiddenAddress) === null, 'SIMULATED_RETIRE_NOT_HIDDEN');
  const scanned = await reader.scan(programId);
  const recovered = scanned.accounts.filter(row => row.address === hiddenAddress);
  check(recovered.length === 1 && recovered[0].ownerProgramId === programId &&
    same(recovered[0].data, archived.data), 'SIMULATED_RETIRE_SCAN_RECOVERY_FAILED');
  return { mode: 'READ_ONLY_SIMULATION', cluster: 'devnet', programId,
    archivedSnapshots: verified.snapshots, hiddenAddress, recovered: true,
    scannedAccounts: scanned.accounts.length, finalizedSlot: scanned.slot };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [archivePath, expectedSha256, rpcFile, hiddenAddress] = process.argv.slice(2);
  if (!archivePath || !expectedSha256 || !rpcFile || !hiddenAddress) {
    console.error('Usage: node scripts/simulate-retired-snapshot-read.mjs ARCHIVE_DB TRUSTED_SHA256 RPC_URL_FILE SNAPSHOT_ADDRESS');
    process.exitCode = 2;
  } else simulateRetiredSnapshotRead({ archivePath, expectedSha256, rpcFile, hiddenAddress })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => {
      console.error(String(error?.message ?? error)
        .replace(/https?:\/\/[^\s"'<>]+/g, '[RPC_URL_REDACTED]').slice(0, 160));
      process.exitCode = 1;
    });
}
