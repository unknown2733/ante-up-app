import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getBase58Decoder, getTransactionDecoder, getTransactionEncoder } from '@solana/kit';
import { ANTE_UP_PROGRAM_ADDRESS } from '../../../clients/chain/dist/index.js';
import type { FreeRecord, MarketView } from '../../../contracts/types.ts';
import { createApp } from '../src/app.ts';
import { LiveStore } from '../src/live-store.ts';
import { KitFreeTransactionAdapter, validateCompiledFree } from '../src/transaction.ts';
import type { ChainReceipt, OperationChain } from '../src/operation-chain.ts';

const work=resolve(import.meta.dirname,'../../../../work/d-live-tests');
mkdirSync(work,{recursive:true});
const base='http://local.test';
const programId=String(ANTE_UP_PROGRAM_ADDRESS);
const marketId='11111111111111111111111111111111';
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const wallet=getBase58Decoder().decode(publicKey.export({format:'der',type:'spki'}).subarray(-32));
const otherWallet=getBase58Decoder().decode(generateKeyPairSync('ed25519').publicKey.export({format:'der',type:'spki'}).subarray(-32));
const now=1_800_000_000;
const market:MarketView={id:marketId,keyword:'test',aliases:[],phase:'CURVE',dataStatus:'PREPARING',epochPhase:null,
  supported:true,chain:{cluster:'localnet',programId,address:marketId},snapshot:null,anchor:null,price:null,
  capabilities:{openFree:{allowed:true,reason:null},closeFree:{allowed:true,reason:null}}};
const records=new Map<string,FreeRecord>();
const read={mode:'localnet' as const,async markets(){return [market];},async market(){return market;},
  async records(){return [...records.values()];},async record(id:string){return records.get(id)??null;},
  async proofs(){return [];},async heldCalculationWallets(){return new Set<string>();}};
const receipts=new Map<string,ChainReceipt>();
const chain:OperationChain={async get(signature){return receipts.get(signature)??null;},
  async discover(){return [...receipts].map(([signature,receipt])=>({signature,receipt}));}};
const json=async(response:Response)=>response.json() as Promise<any>;
const auth=async(api:ReturnType<typeof createApp>,owner=wallet)=>{
  const challenge=await json(await api.handle(new Request(`${base}/v1/auth`,{method:'POST',body:JSON.stringify({wallet:owner,cluster:'localnet'})})));
  const exchanged=await api.handle(new Request(`${base}/v1/auth/session`,{method:'POST',body:JSON.stringify({wallet:owner,cluster:'localnet',nonce:challenge.data.nonce,signature:'test'})}));
  return {token:(await json(exchanged)).data.token,nonce:challenge.data.nonce};
};
const post=(api:ReturnType<typeof createApp>,path:string,body:unknown,token:string)=>api.handle(new Request(`${base}${path}`,{
  method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify(body)}));
function signedWire(unsigned:string) {
  const transaction=getTransactionDecoder().decode(Buffer.from(unsigned,'base64'));
  const signatureBytes=sign(null,Buffer.from(transaction.messageBytes),privateKey);
  const signature=getBase58Decoder().decode(signatureBytes);
  const signed={...transaction,signatures:{...transaction.signatures,[wallet]:signatureBytes}};
  return {signature,wireBase64:Buffer.from(getTransactionEncoder().encode(signed as any)).toString('base64')};
}

test('session, free prepare, durable request identity, verified finality and bounded discovery',async()=>{
  const path=resolve(work,`${randomUUID()}.sqlite`);
  let store=new LiveStore(path);
  let currentNow=now;
  let nextNonce=9n;
  const adapter=new KitFreeTransactionAdapter({cluster:'localnet',programId,read,
    blockhashes:{async latest(){return {blockhash:marketId,lastValidBlockHeight:999n};}},
    now:()=>currentNow,nextRecordNonce:()=>nextNonce++});
  const make=()=>createApp({mode:'localnet',programId,read,transactions:adapter,liveStore:store,chain,
    now:()=>currentNow,verifier:{async verify(){return true;}}});
  let api=make();
  const {token,nonce}=await auth(api);
  const reused=await api.handle(new Request(`${base}/v1/auth/session`,{method:'POST',body:JSON.stringify({wallet,cluster:'localnet',nonce,signature:'test'})}));
  assert.equal(reused.status,403);
  const requestId=randomUUID(),intent={wallet,action:'openFree',marketId,requestId};
  const preparedResponse=await post(api,'/v1/transactions/prepare',intent,token);
  assert.equal(preparedResponse.status,200);
  const prepared=(await json(preparedResponse)).data;
  assert.equal(prepared.kind,'transaction');
  assert.equal(prepared.expiresAt,now+30);
  assert.equal(prepared.cluster,'localnet');
  assert.ok(prepared.unsignedTransaction);
  await assert.rejects(validateCompiledFree({...prepared,action:'closeFree'},
    {wallet,action:'closeFree',marketId,recordId:prepared.recordId,requestId}),/PREPARED_ACTION_MISMATCH/);
  const duplicate=(await json(await post(api,'/v1/transactions/prepare',intent,token))).data;
  assert.deepEqual(duplicate,prepared);
  const conflict=await post(api,'/v1/transactions/prepare',{...intent,marketId:'different'},token);
  assert.equal(conflict.status,400);
  const {signature,wireBase64}=signedWire(prepared.unsignedTransaction);
  const wrongOwner=await post(api,`/v1/operations/${requestId}/submit`,{wallet:otherWallet,signature},token);
  assert.equal(wrongOwner.status,403);
  const unrelated=sign(null,Buffer.from('unrelated'),privateKey);
  const badSignature=getBase58Decoder().decode(unrelated);
  receipts.set(badSignature,{wireBase64,status:'finalized'});
  const bad=await post(api,`/v1/operations/${requestId}/submit`,{wallet,signature:badSignature},token);
  assert.equal(bad.status,400);
  assert.equal(store.get(requestId)?.operation.signature,null);
  receipts.delete(badSignature);
  const claim=await post(api,`/v1/operations/${requestId}/submit`,{wallet,signature},token);
  assert.equal((await json(claim)).data.state,'UNKNOWN');
  store.close();store=new LiveStore(path);api=make();
  receipts.set(signature,{wireBase64,status:'finalized'});
  const result=await json(await api.handle(new Request(`${base}/v1/operations/${requestId}?wallet=${wallet}`,{headers:{authorization:`Bearer ${token}`}})));
  assert.equal(result.data.state,'FINALIZED');
  assert.equal(result.data.signature,signature);
  const secondId=randomUUID(),second=(await json(await post(api,'/v1/transactions/prepare',{...intent,requestId:secondId},token))).data;
  const discovered=signedWire(second.unsignedTransaction);
  receipts.set(discovered.signature,{wireBase64:discovered.wireBase64,status:'finalized'});
  const found=await json(await api.handle(new Request(`${base}/v1/operations/${secondId}?wallet=${wallet}`,{headers:{authorization:`Bearer ${token}`}})));
  assert.equal(found.data.state,'FINALIZED');
  assert.equal(found.data.signature,discovered.signature);
  records.set(prepared.recordId,{id:prepared.recordId,wallet,marketId,direction:'up',
    entry:{executedAt:now,slot:'1',signature, snapshot:null,h:null,unavailableReason:'DataNotReady'},
    exit:null,status:'OPEN',result:null,finality:'finalized',proofId:null});
  const closeId=randomUUID();
  const close=(await json(await post(api,'/v1/transactions/prepare',{wallet,action:'closeFree',marketId,recordId:prepared.recordId,requestId:closeId},token))).data;
  assert.equal(close.action,'closeFree');
  assert.equal(close.recordId,prepared.recordId);
  const expiring={wallet,action:'openFree',marketId,requestId:randomUUID()};
  assert.equal((await json(await post(api,'/v1/transactions/prepare',expiring,token))).data.kind,'transaction');
  currentNow+=31;
  assert.equal((await post(api,'/v1/transactions/prepare',expiring,token)).status,409);
  store.close();
});

test('free prepare uses completion time after real RPC latency, while expired payloads stay rejected',async()=>{
  let clock=now;
  const store=new LiveStore(':memory:');
  const slowRead={...read,async market(){clock+=2;return market;}};
  const adapter=new KitFreeTransactionAdapter({cluster:'localnet',programId,read:slowRead,
    blockhashes:{async latest(){clock+=1;return {blockhash:marketId,lastValidBlockHeight:999n};}},now:()=>clock,nextRecordNonce:()=>77n});
  const api=createApp({mode:'localnet',programId,read,transactions:adapter,liveStore:store,chain,
    now:()=>clock,verifier:{async verify(){return true;}}});
  try{
    const {token}=await auth(api),intent={wallet,action:'openFree',marketId,requestId:randomUUID()};
    const response=await post(api,'/v1/transactions/prepare',intent,token);
    assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
    const prepared=(await json(response)).data;
    assert.equal(prepared.expiresAt,now+32);
    clock=prepared.expiresAt;
    assert.equal((await post(api,'/v1/transactions/prepare',intent,token)).status,409);
  }finally{store.close();}
});
