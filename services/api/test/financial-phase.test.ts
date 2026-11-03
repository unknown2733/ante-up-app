import test from 'node:test';
import assert from 'node:assert/strict';
import {MarketPhase,type Market,type FinanceMarket} from '../../../clients/chain/dist/index.js';
import {financialEpochPhase,type FinalizedFinancialAccounts} from '../src/financial-chain.ts';
import {indexedCapabilities} from '../src/live-read.ts';

test('empty and active Pro cycles both stop new entry at Monday 08:30 KST',async()=>{
 const week=1793577600n,next=week+604800n,cutoff=next-1800n;
 const state={settlement:async()=>null} as unknown as FinalizedFinancialAccounts;
 const market={phase:MarketPhase.Indexed,validityGeneration:7n} as Market;
 const base={currentCycle:1n,currentMaturity:0n,openPositions:0,lpGeneration:7n,
   lpWindowStart:week,lpWindowEnd:week+900n,proReopenAt:week+900n,lastLpMaturity:week} as FinanceMarket;
 for(const currentMaturity of [0n,next]){
  const finance={...base,currentMaturity};
  assert.equal(await financialEpochPhase(state,'market',market,finance,Number(cutoff-1n)),'PRO_OPEN');
  for(const now of [cutoff,next-1n]){
   const epochPhase=await financialEpochPhase(state,'market',market,finance,Number(now));
   assert.equal(epochPhase,'OPEN_CUTOFF');
   const capabilities=indexedCapabilities({epochPhase,price:{kind:'indexed',atoms:'1200000',executable:true},
     lowActivity:false,assets:1000n,free:100n,nav:100n,externalQ:10n,inventory:10n,
     totalShares:100n,lockedShares:100n,openPositions:0,otherReserved:0n});
   assert.deepEqual(capabilities.openPro,{allowed:false,reason:'WRONG_PHASE'});
  }
  assert.equal(await financialEpochPhase(state,'market',market,finance,Number(next)),
    currentMaturity===0n?null:'SETTLING');
 }
 // A genuine LP window still takes precedence; it does not become a Pro entry window.
 assert.equal(await financialEpochPhase(state,'market',market,{...base,lpWindowStart:cutoff-300n,
   lpWindowEnd:cutoff+600n,proReopenAt:cutoff+600n},Number(cutoff)),'LP_WINDOW');
 assert.equal(await financialEpochPhase(state,'market',market,{...base,lpGeneration:6n},Number(cutoff-1n)),null);
 // After the next weekly LP window, first Pro entry can reopen for the new maturity.
 assert.equal(await financialEpochPhase(state,'market',market,{...base,lastLpMaturity:next,
   lpWindowStart:next+960n,lpWindowEnd:next+1860n,proReopenAt:next+1860n},Number(next+1860n)),'PRO_OPEN');
});
