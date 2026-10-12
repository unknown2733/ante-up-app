import { readFile } from 'node:fs/promises';
import { hash } from '../../data/index.mjs';
import { indexPrice } from '../../../contracts/reference.mjs';

const hex=(value:unknown):value is string=>typeof value==='string' && /^[0-9a-f]{64}$/.test(value);
const uint=(value:unknown):value is string=>typeof value==='string' && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value)<=18_446_744_073_709_551_615n;
const second=(value:unknown):value is number=>Number.isSafeInteger(value) && Number(value)>=0;
const record=(value:unknown):Record<string,unknown>=>{
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('KEEPER_CANDIDATE_INVALID');
  return value as Record<string,unknown>;
};
const valid=(ok:unknown)=>{if (!ok) throw new Error('KEEPER_CANDIDATE_INVALID');};

export interface SettlementScope {
  cluster:'localnet'|'devnet';programId:string;marketId:string;epoch:string;epochStartedAt:number;maturityAt:number;
  queryHash:string;queryVersion:string;configVersion:string;
  anchor:{graduationPriceAtoms:string;graduationNowQ12:string;graduation7dQ12:string;maxPriceAtoms:string};
}
export interface AcceptedCandidate {
  marketId:string;epoch:bigint;maturityAt:bigint;candidateHash:Uint8Array;evidenceHash:Uint8Array;
  mode:'NORMAL'|'RECOVERY'|'EMERGENCY';eligibleAt:bigint;effectiveCloseAt:bigint;outageStartedAt:bigint;
  settlementPrice:bigint;activityNowQ12:bigint;activity7dQ12:bigint;queryVersion:bigint;configVersion:bigint;
  dataThrough:number;
  emergencySnapshot?:{sequence:bigint;payloadHash:Uint8Array;publishedAt:number};
}

/** Maps C's immutable FROZEN_LOCAL candidate to B's accept_settlement args. */
export function adaptFrozenSettlement(row:unknown,scope:SettlementScope):AcceptedCandidate {
  const frozen=record(row),candidate=record(frozen.candidate),market=record(candidate.market),anchor=record(candidate.anchor);
  const source=record(candidate.source),provenance=record(candidate.anchorProvenance);
  valid(frozen.state==='FROZEN_LOCAL' && hex(frozen.candidateHash) && hash(candidate)===frozen.candidateHash &&
    market.cluster===scope.cluster && market.programId===scope.programId && market.address===scope.marketId &&
    candidate.epoch===scope.epoch && candidate.epochStartedAt===scope.epochStartedAt && candidate.maturityAt===scope.maturityAt &&
    candidate.queryHash===scope.queryHash && candidate.queryVersion===scope.queryVersion &&
    candidate.configVersion===scope.configVersion && candidate.formulaVersion==='h3-d7-q12-v1' &&
    provenance.finality==='finalized' && record(provenance.market).address===scope.marketId &&
    record(provenance.market).programId===scope.programId && record(provenance.market).cluster===scope.cluster &&
    anchor.graduationPriceAtoms===scope.anchor.graduationPriceAtoms &&
    anchor.graduationNowQ12===scope.anchor.graduationNowQ12 &&
    anchor.graduation7dQ12===scope.anchor.graduation7dQ12 &&
    anchor.maxPriceAtoms===scope.anchor.maxPriceAtoms);
  valid(uint(scope.epoch) && uint(scope.queryVersion) && uint(scope.configVersion) && hex(scope.queryHash) &&
    Object.values(scope.anchor).every(uint) && second(scope.epochStartedAt) && scope.epochStartedAt<scope.maturityAt &&
    second(scope.maturityAt) && second(candidate.eligibleAt) &&
    second(candidate.effectiveCloseAt) && second(source.dataThrough) && hex(source.evidenceHash) &&
    uint(source.priceAtoms) && uint(source.activityNowQ12) && uint(source.activity7dQ12));
  const mode=candidate.mode as AcceptedCandidate['mode'];
  valid(mode==='NORMAL' || mode==='RECOVERY' || mode==='EMERGENCY');
  const outageStartedAt=candidate.outageStartedAt;
  if (mode==='NORMAL') valid(outageStartedAt===null && source.kind==='HISTORICAL_REPLAY' &&
    candidate.effectiveCloseAt===scope.maturityAt && Number(candidate.eligibleAt)>=scope.maturityAt+900);
  if (mode==='RECOVERY') valid(second(outageStartedAt) && Number(outageStartedAt)>0 &&
    source.kind==='HISTORICAL_REPLAY' && candidate.effectiveCloseAt===scope.maturityAt &&
    Number(candidate.eligibleAt)>=scope.maturityAt+900 && Number(outageStartedAt)<Number(candidate.eligibleAt) &&
    Number(candidate.eligibleAt)<=Number(outageStartedAt)+86_400);
  if (mode==='EMERGENCY') valid(second(outageStartedAt) && Number(outageStartedAt)>0 &&
    source.kind==='PUBLISHED_SNAPSHOT' && candidate.eligibleAt===Number(outageStartedAt)+86_400 &&
    candidate.effectiveCloseAt===Math.min(scope.maturityAt,Number(candidate.eligibleAt)) &&
    Number(source.dataThrough)<=Number(outageStartedAt) && record(source.snapshotRef).marketId===scope.marketId &&
    hex(record(source.snapshotRef).payloadHash) && uint(record(source.snapshotRef).sequence) &&
    second(source.snapshotPublishedAt) && Number(source.snapshotPublishedAt)<=Number(outageStartedAt) &&
    typeof source.snapshotSignature==='string' && source.snapshotSignature.length>0 && uint(source.snapshotSlot));
  valid(Number(source.dataThrough)<=Number(candidate.effectiveCloseAt));
  const calculated=indexPrice(BigInt(scope.anchor.graduationPriceAtoms),BigInt(scope.anchor.graduationNowQ12),
    BigInt(scope.anchor.graduation7dQ12),BigInt(source.activityNowQ12 as string),BigInt(source.activity7dQ12 as string));
  valid(BigInt(calculated.price)===BigInt(source.priceAtoms as string) && BigInt(calculated.maximum)===BigInt(scope.anchor.maxPriceAtoms));
  return {marketId:scope.marketId,epoch:BigInt(scope.epoch),maturityAt:BigInt(scope.maturityAt),
    candidateHash:Uint8Array.from(Buffer.from(frozen.candidateHash as string,'hex')),
    evidenceHash:Uint8Array.from(Buffer.from(source.evidenceHash as string,'hex')),
    mode,eligibleAt:BigInt(candidate.eligibleAt as number),effectiveCloseAt:BigInt(candidate.effectiveCloseAt as number),
    outageStartedAt:BigInt(outageStartedAt as number|null ?? 0),settlementPrice:BigInt(calculated.price),
    activityNowQ12:BigInt(source.activityNowQ12 as string),activity7dQ12:BigInt(source.activity7dQ12 as string),
    queryVersion:BigInt(scope.queryVersion),configVersion:BigInt(scope.configVersion),dataThrough:Number(source.dataThrough),
    ...(mode==='EMERGENCY'?{emergencySnapshot:{sequence:BigInt(record(source.snapshotRef).sequence as string),
      payloadHash:Uint8Array.from(Buffer.from(record(source.snapshotRef).payloadHash as string,'hex')),
      publishedAt:Number(source.snapshotPublishedAt)}}:{})};
}

/** Reads the exact C journal row; absence never creates an implicit candidate. */
export async function readFrozenSettlement(path:string,scope:SettlementScope):Promise<AcceptedCandidate|null> {
  let raw:string;
  try {raw=await readFile(path,'utf8');} catch(error) {
    if ((error as NodeJS.ErrnoException).code==='ENOENT') return null;
    throw error;
  }
  const journal=record(JSON.parse(raw)),rows=record(journal.settlements);
  let found:AcceptedCandidate|null=null;
  for (const [key,value] of Object.entries(rows)) {
    const row=record(value),candidate=record(row.candidate),market=record(candidate.market);
    if (market.cluster!==scope.cluster || market.programId!==scope.programId ||
        market.address!==scope.marketId || candidate.epoch!==scope.epoch) continue;
    valid(key===hash({market:candidate.market,epoch:candidate.epoch}) && found===null);
    found=adaptFrozenSettlement(value,scope);
  }
  return found;
}
