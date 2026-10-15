import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteSolFaucetLedger,VisitorSolFaucet,DEVNET_GENESIS} from '../src/visitor-faucet.ts';

const wallet='939RPDweeCfV1s39nND2KsARHesEvaH5MqhjxV5soKQv';
const wallet2='39Rke1e9zfpBQQ5RnBBnaoPoUBz7HWYJseNinCLSPsCo';
const policy={enabled:true,grantLamports:5_000_000n,minimumBalanceLamports:1_000_000n,
  dailyCapLamports:5_000_000n,totalCapLamports:10_000_000n,reserveLamports:20_000_000n,cooldownMs:86_400_000};
test('disabled faucet and high-balance wallet never send',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ante-visitor-'));const ledger=new SqliteSolFaucetLedger(join(dir,'ledger.sqlite'));
  let sent=0;const rpc={genesisHash:async()=>DEVNET_GENESIS,balanceLamports:async()=>2_000_000n,
    sendOnce:async()=>{sent++;return 'sig';},finalized:async()=>false};
  try {
    const disabled=new VisitorSolFaucet({policy:{...policy,enabled:false},rpc,ledger,
      fundingBalanceLamports:async()=>100_000_000n,nowMs:()=>100_000_000});
    assert.equal((await disabled.claim({wallet,authenticatedWallet:wallet,requestId:'request_0001'})).state,'DISABLED');
    const enabled=new VisitorSolFaucet({policy,rpc,ledger,fundingBalanceLamports:async()=>100_000_000n,nowMs:()=>100_000_000});
    assert.equal((await enabled.claim({wallet,authenticatedWallet:wallet,requestId:'request_0001'})).state,'ENOUGH_SOL');
    assert.equal(sent,0);
  }finally{ledger.close();await rm(dir,{recursive:true,force:true});}
});
test('one reservation survives lost response, blocks replay and daily overspend',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ante-visitor-'));const ledger=new SqliteSolFaucetLedger(join(dir,'ledger.sqlite'));
  let sent=0;const rpc={genesisHash:async()=>DEVNET_GENESIS,balanceLamports:async()=>0n,
    sendOnce:async()=>{sent++;throw Error('transport lost');},finalized:async()=>false};
  const service=new VisitorSolFaucet({policy,rpc,ledger,fundingBalanceLamports:async()=>100_000_000n,nowMs:()=>100_000_000});
  try {
    assert.equal((await service.claim({wallet,authenticatedWallet:wallet,requestId:'request_0001'})).state,'UNKNOWN');
    assert.equal((await service.claim({wallet,authenticatedWallet:wallet,requestId:'request_0001'})).state,'UNKNOWN');
    assert.equal((await service.claim({wallet:wallet2,authenticatedWallet:wallet2,requestId:'request_0002'})).state,'LIMIT_REACHED');
    assert.equal(sent,1);
    await assert.rejects(service.claim({wallet,authenticatedWallet:wallet2,requestId:'request_0003'}),/UNAUTHORIZED/);
  }finally{ledger.close();await rm(dir,{recursive:true,force:true});}
});
test('submitted SOL is final only after chain readback',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ante-visitor-'));const ledger=new SqliteSolFaucetLedger(join(dir,'ledger.sqlite'));
  let final=false;const rpc={genesisHash:async()=>DEVNET_GENESIS,balanceLamports:async()=>0n,
    sendOnce:async()=> 'signature1',finalized:async()=>final};
  const service=new VisitorSolFaucet({policy,rpc,ledger,fundingBalanceLamports:async()=>100_000_000n,nowMs:()=>100_000_000});
  try {
    assert.equal((await service.claim({wallet,authenticatedWallet:wallet,requestId:'request_0001'})).state,'SUBMITTED');
    assert.equal((await service.reconcile('request_0001',wallet)).state,'SUBMITTED');
    final=true;
    assert.equal((await service.reconcile('request_0001',wallet)).state,'FINALIZED');
  }finally{ledger.close();await rm(dir,{recursive:true,force:true});}
});
test('concurrent same request never sends twice and uncertain broadcast retains its signature',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ante-visitor-'));const ledger=new SqliteSolFaucetLedger(join(dir,'ledger.sqlite'));
  let sends=0, release!:()=>void, final=false;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const rpc={genesisHash:async()=>DEVNET_GENESIS,balanceLamports:async()=>0n,
    sendOnce:async(_wallet:string,_amount:bigint,_requestId:string,onSigned:(signature:string)=>void)=>{
      sends++;onSigned('signed-before-send');await blocked;throw Error('response lost');
    },finalized:async()=>final};
  const service=new VisitorSolFaucet({policy,rpc,ledger,fundingBalanceLamports:async()=>100_000_000n,nowMs:()=>100_000_000});
  try {
    const first=service.claim({wallet,authenticatedWallet:wallet,requestId:'request_0001'});
    while(!ledger.get('request_0001')?.signature) await new Promise(resolve=>setTimeout(resolve,1));
    const second=await service.claim({wallet,authenticatedWallet:wallet,requestId:'request_0001'});
    assert.equal(second.signature,'signed-before-send');
    assert.equal(sends,1);
    release();
    assert.deepEqual(await first,{state:'UNKNOWN',signature:'signed-before-send',amountLamports:'5000000'});
    final=true;
    assert.equal((await service.reconcile('request_0001',wallet)).state,'FINALIZED');
  }finally{release();ledger.close();await rm(dir,{recursive:true,force:true});}
});
