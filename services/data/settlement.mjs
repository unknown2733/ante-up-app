import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { indexPrice } from '../../contracts/reference.mjs';
import { findSnapshotPda } from '../../clients/chain/dist/index.js';
import { isAddress } from '@solana/kit';
import { DAY, HISTORY_MINUTES, MAX_U64, canonical, hash, replay } from './index.mjs';
import { selectOutageForEpoch } from './outage.mjs';

const check=(ok,code='INVALID_SETTLEMENT_INPUT')=>{if(!ok)throw new Error(code);};
const uint=x=>typeof x==='string' && /^(0|[1-9][0-9]*)$/.test(x);
const second=x=>Number.isSafeInteger(x) && x>=0;
const hex=x=>typeof x==='string' && /^[a-f0-9]{64}$/.test(x);
const same=(a,b)=>canonical(a)===canonical(b);
const identity=({market,epoch,epochStartedAt,maturityAt,historyStart,queryVersion,queryHash,configVersion,
  anchor,anchorProvenance})=>
  ({market,epoch,epochStartedAt,maturityAt,historyStart,queryVersion,queryHash,configVersion,
    anchor,anchorProvenance});

function validateBase(input) {
  const {market,epoch,epochStartedAt,maturityAt,historyStart,now,queryVersion,queryHash,configVersion,
    anchor,anchorProvenance}=input;
  check(['localnet','devnet'].includes(market?.cluster) && isAddress(market.programId) &&
    isAddress(market.address) &&
    uint(epoch) && uint(queryVersion) && uint(configVersion) && hex(queryHash));
  check(second(epochStartedAt) && epochStartedAt<maturityAt && second(maturityAt) &&
    maturityAt%60===0 && second(historyStart) && historyStart%60===0 &&
    maturityAt>=historyStart+HISTORY_MINUTES*60 && second(now));
  check(anchor && [anchor.graduationPriceAtoms,anchor.graduationNowQ12,
    anchor.graduation7dQ12,anchor.maxPriceAtoms].every(uint));
  check(anchorProvenance?.market?.cluster===market.cluster &&
    anchorProvenance.market?.programId===market.programId &&
    anchorProvenance.market?.address===market.address &&
    uint(anchorProvenance.slot) && typeof anchorProvenance.signature==='string' &&
    anchorProvenance.signature.length>0 && anchorProvenance.finality==='finalized','ANCHOR_PROVENANCE_REQUIRED');
  const pg=BigInt(anchor.graduationPriceAtoms),sg=BigInt(anchor.graduationNowQ12),
    dg=BigInt(anchor.graduation7dQ12),maximum=BigInt(anchor.maxPriceAtoms);
  check(pg<=MAX_U64 && sg<=MAX_U64 && dg<=MAX_U64 && maximum<=MAX_U64,'PRICE_OVERFLOW');
  const calculated=indexPrice(pg,sg,dg,sg,dg);
  check(calculated.maximum===maximum,'ANCHOR_MISMATCH');
}

function price(anchor,nowQ12,d7Q12) {
  check(uint(nowQ12) && uint(d7Q12),'INVALID_DENOMINATOR');
  const s=BigInt(nowQ12),d=BigInt(d7Q12);
  check(s<=MAX_U64 && d<=MAX_U64,'PRICE_OVERFLOW');
  const result=indexPrice(BigInt(anchor.graduationPriceAtoms),BigInt(anchor.graduationNowQ12),
    BigInt(anchor.graduation7dQ12),s,d);
  check(result.price<=MAX_U64 && result.maximum<=MAX_U64,'PRICE_OVERFLOW');
  return result.price.toString();
}

function replayAt(input,asOf) {
  const result=replay({observations:input.observations,marketId:input.market.address,
    queryVersion:input.queryVersion,queryHash:input.queryHash,start:input.historyStart,
    end:input.maturityAt,computedAt:asOf,configVersion:input.configVersion,
    formulaVersion:'h3-d7-q12-v1'});
  const complete=result.candidate.dataThrough===input.maturityAt &&
    result.candidate.activityNowQ12!==null && result.candidate.activity7dQ12!==null &&
    BigInt(result.candidate.activity7dQ12)>0n;
  return {result,complete};
}

async function emergencySnapshot(input,outage) {
  const snapshot=outage.lastVerifiedSnapshot;
  const payload=snapshot?.payload;
  check(uint(payload?.sequence),'EMERGENCY_SNAPSHOT_REQUIRED');
  const [snapshotPda]=await findSnapshotPda({market:input.market.address,sequence:BigInt(payload.sequence)},
    {programAddress:input.market.programId});
  check(snapshot?.finality==='finalized' && snapshot.chain?.cluster===input.market.cluster &&
    snapshot.chain.programId===input.market.programId && snapshot.chain.address===snapshotPda &&
    hex(snapshot.payloadHash) && hash(payload)===snapshot.payloadHash &&
    typeof snapshot.signature==='string' && snapshot.signature.length>0 && uint(snapshot.slot) &&
    second(snapshot.publishedAt) && snapshot.publishedAt<=outage.startedAt &&
    second(payload?.dataThrough) && payload.dataThrough<=input.maturityAt &&
    (outage.provenance.kind!=='PERSISTED_RECOVERY_STATE' ||
      payload.dataThrough<=outage.provenance.dataThrough) &&
    ['VALID','LOW_ACTIVITY'].includes(payload.dataStatus) &&
    payload.marketId===input.market.address && payload.queryVersion===input.queryVersion &&
    payload.queryHash===input.queryHash && payload.configVersion===input.configVersion &&
    payload.formulaVersion==='h3-d7-q12-v1','EMERGENCY_SNAPSHOT_REQUIRED');
  const priceAtoms=price(input.anchor,payload.activityNowQ12,payload.activity7dQ12);
  return {kind:'PUBLISHED_SNAPSHOT',priceAtoms,snapshotRef:{marketId:input.market.address,sequence:payload.sequence,
    payloadHash:snapshot.payloadHash},snapshotSignature:snapshot.signature,snapshotSlot:snapshot.slot,
    snapshotPublishedAt:snapshot.publishedAt,dataThrough:payload.dataThrough,
    activityNowQ12:payload.activityNowQ12,activity7dQ12:payload.activity7dQ12,
    evidenceHash:payload.evidenceHash};
}

function validateOutage(input,outage,atCutoff=null) {
  const source=outage?.provenance;
  if(outage?.id!==undefined)
    check(outage.id===hash({marketId:input.market.address,startedAt:outage.startedAt,
      provenance:source}),'OUTAGE_INCIDENT_MISMATCH');
  const stale=source?.kind==='PERSISTED_RECOVERY_STATE' && second(source.dataThrough) &&
    outage.startedAt===source.dataThrough+600 && source.dataThrough<=input.maturityAt &&
    (!atCutoff || source.dataThrough<=atCutoff.result.candidate.dataThrough &&
      atCutoff.result.candidate.dataThrough<input.maturityAt &&
      (atCutoff.result.state.outageStartAt===null ||
        outage.startedAt<=atCutoff.result.state.outageStartAt));
  const invalid=source?.kind==='INVALID_SOURCE' && second(source.invalidatedAt) &&
    outage.startedAt===source.invalidatedAt &&
    ['SOURCE_INVALID','INVALID_DENOMINATOR'].includes(source.reason) &&
    (!atCutoff || atCutoff.result.candidate.dataThrough<input.maturityAt ||
      atCutoff.result.candidate.activity7dQ12==='0');
  check(second(outage?.startedAt) && (stale || invalid),'OUTAGE_PROVENANCE_MISMATCH');
  const emergencyAt=outage.startedAt+DAY;
  check(Number.isSafeInteger(emergencyAt) &&
    (outage.recoveredAt===null || second(outage.recoveredAt) &&
      outage.recoveredAt>outage.startedAt && outage.recoveredAt<=input.now),
    'OUTAGE_RECOVERY_STATE_REQUIRED');
  return emergencyAt;
}

async function emergency(input,cutoffAt,emergencyAt) {
  const outage=input.outage;
  check(outage.recoveredAt===null || outage.recoveredAt>emergencyAt,'OUTAGE_ALREADY_RECOVERED');
  const fallback=await emergencySnapshot(input,outage);
  const candidate={schemaVersion:'0.1',market:input.market,epoch:input.epoch,
    epochStartedAt:input.epochStartedAt,maturityAt:input.maturityAt,
    cutoffAt,mode:'EMERGENCY',eligibleAt:emergencyAt,effectiveCloseAt:Math.min(input.maturityAt,emergencyAt),
    acceptedAt:emergencyAt,emergencyAt,queryVersion:input.queryVersion,queryHash:input.queryHash,
    configVersion:input.configVersion,formulaVersion:'h3-d7-q12-v1',anchor:input.anchor,
    anchorProvenance:input.anchorProvenance,outageIncidentId:outage.id??null,
    outageStartedAt:outage.startedAt,
    outageRecoveredAt:outage.recoveredAt,outageProvenance:outage.provenance,source:fallback};
  return {state:'READY',candidate,candidateHash:hash(candidate)};
}

// A pure, historical settlement calculation; calling it does not finalize.
// `epoch` is B FinanceMarket.current_cycle, including after an emergency
// restart within the same calendar week. The caller must bind it to chain
// state and supply an authoritative finalized anchor and, for emergency,
// the last finalized valid snapshot before the outage.
export async function evaluateSettlement(input) {
  validateBase(input);
  const cutoffAt=input.maturityAt+900;
  check(Number.isSafeInteger(cutoffAt));
  if (input.outage) {
    const earlyDeadline=validateOutage(input,input.outage);
    if (earlyDeadline<cutoffAt && input.now>=earlyDeadline &&
      (input.outage.recoveredAt===null || input.outage.recoveredAt>earlyDeadline)) {
      if (input.maturityAt<=earlyDeadline)
        check(!replayAt(input,earlyDeadline).complete,'OUTAGE_RECOVERY_STATE_MISMATCH');
      return emergency(input,cutoffAt,earlyDeadline);
    }
  }
  if (input.now<cutoffAt) return {state:'WAITING',cutoffAt};
  const atCutoff=replayAt(input,cutoffAt);
  let selected=atCutoff,mode='NORMAL',acceptedAt=cutoffAt;
  let emergencyAt=null;
  if (!atCutoff.complete) {
    const outage=input.outage;
    emergencyAt=validateOutage(input,outage,atCutoff);
    check(outage.startedAt<=cutoffAt,'OUTAGE_PROVENANCE_MISMATCH');
    check(atCutoff.result.candidate.dataThrough>=input.historyStart+HISTORY_MINUTES*60,'DATA_NOT_READY');
    const arrivals=[...new Set(input.observations.map(o=>o.validatedAt)
      .filter(t=>second(t) && t>cutoffAt && t<=input.now && t<=emergencyAt))].sort((a,b)=>a-b);
    selected=null;
    for (const t of arrivals) {
      const attempt=replayAt(input,t);
      if (attempt.complete) {selected=attempt;acceptedAt=t;mode='RECOVERY';break;}
    }
    if (!selected && input.now<emergencyAt) return {state:'PENDING_RECOVERY',cutoffAt,emergencyAt};
    if (!selected) return emergency(input,cutoffAt,emergencyAt);
  }
  const result=selected.result;
  const candidate={schemaVersion:'0.1',market:input.market,epoch:input.epoch,
    epochStartedAt:input.epochStartedAt,maturityAt:input.maturityAt,
    cutoffAt,mode,eligibleAt:acceptedAt,effectiveCloseAt:input.maturityAt,acceptedAt,emergencyAt,
    queryVersion:input.queryVersion,queryHash:input.queryHash,configVersion:input.configVersion,
    formulaVersion:'h3-d7-q12-v1',anchor:input.anchor,anchorProvenance:input.anchorProvenance,
    outageIncidentId:mode==='RECOVERY'?input.outage.id??null:null,
    outageStartedAt:mode==='RECOVERY'?input.outage.startedAt:null,
    outageRecoveredAt:mode==='RECOVERY'?input.outage.recoveredAt:null,
    outageProvenance:mode==='RECOVERY'?input.outage.provenance:null,
    source:{kind:'HISTORICAL_REPLAY',asOf:acceptedAt,dataThrough:result.candidate.dataThrough,
      activityNowQ12:result.candidate.activityNowQ12,activity7dQ12:result.candidate.activity7dQ12,
      priceAtoms:price(input.anchor,result.candidate.activityNowQ12,result.candidate.activity7dQ12),
      evidenceHash:result.candidate.evidenceHash,usedVersions:result.usedVersions,
      usedVersionsHash:hash(result.usedVersions)}};
  return {state:'READY',candidate,candidateHash:hash(candidate)};
}

// Build from C's persisted observations and original incident, rather than
// letting a keeper invent an outage onset on every retry. The snapshot reader
// is a read-only B/D adapter and is needed only when the 24-hour deadline has
// arrived. This function performs no paid collection or transaction send.
export async function settlementInputFromCollection({store,market,epoch,epochStartedAt,maturityAt,historyStart,now,
  configVersion,anchor,anchorProvenance,readLastVerifiedSnapshot}) {
  check(store?.read && market && second(now) && second(maturityAt));
  const state=await store.read(),entry=state.markets?.[market.address];
  check(entry && Array.isArray(entry.observations) && uint(entry.queryVersion) && hex(entry.queryHash),
    'COLLECTION_MARKET_UNAVAILABLE');
  const incident=selectOutageForEpoch(entry,market.address,{epochStartedAt,maturityAt,now});
  let lastVerifiedSnapshot=null;
  if(incident && now>=incident.startedAt+DAY &&
    (incident.recoveredAt===null || incident.recoveredAt>incident.startedAt+DAY)){
    check(typeof readLastVerifiedSnapshot==='function','SNAPSHOT_READER_REQUIRED');
    lastVerifiedSnapshot=await readLastVerifiedSnapshot({market,incident});
  }
  return {market,epoch,epochStartedAt,maturityAt,historyStart,now,configVersion,anchor,anchorProvenance,
    queryVersion:entry.queryVersion,queryHash:entry.queryHash,
    observations:structuredClone(entry.observations),
    outage:incident?{...structuredClone(incident),lastVerifiedSnapshot}:null};
}

// Single-writer, local durable journal. A chain acceptance adapter must check
// candidateHash and record finalized settlement separately before public use.
export class FileSettlementJournal {
  constructor(path){this.path=path;}
  async read(){try{return JSON.parse(await readFile(this.path,'utf8'));}
    catch(e){if(e.code==='ENOENT')return {settlements:{}};throw e;}}
  async write(state){await mkdir(dirname(this.path),{recursive:true});
    const temp=`${this.path}.${process.pid}.tmp`;
    await writeFile(temp,canonical(state),'utf8');await rename(temp,this.path);}
  async get(market,epoch){const state=await this.read();
    const key=hash({market,epoch});const row=state.settlements[key]??null;
    if(row)check(row.candidateHash===hash(row.candidate),'SETTLEMENT_JOURNAL_CORRUPT');
    return row;}
  async freeze(input){
    validateBase(input);
    const existing=await this.get(input.market,input.epoch);
    if(existing){check(same(existing.identity,identity(input)),'SETTLEMENT_IDENTITY_CHANGED');return existing;}
    const evaluated=await evaluateSettlement(input);
    if(evaluated.state!=='READY')return evaluated;
    const row={state:'FROZEN_LOCAL',frozenAt:input.now,identity:identity(input),candidate:evaluated.candidate,
      candidateHash:evaluated.candidateHash};
    const state=await this.read();const key=hash({market:input.market,epoch:input.epoch});
    check(!state.settlements[key],'SETTLEMENT_RACE');
    state.settlements[key]=row;await this.write(state);return row;
  }
}
