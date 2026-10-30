/** One-account Devnet Snapshot retirement. Never retries an unknown signature. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import * as chain from '../clients/chain/dist/index.js';
import { planSnapshotRetirement } from './plan-snapshot-retirement.mjs';
import { verifyArchive } from './verify-snapshot-archive.mjs';
import { verifySnapshotBackup } from './verify-snapshot-backup.mjs';
import { replaceJournal } from './atomic-rename.mjs';

const kit = createRequire(new URL('../clients/chain/package.json', import.meta.url))('@solana/kit');
const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PROGRAM = String(chain.ANTE_UP_PROGRAM_ADDRESS);
const hex = /^[0-9a-f]{64}$/;
const check = (condition, code) => { if (!condition) throw new Error(code); };
const safe = error => String(error?.message ?? error)
  .replace(/https?:\/\/[^\s"'<>]+/g, '[RPC_URL_REDACTED]').slice(0, 180);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function readJournal(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** A fresh verification receipt comes from a separately retained, off-host archive. */
export function verifyOffhostReceipt(receipt, archive, expectedSha256, now = Date.now(), localHost = hostname()) {
  const verifiedAt = Date.parse(receipt?.verifiedAt);
  check(receipt?.version === 1 && receipt.kind === 'SNAPSHOT_OFFHOST_VERIFICATION' &&
    typeof receipt.host === 'string' && receipt.host.length > 0 && receipt.host !== localHost &&
    typeof receipt.archivePath === 'string' && receipt.archivePath.length > 0 &&
    receipt.archiveSha256 === expectedSha256 && receipt.archiveDigest === archive.digest &&
    receipt.snapshots === archive.snapshots && Number.isFinite(verifiedAt) &&
    verifiedAt <= now && now - verifiedAt <= 48 * 60 * 60 * 1000,
  'RETIRE_OFFHOST_RECEIPT_INVALID');
}

export async function prepareSnapshotRetirement({ archivePath, offhostReceiptPath, expectedSha256,
  backupResultPath, backupCopyReceiptPath, backupDrillReportPath,
  rpcFile, address, journalPath, nowSeconds }) {
  check(hex.test(expectedSha256 ?? '') && kit.isAddress(address), 'RETIRE_INPUT_INVALID');
  const primary = await verifyArchive({ archivePath, expectedSha256 });
  verifyOffhostReceipt(JSON.parse(await readFile(offhostReceiptPath, 'utf8')),
    primary, expectedSha256);
  const [backup, copy, drill] = await Promise.all([
    readFile(backupResultPath, 'utf8').then(JSON.parse),
    readFile(backupCopyReceiptPath, 'utf8').then(JSON.parse),
    readFile(backupDrillReportPath, 'utf8').then(JSON.parse),
  ]);
  const backupProof = verifySnapshotBackup({ backup, copy, drill,
    archiveSha256: expectedSha256, archivePath });
  const endpoint = (await readFile(rpcFile, 'utf8')).trim();
  check(/^https:\/\//.test(endpoint), 'DEVNET_RPC_REQUIRED');
  const rpc = kit.createSolanaRpc(endpoint);
  check(await rpc.getGenesisHash().send() === GENESIS, 'DEVNET_GENESIS_MISMATCH');
  const transport = chain.createKitChainTransport(endpoint);
  const config = await chain.readFinalizedConfig(transport);
  const publisher = String(config.data.publisher);
  const admin = String(config.data.admin);
  const existing = await readJournal(journalPath);
  const plan = await planSnapshotRetirement({ archivePath, expectedSha256, rpcFile,
    minAgeDays: 7, limit: 1, onlyAddress: address, nowSeconds, rpc });
  check(plan.batch.length === 1 && plan.batch[0].address === address, 'RETIRE_CANDIDATE_MISMATCH');
  const candidate = plan.batch[0];
  const scope = { version: 1, cluster: 'devnet', programId: PROGRAM, address,
    market: candidate.market, sequence: candidate.sequence,
    publisher, admin, archiveSha256: expectedSha256,
    backupSha256: backupProof.backupSha256,
    refundableLamports: candidate.refundableLamports };
  const fingerprint = digest(scope);
  if (existing) check(existing.fingerprint === fingerprint && existing.scope?.address === address,
    'RETIRE_JOURNAL_SCOPE_MISMATCH');
  return { scope, fingerprint, existing, transport, rpc };
}

/** Status stays available after the 48-hour off-host receipt expires. */
export async function loadRetirementStatus({ rpcFile, address, journalPath }) {
  const existing = await readJournal(journalPath);
  check(existing?.scope?.version === 1 && existing.scope.cluster === 'devnet' &&
    existing.scope.programId === PROGRAM && existing.scope.address === address &&
    existing.fingerprint === digest(existing.scope) && typeof existing.signature === 'string',
  'RETIRE_JOURNAL_SCOPE_MISMATCH');
  const endpoint = (await readFile(rpcFile, 'utf8')).trim();
  check(/^https:\/\//.test(endpoint), 'DEVNET_RPC_REQUIRED');
  const rpc = kit.createSolanaRpc(endpoint);
  check(await rpc.getGenesisHash().send() === GENESIS, 'DEVNET_GENESIS_MISMATCH');
  const transport = chain.createKitChainTransport(endpoint);
  const config = await chain.readFinalizedConfig(transport);
  check(existing.scope.publisher === String(config.data.publisher) &&
    existing.scope.admin === String(config.data.admin), 'RETIRE_JOURNAL_SIGNER_MISMATCH');
  return retirementStatus({ prepared: { scope: existing.scope, existing, transport } });
}

export async function retirementStatus({ prepared }) {
  const { scope, existing, transport } = prepared;
  if (!existing) return { state: 'READY', scope, fingerprint: prepared.fingerprint };
  const [status, account] = await Promise.all([
    transport.getSignatureStatus(existing.signature),
    transport.getFinalizedAccount(kit.address(scope.address)),
  ]);
  if (status?.confirmationStatus === 'finalized' && status.err == null && !account.exists)
    return { state: 'FINALIZED', scope, signature: existing.signature };
  if (status?.err != null) return { state: 'FAILED', scope, signature: existing.signature,
    accountStillExists: account.exists };
  return { state: 'UNKNOWN', scope, signature: existing.signature,
    confirmationStatus: status?.confirmationStatus ?? null, accountStillExists: account.exists };
}

export async function retireSnapshot({ prepared, expectedFingerprint, signerFile, adminSignerFile, journalPath }) {
  const { scope, fingerprint, existing, transport, rpc } = prepared;
  check(!existing, 'RETIRE_EXISTING_ATTEMPT_RECONCILE_FIRST');
  check(expectedFingerprint === fingerprint, 'RETIRE_PLAN_FINGERPRINT_MISMATCH');
  check(typeof signerFile === 'string' && signerFile.length > 0, 'RETIRE_PUBLISHER_KEY_REQUIRED');
  check(typeof adminSignerFile === 'string' && adminSignerFile.length > 0, 'RETIRE_ADMIN_KEY_REQUIRED');
  const signer = await kit.createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(await readFile(signerFile, 'utf8'))));
  const adminSigner = await kit.createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(await readFile(adminSignerFile, 'utf8'))));
  check(String(signer.address) === scope.publisher, 'RETIRE_PUBLISHER_KEY_MISMATCH');
  check(String(adminSigner.address) === scope.admin, 'RETIRE_ADMIN_KEY_MISMATCH');
  const ix = await chain.getRetireSnapshotInstructionAsync({ market: kit.address(scope.market),
    publisher: signer, admin: adminSigner, sequence: BigInt(scope.sequence),
    archiveSha256: Uint8Array.from(Buffer.from(scope.archiveSha256, 'hex')) });
  const lifetime = await transport.getLatestBlockhash();
  let message = kit.setTransactionMessageFeePayerSigner(signer, kit.createTransactionMessage({ version: 0 }));
  message = kit.setTransactionMessageLifetimeUsingBlockhash(
    { ...lifetime, blockhash: kit.blockhash(lifetime.blockhash) }, message);
  message = kit.appendTransactionMessageInstruction(ix, message);
  const signed = await kit.signTransactionMessageWithSigners(message);
  const signature = kit.getSignatureFromTransaction(signed);
  const wire = kit.getBase64Decoder().decode(kit.getTransactionEncoder().encode(signed));
  const simulation = await rpc.simulateTransaction(wire,
    { encoding: 'base64', commitment: 'processed', sigVerify: true }).send();
  check(simulation.value.err === null, 'RETIRE_SIMULATION_FAILED');
  const attempt = { version: 1, scope, fingerprint, signature, state: 'SIGNED',
    lastValidBlockHeight: lifetime.lastValidBlockHeight.toString() };
  const handle = await open(journalPath, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(attempt) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try { check(await transport.sendTransaction(wire) === signature, 'RETIRE_SIGNATURE_MISMATCH'); }
  catch { return { state: 'UNKNOWN', scope, signature }; }
  for (let index = 0; index < 20; index++) {
    const [status, account] = await Promise.all([
      transport.getSignatureStatus(signature),
      transport.getFinalizedAccount(kit.address(scope.address)),
    ]);
    if (status?.err != null) return { state: 'FAILED', scope, signature };
    if (status?.confirmationStatus === 'finalized' && !account.exists) {
      const updated = { ...attempt, state: 'FINALIZED' };
      const tmp = `${journalPath}.tmp`;
      await writeFile(tmp, JSON.stringify(updated) + '\n', { mode: 0o600 });
      await replaceJournal(tmp, journalPath);
      return { state: 'FINALIZED', scope, signature };
    }
    await sleep(1500);
  }
  return { state: 'UNKNOWN', scope, signature };
}

async function main(argv = process.argv, env = process.env) {
  const mode = argv[2] ?? '--plan';
  check(['--plan', '--execute', '--status'].includes(mode), 'RETIRE_MODE_INVALID');
  if (mode === '--status') {
    check(env.ANTE_UP_RETIRE_RPC_FILE && env.ANTE_UP_RETIRE_ADDRESS &&
      env.ANTE_UP_RETIRE_JOURNAL, 'RETIRE_STATUS_INPUTS_REQUIRED');
    const result = await loadRetirementStatus({ rpcFile: env.ANTE_UP_RETIRE_RPC_FILE,
      address: env.ANTE_UP_RETIRE_ADDRESS, journalPath: env.ANTE_UP_RETIRE_JOURNAL });
    console.log(JSON.stringify(result));
    if (result.state === 'UNKNOWN') process.exitCode = 2;
    if (result.state === 'FAILED') process.exitCode = 1;
    return;
  }
  const required = ['ANTE_UP_RETIRE_ARCHIVE', 'ANTE_UP_RETIRE_OFFHOST_RECEIPT',
    'ANTE_UP_RETIRE_ARCHIVE_SHA256', 'ANTE_UP_RETIRE_BACKUP_RESULT',
    'ANTE_UP_RETIRE_BACKUP_COPY_RECEIPT', 'ANTE_UP_RETIRE_BACKUP_DRILL_REPORT',
    'ANTE_UP_RETIRE_RPC_FILE',
    'ANTE_UP_RETIRE_ADDRESS', 'ANTE_UP_RETIRE_JOURNAL'];
  check(required.every(key => env[key]), 'RETIRE_INPUT_FILES_REQUIRED');
  const input = { archivePath: env.ANTE_UP_RETIRE_ARCHIVE,
    offhostReceiptPath: env.ANTE_UP_RETIRE_OFFHOST_RECEIPT,
    expectedSha256: env.ANTE_UP_RETIRE_ARCHIVE_SHA256,
    backupResultPath: env.ANTE_UP_RETIRE_BACKUP_RESULT,
    backupCopyReceiptPath: env.ANTE_UP_RETIRE_BACKUP_COPY_RECEIPT,
    backupDrillReportPath: env.ANTE_UP_RETIRE_BACKUP_DRILL_REPORT,
    rpcFile: env.ANTE_UP_RETIRE_RPC_FILE, address: env.ANTE_UP_RETIRE_ADDRESS,
    journalPath: env.ANTE_UP_RETIRE_JOURNAL };
  const prepared = await prepareSnapshotRetirement(input);
  const result = mode === '--execute'
    ? await retireSnapshot({ prepared, expectedFingerprint: env.ANTE_UP_RETIRE_PLAN_FINGERPRINT,
      signerFile: env.ANTE_UP_RETIRE_PUBLISHER_KEYPAIR_FILE,
      adminSignerFile: env.ANTE_UP_RETIRE_ADMIN_KEYPAIR_FILE, journalPath: input.journalPath })
    : await retirementStatus({ prepared });
  console.log(JSON.stringify(result));
  if (result.state === 'UNKNOWN') process.exitCode = 2;
  if (result.state === 'FAILED') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(safe(error)); process.exitCode = 1; });
