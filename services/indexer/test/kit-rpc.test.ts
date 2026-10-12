import test from 'node:test';
import assert from 'node:assert/strict';
import { createSolanaRpcFromTransport } from '@solana/kit';
import { KitFinalizedRpc } from '../src/rpc.ts';

const program = '11111111111111111111111111111111';
const signature = '1'.repeat(64);

test('Kit transport requests finalized signatures, transaction and block order', async () => {
  const requests: Array<{method:string;params:any[]}> = [];
  const transport: any = async ({ payload }: { payload: { method:string; params:any[] } }) => {
    requests.push({ method: payload.method, params: payload.params });
    if (payload.method === 'getSignaturesForAddress') return { result: [{ signature, slot: 7, err: null, memo: null, blockTime: null, confirmationStatus: 'finalized' }] };
    if (payload.method === 'getTransaction') return { result: { slot: 7, blockTime: null, version: 0, meta: { err: null }, transaction: ['AAAA', 'base64'] } };
    if (payload.method === 'getBlock') return { result: { blockhash: program, previousBlockhash: program, parentSlot: 6, blockTime: null, blockHeight: null, signatures: [signature] } };
    throw new Error('unexpected RPC method');
  };
  const kit = createSolanaRpcFromTransport(transport);
  const rpc = new KitFinalizedRpc('http://fixture.invalid', kit as any);
  assert.deepEqual(await rpc.listSignatures(program, null, 10), [{ signature, slot: '7', failed: false }]);
  const evidence = await rpc.getEvidence(signature, '7');
  assert.equal(evidence.transactionIndex, 0);
  assert.deepEqual(requests.map(item => item.method), ['getSignaturesForAddress', 'getTransaction', 'getBlock']);
  // Kit elides explicit finalized because that is the JSON-RPC server default.
  for (const request of requests) assert.equal(request.params[1].commitment, undefined);
  assert.equal(requests[2].params[1].transactionDetails, 'signatures');
});
