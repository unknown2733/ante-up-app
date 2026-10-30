/** Bounded Devnet Snapshot retirement after a separately verified pilot. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSnapshotRetirement } from './plan-snapshot-retirement.mjs';
import { loadRetirementStatus, prepareSnapshotRetirement, retireSnapshot } from './retire-snapshot.mjs';

const kit = createRequire(new URL('../clients/chain/package.json', import.meta.url))('@solana/kit');
const PROGRAM = 'FrMATpA81wUMYsZufQkew9K5MW2AC8rgdYQ2wUM6KDKr';
const SHA256 = /^[a-f0-9]{64}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const check = (condition, code) => { if (!condition) throw Error(code); };
const fingerprint = scope => createHash('sha256').update(JSON.stringify(scope)).digest('hex');

/** A finalized journal may skip a previously retired account in an immutable archive. */
export async function completedRetirements(journalDir, { legacyAddress, legacyFingerprint } = {}) {
  const legacy = legacyAddress !== undefined || legacyFingerprint !== undefined;
  check(!legacy || (kit.isAddress(legacyAddress ?? '') && SHA256.test(legacyFingerprint ?? '')),
    'RETIRE_BATCH_LEGACY_INPUT_INVALID');
  const entries = await readdir(journalDir, { withFileTypes: true });
  const completed = new Map();
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    const address = entry.name.slice(0, -5);
    check(entry.isFile() && kit.isAddress(address), 'RETIRE_BATCH_JOURNAL_NAME_INVALID');
    const journal = JSON.parse(await readFile(join(journalDir, entry.name), 'utf8'));
    const scope = journal?.scope;
    check(journal?.state === 'FINALIZED', 'RETIRE_BATCH_INCOMPLETE_ATTEMPT');
    check(journal.version === 1 && scope?.version === 1 && scope.cluster === 'devnet' &&
      scope.programId === PROGRAM && scope.address === address && kit.isAddress(scope.market) &&
      kit.isAddress(scope.publisher) && kit.isAddress(scope.admin) &&
      /^(?:[1-9][0-9]*)$/.test(scope.sequence) &&
      /^(?:0|[1-9][0-9]*)$/.test(scope.refundableLamports) &&
      SHA256.test(scope.archiveSha256) &&
      (SHA256.test(scope.backupSha256) || (legacy && address === legacyAddress &&
        scope.backupSha256 === undefined && journal.fingerprint === legacyFingerprint)) &&
      journal.fingerprint === fingerprint(scope) && SIGNATURE.test(journal.signature),
    'RETIRE_BATCH_JOURNAL_INVALID');
    completed.set(address, { market: scope.market, sequence: scope.sequence });
  }
  return completed;
}

export async function planRetirementBatch({ journalDir, archivePath, expectedSha256, rpcFile,
  limit = 1, nowSeconds, legacyAddress, legacyFingerprint,
  plan = planSnapshotRetirement, pilotStatus = loadRetirementStatus }) {
  check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 16,
    'RETIRE_BATCH_LIMIT_INVALID');
  check(SHA256.test(expectedSha256 ?? ''), 'RETIRE_BATCH_ARCHIVE_HASH_INVALID');
  const completedScopes = await completedRetirements(journalDir,
    { legacyAddress, legacyFingerprint });
  if (legacyAddress !== undefined) {
    check(completedScopes.has(legacyAddress), 'RETIRE_BATCH_LEGACY_JOURNAL_REQUIRED');
    const status = await pilotStatus({ rpcFile, address: legacyAddress,
      journalPath: join(journalDir, `${legacyAddress}.json`) });
    check(status.state === 'FINALIZED', 'RETIRE_BATCH_LEGACY_NOT_FINALIZED');
  }
  const selection = await plan({ archivePath, expectedSha256, rpcFile, minAgeDays: 7, limit,
    nowSeconds, completedScopes });
  const addresses = selection?.batch?.map(item => item.address);
  check(selection?.mode === 'READ_ONLY' && selection.archiveSha256 === expectedSha256 &&
    Array.isArray(addresses) && addresses.length <= limit &&
    addresses.every(address => kit.isAddress(address) && !completedScopes.has(address)) &&
    selection.batch.every(item => kit.isAddress(item.market) &&
      /^(?:[1-9][0-9]*)$/.test(item.sequence)) &&
    new Set(addresses).size === addresses.length, 'RETIRE_BATCH_PLAN_INVALID');
  return selection;
}

/** Stops immediately on an unknown or failed transaction; never signs a second one. */
export async function executeRetirementBatch({ journalDir, archivePath, expectedSha256, rpcFile,
  offhostReceiptPath, backupResultPath, backupCopyReceiptPath, backupDrillReportPath,
  signerFile, adminSignerFile, limit = 1, pilotAcknowledged = false,
  pilotAddress, legacyAddress, legacyFingerprint, nowSeconds,
  plan = planSnapshotRetirement, prepare = prepareSnapshotRetirement,
  retire = retireSnapshot, pilotStatus = loadRetirementStatus }) {
  check(typeof signerFile === 'string' && typeof adminSignerFile === 'string' &&
    signerFile.length > 0 && adminSignerFile.length > 0, 'RETIRE_BATCH_SIGNERS_REQUIRED');
  check(limit === 1 || pilotAcknowledged === true, 'RETIRE_BATCH_PILOT_REQUIRED');
  if (limit > 1) {
    check(kit.isAddress(pilotAddress ?? ''), 'RETIRE_BATCH_PILOT_ADDRESS_REQUIRED');
    const completed = await completedRetirements(journalDir,
      { legacyAddress, legacyFingerprint });
    check(completed.has(pilotAddress), 'RETIRE_BATCH_PILOT_JOURNAL_REQUIRED');
    const status = await pilotStatus({ rpcFile, address: pilotAddress,
      journalPath: join(journalDir, `${pilotAddress}.json`) });
    check(status.state === 'FINALIZED', 'RETIRE_BATCH_PILOT_NOT_FINALIZED');
  }
  const selection = await planRetirementBatch({ journalDir, archivePath,
    expectedSha256, rpcFile, limit, nowSeconds, legacyAddress, legacyFingerprint,
    plan, pilotStatus });
  const results = [];
  for (const candidate of selection.batch) {
    const journalPath = join(journalDir, `${candidate.address}.json`);
    const prepared = await prepare({ archivePath, expectedSha256, rpcFile,
      offhostReceiptPath, backupResultPath, backupCopyReceiptPath,
      backupDrillReportPath, address: candidate.address, journalPath, nowSeconds });
    check(prepared.scope.address === candidate.address &&
      prepared.scope.market === candidate.market &&
      prepared.scope.sequence === candidate.sequence &&
      prepared.scope.archiveSha256 === expectedSha256 && !prepared.existing,
      'RETIRE_BATCH_PREPARE_MISMATCH');
    const result = await retire({ prepared, expectedFingerprint: prepared.fingerprint,
      signerFile, adminSignerFile, journalPath });
    if (result.state === 'FINALIZED')
      check(result.scope?.address === candidate.address && SIGNATURE.test(result.signature ?? ''),
        'RETIRE_BATCH_RESULT_INVALID');
    results.push({ address: candidate.address, state: result.state,
      signature: result.signature ?? null });
    if (result.state !== 'FINALIZED') return { state: 'STOPPED', selection, results };
  }
  return { state: 'FINALIZED', selection, results };
}

async function main(mode, env) {
  check(mode === '--plan' || mode === '--execute', 'RETIRE_BATCH_MODE_INVALID');
  const required = ['ANTE_UP_RETIRE_ARCHIVE', 'ANTE_UP_RETIRE_ARCHIVE_SHA256',
    'ANTE_UP_RETIRE_RPC_FILE', 'ANTE_UP_RETIRE_JOURNAL_DIR'];
  check(required.every(key => env[key]), 'RETIRE_BATCH_INPUTS_REQUIRED');
  const input = { archivePath: env.ANTE_UP_RETIRE_ARCHIVE,
    expectedSha256: env.ANTE_UP_RETIRE_ARCHIVE_SHA256,
    rpcFile: env.ANTE_UP_RETIRE_RPC_FILE,
    journalDir: env.ANTE_UP_RETIRE_JOURNAL_DIR,
    legacyAddress: env.ANTE_UP_RETIRE_LEGACY_ADDRESS,
    legacyFingerprint: env.ANTE_UP_RETIRE_LEGACY_FINGERPRINT,
    limit: Number(env.ANTE_UP_RETIRE_BATCH_LIMIT ?? '1') };
  if (mode === '--plan') {
    console.log(JSON.stringify(await planRetirementBatch(input)));return;
  }
  check(env.ANTE_UP_RETIRE_BATCH_EXECUTE === 'YES', 'RETIRE_BATCH_EXECUTE_ACK_REQUIRED');
  const executeRequired = ['ANTE_UP_RETIRE_OFFHOST_RECEIPT', 'ANTE_UP_RETIRE_BACKUP_RESULT',
    'ANTE_UP_RETIRE_BACKUP_COPY_RECEIPT', 'ANTE_UP_RETIRE_BACKUP_DRILL_REPORT',
    'ANTE_UP_RETIRE_PUBLISHER_KEYPAIR_FILE', 'ANTE_UP_RETIRE_ADMIN_KEYPAIR_FILE'];
  check(executeRequired.every(key => env[key]), 'RETIRE_BATCH_EXECUTE_INPUTS_REQUIRED');
  const result = await executeRetirementBatch({ ...input,
    offhostReceiptPath: env.ANTE_UP_RETIRE_OFFHOST_RECEIPT,
    backupResultPath: env.ANTE_UP_RETIRE_BACKUP_RESULT,
    backupCopyReceiptPath: env.ANTE_UP_RETIRE_BACKUP_COPY_RECEIPT,
    backupDrillReportPath: env.ANTE_UP_RETIRE_BACKUP_DRILL_REPORT,
    signerFile: env.ANTE_UP_RETIRE_PUBLISHER_KEYPAIR_FILE,
    adminSignerFile: env.ANTE_UP_RETIRE_ADMIN_KEYPAIR_FILE,
    pilotAcknowledged: env.ANTE_UP_RETIRE_PILOT_VERIFIED === 'YES',
    pilotAddress: env.ANTE_UP_RETIRE_PILOT_ADDRESS });
  console.log(JSON.stringify(result));
  if (result.state === 'STOPPED') process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv[2], process.env).catch(() => {
    console.error('RETIRE_BATCH_FAILED');process.exitCode = 1;
  });
