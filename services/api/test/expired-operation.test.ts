import test from 'node:test';
import assert from 'node:assert/strict';
import * as k from '@solana/kit';
import {LiveStore} from '../src/live-store.ts';
import {KitOperationChain,reconcileLiveOperation} from '../src/operation-chain.ts';
const wallet=await k.generateKeyPairSigner();
const ix={programAddress:k.address('11111111111111111111111111111111'),data:Uint8Array.of(1),accounts:[{address:wallet.address,role:k.AccountRole.WRITABLE_SIGNER}]};
const tx=k.compileTransaction(k.appendTransactionMessageInstruction(ix,k.setTransactionMessageLifetimeUsingBlockhash({blockhash:k.blockhash('11111111111111111111111111111111'),lastValidBlockHeight:10n},k.setTransactionMessageFeePayer(wallet.address,k.createTransactionMessage({version:0})))));
const wire=k.getBase64Decoder().decode(k.getTransactionEncoder().encode(tx));
function fixture(){const store=new LiveStore(':memory:');const intent={wallet:wallet.address,action:'openFree' as const,requestId:'expiry-test',marketId:wallet.address,recordId:null};store.save(intent,{kind:'transaction',action:'openFree',requestId:intent.requestId,recordId:wallet.address,wallet:wallet.address,cluster:'devnet',programId:ix.programAddress,expiresAt:100,unsignedTransaction:wire,lastValidBlockHeight:'10',quoteRef:null},'expiry-test');return store;}

test('expiry requires finalized height and invalid blockhash; full or missing history stays unknown',async()=>{
 let height=10,valid=false,rows:any[]=[],receipt=false;
 const rpc=k.createSolanaRpcFromTransport((async({payload}:any)=>{
  if(payload.method==='getBlockHeight')return {result:height};
  if(payload.method==='isBlockhashValid')return {result:{context:{slot:55},value:valid}};
  if(payload.method==='getSignaturesForAddress'){assert.equal(payload.params[1].minContextSlot,55n);return {result:rows};}
  if(payload.method==='getSignatureStatuses')return {result:{context:{slot:55},value:[receipt?{slot:54,confirmations:null,err:null,confirmationStatus:'finalized'}:null]}};
  throw Error('unexpected RPC');
 }) as any);
 const chain=new KitOperationChain('http://fixture.invalid',rpc as any),store=fixture();
 try{
  assert.equal(await chain.expiredHistory(store.get('expiry-test')!),null);
  height=11;valid=true;assert.equal(await chain.expiredHistory(store.get('expiry-test')!),null);
  valid=false;assert.deepEqual(await chain.expiredHistory(store.get('expiry-test')!),[]);
  const row={signature:'1'.repeat(64),slot:54,err:null,memo:null,blockTime:null,confirmationStatus:'finalized'};
  rows=Array(100).fill(row);assert.equal(await chain.expiredHistory(store.get('expiry-test')!),null);
  rows=[row];assert.equal(await chain.expiredHistory(store.get('expiry-test')!),null);
 }finally{store.close();}
});

test('no history proof never resolves UNKNOWN; complete expired history permits FAILED requote',async()=>{
 const store=fixture();let history:any=null;
 const chain={get:async()=>null,discover:async()=>[],expiredHistory:async()=>history};
 try{
  assert.equal((await reconcileLiveOperation(store,chain,'expiry-test',101)).state,'UNKNOWN');
  history=[];
  const result=await reconcileLiveOperation(store,chain,'expiry-test',101);
  assert.equal(result.state,'FAILED');assert.equal(result.signature,null);assert.equal(result.error?.code,'REQUOTE_REQUIRED');
 }finally{store.close();}
});

test('expired history recovers matching signed receipt instead of clearing a landed request',async()=>{
 const store=fixture(),signed=await k.signTransactionWithSigners([wallet],tx),signature=k.getSignatureFromTransaction(signed);
 const receipt={wireBase64:k.getBase64Decoder().decode(k.getTransactionEncoder().encode(signed)),status:'finalized' as const};
 try{
  const result=await reconcileLiveOperation(store,{get:async()=>null,discover:async()=>[],expiredHistory:async()=>[{signature,receipt}]},'expiry-test',101);
  assert.equal(result.state,'FINALIZED');assert.equal(result.signature,signature);
 }finally{store.close();}
});

test('same-lifetime unrecognized wallet mutation stays UNKNOWN, never safe to requote',async()=>{
 const store=fixture();
 const changed=k.compileTransaction(k.appendTransactionMessageInstruction({...ix,data:Uint8Array.of(2)},k.setTransactionMessageLifetimeUsingBlockhash({blockhash:k.blockhash('11111111111111111111111111111111'),lastValidBlockHeight:10n},k.setTransactionMessageFeePayer(wallet.address,k.createTransactionMessage({version:0})))));
 const signed=await k.signTransactionWithSigners([wallet],changed),signature=k.getSignatureFromTransaction(signed);
 const receipt={wireBase64:k.getBase64Decoder().decode(k.getTransactionEncoder().encode(signed)),status:'finalized' as const};
 try{
  const result=await reconcileLiveOperation(store,{get:async()=>null,discover:async()=>[{signature,receipt}],expiredHistory:async()=>[{signature,receipt}]},'expiry-test',101);
  assert.equal(result.state,'UNKNOWN');assert.equal(result.error,null);assert.equal(result.signature,null);
 }finally{store.close();}
});

test('a discovered verified receipt repairs an earlier unsigned expiry classification',async()=>{
 const store=fixture(),signed=await k.signTransactionWithSigners([wallet],tx),signature=k.getSignatureFromTransaction(signed);
 const receipt={wireBase64:k.getBase64Decoder().decode(k.getTransactionEncoder().encode(signed)),status:'finalized' as const};
 try{
  store.markExpiredUnlanded('expiry-test');
  const result=await reconcileLiveOperation(store,{get:async()=>null,discover:async()=>[{signature,receipt}]},'expiry-test',101);
  assert.equal(result.state,'FINALIZED');assert.equal(result.signature,signature);assert.equal(result.error,null);
 }finally{store.close();}
});
