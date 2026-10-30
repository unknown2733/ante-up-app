import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ANTE_UP_PROGRAM_ADDRESS, AdmissionState, DataStatus,
  findMarketPda, findSnapshotPda, getInitializeInstructionAsync,
  getPublishSnapshotInstructionAsync, getRegisterMarketInstructionAsync,
  getRetireSnapshotInstructionAsync,
} from '../../clients/chain/dist/index.js';
import { formulaVersionBytes } from '../../clients/chain/encoding.mjs';

const requireChain = createRequire(new URL('../../clients/chain/package.json', import.meta.url));
const binary = process.env.ANTE_UP_SBF_PATH ?? resolve(import.meta.dirname, '../../target/deploy/ante_up.so');

test('LiteSVM: only the publisher can retire an archived, aged, non-latest snapshot',
  { skip: !existsSync(binary) && 'A compiled Solana SBF .so is required via ANTE_UP_SBF_PATH' },
  async () => {
    const { LiteSVM, FailedTransactionMetadata } = requireChain('litesvm');
    const kit = requireChain('@solana/kit');
    const { generateKeyPairSigner, lamports, pipe, createTransactionMessage,
      setTransactionMessageFeePayerSigner, appendTransactionMessageInstruction,
      signTransactionMessageWithSigners } = kit;
    const svm = new LiteSVM();
    svm.addProgramFromFile(ANTE_UP_PROGRAM_ADDRESS, binary);
    const admin = await generateKeyPairSigner();
    const publisher = await generateKeyPairSigner();
    const outsider = await generateKeyPairSigner();
    svm.airdrop(admin.address, lamports(1_000_000_000n));
    svm.airdrop(publisher.address, lamports(10_000_000_000n));
    svm.airdrop(outsider.address, lamports(1_000_000_000n));
    const clock = svm.getClock();
    clock.unixTimestamp = 1_800_000_000n;
    svm.setClock(clock);
    async function send(ix, expectFailure = false) {
      const tx = await pipe(createTransactionMessage({ version: 0 }),
        m => setTransactionMessageFeePayerSigner(publisher, m),
        m => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
        m => appendTransactionMessageInstruction(ix, m),
        m => signTransactionMessageWithSigners(m));
      const result = svm.sendTransaction(tx);
      if (expectFailure) assert.ok(result instanceof FailedTransactionMetadata);
      else if (result instanceof FailedTransactionMetadata) throw new Error(`LiteSVM transaction failed: ${result.toString()}`);
      return result;
    }
    const marketId = new Uint8Array(32).fill(41);
    const queryHash = new Uint8Array(32).fill(42);
    const [market] = await findMarketPda({ marketId });
    await send(await getInitializeInstructionAsync({ admin, publisher: publisher.address,
      proofAuthority: publisher.address, formulaVersion: formulaVersionBytes('h3-d7-q12-v1') }));
    await send(await getRegisterMarketInstructionAsync({ admin, marketId, queryHash, queryVersion: 1n }));
    for (const sequence of [1n, 2n]) {
      await send(await getPublishSnapshotInstructionAsync({ market, publisher, sequence,
        queryHash, queryVersion: 1n, configVersion: 1n,
        formulaVersion: formulaVersionBytes('h3-d7-q12-v1'),
        dataThrough: clock.unixTimestamp - 60n,
        activityNowQ12: 1_250_000_000_000n, activity7dQ12: 1_000_000_000_000n,
        dataStatus: DataStatus.Valid,
        admission: { state: AdmissionState.Open, recoveryCount: 0, reason: null },
        evidenceHash: new Uint8Array(32).fill(43),
        payloadHash: new Uint8Array(32).fill(Number(sequence) + 43) }));
    }
    const [first] = await findSnapshotPda({ market, sequence: 1n });
    const [latest] = await findSnapshotPda({ market, sequence: 2n });
    const rent = svm.getAccount(first).lamports;
    const archiveSha256 = new Uint8Array(32).fill(44);
    const retire = (sequence, signer = publisher, digest = archiveSha256, administrator = admin) =>
      getRetireSnapshotInstructionAsync({ market, publisher: signer, admin: administrator,
        sequence, archiveSha256: digest });
    await send(await retire(1n), true, 'too young');
    clock.unixTimestamp += 7n * 86_400n + 1n;
    svm.setClock(clock);
    svm.expireBlockhash();
    await send(await retire(2n), true, 'latest remains on chain');
    await send(await retire(1n, outsider), true, 'wrong publisher');
    await send(await retire(1n, publisher, archiveSha256, outsider), true, 'wrong admin');
    await send(await retire(1n, publisher, new Uint8Array(32)), true, 'missing archive commitment');
    const before = svm.getAccount(publisher.address).lamports;
    await send(await retire(1n));
    assert.equal(svm.getAccount(first).exists, false);
    assert.equal(svm.getAccount(latest).exists, true, 'current price snapshot remains on chain');
    assert.ok(svm.getAccount(publisher.address).lamports > before,
      'closed account rent returns to the configured publisher');
    assert.ok(rent > 0n);
    svm.expireBlockhash();
    await send(await retire(1n), true, 'replay cannot refund twice');
  });
