import assert from 'node:assert/strict';
import test from 'node:test';
import { createResultCard, formatResult, resultCardSvg } from '../src/sharing/resultCard.ts';
const point = { executedAt: 1791800000, slot: '10', signature: 'sig', snapshot: null, h: null, unavailableReason: null };
const record = { id: 'record-1', wallet: 'wallet-owner', marketId: 'market', direction: 'up', entry: point, exit: { ...point, executedAt: 1791803600 }, status: 'CLOSED_RESULT', result: { kind: 'return', numerator: '1', denominator: '4' }, finality: 'finalized', proofId: 'proof-1' };
test('only finalized closed records create public result cards', () => {
  assert.equal(createResultCard({ ...record, status: 'OPEN' }, 'solana', 'devnet', null), null);
  assert.equal(createResultCard({ ...record, finality: 'confirmed' }, 'solana', 'devnet', null), null);
  assert.equal(createResultCard({ ...record, exit: null }, 'solana', 'devnet', null), null);
  const card = createResultCard(record, 'solana', 'devnet', null);
  assert.equal(card.url, 'https://ante-up.fun/records/record-1');
  assert.equal(card.result, '+25.00%');
  assert.equal(card.proof, 'Proof pending');
  assert.equal(createResultCard(record, 'solana', 'fixture', null).url, null);
  assert.equal(createResultCard(record, 'solana', null, null).network, 'NETWORK UNAVAILABLE');
});
test('exact rational results preserve loss, zero, missing and large integers', () => {
  const result = (numerator, denominator) => formatResult({ ...record, result: { kind: 'return', numerator, denominator } });
  assert.equal(result('-1', '8'), '−12.50%');
  assert.equal(result('0', '1'), '0.00%');
  assert.equal(result('9007199254740993', '9007199254740993'), '+100.00%');
  assert.equal(result('1', '0'), 'N/A');
  assert.equal(formatResult({ ...record, status: 'CLOSED_NA', result: { kind: 'na', reason: 'DATA_NOT_READY' } }), 'N/A');
});
test('proof badge requires matching record and proof; invalid and replaced stay visible', () => {
  const ref = {contentHash:'a'.repeat(64),arweaveItemId:'A'.repeat(43),parentTransactionId:'B'.repeat(43)};
  const proof = { id: 'proof-1', recordId: 'record-1', state: 'ISSUED', sasId: '11111111111111111111111111111111', confirmations:20, payloadHash:'a'.repeat(64), manifestRef:ref,evidence:[ref] };
  assert.equal(createResultCard(record, 'solana', 'devnet', proof).proof, 'SAS issued');
  assert.equal(createResultCard(record, 'solana', 'devnet', { ...proof, recordId: 'other' }).proof, 'Proof pending');
  assert.equal(createResultCard(record, 'solana', 'devnet', { ...proof, state: 'INVALID' }).proof, 'Proof invalid');
  assert.equal(createResultCard(record, 'solana', 'devnet', { ...proof, state: 'REPLACED' }).proof, 'Proof replaced');
  assert.equal(createResultCard(record, 'solana', 'devnet', null, true).proof, 'Proof status unavailable');
  assert.equal(createResultCard(record, 'solana', 'devnet', {...proof,confirmations:19}).proof, 'Proof pending');
  assert.equal(createResultCard(record, 'solana', 'devnet', {...proof,sasId:'sas:fake'}).proof, 'Proof pending');
});
test('standalone card escapes public text and distinguishes attention from cash return', () => {
  const svg = resultCardSvg(createResultCard(record, '<script>&"hello', 'devnet', null, false, 1791803600000), 'https://example.com/remote.png');
  assert.ok(svg.includes('&lt;script&gt;&amp;&quot;hello'));
  assert.ok(!svg.includes('<script>'));
  assert.ok(!svg.includes('<image'));
  assert.match(svg, /not a cash return/);
  assert.match(svg, /Proof pending/);
  assert.match(svg, /1080/);
});
