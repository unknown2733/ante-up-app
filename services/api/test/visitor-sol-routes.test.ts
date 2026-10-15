import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/app.ts';
import {LiveStore} from '../src/live-store.ts';
import {VisitorSolFaucet,SqliteSolFaucetLedger,DEVNET_GENESIS} from '../src/visitor-faucet.ts';

const wallet='939RPDweeCfV1s39nND2KsARHesEvaH5MqhjxV5soKQv';
const other='39Rke1e9zfpBQQ5RnBBnaoPoUBz7HWYJseNinCLSPsCo';
const base='http://local.test/v1';

test('visitor SOL reads are public while claims and status require the owner session',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ante-visitor-route-'));
  const ledger=new SqliteSolFaucetLedger(join(dir,'sol.sqlite'));
  const liveStore=new LiveStore(join(dir,'session.sqlite'));
  let sent=0;
  const faucet=new VisitorSolFaucet({policy:{enabled:true,grantLamports:5_000_000n,
    minimumBalanceLamports:10_000_000n,dailyCapLamports:5_000_000n,totalCapLamports:10_000_000n,
    reserveLamports:20_000_000n,cooldownMs:86_400_000},ledger,nowMs:()=>100_000_000,
    fundingBalanceLamports:async()=>100_000_000n,rpc:{genesisHash:async()=>DEVNET_GENESIS,
      balanceLamports:async()=>0n,sendOnce:async()=>{sent++;return 'signature1';},finalized:async()=>true}});
  const api=createApp({mode:'devnet',programId:'11111111111111111111111111111111',visitorSol:faucet,
    liveStore,chain:{async get(){return null;},async discover(){return [];}},
    read:{mode:'devnet',async markets(){return [];},async records(){return [];},async proofs(){return [];},async heldCalculationWallets(){return new Set<string>();}},
    verifier:{async verify(){return true;}},now:()=>1_800_000_000});
  const send=(path:string,init?:RequestInit)=>api.handle(new Request(`${base}${path}`,init));
  const body=async(response:Response)=>response.json() as Promise<any>;
  try {
    const readiness=await body(await send(`/visitor-sol/readiness?wallet=${wallet}`));
    assert.equal(readiness.data.needsSol,true);
    const unauthorized=await send('/visitor-sol/claims',{method:'POST',body:JSON.stringify({wallet,requestId:'request_0001'})});
    assert.equal(unauthorized.status,403);
    const challenge=(await body(await send('/auth',{method:'POST',body:JSON.stringify({wallet,cluster:'devnet'})}))).data;
    const token=(await body(await send('/auth/session',{method:'POST',body:JSON.stringify({wallet,cluster:'devnet',nonce:challenge.nonce,signature:'test'})}))).data.token;
    const headers={authorization:`Bearer ${token}`};
    const claimed=await body(await send('/visitor-sol/claims',{method:'POST',headers,body:JSON.stringify({wallet,requestId:'request_0001'})}));
    assert.equal(claimed.data.state,'SUBMITTED');
    assert.equal(sent,1);
    const replay=await body(await send('/visitor-sol/claims',{method:'POST',headers,body:JSON.stringify({wallet,requestId:'request_0001'})}));
    assert.equal(replay.data.state,'SUBMITTED');
    assert.equal(sent,1);
    assert.equal((await send(`/visitor-sol/claims/request_0001?wallet=${other}`,{headers})).status,403);
    const completed=await body(await send(`/visitor-sol/claims/request_0001?wallet=${wallet}`,{headers}));
    assert.equal(completed.data.state,'FINALIZED');
  }finally{liveStore.close();ledger.close();await rm(dir,{recursive:true,force:true});}
});
