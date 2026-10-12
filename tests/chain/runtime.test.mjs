import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {
  ANTE_UP_PROGRAM_ADDRESS, AdmissionState, DataStatus, FreeState, MarketPhase, NaReason,
  createCloseFreeInstruction, createCompleteProofInstruction, createInitializeInstruction,
  createOpenFreeInstruction, createPublishSnapshotInstruction, createRegisterMarketInstruction,
  findMarketPda, findRecordPda, findSnapshotPda, findSettlementPda, getFreeRecordEncoder,
  getMarketEncoder, getSnapshotEncoder, parseCloseFreeInstruction,
  getRegisterFinancialMarketInstructionAsync, parseRegisterFinancialMarketInstruction,
  parseCompleteProofInstruction, parseInitializeInstruction, parseOpenFreeInstruction,
  parsePublishSnapshotInstruction, parseRegisterMarketInstruction,
  prepareUnsignedTransaction, readFinalizedFreeRecord, readFinalizedMarket,
  readFinalizedSnapshot, submitAndConfirmFinalized, withKitSigner,
} from '../../clients/chain/dist/index.js';
const requireChain = createRequire(new URL('../../clients/chain/package.json', import.meta.url));
const {generateKeyPairSigner, getBase58Decoder, getTransactionDecoder, getBase64Encoder,
  getSignatureFromTransaction} = requireChain('@solana/kit');

const programAddress = ANTE_UP_PROGRAM_ADDRESS;
const hash = new Uint8Array(32).fill(7);
const formulaVersion = new Uint8Array(16).fill(3);
const marketId = new Uint8Array(32).fill(1);
const point = {sequence: 1n, payloadHash: hash, executedAt: 1_800_000_000n,
  slot: 42n, hNum: 125n, hDen: 100n, usable: true, reason: NaReason.None};
const blockhash = getBase58Decoder().decode(new Uint8Array(32).fill(9));

test('settlement PDA separates an empty cycle from each opened Pro cycle', async () => {
  const [market] = await findMarketPda({marketId});
  const [empty] = await findSettlementPda(market, 0n);
  const [first] = await findSettlementPda(market, 1n);
  const [second] = await findSettlementPda(market, 2n);
  assert.equal(new Set([empty, first, second]).size, 3);
  await assert.rejects(findSettlementPda(market, -1n), /SETTLEMENT_CYCLE_RANGE/);
});

function fakeTransport(overrides = {}) {
  return {
    async getFinalizedAccount(account) { return {address: account, exists: false}; },
    async getLatestBlockhash() { return {blockhash, lastValidBlockHeight: 100n}; },
    async isBlockhashValid() { return true; },
    async sendTransaction(wire) {
      return getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));
    },
    async getSignatureStatus() { return {confirmationStatus: 'finalized', err: null}; },
    async getBlockHeight() { return 50n; },
    ...overrides,
  };
}

test('all six runtime builders use the generated instruction schema and derive signer/PDA metas', async () => {
  const signer = await generateKeyPairSigner();
  const owner = signer.address;
  const initialize = await createInitializeInstruction({admin: owner, publisher: owner,
    proofAuthority: owner, formulaVersion});
  assert.equal(parseInitializeInstruction(initialize).accounts.admin.address, owner);
  const registered = await createRegisterMarketInstruction({admin: owner, marketId, queryHash: hash, queryVersion: 1n});
  const [marketAddress] = await findMarketPda({marketId});
  assert.equal(registered.marketAddress, marketAddress);
  assert.equal(parseRegisterMarketInstruction(registered.instruction).accounts.market.address, marketAddress);
  const snapshot = await createPublishSnapshotInstruction({marketAddress, publisher: owner,
    sequence: 1n, queryHash: hash, queryVersion: 1n, configVersion: 1n,
    formulaVersion, dataThrough: 1_800_000_000n, activityNowQ12: 1000n,
    activity7dQ12: 1100n, dataStatus: DataStatus.Valid,
    admission: {state: AdmissionState.Open, recoveryCount: 0, reason: null},
    evidenceHash: hash, payloadHash: hash});
  assert.equal(parsePublishSnapshotInstruction(snapshot.instruction).accounts.snapshot.address, snapshot.snapshotAddress);
  const opened = await createOpenFreeInstruction({marketAddress, owner, recordId: 9n});
  const closed = await createCloseFreeInstruction({marketAddress, owner, recordId: 9n});
  const proof = await createCompleteProofInstruction({marketAddress, owner, recordId: 9n,
    proofAuthority: owner, proofHash: hash});
  assert.equal(parseOpenFreeInstruction(opened.instruction).accounts.record.address, opened.recordAddress);
  assert.equal(parseCloseFreeInstruction(closed.instruction).accounts.record.address, opened.recordAddress);
  assert.equal(parseCompleteProofInstruction(proof.instruction).accounts.record.address, opened.recordAddress);
});

test('compiled financial registration builder binds market seed, mint and fee accounts', async () => {
  const registrant = await generateKeyPairSigner();
  const ix = await getRegisterFinancialMarketInstructionAsync({
    registrant, paymentMint: registrant.address, registrantPayment: registrant.address,
    protocolTreasury: registrant.address, marketId, queryHash: hash, queryVersion: 1n,
  });
  const parsed = parseRegisterFinancialMarketInstruction(ix);
  const [marketAddress] = await findMarketPda({marketId});
  assert.equal(parsed.accounts.market.address, marketAddress);
  assert.equal(parsed.data.queryVersion, 1n);
  assert.equal(parsed.accounts.registrant.address, registrant.address);
  assert.equal(ix.programAddress, programAddress);
});

test('finalized record read rejects wrong owner, PDA and stored identity', async () => {
  const owner = (await generateKeyPairSigner()).address;
  const [marketAddress] = await findMarketPda({marketId});
  const [recordAddress] = await findRecordPda({market: marketAddress, owner, recordId: 9n});
  const makeRecord = (id = 9n) => ({exists: true, address: recordAddress,
    programAddress, executable: false, lamports: 1n, space: 312n,
    data: getFreeRecordEncoder().encode({id, owner, market: marketAddress,
      state: FreeState.Open, openedAt: point.executedAt, closedAt: 0n,
      entry: point, exit: point, resultNegative: false, resultNum: 0n,
      resultDen: 1n, naReason: NaReason.None, proofComplete: false, proofHash: hash})});
  const valid = fakeTransport({getFinalizedAccount: async () => makeRecord()});
  assert.equal((await readFinalizedFreeRecord(valid, marketAddress, owner, 9n)).data.id, 9n);
  await assert.rejects(readFinalizedFreeRecord(fakeTransport({
    getFinalizedAccount: async () => ({...makeRecord(), programAddress: owner}),
  }), marketAddress, owner, 9n), /ACCOUNT_OWNER_MISMATCH/);
  await assert.rejects(readFinalizedFreeRecord(fakeTransport({
    getFinalizedAccount: async () => ({...makeRecord(), address: owner}),
  }), marketAddress, owner, 9n), /ACCOUNT_MISSING_OR_ADDRESS_MISMATCH/);
  await assert.rejects(readFinalizedFreeRecord(fakeTransport({
    getFinalizedAccount: async () => makeRecord(10n),
  }), marketAddress, owner, 9n), /RECORD_IDENTITY_MISMATCH/);
  await assert.rejects(readFinalizedFreeRecord(fakeTransport({
    getFinalizedAccount: async () => ({...makeRecord(), data: new Uint8Array(312)}),
  }), marketAddress, owner, 9n), /ACCOUNT_DISCRIMINATOR_MISMATCH/);
});

test('market seed and snapshot identity are checked against finalized program accounts', async () => {
  const owner = (await generateKeyPairSigner()).address;
  const [marketAddress] = await findMarketPda({marketId});
  const [snapshotAddress] = await findSnapshotPda({market: marketAddress, sequence: 3n});
  const admission = {state: AdmissionState.Open, recoveryCount: 0, reason: null};
  const market = id => ({exists: true, address: marketAddress, programAddress, executable: false,
    lamports: 1n, space: 200n, data: getMarketEncoder().encode({id, admin: owner,
      queryHash: hash, queryVersion: 1n, phase: MarketPhase.Curve,
      dataStatus: DataStatus.Valid, admission, validityGeneration: 0n, latestSequence: 3n, latestHash: hash,
      latestDataThrough: 1n, latestNowQ12: 100n, latest7dQ12: 100n})});
  assert.equal((await readFinalizedMarket(fakeTransport({getFinalizedAccount: async () => market(marketId)}), marketId)).address,
    marketAddress);
  await assert.rejects(readFinalizedMarket(fakeTransport({getFinalizedAccount: async () => market(hash)}), marketId),
    /MARKET_ID_MISMATCH/);
  const snapshot = sequence => ({exists: true, address: snapshotAddress, programAddress,
    executable: false, lamports: 1n, space: 200n,
    data: getSnapshotEncoder().encode({market: marketAddress, sequence, payloadHash: hash,
      evidenceHash: hash, queryHash: hash, queryVersion: 1n, configVersion: 1n,
      formulaVersion, dataThrough: 1n, publishedAt: 2n, activityNowQ12: 100n,
      activity7dQ12: 100n, dataStatus: DataStatus.Valid, admission})});
  assert.equal((await readFinalizedSnapshot(fakeTransport({getFinalizedAccount: async () => snapshot(3n)}),
    marketAddress, 3n)).address, snapshotAddress);
  await assert.rejects(readFinalizedSnapshot(fakeTransport({getFinalizedAccount: async () => snapshot(4n)}),
    marketAddress, 3n), /SNAPSHOT_IDENTITY_MISMATCH/);
});

test('recent blockhash is serialized unsigned and signer injection confirms only finalized status', async () => {
  const signer = await generateKeyPairSigner();
  const [marketAddress] = await findMarketPda({marketId});
  const {instruction} = await createOpenFreeInstruction({marketAddress, owner: signer.address, recordId: 9n});
  let sends = 0;
  let reads = 0;
  const transport = fakeTransport({
    async sendTransaction(wire) { sends++; return getSignatureFromTransaction(
      getTransactionDecoder().decode(getBase64Encoder().encode(wire))); },
    async getSignatureStatus() { reads++; return reads === 1
      ? {confirmationStatus: 'confirmed', err: null} : {confirmationStatus: 'finalized', err: null}; },
  });
  const prepared = await prepareUnsignedTransaction({transport, instruction, feePayer: signer.address});
  const unsigned = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.unsignedTransaction));
  assert.equal(unsigned.signatures[signer.address], null);
  assert.equal(prepared.blockhash, blockhash);
  assert.equal(prepared.lastValidBlockHeight, '100');
  const result = await submitAndConfirmFinalized({transport, prepared, expectedInstruction: instruction,
    sign: withKitSigner(signer), wait: async () => {}});
  assert.equal(result.state, 'FINALIZED');
  assert.equal(sends, 1);
  assert.equal(reads, 2);
});

test('blockhash, prepared identity and signed message mismatch stop submission', async () => {
  const signer = await generateKeyPairSigner();
  const [marketAddress] = await findMarketPda({marketId});
  const {instruction} = await createOpenFreeInstruction({marketAddress, owner: signer.address, recordId: 9n});
  let sends = 0;
  const transport = fakeTransport({sendTransaction: async () => { sends++; return 'unused'; }});
  const prepared = await prepareUnsignedTransaction({transport, instruction, feePayer: signer.address});
  await assert.rejects(submitAndConfirmFinalized({transport, prepared: {...prepared,
    blockhash: getBase58Decoder().decode(new Uint8Array(32).fill(8))},
    expectedInstruction: instruction, sign: withKitSigner(signer)}), /PREPARED_TRANSACTION_IDENTITY_MISMATCH/);
  await assert.rejects(submitAndConfirmFinalized({transport: fakeTransport({getBlockHeight: async () => 101n}),
    prepared, expectedInstruction: instruction, sign: withKitSigner(signer)}), /BLOCKHASH_EXPIRED_BEFORE_SIGNING/);
  await assert.rejects(submitAndConfirmFinalized({transport: fakeTransport({isBlockhashValid: async () => false}),
    prepared, expectedInstruction: instruction, sign: withKitSigner(signer)}), /BLOCKHASH_EXPIRED_BEFORE_SIGNING/);
  const wrong = (await createOpenFreeInstruction({marketAddress, owner: signer.address, recordId: 10n})).instruction;
  await assert.rejects(submitAndConfirmFinalized({transport, prepared, expectedInstruction: wrong,
    sign: withKitSigner(signer)}), /PREPARED_TRANSACTION_IDENTITY_MISMATCH/);
  await assert.rejects(submitAndConfirmFinalized({transport, prepared, expectedInstruction: instruction,
    sign: async transaction => ({...transaction, messageBytes: new Uint8Array([1])})}), /SIGNED_TRANSACTION_IDENTITY_MISMATCH/);
  assert.equal(sends, 0);
});

test('RPC failure, failed status and absent finality never report success', async () => {
  const signer = await generateKeyPairSigner();
  const [marketAddress] = await findMarketPda({marketId});
  const {instruction} = await createOpenFreeInstruction({marketAddress, owner: signer.address, recordId: 9n});
  const base = fakeTransport();
  const prepared = await prepareUnsignedTransaction({transport: base, instruction, feePayer: signer.address});
  const sign = withKitSigner(signer);
  const failure = await submitAndConfirmFinalized({transport: fakeTransport({
    getSignatureStatus: async () => ({confirmationStatus: 'finalized', err: {InstructionError: [0, 'Custom']}}),
  }), prepared, expectedInstruction: instruction, sign});
  assert.equal(failure.state, 'FAILED');
  const unknown = await submitAndConfirmFinalized({transport: fakeTransport({
    getSignatureStatus: async () => ({confirmationStatus: 'confirmed', err: null}),
  }), prepared, expectedInstruction: instruction, sign, attempts: 2, wait: async () => {}});
  assert.equal(unknown.state, 'UNKNOWN');
  const uncertain = await submitAndConfirmFinalized({transport: fakeTransport({
    sendTransaction: async () => {throw new Error('https://rpc.example/?api-key=secret');},
  }), prepared, expectedInstruction: instruction, sign});
  assert.equal(uncertain.state, 'UNKNOWN');
  assert.equal(uncertain.reason, 'SUBMISSION_UNCERTAIN');
  let heightReads = 0;
  const heightFailure = await submitAndConfirmFinalized({transport: fakeTransport({
    getSignatureStatus: async () => null,
    getBlockHeight: async () => { if (++heightReads === 1) return 50n; throw new Error('secret'); },
  }), prepared, expectedInstruction: instruction, sign});
  assert.equal(heightFailure.state, 'UNKNOWN');
  assert.equal(heightFailure.reason, 'FINALITY_HEIGHT_UNAVAILABLE');
  assert.equal(typeof heightFailure.signature, 'string');
  let sent = false;
  await assert.rejects(submitAndConfirmFinalized({transport: fakeTransport({
    sendTransaction: async () => { sent = true; throw new Error('send'); },
  }), prepared, expectedInstruction: instruction, sign, attempts: 0}), /INVALID_FINALITY_ATTEMPTS/);
  assert.equal(sent, false);
});
