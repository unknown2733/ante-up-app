import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {initializeCore} from '../../scripts/initialize-core.mjs';
import * as chain from '../../clients/chain/dist/index.js';
const kit=createRequire(new URL('../../clients/chain/package.json',import.meta.url))('@solana/kit');
async function fixture(){
  const signer=await kit.generateKeyPairSigner();let saved=null,sends=0,failWrite=false;
  return {signer,admin:signer.address,publisher:signer.address,proofAuthority:signer.address,
    rpc:{getGenesisHash:()=>({send:async()=> 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'})},
    journal:{read:async()=>saved,write:async value=>{if(failWrite)throw Error('DISK_FULL');saved=value;}},
    transport:{getFinalizedAccount:async address=>({address,exists:address===chain.ANTE_UP_PROGRAM_ADDRESS,executable:true}),
      getLatestBlockhash:async()=>({blockhash:'11111111111111111111111111111111',lastValidBlockHeight:999n}),
      sendTransaction:async()=>{sends++;throw Error('RESPONSE_LOST');},getSignatureStatus:async()=>null},
    count:()=>sends,failWrite:()=>{failWrite=true;}};
}
test('core init plan does not send; unknown signed init persists and cannot resend',async()=>{
  const f=await fixture();assert.equal((await initializeCore(f)).state,'READY');assert.equal(f.count(),0);
  const result=await initializeCore({...f,execute:true});assert.equal(result.state,'PENDING_RECONCILIATION');
  assert.equal(f.count(),1);assert.ok(result.signature);
  assert.equal((await initializeCore({...f,execute:true})).signature,result.signature);assert.equal(f.count(),1);
});
test('core init rejects wrong genesis and stops before send on journal write failure',async()=>{
  const f=await fixture();await assert.rejects(initializeCore({...f,execute:true,
    rpc:{getGenesisHash:()=>({send:async()=> 'mainnet'})}}),/DEVNET_GENESIS_REQUIRED/);
  f.failWrite();await assert.rejects(initializeCore({...f,execute:true}),/DISK_FULL/);assert.equal(f.count(),0);
});
