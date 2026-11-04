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

test('a stale funding read cannot reuse capital released by concurrent finalization',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ante-visitor-funding-')),path=join(dir,'ledger.sqlite');
 const ledger=new SqliteSolFaucetLedger(path),otherLedger=new SqliteSolFaucetLedger(path);
 let release!:()=>void,reading!:()=>void,reads=0,sends=0,final=false,funding=25_000_000n;
 const blocked=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{reading=resolve;});
 const service=new VisitorSolFaucet({policy:{...policy,dailyCapLamports:20_000_000n,totalCapLamports:25_000_000n},ledger,nowMs:()=>100_000_000,
  fundingBalanceLamports:async()=>{const captured=funding;if(++reads===2){reading();await blocked;}return captured;},
  rpc:{genesisHash:async()=>DEVNET_GENESIS,balanceLamports:async()=>0n,sendOnce:async()=>{sends++;return 'signature-first';},finalized:async()=>final}});
 try{
  await service.claim({wallet,authenticatedWallet:wallet,requestId:'funding_first'});
  const second=service.claim({wallet:wallet2,authenticatedWallet:wallet2,requestId:'funding_stale'});
  await started;funding=20_000_000n;final=true;
  assert.equal(otherLedger.markFinalizedIfSigned('funding_first','signature-first'),true);
  release();assert.equal((await second).state,'LIMIT_REACHED');
  assert.equal(ledger.get('funding_stale'),null);assert.equal(sends,1);
 }finally{release();otherLedger.close();ledger.close();await rm(dir,{recursive:true,force:true});}
});

test('public readiness rejects a funding snapshot when the retained ledger changes during the read',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ante-visitor-funding-')),ledger=new SqliteSolFaucetLedger(join(dir,'ledger.sqlite'));
 let release!:()=>void,reading!:()=>void;
 const blocked=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{reading=resolve;});
 const broad={...policy,dailyCapLamports:20_000_000n,totalCapLamports:25_000_000n};
 ledger.reserve('funding_first',wallet,100_000_000,broad);ledger.mark('funding_first','SUBMITTED','signature-first');
 const service=new VisitorSolFaucet({policy:broad,ledger,nowMs:()=>100_000_000,
  fundingBalanceLamports:async()=>{reading();await blocked;return 25_000_000n;},
  rpc:{genesisHash:async()=>DEVNET_GENESIS,balanceLamports:async()=>0n,sendOnce:async()=>{throw Error('NO_SEND');},finalized:async()=>true}});
 try{
  const read=service.readiness(wallet2);const rejected=assert.rejects(read,/DATA_NOT_READY/);
  await started;ledger.markFinalizedIfSigned('funding_first','signature-first');release();await rejected;
 }finally{release();ledger.close();await rm(dir,{recursive:true,force:true});}
});

test('concurrent different wallets cannot reuse the same funding headroom',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ante-visitor-funding-')),ledger=new SqliteSolFaucetLedger(join(dir,'ledger.sqlite'));
 let release!:()=>void,sends=0;
 const blocked=new Promise<void>(resolve=>{release=resolve;});
 const rpc={genesisHash:async()=>DEVNET_GENESIS,balanceLamports:async()=>0n,
  sendOnce:async()=>{sends++;await blocked;throw Error('unknown send');},finalized:async()=>false};
 const service=new VisitorSolFaucet({policy:{...policy,dailyCapLamports:15_000_000n,totalCapLamports:20_000_000n},rpc,ledger,
  fundingBalanceLamports:async()=>25_000_000n,nowMs:()=>100_000_000});
 try{
  const first=service.claim({wallet,authenticatedWallet:wallet,requestId:'funding_first'});
  while(!sends)await new Promise(resolve=>setTimeout(resolve,1));
  const second=service.claim({wallet:wallet2,authenticatedWallet:wallet2,requestId:'funding_second'});
  release();
  assert.equal((await first).state,'UNKNOWN');
  assert.equal((await second).state,'LIMIT_REACHED');
  assert.equal(sends,1);
  assert.equal((await service.readiness(wallet2)).grantRemaining,'0');
 }finally{release();ledger.close();await rm(dir,{recursive:true,force:true});}
});

test('uncertain funding reservations survive a day boundary without releasing capital',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ante-visitor-funding-')),ledger=new SqliteSolFaucetLedger(join(dir,'ledger.sqlite'));
 let now=100_000_000;
 const rpc={genesisHash:async()=>DEVNET_GENESIS,balanceLamports:async()=>0n,
  sendOnce:async()=>{throw Error('unknown send');},finalized:async()=>false};
 const service=new VisitorSolFaucet({policy:{...policy,dailyCapLamports:15_000_000n,totalCapLamports:20_000_000n},rpc,ledger,
  fundingBalanceLamports:async()=>25_000_000n,nowMs:()=>now});
 try{
  await service.claim({wallet,authenticatedWallet:wallet,requestId:'funding_unknown'});
  now+=86_400_000;
  const status=await service.readiness(wallet2);
  assert.equal(status.grantRemaining,'0');assert.equal(status.grantUnavailableReason,'FUNDING_LOW');
  assert.equal(ledger.get('funding_unknown')?.state,'UNKNOWN');
 }finally{ledger.close();await rm(dir,{recursive:true,force:true});}
});
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
test('public readiness reflects reserved grants, wallet cooldown and the funding reserve',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ante-visitor-'));const ledger=new SqliteSolFaucetLedger(join(dir,'ledger.sqlite'));
  let now=100_000_000, funding=25_000_000n;
  const rpc={genesisHash:async()=>DEVNET_GENESIS,balanceLamports:async()=>0n,
    sendOnce:async()=>{throw Error('transport lost');},finalized:async()=>false};
  const service=new VisitorSolFaucet({policy,rpc,ledger,fundingBalanceLamports:async()=>funding,nowMs:()=>now});
  try {
    assert.deepEqual(await service.readiness(wallet),{
      balanceLamports:'0',minimumBalanceLamports:'1000000',needsSol:true,serverGrantEnabled:true,
      grantLamports:'5000000',grantRemaining:'1',serverGrantAvailable:true,grantUnavailableReason:null});
    assert.equal((await service.claim({wallet,authenticatedWallet:wallet,requestId:'request_0001'})).state,'UNKNOWN');
    assert.equal((await service.readiness(wallet)).grantUnavailableReason,'COOLDOWN');
    assert.equal((await service.readiness(wallet2)).grantUnavailableReason,'FUNDING_LOW');
    funding=30_000_000n;
    assert.equal((await service.readiness(wallet2)).grantUnavailableReason,'DAILY_LIMIT');
    funding=24_999_999n;now+=86_400_000;
    assert.equal((await service.readiness(wallet2)).grantUnavailableReason,'FUNDING_LOW');
    funding=25_000_000n;
    assert.deepEqual((await service.readiness(wallet2)).grantRemaining,'0');
  }finally{ledger.close();await rm(dir,{recursive:true,force:true});}
});

test('finalized grants are not subtracted twice from the finalized funding balance',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ante-visitor-funding-')),ledger=new SqliteSolFaucetLedger(join(dir,'ledger.sqlite'));
 let funding=35_000_000n,final=false,sends=0;
 const rpc={genesisHash:async()=>DEVNET_GENESIS,balanceLamports:async()=>0n,
  sendOnce:async()=>{sends++;return 'finalized-grant';},finalized:async()=>final};
 const service=new VisitorSolFaucet({policy:{...policy,dailyCapLamports:20_000_000n,totalCapLamports:25_000_000n},rpc,ledger,
  fundingBalanceLamports:async()=>funding,nowMs:()=>100_000_000});
 try{
  assert.equal((await service.readiness(wallet2)).grantRemaining,'3');
  await service.claim({wallet,authenticatedWallet:wallet,requestId:'funding_finalized'});
  assert.equal((await service.readiness(wallet2)).grantRemaining,'2');
  funding-=policy.grantLamports;
  // Balance alone cannot prove which uncertain signature settled. Hold it
  // conservatively until the existing finalized signature sweep confirms it.
  assert.equal((await service.readiness(wallet2)).grantRemaining,'1');
  final=true;assert.equal(await service.reconcilePendingSigned(),1);
  assert.equal((await service.readiness(wallet2)).grantRemaining,'2');
  assert.equal(ledger.availability(wallet2,100_000_000,{...policy,dailyCapLamports:20_000_000n,totalCapLamports:25_000_000n}).total,5_000_000n);
  assert.equal(sends,1);
 }finally{ledger.close();await rm(dir,{recursive:true,force:true});}
});

test('RESERVED, SUBMITTED and signed UNKNOWN grants retain funding but retries never send again',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ante-visitor-funding-')),ledger=new SqliteSolFaucetLedger(join(dir,'ledger.sqlite'));
 let sends=0;
 const broad={...policy,dailyCapLamports:20_000_000n,totalCapLamports:25_000_000n};
 const service=new VisitorSolFaucet({policy:broad,ledger,fundingBalanceLamports:async()=>25_000_000n,nowMs:()=>100_000_000,
  rpc:{genesisHash:async()=>DEVNET_GENESIS,balanceLamports:async()=>0n,sendOnce:async()=>{sends++;return 'unexpected';},finalized:async()=>false}});
 try{
  ledger.reserve('funding_reserved',wallet,100_000_000,broad);
  for(const state of ['RESERVED','SUBMITTED','UNKNOWN'] as const){
   if(state!=='RESERVED')ledger.mark('funding_reserved',state,'uncertain-signature');
   assert.equal((await service.readiness(wallet2)).grantRemaining,'0');
   assert.equal((await service.claim({wallet,authenticatedWallet:wallet,requestId:'funding_reserved'})).state,state);
  }
  assert.equal(ledger.get('funding_reserved')?.signature,'uncertain-signature');assert.equal(sends,0);
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

test('background reconciliation finalizes signed grants without sending again or clearing unknowns',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ante-visitor-'));const ledger=new SqliteSolFaucetLedger(join(dir,'ledger.sqlite'));
  let sends=0,final=false,genesis=DEVNET_GENESIS;
  const rpc={genesisHash:async()=>genesis,balanceLamports:async()=>0n,
    sendOnce:async()=>{sends++;return 'signed-grant';},finalized:async(signature:string)=>signature==='signed-grant'&&final};
  const service=new VisitorSolFaucet({policy,rpc,ledger,fundingBalanceLamports:async()=>100_000_000n,nowMs:()=>100_000_000});
  try {
    assert.equal((await service.claim({wallet,authenticatedWallet:wallet,requestId:'request_0001'})).state,'SUBMITTED');
    ledger.mark('request_0001','UNKNOWN',null);
    assert.equal(ledger.pendingSigned().length,1);
    assert.equal(await service.reconcilePendingSigned(),0);
    assert.equal(ledger.get('request_0001')?.state,'UNKNOWN');
    final=true;genesis='wrong-network';
    await assert.rejects(service.reconcilePendingSigned(),/DEVNET_REQUIRED/);
    assert.equal(ledger.get('request_0001')?.state,'UNKNOWN');
    genesis=DEVNET_GENESIS;
    assert.equal(await service.reconcilePendingSigned(),1);
    assert.equal(ledger.get('request_0001')?.state,'FINALIZED');
    assert.equal(await service.reconcilePendingSigned(),0);
    assert.equal(sends,1);
  }finally{ledger.close();await rm(dir,{recursive:true,force:true});}
});

test('bounded grant sweeps reach later pending wallets when earlier signatures never finalize',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ante-visitor-'));const ledger=new SqliteSolFaucetLedger(join(dir,'ledger.sqlite'));
  const seen:string[]=[];let sent=0;
  const rpc={genesisHash:async()=>DEVNET_GENESIS,balanceLamports:async()=>0n,
    sendOnce:async()=>`signature-${++sent}`,finalized:async(signature:string)=>{
      seen.push(signature);return signature==='signature-2';
    }};
  const service=new VisitorSolFaucet({policy:{...policy,dailyCapLamports:10_000_000n},rpc,ledger,
    fundingBalanceLamports:async()=>100_000_000n,nowMs:()=>100_000_000});
  try {
    assert.equal((await service.claim({wallet,authenticatedWallet:wallet,requestId:'request_0001'})).state,'SUBMITTED');
    assert.equal((await service.claim({wallet:wallet2,authenticatedWallet:wallet2,requestId:'request_0002'})).state,'SUBMITTED');
    assert.equal(await service.reconcilePendingSigned(1),0);
    assert.equal(await service.reconcilePendingSigned(1),1);
    assert.deepEqual(seen,['signature-1','signature-2']);
    assert.equal(ledger.get('request_0001')?.state,'SUBMITTED');
    assert.equal(ledger.get('request_0002')?.state,'FINALIZED');
  }finally{ledger.close();await rm(dir,{recursive:true,force:true});}
});
