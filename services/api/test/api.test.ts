import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { validateActionBody, validateMarket, validateProof, validateRecord } from '../src/validate.ts';
import { fixtureMarkets } from '../src/fixture.ts';
import { validatePreparedForWallet } from '../src/transaction.ts';
import { LiveStore } from '../src/live-store.ts';

const at = 1_800_000_000;
const base = 'http://fixture.test';
const wallet = '11111111111111111111111111111111';
const requestId = '123e4567-e89b-42d3-a456-426614174000';
const app = () => createApp({ now: () => at, verifier: { async verify() { return true; } } });
async function body(response: Response) { return response.json() as Promise<any>; }
async function signedPost(api: ReturnType<typeof app>, path: string, payload: unknown) {
  const challenge = await body(await api.handle(new Request(`${base}/v1/auth`, { method: 'POST', body: JSON.stringify({ wallet, cluster: 'localnet' }) })));
  return api.handle(new Request(`${base}${path}`, { method: 'POST', headers: { 'x-ante-nonce': challenge.data.nonce, 'x-ante-signature': 'fixture-test-signature' }, body: JSON.stringify(payload) }));
}

test('an exhausted RPC is reported as a retryable service error', async () => {
  const api = createApp({now: () => at, read: {
    async markets() { throw new Error('HTTP error (429): Too Many Requests'); },
    async records() { return []; },
    async proofs() { return []; },
    async heldCalculationWallets() { return new Set<string>(); },
  }});
  const response = await api.handle(new Request(`${base}/v1/markets`));
  assert.equal(response.status, 503);
  assert.deepEqual(await body(response), {
    code: 'RPC_RATE_LIMITED',
    message: 'Devnet RPC is busy. Request a fresh quote in a moment.',
    retryable: true,
    requestId: null,
  });
});

test('fixture reads disclose mode, free history, N/A and no Pro/LP money', async () => {
  const api = app();
  const markets = await body(await api.handle(new Request(`${base}/v1/markets`)));
  assert.equal(markets.mode, 'fixture');
  assert.equal(markets.data[0].price.executable, false);
  assert.equal(markets.data[0].snapshot.payload.formulaVersion, 'h3-d7-q12-v1');
  assert.equal(markets.data[0].snapshot.payload.queryHash.length, 64);
  assert.equal(markets.data[0].snapshot.payload.admission.state, 'BLOCKED');
  const profile = await body(await api.handle(new Request(`${base}/v1/profiles/FixtureBob`)));
  assert.equal(profile.data.closedNaCount, '1');
  assert.equal(profile.data.closedValidCount, '1');
  assert.equal(profile.data.averageReturn.numerator, '-1');
  assert.equal(profile.data.openRecords.length, 0);
  assert.ok(!JSON.stringify(profile).includes('collateralAtoms'));
  assert.ok(!JSON.stringify(profile).includes('lpShares'));
  const carol = await body(await api.handle(new Request(`${base}/v1/profiles/FixtureCarol`)));
  assert.equal(carol.data.openRecords[0].marketId, 'fixture:sol');
  assert.equal(carol.data.leaderboardStatus, 'NO_RESULT');
  assert.deepEqual(carol.data.openPreviews[0].referenceReturn, { numerator: '1', denominator: '5' });
  assert.equal(carol.data.openPreviews[0].status, 'REFERENCE');
  const held = await body(await api.handle(new Request(`${base}/v1/profiles/FixtureHeld`)));
  assert.equal(held.data.averageReturn, null);
  assert.equal(held.data.leaderboardStatus, 'HELD_CALCULATION_ERROR');
});

test('proof route resolves proofId, replacement, and nullable missing proof', async () => {
  const api = app();
  const record = await body(await api.handle(new Request(`${base}/v1/records/fixture%3Aalice-win`)));
  assert.equal(record.data.proofId, 'fixture:proof-alice-v1');
  const proof = await body(await api.handle(new Request(`${base}/v1/proofs/${encodeURIComponent(record.data.proofId)}`)));
  assert.equal(proof.data.state, 'REPLACED');
  assert.equal(proof.data.replacementId, 'fixture:proof-alice-v2');
  const replacement = await body(await api.handle(new Request(`${base}/v1/proofs/${encodeURIComponent(proof.data.replacementId)}`)));
  assert.equal(replacement.data.state, 'QUEUED');
  assert.equal(replacement.data.payloadHash, null);
  const missing = await body(await api.handle(new Request(`${base}/v1/proofs/not-found`)));
  assert.equal(missing.data, null);
  const doubleEncoded = await body(await api.handle(new Request(`${base}/v1/proofs/fixture%253Aproof-alice-v1`)));
  assert.equal(doubleEncoded.data, null);
});

test('leaderboard includes losses, excludes N/A and open, filters by exit time, holds calculation errors', async () => {
  const api = app();
  const week = (await body(await api.handle(new Request(`${base}/v1/leaderboard?period=7d`)))).data;
  assert.deepEqual(week.rows.map((r: any) => [r.wallet, r.averageReturn.numerator, r.averageReturn.denominator, r.rank]),
    [['FixtureAlice', '1', '5', 1], ['FixtureBob', '-1', '4', 2]]);
  assert.equal(week.rows[1].closedNaCount, '1');
  assert.equal(week.rows[0].status, 'ELIGIBLE');
  assert.deepEqual(week.heldWallets, ['FixtureHeld']);
  const all = (await body(await api.handle(new Request(`${base}/v1/leaderboard?period=all`)))).data;
  assert.equal(all.rows[0].wallet, 'FixtureAlice');
  assert.deepEqual(all.rows[0].averageReturn, { numerator: '-3', denominator: '20' });
  assert.equal(all.rows[0].closedValidCount, '2');
});

test('fixture quote and prepare require signatures and remain explicitly not executable', async () => {
  let preparedCalls = 0;
  const api = createApp({ now: () => at, verifier: { async verify() { return true; } },
    transactions: { async prepare() { preparedCalls++; return { kind: 'transaction', action: 'openFree', requestId, unsignedTransaction: 'AAAA', lastValidBlockHeight: '1', quoteRef: 'q', wallet, cluster: 'localnet', programId: wallet, expiresAt: at + 30, recordId: 'generated' }; } } });
  const payload = { wallet, action: 'openFree', requestId, marketId: 'fixture:sol' };
  const unsigned = await api.handle(new Request(`${base}/v1/quotes`, { method: 'POST', body: JSON.stringify(payload) }));
  assert.equal(unsigned.status, 403);
  const quote = await body(await signedPost(api, '/v1/quotes', payload));
  assert.equal(quote.data.kind, 'notExecutable');
  assert.equal(quote.data.reason, 'FIXTURE_NO_CHAIN_ADAPTER');
  const prepared = await body(await signedPost(api, '/v1/transactions/prepare', payload));
  assert.equal(prepared.data.kind, 'notExecutable');
  assert.equal(prepared.data.unsignedTransaction, undefined);
  assert.equal(preparedCalls, 0);
  assert.equal(api.operations.get(requestId), null);
  const faucet = await api.handle(new Request(`${base}/v1/faucet/claims`, { method: 'POST' }));
  assert.equal(faucet.status, 409);
  const deniedAdmin = await signedPost(api, '/v1/admin/actions', { wallet, action: 'publishSnapshot' });
  assert.equal(deniedAdmin.status, 403);
  assert.equal(api.audit[0].allowed, false);
});

test('closeFree requires record ID and prepared bytes remain bound to wallet/cluster/program/deadline', () => {
  const input = validateActionBody({ wallet, action: 'closeFree', requestId, marketId: 'fixture:sol', recordId: 'r1' });
  assert.throws(() => validateActionBody({ wallet, action: 'closeFree', requestId, marketId: 'fixture:sol' }), /recordId required/);
  assert.throws(() => validateActionBody({ wallet, action: 'openFree', requestId, marketId: 'fixture:sol', recordId: 'caller-chosen' }), /generated by the chain builder/);
  const prepared: any = { kind: 'transaction', action: 'closeFree', requestId, wallet, cluster: 'localnet', programId: wallet,
    expiresAt: at + 30, recordId: 'r1', unsignedTransaction: 'AAAA', lastValidBlockHeight: '100', quoteRef: null };
  const expected = { cluster: 'localnet' as const, programId: wallet, now: at };
  assert.equal(validatePreparedForWallet(prepared, input, expected).recordId, 'r1');
  assert.throws(() => validatePreparedForWallet({ ...prepared, wallet: 'other' }, input, expected), /IDENTITY_MISMATCH/);
  assert.throws(() => validatePreparedForWallet({ ...prepared, expiresAt: at }, input, expected), /PREPARED_EXPIRED/);
  assert.throws(() => validatePreparedForWallet({ ...prepared, recordId: 'r2' }, input, expected), /RECORD_ID_MISMATCH/);
});

test('live mode requires a matching read adapter and rejects a challenge for another cluster', async () => {
  assert.throws(() => createApp({mode: 'devnet'}), /READ_ADAPTER_MODE_MISMATCH/);
  const liveStore=new LiveStore(':memory:');
  const api = createApp({mode: 'devnet', programId:wallet, liveStore,
    chain:{async get(){return null;},async discover(){return [];}},
    now: () => at, verifier: {async verify() {return true;}}, read: {
    mode: 'devnet', async markets() {return [];}, async records() {return [];},
    async proofs() {return [];}, async heldCalculationWallets() {return new Set<string>();},
  }});
  const mismatch = await api.handle(new Request(`${base}/v1/auth`, {method: 'POST', body: JSON.stringify({wallet, cluster: 'localnet'})}));
  assert.equal(mismatch.status, 403);
  const markets = await body(await api.handle(new Request(`${base}/v1/markets`)));
  assert.equal(markets.mode, 'devnet');
  liveStore.close();
});

test('runtime validation rejects malformed result denominator and missing status', () => {
  const record: any = { id: 'r', wallet: 'w', marketId: 'm', direction: 'up', entry: { executedAt: 1, slot: '1', signature: 's', h: { numerator: '1', denominator: '1' }, snapshot: null },
    exit: { executedAt: 2, slot: '2', signature: 's', h: { numerator: '2', denominator: '1' }, snapshot: null }, status: 'CLOSED_RESULT', finality: 'finalized', result: { kind: 'return', numerator: '1', denominator: '0' } };
  assert.throws(() => validateRecord(record), /zero result denominator/);
  record.result.denominator = '2'; record.status = 'OPEN';
  assert.throws(() => validateRecord(record), /open record has result/);
});

test('ready and issued proof require matching manifest, complete refs, 20 confirmations and SAS ID', () => {
  const hash = 'a'.repeat(64);
  const ref = { contentHash: hash, arweaveItemId: 'item', parentTransactionId: 'parent' };
  const proof: any = { id: 'p', recordId: 'r', payloadHash: hash, manifestRef: ref, state: 'READY_TO_ISSUE',
    evidence: [ref], confirmations: 20, sasId: null, retryAt: null, error: null, replacementId: null };
  assert.equal(validateProof(proof).state, 'READY_TO_ISSUE');
  assert.throws(() => validateProof({ ...proof, manifestRef: { ...ref, contentHash: 'b'.repeat(64) } }), /manifest hash mismatch/);
  assert.throws(() => validateProof({ ...proof, confirmations: 19 }), /20 confirmations/);
  assert.throws(() => validateProof({ ...proof, evidence: [{ ...ref, parentTransactionId: null }] }), /complete evidence refs/);
  assert.throws(() => validateProof({ ...proof, state: 'ISSUED' }), /proof.sasId required/);
  assert.equal(validateProof({ ...proof, state: 'ISSUED', sasId: 'synthetic-sas' }).state, 'ISSUED');
});

test('snapshot runtime validation binds formula, query hash and admission', () => {
  const invalid: any = structuredClone(fixtureMarkets[0]);
  invalid.snapshot.payload.queryHash = 'A'.repeat(64);
  assert.throws(() => validateMarket(invalid), /lowercase SHA-256/);
  invalid.snapshot.payload.queryHash = 'a'.repeat(64);
  invalid.snapshot.payload.formulaVersion = 'old';
  assert.throws(() => validateMarket(invalid), /formula version mismatch/);
  invalid.snapshot.payload.formulaVersion = 'h3-d7-q12-v1';
  invalid.snapshot.payload.admission.state = 'UNKNOWN';
  assert.throws(() => validateMarket(invalid), /admission.state invalid/);
});
