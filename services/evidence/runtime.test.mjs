import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ANTE_UP_PROGRAM_ADDRESS, getCompleteProofInstructionDataDecoder } from '../../clients/chain/dist/index.js';
import { FileRawResponseRepository, ingestCounts, replay, hash, HISTORY_MINUTES } from '../data/index.mjs';
import { FileCandidateRepository } from '../data/publisher.mjs';
import { FileJobRepository, canonical, payloadHash } from './index.mjs';
import { createEvidenceRuntime, createSemanticReaders, projectionReaders } from './runtime.mjs';
import { verifySemanticPacket } from './semantic.mjs';

const start=Math.floor(1_700_000_000/300)*300,end=start+HISTORY_MINUTES*60;
const marketId=ANTE_UP_PROGRAM_ADDRESS, queryHash='a'.repeat(64);
const rows=Array.from({length:HISTORY_MINUTES},(_,i)=>({start:new Date((start+i*60)*1000).toISOString(),
  end:new Date((start+(i+1)*60)*1000).toISOString(),tweet_count:1}));

test('real raw repository to candidate to archived packet; completion reconciles on-chain hash',async()=>{
  const dir=await mkdtemp(join(process.cwd(),'ante-e2e-evidence-'));
  try {
    const rawRepo=new FileRawResponseRepository(join(dir,'raw'));
    const raw={data:rows,meta:{total_tweet_count:HISTORY_MINUTES}},rawHash=await rawRepo.put(raw);
    const observations=ingestCounts(raw,{marketId,queryVersion:'1',queryHash,from:start,through:end,
      historical:true,granularity:'minute',receivedAt:end,validatedAt:end});
    assert.equal(observations[0].rawHash,rawHash);
    const replayInput={observations,marketId,queryVersion:'1',queryHash,start,end,computedAt:end,sequence:'1',configVersion:'2'};
    const calculated=replay(replayInput);
    const published={payload:calculated.candidate,payloadHash:calculated.candidateHash,
      chain:{cluster:'localnet',programId:ANTE_UP_PROGRAM_ADDRESS,address:marketId},
      signature:'sig',slot:'1',publishedAt:end,finality:'finalized'};
    const candidateRepo=new FileCandidateRepository(join(dir,'candidates.json'));
    await candidateRepo.write({jobs:{},snapshots:{[`${marketId}:1`]:{
      market:{address:marketId,logicalId:'fixture',seedHex:'01'.repeat(32),cluster:'localnet',programId:ANTE_UP_PROGRAM_ADDRESS},
      published,replayInput,candidate:calculated.candidate,candidateHash:calculated.candidateHash}}});
    const point={executedAt:end,slot:'1',signature:'sig',snapshot:{marketId,sequence:'1',payloadHash:published.payloadHash},
      h:{numerator:'1',denominator:'1'},unavailableReason:null};
    const record={id:marketId,wallet:'wallet',marketId,direction:'up',entry:point,exit:point,
      status:'CLOSED_RESULT',result:{kind:'return',numerator:'0',denominator:'1'},finality:'finalized',proofId:null};
    let projected=record,proofState={proofComplete:false,proofHash:null},sends=0;
    const projection={records:()=>[projected],snapshots:()=>[published]};
    const readers=projectionReaders(projection,{cluster:'localnet',programId:ANTE_UP_PROGRAM_ADDRESS});
    const jobRepo=new FileJobRepository(join(dir,'jobs.json'));
    const proofChain={readFinalizedProof:async()=>proofState,
      async sendCompleteInstruction({instruction,proofHash}){
        sends++;const decoded=getCompleteProofInstructionDataDecoder().decode(instruction.data);
        assert.equal(Buffer.from(decoded.proofHash).toString('hex'),proofHash);
        return {signature:'complete-sig'};}};
    const signer={address:marketId,signTransactions:async txs=>txs};
    const runtime=await createEvidenceRuntime({jobRepository:jobRepo,candidateRepository:candidateRepo,
      rawRepository:rawRepo,recordReader:readers,snapshotReader:readers,
      turbo:{upload:async()=>{throw new Error('NO_UPLOAD');}},receiptVerifier:async()=>true,
      rpc:{},credential:marketId,schema:marketId,payer:signer,authority:signer,
      sendSasInstruction:async()=>{throw new Error('NO_SAS');},proofAuthority:signer,
      proofChain,programId:ANTE_UP_PROGRAM_ADDRESS,attestationExpiry:Math.floor(Date.now()/1000)+365*86400});
    const job=await runtime.enqueueRecord(record.id);
    assert.equal(job.artifacts.length,2);
    assert(Number.isSafeInteger(job.attestationExpiry));
    assert.equal(hash(raw),rawHash);
    const evidence=job.artifacts.map((a,i)=>({contentHash:a.contentHash,arweaveItemId:`item-${i}`,parentTransactionId:'parent'}));
    const payload={schemaVersion:'0.1',record:job.record,versions:job.versions,evidence,replacesProofId:null};
    const archived=new Map(job.artifacts.map((a,i)=>[`item-${i}`,a.content]));
    assert.equal(typeof runtime.sas.lookupIssue,'function');
    const semantics=createSemanticReaders({recordReader:readers,snapshotReader:readers,candidateRepository:candidateRepo});
    const semantic=await semantics.semanticPacketProvider(job.id,payload);
    assert.equal(await verifySemanticPacket(payload,semantic,semantics.chainVerifier,
      {fetch:async ref=>archived.get(ref.arweaveItemId)}),true);
    archived.set('item-1',canonical({kind:'unrelated'}));
    await assert.rejects(()=>verifySemanticPacket(payload,semantic,semantics.chainVerifier,
      {fetch:async ref=>archived.get(ref.arweaveItemId)}),/CONTENT_MISMATCH/);
    archived.set('item-1',job.artifacts[1].content);
    projected={...record,proofId:job.id};
    const enriched=await runtime.enqueueRecord(record.id);
    assert.equal(enriched.id,job.id); // proofId enrichment does not mutate the frozen payload
    assert.equal(enriched.attestationExpiry,job.attestationExpiry);
    assert.equal((await semantics.semanticPacketProvider(job.id,payload)).payloadHash,payloadHash(payload));
    const jobs=await jobRepo.read();jobs[job.id].state='ISSUED';jobs[job.id].payloadHash=payloadHash(payload);
    await jobRepo.write(jobs);
    const first=await runtime.complete(job.id);
    assert.equal(first.state,'SUBMITTED');assert.equal(sends,1);
    proofState={proofComplete:true,proofHash:payloadHash(payload)};
    const final=await runtime.complete(job.id);
    assert.equal(final.state,'FINALIZED');assert.equal(sends,1);
    proofState={proofComplete:true,proofHash:'0'.repeat(64)};
    await assert.rejects(()=>runtime.complete(job.id),/ONCHAIN_PROOF_CONFLICT/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('both snapshot-null N/A points use finalized market/config provenance',async()=>{
  const dir=await mkdtemp(join(process.cwd(),'ante-na-evidence-'));
  try {
    const absent={executedAt:end,slot:'1',signature:'sig',snapshot:null,h:null,
      unavailableReason:'DATA_NOT_READY'};
    const record={id:'2'.repeat(32),wallet:'wallet',marketId,direction:'up',entry:absent,exit:absent,
      status:'CLOSED_NA',result:{kind:'na',reason:'DATA_NOT_READY'},finality:'finalized',proofId:null};
    const projection={records:()=>[record],snapshots:()=>[]};
    const readers=projectionReaders(projection,{cluster:'localnet',programId:ANTE_UP_PROGRAM_ADDRESS});
    const candidateRepository=new FileCandidateRepository(join(dir,'candidates.json'));
    const jobRepository=new FileJobRepository(join(dir,'jobs.json'));
    let version={source:'finalized-program-accounts',marketId,configAddress:'3'.repeat(32),
      schemaVersion:'0.1',formulaVersion:'h3-d7-q12-v1',configVersion:'2',queryVersion:'1',queryHash};
    const marketVersionReader={getFinalizedVersions:async()=>version};
    const signer={address:marketId,signTransactions:async txs=>txs};
    const runtime=await createEvidenceRuntime({jobRepository,candidateRepository,
      rawRepository:new FileRawResponseRepository(join(dir,'raw')),recordReader:readers,snapshotReader:readers,
      marketVersionReader,turbo:{upload:async()=>{throw new Error('NO_UPLOAD');}},receiptVerifier:async()=>true,
      rpc:{},credential:marketId,schema:marketId,payer:signer,authority:signer,
      sendSasInstruction:async()=>{throw new Error('NO_SAS');},proofAuthority:signer,
      proofChain:{readFinalizedProof:async()=>null,sendCompleteInstruction:async()=>{throw new Error('NO_CHAIN');}},
      programId:ANTE_UP_PROGRAM_ADDRESS,attestationExpiry:Math.floor(Date.now()/1000)+365*86400});
    const job=await runtime.enqueueRecord(record.id);
    assert.equal(job.artifacts.length,2);assert.equal(job.versions.configVersion,'2');
    const evidence=job.artifacts.map((a,i)=>({contentHash:a.contentHash,arweaveItemId:`na-${i}`,parentTransactionId:'parent'}));
    const payload={schemaVersion:'0.1',record:job.record,versions:job.versions,evidence,replacesProofId:null};
    const archived=new Map(job.artifacts.map((a,i)=>[`na-${i}`,a.content]));
    const semantics=createSemanticReaders({recordReader:readers,snapshotReader:readers,
      candidateRepository,marketVersionReader});
    const packet=await semantics.semanticPacketProvider(job.id,payload);
    assert.equal(await verifySemanticPacket(payload,packet,semantics.chainVerifier,
      {fetch:async ref=>archived.get(ref.arweaveItemId)}),true);
    version={...version,queryVersion:'2'};
    await assert.rejects(()=>verifySemanticPacket(payload,packet,semantics.chainVerifier,
      {fetch:async ref=>archived.get(ref.arweaveItemId)}),/CHAIN_NOT_VERIFIED/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
