import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hash } from '../../data/index.mjs';
import { SqliteKeeperAttempts } from '../src/attempts.ts';
import { advanceFinancialEpoch, type FinalizedEpochState, type FinancialEpochChain } from '../src/flow.ts';
import type { SettlementScope } from '../src/candidate.ts';

const work=resolve(import.meta.dirname,'../../../../work/d-keeper-flow');mkdirSync(work,{recursive:true});
const scope:SettlementScope={cluster:'localnet',programId:'FrMATpA81wUMYsZufQkew9K5MW2AC8rgdYQ2wUM6KDKr',
  marketId:'11111111111111111111111111111111',epoch:'2',epochStartedAt:1_800_000_000,maturityAt:1_800_057_600,
  queryHash:'a'.repeat(64),queryVersion:'1',configVersion:'2',anchor:{graduationPriceAtoms:'1000000',
    graduationNowQ12:'1000000000000',graduation7dQ12:'1000000000000',maxPriceAtoms:'5000000'}};
function setup(){
  const candidate={market:{cluster:scope.cluster,programId:scope.programId,address:scope.marketId},epoch:scope.epoch,epochStartedAt:scope.epochStartedAt,
    maturityAt:scope.maturityAt,mode:'NORMAL',eligibleAt:scope.maturityAt+900,effectiveCloseAt:scope.maturityAt,
    outageStartedAt:null,queryHash:scope.queryHash,queryVersion:scope.queryVersion,configVersion:scope.configVersion,
    formulaVersion:'h3-d7-q12-v1',anchor:scope.anchor,anchorProvenance:{market:{cluster:scope.cluster,programId:scope.programId,address:scope.marketId},finality:'finalized'},
    source:{kind:'HISTORICAL_REPLAY',dataThrough:scope.maturityAt,evidenceHash:'b'.repeat(64),
      activityNowQ12:'1000000000000',activity7dQ12:'1000000000000',priceAtoms:'1000000'}};
  const candidateHash=hash(candidate),key=hash({market:candidate.market,epoch:candidate.epoch});
  const journalPath=resolve(work,`${randomUUID()}.json`),dbPath=resolve(work,`${randomUUID()}.sqlite`);
  writeFileSync(journalPath,JSON.stringify({settlements:{[key]:{state:'FROZEN_LOCAL',candidate,candidateHash}}}));
  return {journalPath,attempts:new SqliteKeeperAttempts(dbPath),candidateHash};
}

test('keeper advances accepted settlement, individual payout fixation and LP window one transaction at a time',async()=>{
  const fixture=setup(),now=scope.maturityAt+900;
  const state:FinalizedEpochState={marketId:scope.marketId,cycle:'2',epochStartedAt:scope.epochStartedAt,maturityAt:scope.maturityAt,settlement:null,
    openPositions:[{address:'position',marketId:scope.marketId,cycle:'2'}],openPositionCount:1,
    lpWindowStart:now-100_000,lpWindowEnd:now-99_100,navValid:true};
  const sent:string[]=[];
  const chain:FinancialEpochChain={async read(){return structuredClone(state);},async verifyAttempt(){return 'PENDING';},
    async accept(){sent.push('accept');return 'accept-sig';},async settle(){sent.push('settle');return 'settle-sig';},
    async startLpWindow(){sent.push('lp');return 'lp-sig';}};
  const input={journalPath:fixture.journalPath,scope,attempts:fixture.attempts,chain,now};
  assert.deepEqual(await advanceFinancialEpoch({...input,now:now-1}),{state:'notDue',action:null,signature:null});
  assert.equal((await advanceFinancialEpoch(input)).action,'ACCEPT_SETTLEMENT');
  assert.equal((await advanceFinancialEpoch(input)).state,'unknown');
  assert.deepEqual(sent,['accept']);
  state.settlement={marketId:scope.marketId,cycle:'2',epoch:scope.epoch,maturityAt:scope.maturityAt,
    candidateHash:fixture.candidateHash,priceAtoms:'1000000',mode:'NORMAL',effectiveCloseAt:scope.maturityAt,acceptedAt:now};
  assert.equal((await advanceFinancialEpoch(input)).action,'SETTLE_PRO');
  assert.deepEqual(sent,['accept','settle']);
  state.openPositions=[];state.openPositionCount=0;
  assert.equal((await advanceFinancialEpoch(input)).action,'START_LP_WINDOW');
  state.lpWindowStart=now;state.lpWindowEnd=now+900;
  state.maturityAt=0;
  assert.deepEqual(await advanceFinancialEpoch(input),{state:'complete',action:null,signature:null});
  assert.deepEqual(sent,['accept','settle','lp']);
  fixture.attempts.close();
});

test('keeper stops on settlement identity or incomplete position enumeration',async()=>{
  const fixture=setup(),now=scope.maturityAt+900;
  const state:FinalizedEpochState={marketId:scope.marketId,cycle:'2',epochStartedAt:scope.epochStartedAt,maturityAt:scope.maturityAt,settlement:null,
    openPositions:[],openPositionCount:1,lpWindowStart:0,lpWindowEnd:0,navValid:true};
  const chain:FinancialEpochChain={async read(){return state;},async verifyAttempt(){return 'PENDING';},
    async accept(){throw new Error('unreachable');},async settle(){throw new Error('unreachable');},async startLpWindow(){throw new Error('unreachable');}};
  const input={journalPath:fixture.journalPath,scope,attempts:fixture.attempts,chain,now};
  await assert.rejects(()=>advanceFinancialEpoch(input),/KEEPER_CHAIN_STATE_MISMATCH/);
  state.openPositionCount=0;
  state.settlement={marketId:scope.marketId,cycle:'2',epoch:scope.epoch,maturityAt:scope.maturityAt,
    candidateHash:'c'.repeat(64),priceAtoms:'1000000',mode:'NORMAL',effectiveCloseAt:scope.maturityAt,acceptedAt:now};
  await assert.rejects(()=>advanceFinancialEpoch(input),/KEEPER_SETTLEMENT_ACCOUNT_MISMATCH/);
  fixture.attempts.close();
});

test('same-week reopened cycle cannot reuse the earlier emergency candidate',async()=>{
  const fixture=setup(),now=scope.maturityAt+900;
  const state:FinalizedEpochState={marketId:scope.marketId,cycle:'3',epochStartedAt:scope.epochStartedAt+1000,
    maturityAt:scope.maturityAt,settlement:null,openPositions:[{address:'new-position',marketId:scope.marketId,cycle:'3'}],
    openPositionCount:1,lpWindowStart:0,lpWindowEnd:0,navValid:true};
  let sends=0;
  const chain:FinancialEpochChain={async read(){return state;},async verifyAttempt(){return 'PENDING';},
    async accept(){sends++;return 'sig';},async settle(){sends++;return 'sig';},async startLpWindow(){sends++;return 'sig';}};
  await assert.rejects(()=>advanceFinancialEpoch({journalPath:fixture.journalPath,scope,attempts:fixture.attempts,chain,now}),/KEEPER_CHAIN_STATE_MISMATCH/);
  assert.equal(sends,0);
  fixture.attempts.close();
});

test('a signed transaction is journaled before an uncertain submission',async()=>{
  const fixture=setup(),now=scope.maturityAt+900;
  const state:FinalizedEpochState={marketId:scope.marketId,cycle:'2',epochStartedAt:scope.epochStartedAt,
    maturityAt:scope.maturityAt,settlement:null,openPositions:[],openPositionCount:0,
    lpWindowStart:0,lpWindowEnd:0,navValid:false};
  let sends=0;
  const chain:FinancialEpochChain={async read(){return state;},async verifyAttempt(){return 'PENDING';},
    async accept(_candidate,onSigned){sends++;onSigned?.('signed-before-send');throw new Error('network unknown');},
    async settle(){throw new Error('unreachable');},async startLpWindow(){throw new Error('unreachable');}};
  const input={journalPath:fixture.journalPath,scope,attempts:fixture.attempts,chain,now};
  assert.deepEqual(await advanceFinancialEpoch(input),{state:'unknown',action:'ACCEPT_SETTLEMENT',signature:'signed-before-send'});
  assert.equal(fixture.attempts.get({action:'ACCEPT_SETTLEMENT',marketId:scope.marketId,cycle:'2',entity:''})?.signature,
    'signed-before-send');
  assert.equal((await advanceFinancialEpoch(input)).state,'unknown');
  assert.equal(sends,1);
  fixture.attempts.close();
});
