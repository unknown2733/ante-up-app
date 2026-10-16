import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {
  ANTE_UP_PROGRAM_ADDRESS, AdmissionState, DataStatus, FreeState,
  findMarketPda, findRecordPda, getCloseFreeInstructionAsync,
  getAdmissionDecoder, getFreeRecordDecoder, getInitializeInstructionAsync,
  getOpenFreeInstructionAsync, getPublishSnapshotInstructionAsync,
  getRaiseFundedOpenCapInstructionAsync, getRegisterMarketInstructionAsync, getSetAdmissionGateInstructionAsync,
  findAdmissionPda,
} from '../../clients/chain/dist/index.js';
import {formulaVersionBytes} from '../../clients/chain/encoding.mjs';

const requireChain = createRequire(new URL('../../clients/chain/package.json', import.meta.url));
const binary = process.env.ANTE_UP_SBF_PATH ?? resolve(import.meta.dirname, '../../target/deploy/ante_up.so');

test('LiteSVM: publish, open, close while new admission is blocked',
  {skip: !existsSync(binary) && 'A compiled Solana SBF .so is required via ANTE_UP_SBF_PATH'},
  async () => {
    // Dynamic import keeps Windows codec tests runnable: LiteSVM 1.6 ships Linux/macOS bindings only.
    const {LiteSVM, FailedTransactionMetadata} = requireChain('litesvm');
    const kit = requireChain('@solana/kit');
    const {
      generateKeyPairSigner, lamports, pipe, createTransactionMessage,
      setTransactionMessageFeePayerSigner, appendTransactionMessageInstruction,
      signTransactionMessageWithSigners,
    } = kit;
    const svm = new LiteSVM();
    svm.addProgramFromFile(ANTE_UP_PROGRAM_ADDRESS, binary);
    const admin = await generateKeyPairSigner();
    svm.airdrop(admin.address, lamports(10_000_000_000n));
    const clock = svm.getClock();
    clock.unixTimestamp = 1_800_000_000n;
    svm.setClock(clock);
    const now = svm.getClock().unixTimestamp;
    async function send(ix, expectFailure = false) {
      const tx = await pipe(
        createTransactionMessage({version: 0}),
        m => setTransactionMessageFeePayerSigner(admin, m),
        m => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
        m => appendTransactionMessageInstruction(ix, m),
        m => signTransactionMessageWithSigners(m),
      );
      const result = svm.sendTransaction(tx);
      if (expectFailure) {
        assert.ok(result instanceof FailedTransactionMetadata);
      } else if (result instanceof FailedTransactionMetadata) {
        throw new Error(`LiteSVM transaction failed: ${result.err()}`);
      }
      return result;
    }

    const marketId = new Uint8Array(32).fill(1);
    const queryHash = new Uint8Array(32).fill(2);
    const [market] = await findMarketPda({marketId});
    const [admission] = await findAdmissionPda();
    const [record] = await findRecordPda({market, owner: admin.address, recordId: 1n});
    await send(await getInitializeInstructionAsync({
      admin, publisher: admin.address, proofAuthority: admin.address,
      formulaVersion: formulaVersionBytes('h3-d7-q12-v1'),
    }));
    await send(await getRegisterMarketInstructionAsync({
      admin, marketId, queryHash, queryVersion: 1n,
    }));
    const snapshot = (sequence, configVersion, activityNowQ12) =>
      getPublishSnapshotInstructionAsync({
        market, publisher: admin, sequence, queryHash, queryVersion: 1n,
        configVersion, formulaVersion: formulaVersionBytes('h3-d7-q12-v1'),
        dataThrough: now - 60n, activityNowQ12, activity7dQ12: 1_000_000_000_000n,
        dataStatus: DataStatus.Valid,
        admission: {state: AdmissionState.Open, recoveryCount: 0, reason: null},
        evidenceHash: new Uint8Array(32).fill(3),
        payloadHash: new Uint8Array(32).fill(Number(sequence) + 3),
      });
    await send(await snapshot(1n, 1n, 1_250_000_000_000n));
    await send(await getSetAdmissionGateInstructionAsync({admin, open: true}));
    await send(await getOpenFreeInstructionAsync({market, owner: admin, recordId: 0n}), true);
    await send(await getRaiseFundedOpenCapInstructionAsync({admin, cap: 1n}));
    await send(await getOpenFreeInstructionAsync({market, owner: admin, recordId: 1n}));
    let gate=getAdmissionDecoder().decode(svm.getAccount(admission).data);
    assert.equal(gate.fundedOpenCap,1n);
    assert.equal(gate.fundedOpenCount,1n);
    assert.equal(getFreeRecordDecoder().decode(svm.getAccount(record).data).state, FreeState.Open);

    await send(await snapshot(2n, 3n, 1_500_000_000_000n));
    await send(await getOpenFreeInstructionAsync({market, owner: admin, recordId: 2n}), true);
    await send(await getSetAdmissionGateInstructionAsync({admin, open: false}));
    await send(await getOpenFreeInstructionAsync({market, owner: admin, recordId: 2n}), true);
    await send(await getCloseFreeInstructionAsync({market, record, owner: admin}));
    gate=getAdmissionDecoder().decode(svm.getAccount(admission).data);
    assert.equal(gate.fundedOpenCount,1n,'closing does not refund a proof obligation');
    const closed = getFreeRecordDecoder().decode(svm.getAccount(record).data);
    assert.equal(closed.state, FreeState.ClosedResult);
    assert.ok(closed.resultNum > 0n);
    assert.equal(closed.exit.sequence, 2n);
  });
