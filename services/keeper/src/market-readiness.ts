import {freeCapital,indexPrice} from '../../../contracts/reference.mjs';
const UNIT=1_000_000n;

export interface FinanceMarketFacts {
  finality:'finalized'; cluster:'devnet'|'localnet'; marketId:string; programId:string; chainNow:number;
  provenance:'OBSERVED'|'SYNTHETIC'|'UNKNOWN';
  phase:'CURVE'|'GRADUATION_WAIT'|'INDEXED'; dataStatus:'PREPARING'|'VALID'|'LOW_ACTIVITY'|'OUTAGE';
  admission:'BLOCKED'|'RECOVERING'|'OPEN'; latestSequence:string; latestDataThrough:number;
  queryHash:string; queryVersion:string;latestHash:string;
  snapshot:{sequence:string;payloadHash:string;queryHash:string;queryVersion:string}|null;
  activityNowQ12:string|null; activity7dQ12:string|null;
  finance:{curveSold:string;curveReserve:string;marketFees:string;assets:string;externalQ:string;
    anchorPg:string;anchorSg:string;anchorDg:string;pmax:string;proReserved:string;otherReserved:string;
    openPositions:number;totalShares:string;lockedShares:string;currentCycle:string;currentMaturity:number;
    lpWindowStart:number;lpWindowEnd:number;proReopenAt:number;lastLpMaturity:number;
    lpGeneration:string;validityGeneration:string};
  support:{supportedMarkets:number;supportSpent:string;supportPaymentBalance:string|null};
  keeper:{scopePresent:boolean;scopeMatches:boolean;publisherKeyPresent:boolean;keeperKeyPresent:boolean;
    attemptsStorePresent:boolean;candidateFrozen:boolean};
}
export interface FinanceMarketReadiness {
  readOnly:true;marketId:string;at:number;status:'BLOCKED'|'READY_FOR_REVIEW';
  graduation:{eligible:boolean;blockers:string[];targetAssets:string|null;requiredContribution:string|null};
  indexed:{eligible:boolean;blockers:string[];spotReserve:string|null;freeCapital:string|null;nav:string|null;
    epoch:'INITIAL_LP'|'PRO_OPEN'|'OPEN_CUTOFF'|'SETTLING'|'LP_WINDOW'|'CLOSED'|null};
  maturity:{eligible:boolean;blockers:string[];cycle:string;at:number|null};blockers:string[];
}
const uint=(s:string|null):s is string=>typeof s==='string' && /^(0|[1-9][0-9]*)$/.test(s) && BigInt(s)<=18_446_744_073_709_551_615n;
const n=(s:string)=>BigInt(s);
const add=(list:string[],condition:boolean,code:string)=>{if(!condition)list.push(code);};
const monday=(at:number)=>Math.floor((at-345_600)/604_800)*604_800+345_600;

/** Advisory only: the program still checks all conditions on the signed instruction. */
export function evaluateFinanceMarketReadiness(f:FinanceMarketFacts):FinanceMarketReadiness {
  if (f.finality!=='finalized' || !Number.isSafeInteger(f.chainNow) || f.chainNow<0 ||
      !Number.isSafeInteger(f.latestDataThrough) || f.latestDataThrough<0 ||
      !Number.isSafeInteger(f.finance.currentMaturity) || !Number.isSafeInteger(f.finance.openPositions) ||
      !Number.isSafeInteger(f.support.supportedMarkets) ||
      Object.values({...f.finance,assets:f.finance.assets}).some((v)=>typeof v==='string' && !uint(v)) ||
      Object.values(f.support).some(v=>typeof v==='string' && !uint(v)))
    throw new Error('FINANCE_READINESS_FACTS_INVALID');
  const data:string[]=[],graduation:string[]=[],indexed:string[]=[],maturity:string[]=[];
  add(data,f.provenance==='OBSERVED','SOURCE_NOT_VERIFIED_OBSERVED');
  add(data,f.dataStatus==='VALID','DATA_NOT_VALID');
  add(data,f.admission==='OPEN','ADMISSION_NOT_OPEN');
  add(data,f.latestDataThrough<=f.chainNow && f.chainNow-f.latestDataThrough<600,'DATA_STALE_OR_FUTURE');
  add(data,!!f.snapshot && f.snapshot.sequence===f.latestSequence && f.snapshot.payloadHash===f.latestHash &&
    f.snapshot.queryHash===f.queryHash &&
    f.snapshot.queryVersion===f.queryVersion && /^[0-9a-f]{64}$/.test(f.snapshot.payloadHash),'SNAPSHOT_IDENTITY_UNVERIFIED');
  add(data,uint(f.activityNowQ12) && uint(f.activity7dQ12) && n(f.activityNowQ12)>=100n*1_000_000_000_000n &&
    n(f.activity7dQ12)>=100n*1_000_000_000_000n && n(f.activityNowQ12)<5n*n(f.activity7dQ12),
    'GRADUATION_ACTIVITY_INVALID');
  graduation.push(...data);
  add(graduation,f.phase==='CURVE','NOT_CURVE');
  add(graduation,n(f.finance.curveSold)===1_000n*UNIT,'CURVE_CAP_NOT_REACHED');
  add(graduation,n(f.finance.curveReserve)>=1_100n*UNIT,'CURVE_RESERVE_BELOW_MINIMUM');
  add(graduation,f.support.supportedMarkets<10,'SUPPORT_SLOTS_EXHAUSTED');
  add(graduation,n(f.finance.assets)>=n(f.finance.curveReserve)+n(f.finance.marketFees),'CURVE_ASSETS_BELOW_LIABILITIES');
  let targetAssets:string|null=null,requiredContribution:string|null=null;
  if(uint(f.activityNowQ12) && uint(f.activity7dQ12) && n(f.activityNowQ12)>0n && n(f.activity7dQ12)>0n &&
      n(f.activityNowQ12)<5n*n(f.activity7dQ12)) {
    try {
      const pmax=indexPrice(1_200_000n,n(f.activityNowQ12),n(f.activity7dQ12),
        n(f.activityNowQ12),n(f.activity7dQ12)).maximum;
      const target=(1_000n*UNIT*BigInt(pmax)+UNIT-1n)/UNIT+3_500n*UNIT;
      const contribution=target>n(f.finance.assets)?target-n(f.finance.assets):0n;
      targetAssets=target.toString();requiredContribution=contribution.toString();
      add(graduation,contribution<=10_000n*UNIT && n(f.support.supportSpent)+contribution<=100_000n*UNIT,
        'SUPPORT_BUDGET_INSUFFICIENT');
      add(graduation,uint(f.support.supportPaymentBalance) &&
        contribution<=n(f.support.supportPaymentBalance),
        'ACTUAL_SUPPORT_BALANCE_INSUFFICIENT');
    } catch {graduation.push('GRADUATION_PRICE_INVALID');}
  } else graduation.push('GRADUATION_PRICE_INVALID');

  indexed.push(...data.filter(code=>code!=='GRADUATION_ACTIVITY_INVALID'));
  add(indexed,f.phase==='INDEXED','NOT_INDEXED');
  const q=n(f.finance.externalQ),pmax=n(f.finance.pmax),assets=n(f.finance.assets);
  const spotReserve=(q*pmax+UNIT-1n)/UNIT;
  const free=freeCapital(assets,q,pmax,n(f.finance.proReserved),n(f.finance.otherReserved),500n*UNIT) as bigint;
  add(indexed,free>=0n,'RESERVE_BUFFER_OR_FIXED_DEBT_UNFUNDED');
  add(indexed,n(f.finance.totalShares)>0n && n(f.finance.lockedShares)<=n(f.finance.totalShares),'LP_SHARES_INVALID');
  let nav:string|null=null;
  if(uint(f.activityNowQ12) && uint(f.activity7dQ12) && n(f.activity7dQ12)>0n &&
      n(f.finance.anchorPg)>0n && n(f.finance.anchorSg)>0n && n(f.finance.anchorDg)>0n) {
    try {const price=indexPrice(n(f.finance.anchorPg),n(f.finance.anchorSg),n(f.finance.anchorDg),
      n(f.activityNowQ12),n(f.activity7dQ12));
      if(BigInt(price.maximum)!==pmax) indexed.push('ANCHOR_MAXIMUM_MISMATCH');
      else if(f.finance.openPositions===0) {
        const value=assets-q*BigInt(price.price)/UNIT-n(f.finance.otherReserved);
        if(value>=0n)nav=value.toString();
      }
    } catch {indexed.push('INDEX_PRICE_INVALID');}
  } else indexed.push('INDEX_PRICE_INVALID');
  if(nav===null) indexed.push('CURRENT_NAV_UNAVAILABLE');
  let epoch:FinanceMarketReadiness['indexed']['epoch']=null;
  if(f.phase==='INDEXED') {
    const fm=f.finance;
    if(fm.currentMaturity>0) epoch=f.chainNow>=fm.currentMaturity?'SETTLING':
      f.chainNow>=fm.currentMaturity-1800?'OPEN_CUTOFF':'PRO_OPEN';
    else if(f.chainNow>=fm.lpWindowStart && f.chainNow<fm.lpWindowEnd && fm.openPositions===0 &&
      fm.lpGeneration===fm.validityGeneration) epoch=fm.currentCycle==='0'?'INITIAL_LP':'LP_WINDOW';
    else if(f.chainNow>=fm.proReopenAt && f.chainNow>=fm.lpWindowEnd &&
      fm.lpGeneration===fm.validityGeneration && monday(f.chainNow)<=fm.lastLpMaturity) epoch='PRO_OPEN';
    else epoch='CLOSED';
  }
  if(epoch==='CLOSED' || epoch===null) indexed.push('EPOCH_NOT_OPEN');
  // Historical maturity uses a frozen candidate through T; the latest feed may now be stale.
  maturity.push(...indexed.filter(code=>['NOT_INDEXED','RESERVE_BUFFER_OR_FIXED_DEBT_UNFUNDED',
    'SOURCE_NOT_VERIFIED_OBSERVED'].includes(code)));
  add(maturity,f.finance.currentMaturity>0 && epoch==='SETTLING','MATURITY_NOT_DUE');
  add(maturity,f.keeper.scopePresent && f.keeper.scopeMatches,'KEEPER_SCOPE_MISSING_OR_STALE');
  add(maturity,f.keeper.publisherKeyPresent && f.keeper.keeperKeyPresent && f.keeper.attemptsStorePresent,
    'KEEPER_KEYS_OR_DURABLE_ATTEMPTS_MISSING');
  add(maturity,f.keeper.candidateFrozen,'FROZEN_MATURITY_CANDIDATE_MISSING');
  const blockers=f.phase==='CURVE'?graduation:f.phase==='INDEXED'?
    (epoch==='SETTLING'?maturity:indexed):['NOT_CURVE_OR_INDEXED'];
  return {readOnly:true,marketId:f.marketId,at:f.chainNow,status:blockers.length?'BLOCKED':'READY_FOR_REVIEW',
    graduation:{eligible:graduation.length===0,blockers:graduation,targetAssets,requiredContribution},
    indexed:{eligible:indexed.length===0,blockers:indexed,spotReserve:spotReserve.toString(),freeCapital:free.toString(),nav,epoch},
    maturity:{eligible:maturity.length===0,blockers:maturity,cycle:f.finance.currentCycle,
      at:f.finance.currentMaturity>0?f.finance.currentMaturity:null},blockers};
}
