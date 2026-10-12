import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { getBase58Decoder } from '@solana/kit';
import { ANTE_UP_PROGRAM_ADDRESS } from '../../../clients/chain/dist/index.js';
import type { MarketView } from '../../../contracts/types.ts';
import { createApp } from '../src/app.ts';
import { LiveStore } from '../src/live-store.ts';
import { KitFreeTransactionAdapter } from '../src/transaction.ts';
import { createApiServer } from '../src/server.ts';

test('actual HTTP session and generated free prepare', {skip:process.env.ANTE_UP_HTTP_TEST!=='1'}, async()=>{
  const wallet=getBase58Decoder().decode(generateKeyPairSync('ed25519').publicKey.export({format:'der',type:'spki'}).subarray(-32));
  const programId=String(ANTE_UP_PROGRAM_ADDRESS),marketId='11111111111111111111111111111111',now=1_800_000_000;
  const market:MarketView={id:marketId,keyword:'test',aliases:[],phase:'CURVE',dataStatus:'PREPARING',epochPhase:null,
    supported:true,chain:{cluster:'localnet',programId,address:marketId},snapshot:null,anchor:null,price:null,
    capabilities:{openFree:{allowed:true,reason:null},closeFree:{allowed:true,reason:null}}};
  const read={mode:'localnet' as const,async markets(){return [market];},async market(){return market;},
    async records(){return [];},async record(){return null;},async proofs(){return [];},async heldCalculationWallets(){return new Set<string>();}};
  const liveStore=new LiveStore(':memory:');
  const transactions=new KitFreeTransactionAdapter({cluster:'localnet',programId,read,
    blockhashes:{async latest(){return {blockhash:marketId,lastValidBlockHeight:100n};}},now:()=>now,nextRecordNonce:()=>7n});
  const app=createApp({mode:'localnet',programId,read,liveStore,transactions,
    chain:{async get(){return null;},async discover(){return [];}},now:()=>now,verifier:{async verify(){return true;}}});
  const server=createApiServer(app);
  try {
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=(server.address() as {port:number}).port,base=`http://127.0.0.1:${port}`;
    const challenge=await (await fetch(`${base}/v1/auth`,{method:'POST',body:JSON.stringify({wallet,cluster:'localnet'})})).json() as any;
    const session=await (await fetch(`${base}/v1/auth/session`,{method:'POST',body:JSON.stringify({wallet,cluster:'localnet',nonce:challenge.data.nonce,signature:'test'})})).json() as any;
    const response=await fetch(`${base}/v1/transactions/prepare`,{method:'POST',
      headers:{authorization:`Bearer ${session.data.token}`},body:JSON.stringify({wallet,action:'openFree',marketId,requestId:'123e4567-e89b-42d3-a456-426614174000'})});
    const result=await response.json() as any;
    assert.equal(response.status,200);
    assert.equal(result.mode,'localnet');
    assert.equal(result.data.kind,'transaction');
    assert.ok(result.data.unsignedTransaction);
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    liveStore.close();
  }
});
