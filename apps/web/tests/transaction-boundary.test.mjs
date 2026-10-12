import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { address, getBase64Decoder, getCompiledTransactionMessageEncoder, getTransactionDecoder, getTransactionEncoder } from '@solana/kit';
import { ANTE_UP_PROGRAM_ADDRESS, findAdmissionPda, findRecordPda, findWalletMarketPda, findWalletStatsPda, getCloseFreeInstructionDataEncoder, getOpenFreeInstructionDataEncoder } from '@ante-up/chain-client';

const server = await createServer({ optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
after(() => server.close());
const { inspectPreparedTransaction, sendPreparedTransaction } = await server.ssrLoadModule('/src/transactionBoundary.ts');
const { verifyFreeInstruction } = await server.ssrLoadModule('/src/freeInstructionVerifier.ts');
const owner = address('Vote111111111111111111111111111111111111111');
const market = address('Stake11111111111111111111111111111111111111');
const programId = ANTE_UP_PROGRAM_ADDRESS;
const system = address('11111111111111111111111111111111');
const [admission] = await findAdmissionPda();
const [walletStats] = await findWalletStatsPda({ owner });
const [walletMarket] = await findWalletMarketPda({ owner, market });
const [record] = await findRecordPda({ owner, market, recordId: 7n });
const now = 1_700_000_000;
const reportSubmission = async (requestId, signature) => ({ requestId, wallet: owner, action: 'openFree', signature, state: 'SUBMITTED', error: null });

function bytes(action = 'openFree', { program = programId, recordAccount = record, data } = {}) {
  const opening = action === 'openFree';
  const staticAccounts = opening
    ? [owner, admission, walletStats, walletMarket, recordAccount, market, system, program]
    : [owner, recordAccount, walletStats, walletMarket, market, program];
  const messageBytes = getCompiledTransactionMessageEncoder().encode({
    version: 'legacy',
    header: { numSignerAccounts: 1, numReadonlySignerAccounts: 0, numReadonlyNonSignerAccounts: opening ? 3 : 2 },
    staticAccounts,
    lifetimeToken: '11111111111111111111111111111111',
    instructions: [{
      programAddressIndex: opening ? 7 : 5,
      accountIndices: opening ? [5, 1, 2, 3, 4, 0, 6] : [4, 1, 2, 3, 0],
      data: data ?? (opening ? getOpenFreeInstructionDataEncoder().encode({ recordId: 7n }) : getCloseFreeInstructionDataEncoder().encode({})),
    }],
  });
  return getTransactionEncoder().encode({ messageBytes, signatures: { [owner]: null } });
}
function fixture(action = 'openFree', overrides = {}) {
  const prepared = { kind: 'transaction', action, requestId: 'req-1', recordId: record, wallet: owner, cluster: 'devnet', programId, expiresAt: now + 60, unsignedTransaction: getBase64Decoder().decode(bytes(action)), lastValidBlockHeight: '1', quoteRef: null, ...overrides };
  const intent = { action, requestId: 'req-1', recordId: record, programId, marketAddress: market };
  const signer = { address: owner, async signAndSendTransactions() { return [new Uint8Array(64).fill(1)]; } };
  const wallet = { address: owner, cluster: 'devnet', supportedTransactionVersions: new Set(['legacy']), signer };
  return { prepared, intent, wallet };
}

test('decodes unsigned bytes and binds wallet, cluster, action, program and expiry', () => {
  const { prepared, intent, wallet } = fixture();
  assert.ok(inspectPreparedTransaction(prepared, intent, wallet, now).messageBytes.length > 0);
  assert.throws(() => inspectPreparedTransaction({ ...prepared, cluster: 'localnet' }, intent, wallet, now), /cluster/);
  assert.throws(() => inspectPreparedTransaction({ ...prepared, action: 'closeFree' }, intent, wallet, now), /requested action/);
  assert.throws(() => inspectPreparedTransaction({ ...prepared, recordId: 'wrong' }, intent, wallet, now), /requested action/);
  assert.throws(() => inspectPreparedTransaction({ ...prepared, expiresAt: now }, intent, wallet, now), /expired/);
  assert.throws(() => inspectPreparedTransaction({ ...prepared, unsignedTransaction: getBase64Decoder().decode(bytes('openFree', { program: market })) }, intent, wallet, now), /expected program/);
  assert.throws(() => inspectPreparedTransaction(prepared, intent, { ...wallet, supportedTransactionVersions: new Set([0]) }, now), /does not support/);
});

test('generated decoder validates open and close account identity and PDA', async () => {
  const { intent, wallet } = fixture();
  await verifyFreeInstruction(getTransactionDecoder().decode(bytes()), intent, wallet);
  await verifyFreeInstruction(getTransactionDecoder().decode(bytes('closeFree')), { ...intent, action: 'closeFree' }, wallet);
  await assert.rejects(verifyFreeInstruction(getTransactionDecoder().decode(bytes('openFree', { recordAccount: market })), intent, wallet), /record PDA/);
  await assert.rejects(verifyFreeInstruction(getTransactionDecoder().decode(bytes('openFree', { data: new Uint8Array(16) })), intent, wallet), /discriminator/);
  await assert.rejects(verifyFreeInstruction(getTransactionDecoder().decode(bytes('closeFree', { recordAccount: market })), { ...intent, action: 'closeFree' }, wallet), /record PDA/);
});

test('wallet switch, rejection and bad instruction stop before submission', async () => {
  const { prepared, intent, wallet } = fixture();
  let called = 0;
  const switched = await sendPreparedTransaction({ prepared, intent, wallet: { ...wallet, signer: { address: owner, async signAndSendTransactions() { called++; return []; } } }, getWallet: () => wallet, reportSubmission, readOperation: async () => null, nowSeconds: () => now });
  assert.equal(switched.state, 'AWAITING_SIGNATURE');
  assert.equal(called, 0);
  const rejectingWallet = { ...wallet, signer: { address: owner, async signAndSendTransactions() { throw Object.assign(new Error('User rejected'), { code: 4001000 }); } } };
  const denied = await sendPreparedTransaction({ prepared, intent, wallet: rejectingWallet, getWallet: () => rejectingWallet, reportSubmission, readOperation: async () => null, nowSeconds: () => now });
  assert.equal(denied.state, 'AWAITING_SIGNATURE');
  const timingOutWallet = { ...wallet, signer: { address: owner, async signAndSendTransactions() { throw new Error('Network timeout'); } } };
  const ambiguous = await sendPreparedTransaction({ prepared, intent, wallet: timingOutWallet, getWallet: () => timingOutWallet, reportSubmission, readOperation: async () => null, nowSeconds: () => now });
  assert.equal(ambiguous.state, 'UNKNOWN');
  assert.equal(ambiguous.signature, null);
  const bad = await sendPreparedTransaction({ prepared: { ...prepared, unsignedTransaction: getBase64Decoder().decode(bytes('openFree', { data: new Uint8Array(16) })) }, intent, wallet, getWallet: () => wallet, reportSubmission, readOperation: async () => null, nowSeconds: () => now });
  assert.equal(bad.state, 'AWAITING_SIGNATURE');
  assert.match(bad.reason, /discriminator/);
});

test('signature alone never means finalized; operation identity and finality are checked', async () => {
  const { prepared, intent, wallet } = fixture();
  const base = { prepared, intent, wallet, getWallet: () => wallet, reportSubmission, nowSeconds: () => now, wait: async () => {}, attempts: 2 };
  const unknown = await sendPreparedTransaction({ ...base, readOperation: async () => null });
  assert.equal(unknown.state, 'UNKNOWN');
  const final = await sendPreparedTransaction({ ...base, readOperation: async () => ({ requestId: prepared.requestId, wallet: owner, action: 'openFree', signature: unknown.signature, state: 'FINALIZED', error: null }) });
  assert.equal(final.state, 'FINALIZED');
  const mismatch = await sendPreparedTransaction({ ...base, readOperation: async () => ({ requestId: prepared.requestId, wallet: owner, action: 'openFree', signature: 'wrong', state: 'FINALIZED', error: null }) });
  assert.equal(mismatch.state, 'UNKNOWN');
  const wrongAction = await sendPreparedTransaction({ ...base, readOperation: async () => ({ requestId: prepared.requestId, wallet: owner, action: 'closeFree', signature: unknown.signature, state: 'FINALIZED', error: null }) });
  assert.equal(wrongAction.state, 'UNKNOWN');
  const unreported = await sendPreparedTransaction({ ...base, reportSubmission: async () => { throw new Error('response lost'); }, readOperation: async () => null });
  assert.equal(unreported.state, 'UNKNOWN');
  assert.ok(unreported.signature);
});

test('wallet change after send keeps request unknown and does not report from a different account', async () => {
  const { prepared, intent, wallet } = fixture();
  let current = wallet;
  let reports = 0;
  const changingWallet = { ...wallet, signer: { address: owner, async signAndSendTransactions() { current = null; return [new Uint8Array(64).fill(1)]; } } };
  current = changingWallet;
  const result = await sendPreparedTransaction({ prepared, intent, wallet: changingWallet, getWallet: () => current, reportSubmission: async () => { reports++; return reportSubmission(prepared.requestId, ''); }, readOperation: async () => null, nowSeconds: () => now });
  assert.equal(result.state, 'UNKNOWN');
  assert.equal(reports, 0);
});
