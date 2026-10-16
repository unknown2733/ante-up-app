import { copyFile, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import * as sdk from '../clients/chain/dist/index.js';
import { hash } from '../services/data/index.mjs';
import { FileCollectionState } from '../services/data/live.mjs';
import { FileCandidateRepository, publishSnapshot } from '../services/data/publisher.mjs';
import { createKitPublisherChain } from '../services/data/kit.mjs';

const kit = createRequire(new URL('../clients/chain/package.json', import.meta.url))('@solana/kit');
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MIN_AGE_MS = 60 * 60 * 1000;
const check = (ok, code) => { if (!ok) throw new Error(code); };
const required = name => { const value = process.env[name]; check(value, `${name}_REQUIRED`); return value; };

// A crash after REQUESTING and before a signature is persisted is ambiguous.
// This is an explicit operator recovery, never a normal collector retry.
export async function recoverPendingPublish({ mode, jobId, directory, endpoint, signerPath, collectorStopped = false,
  now = Date.now() }) {
  check(mode === 'plan' || mode === 'execute', 'RECOVERY_MODE_INVALID');
  check(typeof jobId === 'string' && jobId.length > 0, 'RECOVERY_JOB_ID_REQUIRED');
  const path = join(directory, 'candidates.json');
  const repository = new FileCandidateRepository(path);
  const state = await repository.read();
  const pending = Object.values(state.jobs).filter(job => job.state !== 'FINALIZED');
  check(pending.length === 1 && pending[0].id === jobId, 'RECOVERY_PENDING_SET_CHANGED');
  const job = pending[0];
  check(job.state === 'REQUESTING' && job.signature === null && job.published === null,
    'RECOVERY_JOB_NOT_UNSIGNED_REQUESTING');
  check(job.market?.cluster === 'devnet' && job.market.programId === sdk.ANTE_UP_PROGRAM_ADDRESS &&
    job.candidate?.marketId === job.market.address && job.candidate?.sequence === job.sequence &&
    hash(job.candidate) === job.candidateHash, 'RECOVERY_JOB_MISMATCH');
  check(Number.isSafeInteger(job.candidate.computedAt) &&
    now - job.candidate.computedAt * 1000 >= MIN_AGE_MS &&
    now - (await stat(path)).mtimeMs >= MIN_AGE_MS, 'RECOVERY_JOB_TOO_RECENT');

  const rpc = kit.createSolanaRpc(endpoint);
  check(await rpc.getGenesisHash().send() === DEVNET_GENESIS, 'RECOVERY_NOT_DEVNET');
  const transport = sdk.createKitChainTransport(endpoint);
  const market = await sdk.readFinalizedMarket(transport, Buffer.from(job.market.seedHex, 'hex'));
  check(market.address === job.market.address && market.data.latestSequence + 1n === BigInt(job.sequence),
    'RECOVERY_CHAIN_SEQUENCE_CHANGED');
  let snapshot;
  try { snapshot = await sdk.readFinalizedSnapshot(transport, market.address, BigInt(job.sequence)); }
  catch (error) {
    if (error.message !== 'ACCOUNT_MISSING_OR_ADDRESS_MISMATCH') throw error;
  }
  check(!snapshot, 'RECOVERY_SNAPSHOT_ALREADY_EXISTS');
  const report = { mode, jobId, market: market.address, sequence: job.sequence,
    ageSeconds: Math.floor((now - job.candidate.computedAt * 1000) / 1000),
    finalizedSequence: market.data.latestSequence.toString(), snapshot: 'ABSENT' };
  if (mode === 'plan') return report;

  check(collectorStopped, 'RECOVERY_COLLECTOR_MUST_BE_STOPPED');
  const signer = await kit.createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(await readFile(signerPath, 'utf8'))));
  const config = await sdk.readFinalizedConfig(transport, sdk.ANTE_UP_PROGRAM_ADDRESS);
  check(config.data.publisher === signer.address, 'RECOVERY_PUBLISHER_MISMATCH');
  check((await rpc.getBalance(signer.address).send()).value >= 10_000_000n, 'RECOVERY_PUBLISHER_SOL_LOW');
  const backup = `${path}.recovery-${now}.bak`;
  await copyFile(path, backup, constants.COPYFILE_EXCL);
  job.state = 'PREPARED';
  await repository.write(state);
  const chain = createKitPublisherChain({ transport, programId: sdk.ANTE_UP_PROGRAM_ADDRESS,
    publisherSigner: signer, feePayer: signer.address, sign: sdk.withKitSigner(signer),
    attempts: 40, wait: () => sleep(1500), finalizedSnapshots: { async getFinalizedSnapshot() { return null; } } });
  const collectionStore = new FileCollectionState(join(directory, 'collection.json'));
  const result = await publishSnapshot({ collectionStore, repository, batchId: jobId,
    market: job.market, chain, publisherSigner: signer });
  return { ...report, backup, publication: result };
}

if (process.argv[1]?.endsWith('recover-pending-publish.mjs') || process.argv[1] === '-') {
  try {
    const config = JSON.parse(await readFile(required('ANTE_UP_COLLECTION_CONFIG'), 'utf8'));
    const result = await recoverPendingPublish({
      mode: required('ANTE_UP_RECOVERY_MODE'), jobId: required('ANTE_UP_RECOVERY_JOB_ID'),
      directory: config.directory, endpoint: (await readFile(required('ANTE_UP_RPC_URL_FILE'), 'utf8')).trim(),
      signerPath: process.env.ANTE_UP_PUBLISHER_KEYPAIR_FILE,
      collectorStopped: process.env.ANTE_UP_RECOVERY_COLLECTOR_STOPPED === 'yes',
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'PUBLICATION_RECOVERY_FAILED');
    process.exitCode = 1;
  }
}
