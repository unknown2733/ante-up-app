import { createHash } from 'node:crypto';
import { getAddressDecoder } from '@solana/kit';
import { canonical, enqueue, processJob } from './index.mjs';
import { calculationArtifact, rawCountsArtifact, marketVersionArtifact } from './semantic.mjs';
import { createTurboClient, createTurboStorageAdapter } from './turbo.mjs';
import { createSasAdapter } from './sas.mjs';

const check=(ok,code='EVIDENCE_RUNTIME_CONFIG')=>{if(!ok)throw new Error(code);};
const chainAddress=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const immutableRecord=record=>({...record,proofId:null});
const same=(a,b)=>canonical(a)===canonical(b);
const hexBytes=hex=>Uint8Array.from(Buffer.from(hex,'hex'));

// SAS layout [12]: one Borsh string, containing canonical JSON claims.
export const encodeAnteUpClaims=claims=>{
  const bytes=Buffer.from(canonical(claims),'utf8'),length=Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);return Buffer.concat([length,bytes]);
};
export function decodeAnteUpClaims(data){
  const bytes=Buffer.from(data);
  check(bytes.length>=4 && bytes.readUInt32LE(0)===bytes.length-4,'SAS_CLAIM_ENCODING');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(4)),value=JSON.parse(text);
  check(canonical(value)===text,'SAS_CLAIM_ENCODING');return value;
}
export const nonceForProofJob=jobId=>getAddressDecoder().decode(
  createHash('sha256').update(`ante-up-sas-v1:${jobId}`,'utf8').digest());

// D's finalized projection store has records(cluster,programId) and snapshots(...).
export function projectionReaders(projection,{cluster,programId}) {
  check(projection && typeof projection.records==='function' && typeof projection.snapshots==='function');
  return {
    async getFinalizedRecord(id){return projection.records(cluster,programId).find(r=>r.id===id && r.finality==='finalized')??null;},
    async getFinalizedSnapshot(marketId,sequence){return projection.snapshots(cluster,programId)
      .find(s=>s.finality==='finalized' && s.payload.marketId===marketId && s.payload.sequence===sequence)??null;}
  };
}

export function createSemanticReaders({recordReader,snapshotReader,candidateRepository,marketVersionReader}) {
  check(typeof recordReader?.getFinalizedRecord==='function' &&
    typeof snapshotReader?.getFinalizedSnapshot==='function' &&
    typeof candidateRepository?.getPublished==='function');
  async function pointsFor(record) {
    const points={};
    for (const name of ['entry','exit']) {
      const ref=record[name]?.snapshot;
      if (!ref) {points[name]={published:null,replayInput:null};continue;}
      const archived=await candidateRepository.getPublished(ref.marketId,ref.sequence);
      check(archived?.published?.finality==='finalized' &&
        archived.published.payloadHash===ref.payloadHash &&
        archived.published.payload.marketId===ref.marketId,'CANDIDATE_NOT_ARCHIVED');
      points[name]={published:archived.published,replayInput:archived.replayInput};
    }
    return points;
  }
  return {
    pointsFor,
    async semanticPacketProvider(_jobId,payload){
      const current=await recordReader.getFinalizedRecord(payload.record.id);
      check(current && same(immutableRecord(current),payload.record),'RECORD_MISMATCH');
      const points=await pointsFor(payload.record);
      const marketVersion=['entry','exit'].every(name=>payload.record[name]?.snapshot===null) ?
        await marketVersionReader?.getFinalizedVersions(payload.record.marketId) : null;
      return {record:payload.record,points,marketVersion,payloadHash:
        createHash('sha256').update(canonical(payload),'utf8').digest('hex')};
    },
    async chainVerifier(record,points,marketVersion){
      const current=await recordReader.getFinalizedRecord(record.id);
      if (!current || !same(immutableRecord(current),record)) return false;
      for (const name of ['entry','exit']) {
        const ref=record[name]?.snapshot;
        if (!ref) continue;
        const chain=await snapshotReader.getFinalizedSnapshot(ref.marketId,ref.sequence);
        if (!chain || !same(chain,points[name].published) || chain.payloadHash!==ref.payloadHash) return false;
      }
      if (['entry','exit'].every(name=>record[name]?.snapshot===null)) {
        const currentVersion=await marketVersionReader?.getFinalizedVersions(record.marketId);
        if (!currentVersion || !same(currentVersion,marketVersion)) return false;
      }
      return true;
    }
  };
}

export async function createEvidenceRuntime({jobRepository,candidateRepository,rawRepository,recordReader,snapshotReader,marketVersionReader,
  turbo,privateKey,receiptVerifier,rpc,credential,schema,payer,authority,sendSasInstruction,
  proofAuthority,proofChain,programId,attestationExpiry,sdk,storageOptions={}}) {
  check(jobRepository && candidateRepository && rawRepository && recordReader && snapshotReader &&
    (turbo || privateKey) && typeof receiptVerifier==='function' && rpc && credential && schema && payer && authority &&
    typeof sendSasInstruction==='function' && proofAuthority && proofChain && programId);
  check(typeof proofChain.readFinalizedProof==='function' && typeof proofChain.sendCompleteInstruction==='function');
  check(Number.isSafeInteger(attestationExpiry) && attestationExpiry>Math.floor(Date.now()/1000),'ATTESTATION_EXPIRY_REQUIRED');
  const storage=createTurboStorageAdapter({...storageOptions,turbo:turbo??await createTurboClient({privateKey}),receiptVerifier});
  const semantics=createSemanticReaders({recordReader,snapshotReader,candidateRepository,marketVersionReader});
  const sas=createSasAdapter({rpc,credential,schema,payer,authority,storage,
    nonceForJob:async id=>nonceForProofJob(id),encodeClaims:encodeAnteUpClaims,decodeClaims:decodeAnteUpClaims,
    sendInstruction:sendSasInstruction,semanticPacketProvider:semantics.semanticPacketProvider,
    chainVerifier:semantics.chainVerifier,expiryAt:async id=>{
      const value=(await jobRepository.read())[id]?.attestationExpiry;
      check(Number.isSafeInteger(value) && value>Math.floor(Date.now()/1000),'ATTESTATION_EXPIRY_INVALID');
      return value;
    },sdk});
  async function enqueueRecord(recordId){
    const current=await recordReader.getFinalizedRecord(recordId);
    check(current?.finality==='finalized' && ['CLOSED_RESULT','CLOSED_NA'].includes(current.status),'RECORD_NOT_FINALIZED');
    check(chainAddress.test(current.id) && chainAddress.test(current.marketId),'CHAIN_ADDRESS_REQUIRED');
    const record=immutableRecord(current), points=await semantics.pointsFor(record);
    const rawHashes=new Set();
    for (const name of ['entry','exit']) {
      for (const o of points[name].replayInput?.observations??[]) rawHashes.add(o.rawHash);
      if(points[name].replayInput?.kind==='SOURCE_INVALID_OUTAGE')
        rawHashes.add(points[name].replayInput.provenance.rawHash);
    }
    const artifacts=[{key:`calculation:${recordId}`,kind:'record',content:calculationArtifact(recordId,points)}];
    for (const rawHash of [...rawHashes].sort()) {
      const raw=await rawRepository.get(rawHash);
      check(createHash('sha256').update(canonical(raw),'utf8').digest('hex')===rawHash,'RAW_HASH_MISMATCH');
      artifacts.push({key:`raw:${rawHash}`,kind:'market',content:rawCountsArtifact(raw)});
    }
    const published=points.exit.published??points.entry.published;
    const marketVersion=published?null:await marketVersionReader?.getFinalizedVersions(record.marketId);
    check(published || marketVersion?.source==='finalized-program-accounts','SNAPSHOT_VERSION_REQUIRED');
    if (marketVersion) artifacts.push({key:`market-version:${recordId}`,kind:'record',
      content:marketVersionArtifact(marketVersion)});
    const versions=published?{schemaVersion:'0.1',formulaVersion:'h3-d7-q12-v1',
      configVersion:published.payload.configVersion,queryVersion:published.payload.queryVersion}:
      {schemaVersion:marketVersion.schemaVersion,formulaVersion:marketVersion.formulaVersion,
        configVersion:marketVersion.configVersion,queryVersion:marketVersion.queryVersion};
    const job=await enqueue(jobRepository,{record,versions,artifacts});
    const jobs=await jobRepository.read();
    if (jobs[job.id].attestationExpiry===undefined) {
      jobs[job.id].attestationExpiry=attestationExpiry;await jobRepository.write(jobs);
    }
    check(jobs[job.id].attestationExpiry===attestationExpiry,'ATTESTATION_EXPIRY_MISMATCH');
    return jobs[job.id];
  }
  async function complete(jobId){
    const jobs=await jobRepository.read(),job=jobs[jobId];
    check(job?.state==='ISSUED' && /^[a-f0-9]{64}$/.test(job.payloadHash),'SAS_NOT_FINALIZED');
    const onChain=await proofChain.readFinalizedProof(job.record.id);
    if (onChain?.proofComplete) {
      check(onChain.proofHash===job.payloadHash,'ONCHAIN_PROOF_CONFLICT');
      job.completion={state:'FINALIZED',signature:job.completion?.signature??null};
      await jobRepository.write(jobs);return job.completion;
    }
    check(job.completion?.state!=='FINALIZED','FINALITY_MISMATCH');
    if (job.completion && job.completion.state!=='PREPARED') return job.completion;
    const chainSdk=await import('../../clients/chain/dist/index.js');
    const instruction=await chainSdk.getCompleteProofInstructionAsync({record:job.record.id,
      proofAuthority,proofHash:hexBytes(job.payloadHash)},{programAddress:programId});
    job.completion={state:'REQUESTING',signature:null};await jobRepository.write(jobs);
    const result=await proofChain.sendCompleteInstruction({jobId,recordId:job.record.id,
      proofHash:job.payloadHash,instruction});
    if (result?.signature){job.completion={state:'SUBMITTED',signature:result.signature};await jobRepository.write(jobs);}
    return job.completion;
  }
  return {storage,sas,enqueueRecord,complete,
    async run(jobId,now=Math.floor(Date.now()/1000)){
      const proof=await processJob(jobRepository,jobId,{...storage,...sas},now);
      return {proof,completion:proof.state==='ISSUED'?await complete(jobId):null};
    }};
}
