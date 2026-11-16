import test from 'node:test';
import assert from 'node:assert/strict';
import { address } from '@solana/kit';
import { ANTE_UP_PROGRAM_ADDRESS, AdmissionReason, AdmissionState, DataStatus, MarketPhase,
  findAdmissionPda, findMarketPda, getAdmissionEncoder, getMarketEncoder } from '../../../clients/chain/dist/index.js';
import { SqliteProjectionStore } from '../../indexer/src/sqlite.ts';
import { SqliteEventRepositories } from '../../indexer/src/repositories.ts';
import { SqliteFinalizedReadAdapter, mergeMarketRegistry, indexedCapabilities } from '../src/live-read.ts';
import { validateMarket } from '../src/validate.ts';
import type { FinalizedFinancialAccounts } from '../src/financial-chain.ts';

test('finalized market and global admission permit free entry before numeric data, but gate closure preserves exit',async()=>{
  const programId=String(ANTE_UP_PROGRAM_ADDRESS),seed=new Uint8Array(32).fill(3);
  const [marketAddress]=await findMarketPda({marketId:seed},{programAddress:address(programId)});
  const [admissionAddress]=await findAdmissionPda({programAddress:address(programId)});
  let open=true,outstanding=0,recent=Array(100).fill(0n),fundedOpenCap=1n,fundedOpenCount=0n,accountReads=0;
  const accountReader={async get(id:string){
    accountReads++;
    if (id===String(admissionAddress)) return {ownerProgramId:programId,data:getAdmissionEncoder().encode({admin:address(programId),open,outstanding,recent,fundedOpenCap,fundedOpenCount})};
    if (id===String(marketAddress)) return {ownerProgramId:programId,data:getMarketEncoder().encode({id:seed,admin:address(programId),
      queryHash:new Uint8Array(32),queryVersion:0n,phase:MarketPhase.Curve,dataStatus:DataStatus.Preparing,
      admission:{state:AdmissionState.Blocked,recoveryCount:0,reason:AdmissionReason.DataNotReady},
      latestSequence:0n,latestHash:new Uint8Array(32),latestDataThrough:0n,latestNowQ12:null,latest7dQ12:null,validityGeneration:0n})};
    return null;
  }};
  const store=new SqliteProjectionStore(':memory:'),repositories=new SqliteEventRepositories(':memory:',accountReader);
  const read=new SqliteFinalizedReadAdapter({mode:'localnet',programId,store,repositories,accounts:accountReader,
    registry:[{address:String(marketAddress),seedHex:Buffer.from(seed).toString('hex'),keyword:'test',aliases:[]}],now:()=>1_800_000_000,
    runtimeReadiness:async()=>({reason:'STORAGE_PRESSURE',checkedAt:1_800_000_000})});
  const [market]=await read.markets();
  assert.equal(market.snapshot,null);
  assert.equal(market.dataStatus,'PREPARING');
  assert.equal(market.capabilities.openFree?.allowed,true);
  assert.equal(market.runtimeStatus,undefined,'operational diagnostics do not override a permitted action');
  assert.deepEqual(market.freeChipCapacity,{fundedCap:'1',fundedUsed:'0',fundedRemaining:'1'});
  assert.equal((await read.markets())[0],market);
  assert.equal(accountReads,2,'public market read should reuse the verified snapshot');
  fundedOpenCount=1n;
  const exhausted=(await read.markets(0))[0];
  assert.deepEqual(exhausted.capabilities.openFree,{allowed:false,reason:'BUDGET_EXHAUSTED',detail:'FUNDED_PROOF_CAP'});
  assert.deepEqual(exhausted.freeChipCapacity,{fundedCap:'1',fundedUsed:'1',fundedRemaining:'0'});
  assert.equal(validateMarket(exhausted),exhausted);
  open=false;
  assert.deepEqual((await read.markets(0))[0].capabilities.openFree,
    {allowed:false,reason:'BUDGET_EXHAUSTED',detail:'FUNDED_PROOF_CAP'});
  fundedOpenCount=0n;
  const [closedGate]=await read.markets(0);
  assert.equal(closedGate.capabilities.openFree?.allowed,false);
  assert.equal(closedGate.capabilities.openFree?.reason,'ENTRY_PAUSED');
  assert.equal(closedGate.capabilities.closeFree?.allowed,true);
  assert.deepEqual(closedGate.runtimeStatus,{reason:'STORAGE_PRESSURE',checkedAt:1_800_000_000});
  open=true;outstanding=200;
  assert.deepEqual((await read.markets(0))[0].capabilities.openFree,{allowed:false,reason:'LIMIT_REACHED',detail:'GLOBAL_OUTSTANDING_LIMIT'});
  outstanding=0;recent=Array(100).fill(1_800_000_000n-10n);
  assert.deepEqual((await read.markets(0))[0].capabilities.openFree,{allowed:false,reason:'LIMIT_REACHED',detail:'GLOBAL_DAILY_LIMIT'});
  recent=Array(100).fill(1_800_000_000n-86_400n);
  assert.deepEqual((await read.markets(0))[0].capabilities.openFree,{allowed:true,reason:null});
  repositories.close();store.close();
});

test('indexed market price requires matching fresh finalized snapshot and blocks new entry in LowActivity',async()=>{
  const programId=String(ANTE_UP_PROGRAM_ADDRESS),seed=new Uint8Array(32).fill(4);
  const [marketAddress]=await findMarketPda({marketId:seed},{programAddress:address(programId)});
  const [admissionAddress]=await findAdmissionPda({programAddress:address(programId)});
  const now=1_800_000_000,hash=new Uint8Array(32).fill(7);
  let status=DataStatus.Valid,through=now-100,projectedSequence='3',rpcFailed=false;
  const accountReader={async get(id:string){
    if (id===String(admissionAddress)) return {ownerProgramId:programId,data:getAdmissionEncoder().encode({admin:address(programId),open:true,outstanding:0,recent:Array(100).fill(0n),fundedOpenCap:1n,fundedOpenCount:0n})};
    if (id===String(marketAddress)) return {ownerProgramId:programId,data:getMarketEncoder().encode({id:seed,admin:address(programId),
      queryHash:new Uint8Array(32),queryVersion:1n,phase:MarketPhase.Indexed,dataStatus:status,
      admission:{state:AdmissionState.Open,recoveryCount:0,reason:null},latestSequence:3n,latestHash:hash,
      latestDataThrough:BigInt(through),latestNowQ12:1_000_000_000_000n,latest7dQ12:1_000_000_000_000n,validityGeneration:0n})};
    return null;
  }};
  const store=new SqliteProjectionStore(':memory:'),repositories=new SqliteEventRepositories(':memory:',accountReader);
  store.snapshots=()=>[{payload:{marketId:String(marketAddress),sequence:projectedSequence},payloadHash:Buffer.from(hash).toString('hex'),finality:'finalized'}] as any;
  const fm={anchorPg:1_000_000n,anchorSg:1_000_000_000_000n,anchorDg:1_000_000_000_000n,pmax:5_000_000n,
    lpWindowStart:BigInt(now-100),lpWindowEnd:BigInt(now+100),proReopenAt:BigInt(now+100),
    currentMaturity:0n,currentCycle:1n,openPositions:0,lpGeneration:0n,lastLpMaturity:BigInt(now),
    paymentVault:'vault',vaultInventory:'inventory',keywordMint:programId,externalQ:1000_000000n,
    proReserved:0n,otherReserved:0n,totalShares:7100_000000n,lockedShares:7100_000000n};
  let settled=false;
  const financial=({async financeMarket(){if(rpcFailed)throw Error('HTTP 429');return fm;},async settlement(){return settled?{}:null;},
    async financeConfig(){return {paymentMint:programId};},async tokenAt(id:string){return {amount:id==='vault'?8300_000000n:1000_000000n};}}) as unknown as FinalizedFinancialAccounts;
  const read=new SqliteFinalizedReadAdapter({mode:'localnet',programId,store,repositories,accounts:accountReader,financial,
    registry:[{address:String(marketAddress),seedHex:Buffer.from(seed).toString('hex'),keyword:'test',aliases:[]}],now:()=>now});
  assert.deepEqual((await read.markets())[0].price,{kind:'indexed',atoms:'1000000',executable:true});
  assert.equal((await read.markets())[0].epochPhase,'LP_WINDOW');
  assert.equal((await read.markets())[0].capabilities.depositLP?.allowed,true);
  assert.equal((await read.markets())[0].capabilities.spotBuy?.allowed,true);
  fm.lpWindowEnd=BigInt(now-100);fm.proReopenAt=BigInt(now-100);
  assert.equal((await read.markets(0))[0].epochPhase,'PRO_OPEN');
  fm.currentMaturity=BigInt(now+2000);settled=true;
  assert.equal((await read.markets(0))[0].epochPhase,'SETTLING');
  status=DataStatus.LowActivity;
  assert.deepEqual((await read.markets(0))[0].price,{kind:'indexed',atoms:'1000000',executable:false});
  through=now-600;
  assert.equal((await read.markets(0))[0].price,null);
  assert.equal((await read.market(String(marketAddress)))?.price,null,'targeted execution does not reuse a prior fresh listing price');
  assert.equal((await read.markets(0))[0].priceReadiness?.state,'STALE');
  assert.equal((await read.markets(0))[0].dataStatus,'LOW_ACTIVITY');
  assert.equal((await read.markets(0))[0].priceReadiness?.reason,'DATA_STALE');
  projectedSequence='2';through=now-100;status=DataStatus.Valid;
  const syncing=(await read.markets(0))[0];
  assert.equal(syncing.snapshot,null);assert.equal(syncing.price,null);
  assert.deepEqual(syncing.priceReadiness,{state:'SYNCING',dataThrough:through,checkedAt:now,reason:'INDEX_SYNCING'});
  assert.equal(syncing.capabilities.openPro?.allowed,false);
  assert.equal(syncing.capabilities.spotSell?.allowed,false);
  assert.equal((await read.market(String(marketAddress)))?.priceReadiness?.state,'SYNCING','targeted projection keeps snapshot matching gate');
  through=now-600;
  assert.equal((await read.markets(0))[0].priceReadiness?.state,'STALE','staleness takes precedence over projection mismatch');
  through=now-100;projectedSequence='3';
  assert.equal((await read.markets(0))[0].priceReadiness?.state,'CURRENT');
  assert.equal((await read.markets(0))[0].price?.executable,true);
  rpcFailed=true;
  await assert.rejects(read.markets(0),/429/);
  repositories.close();store.close();
});

test('targeted market reads only target and global admission, bypasses listing cache and unrelated failure',async()=>{
 const programId=String(ANTE_UP_PROGRAM_ADDRESS),seeds=[new Uint8Array(32).fill(11),new Uint8Array(32).fill(12)];
 const ids=await Promise.all(seeds.map(async seed=>String((await findMarketPda({marketId:seed},{programAddress:address(programId)}))[0])));
 const admissionId=String((await findAdmissionPda({programAddress:address(programId)}))[0]);
 const reads:string[]=[],financialReads:string[]=[];let gateOpen=true,unrelatedFailure=false,reconciliations=0;
 let unrelatedWait:Promise<void>|null=null,onUnrelatedWait=()=>{};
 const accountReader={async get(id:string){
  reads.push(id);
  if(id===admissionId)return {ownerProgramId:programId,data:getAdmissionEncoder().encode({admin:address(programId),open:gateOpen,outstanding:0,
   recent:Array(100).fill(0n),fundedOpenCap:20n,fundedOpenCount:0n})};
  const i=ids.indexOf(id);if(i<0)throw Error('UNEXPECTED_ACCOUNT');
  if(i===1&&unrelatedWait){onUnrelatedWait();await unrelatedWait;}
  if(i===1&&unrelatedFailure)throw Error('HTTP 429 unrelated market');
  return {ownerProgramId:programId,data:getMarketEncoder().encode({id:seeds[i],admin:address(programId),queryHash:new Uint8Array(32),queryVersion:1n,
   phase:MarketPhase.Curve,dataStatus:DataStatus.Preparing,admission:{state:AdmissionState.Blocked,recoveryCount:0,reason:AdmissionReason.DataNotReady},
   latestSequence:0n,latestHash:new Uint8Array(32),latestDataThrough:0n,latestNowQ12:null,latest7dQ12:null,validityGeneration:0n})};
 }};
 const store=new SqliteProjectionStore(':memory:'),repositories=new SqliteEventRepositories(':memory:',accountReader);
 const read=new SqliteFinalizedReadAdapter({mode:'localnet',programId,store,repositories,accounts:accountReader,now:()=>1_800_000_000,
  registry:ids.map((id,i)=>({address:id,seedHex:Buffer.from(seeds[i]).toString('hex'),keyword:`market${i}`,aliases:[]})),
  financial:{async financeMarket(id:string){financialReads.push(id);if(id===ids[1]&&unrelatedFailure)throw Error('HTTP 429');return {curveSold:0n};}} as unknown as FinalizedFinancialAccounts,
  registrations:{finalized:()=>[],async reconcilePending(){reconciliations++;}} as any});
 try{
  const listing=await read.markets();assert.equal(listing.length,2);assert.equal(reconciliations,1);
  reads.length=0;financialReads.length=0;gateOpen=false;unrelatedFailure=true;
  const target=await read.market(ids[0]);assert.equal(target?.capabilities.openFree?.reason,'ENTRY_PAUSED');
  assert.deepEqual(reads,[admissionId,ids[0]]);assert.deepEqual(financialReads,[ids[0]]);assert.equal(reconciliations,1);
  assert.equal(await read.markets(),listing,'single read must not overwrite full listing cache');
  assert.equal(listing[0].capabilities.openFree?.allowed,true,'target gate refresh cannot mutate cached public results');
  reads.length=0;financialReads.length=0;
  assert.equal(await read.market('unknown'),null);assert.deepEqual(reads,[]);assert.deepEqual(financialReads,[]);
  await assert.rejects(read.markets(0),/429/,'the unrelated market really fails a whole-list read');
  reads.length=0;financialReads.length=0;gateOpen=true;
  assert.equal((await read.market(ids[0]))?.capabilities.openFree?.allowed,true);
  assert.deepEqual(reads,[admissionId,ids[0]]);assert.deepEqual(financialReads,[ids[0]]);
  unrelatedFailure=false;
  let release!:()=>void;unrelatedWait=new Promise<void>(resolve=>{release=resolve;});
  const entered=new Promise<void>(resolve=>{onUnrelatedWait=resolve;});
  const listingInFlight=read.markets(0);await entered;gateOpen=false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const fresh=await Promise.race([read.market(ids[0]),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('target joined unrelated listing')),1500);})]);
   assert.equal(fresh?.capabilities.openFree?.reason,'ENTRY_PAUSED','target execution does not join a stale in-flight listing');
  }finally{if(timer)clearTimeout(timer);release();await listingInFlight;}
 }finally{repositories.close();store.close();}
});

test('operator synthetic provenance cannot be stripped by an automatic registration',()=>{
  const real={address:'same',seedHex:'00'.repeat(32),keyword:'auto label',aliases:[]};
  const configured={...real,keyword:'Synthetic finance demo',dataProvenance:'SYNTHETIC_QA' as const};
  assert.deepEqual(mergeMarketRegistry([configured],[real]),[configured]);
  assert.deepEqual(mergeMarketRegistry([configured],[real,{...real,address:'other'}]),[configured,{...real,address:'other'}]);
});

test('indexed capabilities open initial LP, then Pro, without relaxing exit or capital checks',()=>{
 const base={price:{kind:'indexed' as const,atoms:'1200000',executable:true},epochPhase:'INITIAL_LP' as const,
   lowActivity:false,assets:8300000000n,free:3000000000n,nav:7100000000n,externalQ:1000000000n,
   inventory:1000000000n,totalShares:7100000000n,lockedShares:7100000000n,openPositions:0,otherReserved:0n};
 const initial=indexedCapabilities(base);
 assert.equal(initial.depositLP?.allowed,true);assert.equal(initial.spotBuy?.allowed,true);
 assert.equal(initial.openPro?.allowed,false);assert.equal(initial.withdrawLP?.allowed,false);
 assert.equal(indexedCapabilities({...base,totalShares:7200000000n}).withdrawLP?.allowed,true);
 const pro=indexedCapabilities({...base,epochPhase:'PRO_OPEN',openPositions:1});
 assert.equal(pro.openPro?.allowed,true);assert.equal(pro.closePro?.allowed,true);
 assert.equal(pro.depositLP?.reason,'LP_WINDOW_CLOSED');
 const low=indexedCapabilities({...base,lowActivity:true,price:{...base.price,executable:false}});
 assert.equal(low.spotBuy?.allowed,false);assert.equal(low.spotSell?.allowed,true);assert.equal(low.depositLP?.allowed,true);
 const stale=indexedCapabilities({...base,price:null,otherReserved:100n});
 assert.equal(stale.depositLP?.allowed,false);assert.equal(stale.spotSell?.allowed,false);assert.equal(stale.claim?.allowed,true);
 assert.equal(indexedCapabilities({...base,free:0n}).spotBuy?.reason,'INSUFFICIENT_FREE_CAPITAL');
 assert.equal(indexedCapabilities({...base,epochPhase:'SETTLING',openPositions:1}).closePro?.allowed,false);
});
