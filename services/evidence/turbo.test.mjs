import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256,canonical } from './index.mjs';
import { createTurboStorageAdapter,encodeStorageContent,quoteUploadCosts } from './turbo.mjs';
import {gunzipSync} from 'node:zlib';

const item='A'.repeat(43), parent='B'.repeat(43), content='{"hello":"world"}';
const contentHash=sha256(Buffer.from(content));
test('Turbo cost quote batches a large proof packet without changing item order',async()=>{
  const calls=[];
  const costs=await quoteUploadCosts({async getUploadCosts({bytes}){
    calls.push(bytes);
    return bytes.map(value=>({winc:String(value+1)}));
  }},Array.from({length:1337},(_,i)=>i),{batchSize:64});
  assert.equal(calls.length,21);
  assert.ok(calls.every(batch=>batch.length<=64));
  assert.equal(costs.length,1337);
  assert.equal(costs[0].winc,'1');
  assert.equal(costs.at(-1).winc,'1337');
  await assert.rejects(()=>quoteUploadCosts({getUploadCosts:async()=>[]},[1]),/INVALID_COST_QUOTE/);
});
test('Turbo SDK receipt is only upload acceptance; gateway parent and 20 confirmations are separate',async()=>{
  let uploads=0,confirmations=19,verified=true;
  const turbo={async upload(input){uploads++;assert.equal(Buffer.from(input.data).toString(),content);return {id:item,signature:'fixture',version:'0.2.0',optional:undefined,helper:()=>true};}};
  const fetcher=async (url,options) => {
    if (url.pathname.startsWith('/raw/')) return {ok:true,arrayBuffer:async()=>Buffer.from(content),headers:new Headers({
      'x-ar-io-root-transaction-id':parent,'x-ar-io-verified':String(verified)})};
    if (url.pathname===`/tx/${parent}/status`) {
      assert.match(url.searchParams.get('observedAt'),/^\d+$/);assert.equal(options.cache,'no-store');
      return {ok:true,json:async()=>({number_of_confirmations:confirmations})};
    }
    throw new Error('unexpected URL');
  };
  const adapter=createTurboStorageAdapter({turbo,fetcher,receiptVerifier:async r=>r.signature==='fixture'});
  const accepted=await adapter.upload('market',content,contentHash);
  assert.doesNotThrow(()=>canonical(accepted));
  assert.equal(uploads,1); assert.equal(accepted.ref.parentTransactionId,null);
  const ref=await adapter.resolve(accepted.ref);
  assert.equal(ref.parentTransactionId,parent);
  assert.equal((await adapter.verify(ref,accepted.receipt)).confirmations,19);
  confirmations=20;
  assert.equal((await adapter.verify(ref,accepted.receipt)).confirmations,20);
  verified=false;
  assert.equal((await adapter.verify(ref,accepted.receipt)).itemIncluded,false);
  assert.equal(await adapter.fetch(ref),content);
  await assert.rejects(()=>adapter.verify(ref,{...accepted.receipt,signature:'bad'}),/INVALID_RECEIPT/);
});

test('Turbo adapter refuses upload path without signature verifier',()=>{
  assert.throws(()=>createTurboStorageAdapter({turbo:{upload:async()=>({})}}),/RECEIPT_VERIFIER_REQUIRED/);
});

test('large canonical artifacts are losslessly compressed and verified after retrieval',async()=>{
 const original=JSON.stringify({rows:Array.from({length:1000},(_,i)=>({time:i,value:15}))});
 const hash=sha256(Buffer.from(original)),encoded=encodeStorageContent(original);
 assert.equal(encoded.encoding,'gzip');assert.ok(encoded.bytes.length<original.length);
 assert.equal(gunzipSync(encoded.bytes).toString(),original);
 let stored;
 const adapter=createTurboStorageAdapter({turbo:{upload:async input=>{stored=input;return {id:item};}},receiptVerifier:async()=>true,
  fetcher:async()=>({ok:true,arrayBuffer:async()=>stored.data,headers:new Headers({'x-ar-io-root-transaction-id':parent})})});
 const uploaded=await adapter.upload('calc',original,hash);
 assert.equal(stored.dataItemOpts.tags.find(t=>t.name==='Content-Type').value,'application/gzip');
 assert.equal(await adapter.fetch(uploaded.ref),original);
 assert.equal((await adapter.resolve(uploaded.ref)).contentHash,hash);
 stored.data=Buffer.from('{"tampered":true}');
 await assert.rejects(()=>adapter.fetch(uploaded.ref),/CONTENT_MISMATCH/);
});
