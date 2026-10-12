import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readStateJson, writeStateJson } from './state-json.mjs';
import { replay, canonical, hash } from './index.mjs';
import { getAdmissionGateIntent } from './outage.mjs';

const check=(ok,code='INVALID_PUBLISH_INPUT')=>{if(!ok)throw new Error(code);};
const decimal=x=>typeof x==='string' && /^(0|[1-9][0-9]*)$/.test(x);
const hex=x=>typeof x==='string' && /^[a-f0-9]{64}$/.test(x);
const bytes=x=>Uint8Array.from(Buffer.from(x,'hex'));
const enumName=x=>x.toLowerCase().split('_').map(s=>s[0].toUpperCase()+s.slice(1)).join('');

export function sourceInvalidOutageCandidate(input) {
  check(input?.kind==='SOURCE_INVALID_OUTAGE' &&
    Number.isSafeInteger(input.blockedAt) && input.blockedAt>=0 &&
    Number.isSafeInteger(input.computedAt) && input.computedAt>=input.blockedAt &&
    input.provenance?.kind==='INVALID_SOURCE' &&
    input.provenance.reason==='SOURCE_INVALID' &&
    input.provenance.invalidatedAt===input.blockedAt &&
    hex(input.provenance.rawHash) && typeof input.provenance.batchId==='string' &&
    input.provenance.batchId.length>0 &&
    input.incidentId===hash({marketId:input.marketId,startedAt:input.blockedAt,
      provenance:input.provenance}) && hex(input.queryHash) &&
    decimal(input.queryVersion) && decimal(input.configVersion) &&
    decimal(input.sequence) && BigInt(input.sequence)>0n &&
    decimal(input.chainBaseline?.sequence) &&
    BigInt(input.sequence)===BigInt(input.chainBaseline.sequence)+1n &&
    decimal(input.chainBaseline.dataThrough) &&
    Number.isSafeInteger(Number(input.chainBaseline.dataThrough)) &&
    Number(input.chainBaseline.dataThrough)<=input.computedAt &&
    hex(input.chainBaseline.payloadHash),'INVALID_SOURCE_OUTAGE_INPUT');
  const evidenceHash=hash({kind:input.kind,marketId:input.marketId,
    incidentId:input.incidentId,blockedAt:input.blockedAt,
    provenance:input.provenance,chainBaseline:input.chainBaseline});
  const candidate={schemaVersion:'0.1',formulaVersion:'h3-d7-q12-v1',
    configVersion:input.configVersion,queryVersion:input.queryVersion,
    queryHash:input.queryHash,marketId:input.marketId,sequence:input.sequence,
    dataThrough:Number(input.chainBaseline.dataThrough),computedAt:input.computedAt,
    activityNowQ12:null,activity7dQ12:null,dataStatus:'OUTAGE',reason:'DATA_NOT_READY',
    admission:{state:'BLOCKED',recoveryCount:0,reason:'DATA_NOT_READY'},evidenceHash};
  return {candidate,candidateHash:hash(candidate)};
}

// One local writer; the indexer can consume snapshots and immutable replay
// inputs by market PDA + sequence without reading the collection journal.
export class FileCandidateRepository {
  constructor(path){this.path=path;}
  async read(){try{return readStateJson(this.path);}catch(e){if(e.code==='ENOENT')return {jobs:{},snapshots:{}};throw e;}}
  async write(state){writeStateJson(this.path,state);}
  async getPublished(marketAddress,sequence){return (await this.read()).snapshots[`${marketAddress}:${sequence}`]??null;}
  // D's finalized event resolver may need a PREPARED/SUBMITTED candidate
  // before C can observe D's projection. This does not claim publication.
  async getCandidate(marketAddress,sequence,payloadHash){
    const state=await this.read();
    const values=[...Object.values(state.jobs),...Object.values(state.snapshots)];
    const found=values.find(v=>v.market?.address===marketAddress &&
      (v.sequence??v.candidate?.sequence)===sequence && v.candidateHash===payloadHash);
    return found?{market:found.market,candidate:found.candidate,replayInput:found.replayInput,
      candidateHash:found.candidateHash,publicationState:found.state??'FINALIZED'}:null;
  }
}

export async function publishSnapshot({collectionStore,repository,batchId,market,chain,publisherSigner,sdk,reconcileOnly=false}) {
  check(collectionStore && repository && chain && publisherSigner && market &&
    typeof market.address==='string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(market.address) &&
    typeof market.logicalId==='string' && /^[a-f0-9]{64}$/.test(market.seedHex) &&
    ['localnet','devnet'].includes(market.cluster) && typeof market.programId==='string','MARKET_MAPPING_REQUIRED');
  check(typeof chain.readPublishContext==='function' && typeof chain.sendInstruction==='function' &&
    typeof chain.readFinalizedSnapshot==='function','CHAIN_ADAPTER_REQUIRED');
  sdk??=await import('../../clients/chain/dist/index.js');
  const state=await repository.read();
  let job=state.jobs[batchId];
  if (reconcileOnly && !job) throw new Error('UNKNOWN_PUBLICATION_JOB');
  if (!job) {
    const collection=await collectionStore.read(), batch=collection.batches[batchId];
    check(batch?.state==='VALIDATED' && batch.replayInput?.marketId===market.address,'DATA_NOT_READY');
    const context=await chain.readPublishContext(market);
    const {sequence,configVersion,queryVersion,queryHash}=context??{};
    check(decimal(sequence) && BigInt(sequence)>0n && decimal(configVersion) &&
      queryVersion===batch.replayInput.queryVersion && queryHash===batch.replayInput.queryHash,
      'PUBLISH_CONTEXT_MISMATCH');
    const replayInput={...batch.replayInput,sequence,configVersion};
    const computed=replay(replayInput);
    check(computed.candidate.marketId===market.address &&
      canonical((({sequence:_s,...rest})=>rest)(computed.candidate))===
      canonical({...batch.calculation,configVersion}),'CANDIDATE_DRIFT');
    job={id:batchId,state:'PREPARED',market,sequence,candidate:computed.candidate,
      candidateHash:computed.candidateHash,replayInput,signature:null,published:null};
    state.jobs[batchId]=job;await repository.write(state);
  }
  check(job.market.address===market.address && job.market.seedHex===market.seedHex,'MARKET_MAPPING_MISMATCH');
  if (job.state==='FINALIZED') return job.published;
  const finalized=await chain.readFinalizedSnapshot({market,sequence:job.sequence,payloadHash:job.candidateHash,
    signature:job.signature,candidate:job.candidate});
  if (finalized) {
    check(finalized.finality==='finalized' && finalized.payloadHash===job.candidateHash &&
      hash(finalized.payload)===job.candidateHash && finalized.payload.marketId===market.address &&
      finalized.payload.sequence===job.sequence && finalized.chain?.address &&
      finalized.chain.programId===market.programId && finalized.chain.cluster===market.cluster,'FINALITY_MISMATCH');
    job.published=finalized;job.state='FINALIZED';
    state.snapshots[`${market.address}:${job.sequence}`]={market,published:finalized,replayInput:job.replayInput,
      candidate:job.candidate,candidateHash:job.candidateHash};
    await repository.write(state);return finalized;
  }
  if (job.state!=='PREPARED') return {pending:true,sequence:job.sequence,payloadHash:job.candidateHash};
  if (reconcileOnly) return {pending:true,sequence:job.sequence,payloadHash:job.candidateHash};
  const current=await chain.readPublishContext(market);
  check(current?.sequence===job.sequence && current.configVersion===job.candidate.configVersion &&
    current.queryVersion===job.candidate.queryVersion && current.queryHash===job.candidate.queryHash,
    'PUBLISH_CONTEXT_CHANGED');
  if(job.kind==='SOURCE_INVALID_OUTAGE')
    check(current.latestDataThrough===job.replayInput.chainBaseline.dataThrough &&
      current.latestPayloadHash===job.replayInput.chainBaseline.payloadHash,
      'OUTAGE_BASELINE_CHANGED');
  const c=job.candidate;
  const reason=c.admission.reason===null?null:sdk.AdmissionReason[enumName(c.admission.reason)];
  check(reason!==undefined,'INVALID_ADMISSION_REASON');
  const input={market:market.address,publisher:publisherSigner,sequence:BigInt(job.sequence),
    queryHash:bytes(c.queryHash),queryVersion:BigInt(c.queryVersion),configVersion:BigInt(c.configVersion),
    formulaVersion:new Uint8Array([...Buffer.from(c.formulaVersion,'ascii'),...new Uint8Array(16-c.formulaVersion.length)]),
    dataThrough:BigInt(c.dataThrough),activityNowQ12:c.activityNowQ12===null?null:BigInt(c.activityNowQ12),
    activity7dQ12:c.activity7dQ12===null?null:BigInt(c.activity7dQ12),
    dataStatus:sdk.DataStatus[enumName(c.dataStatus)],
    admission:{state:sdk.AdmissionState[enumName(c.admission.state)],recoveryCount:c.admission.recoveryCount,reason},
    evidenceHash:bytes(c.evidenceHash),payloadHash:bytes(job.candidateHash)};
  check(input.dataStatus!==undefined && input.admission.state!==undefined && c.formulaVersion.length<=16,'INVALID_ENUM');
  const instruction=await sdk.getPublishSnapshotInstructionAsync(input,{programAddress:market.programId});
  job.state='REQUESTING';await repository.write(state);
  const submission=await chain.sendInstruction({id:batchId,market,sequence:job.sequence,candidate:job.candidate,
    candidateHash:job.candidateHash,instruction});
  if (submission?.signature) {job.signature=submission.signature;job.state='SUBMITTED';await repository.write(state);}
  return {pending:true,sequence:job.sequence,payloadHash:job.candidateHash,signature:job.signature};
}

// This is a publisher job, not a synthetic Counts observation. It leaves the
// chain's last attested dataThrough in place and clears both price inputs.
export async function publishSourceInvalidOutage({collectionStore,rawRepository,repository,batchId,now,
  market,chain,publisherSigner,sdk}) {
  check(Number.isSafeInteger(now) && now>=0,'OUTAGE_TIME_REQUIRED');
  const collection=await collectionStore.read();
  const stored=collection.markets[market.address];
  const intent=stored && getAdmissionGateIntent(stored,market.address);
  check(intent?.provenance.reason==='SOURCE_INVALID' &&
    intent.provenance.batchId===batchId && hex(intent.provenance.rawHash) &&
    stored.queryVersion && stored.queryHash && now>=intent.blockedAt,
    'SOURCE_INVALID_INCIDENT_REQUIRED');
  check(typeof rawRepository?.get==='function','RAW_REPOSITORY_REQUIRED');
  await rawRepository.get(intent.provenance.rawHash);
  const id=`source-invalid:${intent.incidentId}`;
  const state=await repository.read();
  if(!state.jobs[id]){
    check(!Object.values(state.jobs).some(j=>j.market?.address===market.address &&
      j.state!=='FINALIZED'),'PUBLICATION_PENDING');
    const context=await chain.readPublishContext(market);
    check(decimal(context?.sequence) && BigInt(context.sequence)>0n &&
      decimal(context.configVersion) && context.queryVersion===stored.queryVersion &&
      context.queryHash===stored.queryHash && decimal(context.latestDataThrough) &&
      Number.isSafeInteger(Number(context.latestDataThrough)) &&
      Number(context.latestDataThrough)<=now && hex(context.latestPayloadHash),
      'OUTAGE_PUBLISH_CONTEXT_MISMATCH');
    const chainBaseline={dataThrough:context.latestDataThrough,
      payloadHash:context.latestPayloadHash,sequence:(BigInt(context.sequence)-1n).toString()};
    const replayInput={kind:'SOURCE_INVALID_OUTAGE',marketId:market.address,
      queryVersion:context.queryVersion,queryHash:context.queryHash,
      configVersion:context.configVersion,sequence:context.sequence,computedAt:now,
      incidentId:intent.incidentId,blockedAt:intent.blockedAt,
      provenance:intent.provenance,chainBaseline};
    const {candidate,candidateHash}=sourceInvalidOutageCandidate(replayInput);
    state.jobs[id]={id,kind:'SOURCE_INVALID_OUTAGE',state:'PREPARED',market,
      sequence:context.sequence,candidate,candidateHash,replayInput,
      signature:null,published:null};
    await repository.write(state);
  }
  return publishSnapshot({collectionStore,repository,batchId:id,market,chain,publisherSigner,sdk});
}

// C's read-only bridge for API/keeper fail-closed admission before chain
// finality. Only the finalized B account plus D projection sets FINALIZED.
export async function getSourceInvalidPublicationState({collectionStore,repository,marketAddress}) {
  const collection=await collectionStore.read();
  const stored=collection.markets[marketAddress];
  const intent=stored && getAdmissionGateIntent(stored,marketAddress);
  if(intent?.provenance.reason!=='SOURCE_INVALID')return null;
  const id=`source-invalid:${intent.incidentId}`;
  const job=(await repository.read()).jobs[id]??null;
  if(job){
    check(job.kind==='SOURCE_INVALID_OUTAGE' && job.market?.address===marketAddress &&
      job.replayInput?.incidentId===intent.incidentId &&
      job.replayInput?.provenance?.rawHash===intent.provenance.rawHash &&
      hash(job.candidate)===job.candidateHash,'OUTAGE_PUBLICATION_MISMATCH');
  }
  const finalized=job?.state==='FINALIZED' && job.published?.finality==='finalized' &&
    job.published.payloadHash===job.candidateHash &&
    hash(job.published.payload)===job.candidateHash &&
    job.published.payload?.sequence===job.sequence &&
    job.published.payload?.marketId===marketAddress &&
    job.published.payload?.dataStatus==='OUTAGE' &&
    job.published.chain?.cluster===job.market.cluster &&
    job.published.chain?.programId===job.market.programId;
  return {marketAddress,incidentId:intent.incidentId,rawHash:intent.provenance.rawHash,
    blockedAt:intent.blockedAt,expectedSequence:job?.sequence??null,
    payloadHash:job?.candidateHash??null,
    publicationState:finalized?'FINALIZED':job?'PENDING':'LOCAL_BLOCKED',
    finalizedSignature:finalized?job.published.signature:null};
}

export async function reconcilePublications({collectionStore,repository,market,chain,publisherSigner,sdk}) {
  const state=await repository.read();
  const pending=Object.values(state.jobs).filter(j=>j.market?.address===market.address && j.state!=='FINALIZED');
  let finalized=0;
  for (const job of pending) {
    const result=await publishSnapshot({collectionStore,repository,batchId:job.id,market,chain,publisherSigner,sdk,
      reconcileOnly:true});
    if (result?.finality==='finalized') finalized++;
  }
  const latest=await repository.read();
  return {finalized,unresolved:Object.values(latest.jobs).filter(j=>j.market?.address===market.address &&
    j.state!=='FINALIZED').length};
}
