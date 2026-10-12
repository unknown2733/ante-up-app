import test from 'node:test';
import assert from 'node:assert/strict';
import { address } from '@solana/kit';
import { ANTE_UP_PROGRAM_ADDRESS, AdmissionReason, AdmissionState, DataStatus, MarketPhase,
  findAdmissionPda, findMarketPda, getAdmissionEncoder, getMarketEncoder } from '../../../clients/chain/dist/index.js';
import { SqliteProjectionStore } from '../../indexer/src/sqlite.ts';
import { SqliteEventRepositories } from '../../indexer/src/repositories.ts';
import { SqliteFinalizedReadAdapter } from '../src/live-read.ts';
import type { FinalizedFinancialAccounts } from '../src/financial-chain.ts';

test('finalized market and global admission permit free entry before numeric data, but gate closure preserves exit',async()=>{
  const programId=String(ANTE_UP_PROGRAM_ADDRESS),seed=new Uint8Array(32).fill(3);
  const [marketAddress]=await findMarketPda({marketId:seed},{programAddress:address(programId)});
  const [admissionAddress]=await findAdmissionPda({programAddress:address(programId)});
  let open=true;
  const accountReader={async get(id:string){
    if (id===String(admissionAddress)) return {ownerProgramId:programId,data:getAdmissionEncoder().encode({admin:address(programId),open,outstanding:0,recent:Array(100).fill(0n)})};
    if (id===String(marketAddress)) return {ownerProgramId:programId,data:getMarketEncoder().encode({id:seed,admin:address(programId),
      queryHash:new Uint8Array(32),queryVersion:0n,phase:MarketPhase.Curve,dataStatus:DataStatus.Preparing,
      admission:{state:AdmissionState.Blocked,recoveryCount:0,reason:AdmissionReason.DataNotReady},
      latestSequence:0n,latestHash:new Uint8Array(32),latestDataThrough:0n,latestNowQ12:null,latest7dQ12:null,validityGeneration:0n})};
    return null;
  }};
  const store=new SqliteProjectionStore(':memory:'),repositories=new SqliteEventRepositories(':memory:',accountReader);
  const read=new SqliteFinalizedReadAdapter({mode:'localnet',programId,store,repositories,accounts:accountReader,
    registry:[{address:String(marketAddress),seedHex:Buffer.from(seed).toString('hex'),keyword:'test',aliases:[]}],now:()=>1_800_000_000});
  const [market]=await read.markets();
  assert.equal(market.snapshot,null);
  assert.equal(market.dataStatus,'PREPARING');
  assert.equal(market.capabilities.openFree?.allowed,true);
  open=false;
  const [closedGate]=await read.markets();
  assert.equal(closedGate.capabilities.openFree?.allowed,false);
  assert.equal(closedGate.capabilities.closeFree?.allowed,true);
  repositories.close();store.close();
});

test('indexed market price requires matching fresh finalized snapshot and blocks new entry in LowActivity',async()=>{
  const programId=String(ANTE_UP_PROGRAM_ADDRESS),seed=new Uint8Array(32).fill(4);
  const [marketAddress]=await findMarketPda({marketId:seed},{programAddress:address(programId)});
  const [admissionAddress]=await findAdmissionPda({programAddress:address(programId)});
  const now=1_800_000_000,hash=new Uint8Array(32).fill(7);
  let status=DataStatus.Valid,through=now-100;
  const accountReader={async get(id:string){
    if (id===String(admissionAddress)) return {ownerProgramId:programId,data:getAdmissionEncoder().encode({admin:address(programId),open:true,outstanding:0,recent:Array(100).fill(0n)})};
    if (id===String(marketAddress)) return {ownerProgramId:programId,data:getMarketEncoder().encode({id:seed,admin:address(programId),
      queryHash:new Uint8Array(32),queryVersion:1n,phase:MarketPhase.Indexed,dataStatus:status,
      admission:{state:AdmissionState.Open,recoveryCount:0,reason:null},latestSequence:3n,latestHash:hash,
      latestDataThrough:BigInt(through),latestNowQ12:1_000_000_000_000n,latest7dQ12:1_000_000_000_000n,validityGeneration:0n})};
    return null;
  }};
  const store=new SqliteProjectionStore(':memory:'),repositories=new SqliteEventRepositories(':memory:',accountReader);
  store.snapshots=()=>[{payload:{marketId:String(marketAddress),sequence:'3'},payloadHash:Buffer.from(hash).toString('hex'),finality:'finalized'}] as any;
  const fm={anchorPg:1_000_000n,anchorSg:1_000_000_000_000n,anchorDg:1_000_000_000_000n,pmax:5_000_000n,
    lpWindowStart:BigInt(now-100),lpWindowEnd:BigInt(now+100),proReopenAt:BigInt(now+100),
    currentMaturity:0n,currentCycle:1n,openPositions:0,lpGeneration:0n,lastLpMaturity:BigInt(now)};
  let settled=false;
  const financial=({async financeMarket(){return fm;},async settlement(){return settled?{}:null;}}) as unknown as FinalizedFinancialAccounts;
  const read=new SqliteFinalizedReadAdapter({mode:'localnet',programId,store,repositories,accounts:accountReader,financial,
    registry:[{address:String(marketAddress),seedHex:Buffer.from(seed).toString('hex'),keyword:'test',aliases:[]}],now:()=>now});
  assert.deepEqual((await read.markets())[0].price,{kind:'indexed',atoms:'1000000',executable:true});
  assert.equal((await read.markets())[0].epochPhase,'LP_WINDOW');
  fm.lpWindowEnd=BigInt(now-100);fm.proReopenAt=BigInt(now-100);
  assert.equal((await read.markets())[0].epochPhase,'PRO_OPEN');
  fm.currentMaturity=BigInt(now+2000);settled=true;
  assert.equal((await read.markets())[0].epochPhase,'SETTLING');
  status=DataStatus.LowActivity;
  assert.deepEqual((await read.markets())[0].price,{kind:'indexed',atoms:'1000000',executable:false});
  through=now-600;
  assert.equal((await read.markets())[0].price,null);
  repositories.close();store.close();
});
