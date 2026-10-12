import test from 'node:test';
import assert from 'node:assert/strict';
import { createSolanaRpcFromTransport } from '@solana/kit';
import { KitOperationChain } from '../src/operation-chain.ts';

test('Kit receipt reader checks RPC status and fetches bounded record signatures',async()=>{
  const requests:string[]=[];
  const signature='1'.repeat(64);
  const transport:any=async({payload}:{payload:{method:string;params:any[]}})=>{
    requests.push(payload.method);
    if (payload.method==='getSignatureStatuses') return {result:{context:{slot:7},value:[{slot:7,confirmations:null,err:null,confirmationStatus:'finalized'}]}};
    if (payload.method==='getTransaction') return {result:{slot:7,blockTime:null,version:0,meta:{err:null},transaction:['AAAA','base64']}};
    if (payload.method==='getSignaturesForAddress') return {result:[{signature,slot:7,err:null,memo:null,blockTime:null,confirmationStatus:'finalized'}]};
    throw new Error('unexpected RPC method');
  };
  const rpc=new KitOperationChain('http://fixture.invalid',createSolanaRpcFromTransport(transport) as any);
  assert.deepEqual(await rpc.get(signature),{wireBase64:'AAAA',status:'finalized'});
  assert.deepEqual(await rpc.discover('11111111111111111111111111111111'),[{signature,receipt:{wireBase64:'AAAA',status:'finalized'}}]);
  assert.deepEqual(requests,['getSignatureStatuses','getTransaction','getSignaturesForAddress','getSignatureStatuses','getTransaction']);
});
