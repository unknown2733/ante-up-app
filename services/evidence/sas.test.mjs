import test from 'node:test';
import assert from 'node:assert/strict';
import * as sas from 'sas-lib';
import { replay, hash } from '../data/index.mjs';
import { sourceInvalidOutageCandidate } from '../data/publisher.mjs';
import { canonical, payloadHash } from './index.mjs';
import { verifySemanticPacket, calculationArtifact, rawCountsArtifact } from './semantic.mjs';
import { createSasAdapter } from './sas.mjs';

const start=Math.floor(1_700_000_000/60)*60, n=28*1440, end=start+n*60;
const marketId='fixture:proof',queryVersion='1',queryHash='a'.repeat(64);
const raw={data:[{start:new Date(start*1000).toISOString(),tweet_count:1}],meta:{total_tweet_count:1}};
const sourceRawHash=hash(raw);
const observations=Array.from({length:n},(_,i)=>({marketId,queryVersion,queryHash,bucketStart:start+i*60,
  bucketEnd:start+(i+1)*60,value:{kind:'count',count:'1'},receivedAt:start+(i+1)*60,
  validatedAt:start+(i+1)*60,revision:'0',rawHash:sourceRawHash}));
const replayInput={observations,marketId,queryVersion,queryHash,start,end,computedAt:end,sequence:'1'};
let cache;
function fixture() {
  if (cache) return cache;
  const calculated=replay(replayInput), published={payload:calculated.candidate,payloadHash:calculated.candidateHash,
    chain:{cluster:'localnet',programId:'P',address:'M'},signature:'sig',slot:'1',publishedAt:end,finality:'finalized'};
  const point={executedAt:end,slot:'1',signature:'sig',snapshot:{marketId,sequence:'1',payloadHash:published.payloadHash},
    h:{numerator:'1',denominator:'1'},unavailableReason:null};
  const record={id:'r1',wallet:'wallet',marketId,direction:'up',entry:point,exit:point,
    status:'CLOSED_RESULT',result:{kind:'return',numerator:'0',denominator:'1'},finality:'finalized',proofId:null};
  const points={entry:{published,replayInput},exit:{published,replayInput}};
  const archived=new Map([['raw',rawCountsArtifact(raw)],['calculation',calculationArtifact(record.id,points)]]);
  const evidence=[...archived].map(([id,content])=>({contentHash:hash(JSON.parse(content)),arweaveItemId:id,parentTransactionId:'parent'}));
  const payload={schemaVersion:'0.1',record,versions:{schemaVersion:'0.1',formulaVersion:'h3-d7-q12-v1',configVersion:'1',queryVersion},
    evidence,replacesProofId:null};
  const packet={record,points,payloadHash:payloadHash(payload)};
  const storage={fetch:async ref=>archived.get(ref.arweaveItemId)};
  return cache={payload,packet,storage,archived};
}

test('semantic gate ties finalized record, published candidate, query and replayed h',async()=>{
  const {payload,packet,storage}=fixture();
  assert.equal(await verifySemanticPacket(payload,packet,async()=>true,storage),true);
  await assert.rejects(()=>verifySemanticPacket(payload,packet,async()=>false,storage),/CHAIN_NOT_VERIFIED/);
  const altered=structuredClone(payload); altered.record.entry.h.numerator='2';
  await assert.rejects(()=>verifySemanticPacket(altered,{...packet,record:altered.record,payloadHash:payloadHash(altered)},async()=>true,storage),/INVALID_EVIDENCE/);
});

test('unrelated archived artifacts cannot authorize a valid semantic packet',async()=>{
  const {payload,packet,storage,archived}=fixture();
  const forged=structuredClone(payload), unrelated=canonical({kind:'calculation',schemaVersion:'0.1',recordId:'unrelated',points:{}});
  archived.set('unrelated',unrelated);
  forged.evidence=[{contentHash:hash(JSON.parse(unrelated)),arweaveItemId:'unrelated',parentTransactionId:'parent'}];
  await assert.rejects(()=>verifySemanticPacket(forged,{...packet,payloadHash:payloadHash(forged)},async()=>true,storage),/INVALID_EVIDENCE/);
  const rawOnly=structuredClone(payload); rawOnly.evidence=payload.evidence.filter(r=>r.arweaveItemId==='calculation');
  await assert.rejects(()=>verifySemanticPacket(rawOnly,{...packet,payloadHash:payloadHash(rawOnly)},async()=>true,storage),/RAW_EVIDENCE_MISSING/);
  const wrongRaw=canonical({kind:'x-counts-raw',schemaVersion:'0.1',rawHash:'0'.repeat(64),raw});
  archived.set('wrong-raw',wrongRaw);
  const inconsistent=structuredClone(payload);
  inconsistent.evidence[0]={contentHash:hash(JSON.parse(wrongRaw)),arweaveItemId:'wrong-raw',parentTransactionId:'parent'};
  await assert.rejects(()=>verifySemanticPacket(inconsistent,{...packet,payloadHash:payloadHash(inconsistent)},async()=>true,storage),/INVALID_EVIDENCE/);
});

test('source-invalid OUTAGE proof binds raw response and has no invented price inputs',async()=>{
  const provenance={kind:'INVALID_SOURCE',invalidatedAt:end,reason:'SOURCE_INVALID',
    rawHash:sourceRawHash,batchId:'invalid-batch'};
  const marker={kind:'SOURCE_INVALID_OUTAGE',marketId,queryVersion,queryHash,
    configVersion:'1',sequence:'1',computedAt:end,blockedAt:end,
    incidentId:hash({marketId,startedAt:end,provenance}),provenance,
    chainBaseline:{sequence:'0',dataThrough:String(end-300),payloadHash:'0'.repeat(64)}};
  const {candidate,candidateHash}=sourceInvalidOutageCandidate(marker);
  const published={payload:candidate,payloadHash:candidateHash,
    chain:{cluster:'localnet',programId:'P',address:'M'},signature:'sig',slot:'1',
    publishedAt:end,finality:'finalized'};
  const point={executedAt:end,slot:'1',signature:'sig',
    snapshot:{marketId,sequence:'1',payloadHash:candidateHash},h:null,
    unavailableReason:'DATA_UNAVAILABLE'};
  const record={id:'outage-record',wallet:'wallet',marketId,direction:'up',entry:point,exit:point,
    status:'CLOSED_NA',result:{kind:'na',reason:'DATA_UNAVAILABLE'},finality:'finalized',proofId:null};
  const points={entry:{published,replayInput:marker},exit:{published,replayInput:marker}};
  const archived=new Map([['raw',rawCountsArtifact(raw)],
    ['calculation',calculationArtifact(record.id,points)]]);
  const evidence=[...archived].map(([id,content])=>({contentHash:hash(JSON.parse(content)),
    arweaveItemId:id,parentTransactionId:'parent'}));
  const payload={schemaVersion:'0.1',record,
    versions:{schemaVersion:'0.1',formulaVersion:'h3-d7-q12-v1',configVersion:'1',queryVersion},
    evidence,replacesProofId:null};
  const packet={record,points,payloadHash:payloadHash(payload)};
  assert.equal(await verifySemanticPacket(payload,packet,async()=>true,
    {fetch:async ref=>archived.get(ref.arweaveItemId)}),true);
  const withoutRaw={...payload,evidence:evidence.filter(e=>e.arweaveItemId!=='raw')};
  await assert.rejects(()=>verifySemanticPacket(withoutRaw,
    {...packet,payloadHash:payloadHash(withoutRaw)},async()=>true,
    {fetch:async ref=>archived.get(ref.arweaveItemId)}),/RAW_EVIDENCE_MISSING/);
});

test('SAS adapter checks semantic packet and archived manifest before SDK issue or finalized lookup',async()=>{
  const {payload,packet,archived}=fixture(), bytes=canonical(payload), digest=hash(payload);
  const manifestRef={contentHash:digest,arweaveItemId:'manifest',parentTransactionId:'parent'};
  archived.set('manifest',bytes);
  let account={exists:false,address:'attestation-address'},sends=0,semanticCalls=0,archiveReads=0,suppliedPacket=packet;
  const sdk={
    async deriveAttestationPda(){return ['attestation-address',1];},
    async fetchMaybeAttestation(){return account;},
    getCreateAttestationInstruction(input){assert.equal(input.data.length>0,true);return {input};}
  };
  const encodeClaims=claims=>new TextEncoder().encode(canonical(claims));
  const decodeClaims=data=>JSON.parse(new TextDecoder().decode(data));
  const adapter=createSasAdapter({rpc:{},credential:'credential',schema:'schema',payer:{address:'payer'},authority:{address:'issuer'},
    nonceForJob:async()=> 'nonce',encodeClaims,decodeClaims,
    sendInstruction:async ({instruction})=>{sends++;account={exists:true,address:'attestation-address',
      programAddress:sas.SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS,
      data:{credential:'credential',schema:'schema',signer:'issuer',data:instruction.input.data,
        expiry:BigInt(Math.floor(Date.now()/1000)+3600)}};return {finalized:true};},
    semanticPacketProvider:async()=>{semanticCalls++;return suppliedPacket;},chainVerifier:async()=>true,
    storage:{fetch:async ref=>{archiveReads++;return archived.get(ref.arweaveItemId);}},expiryAt:async()=>Math.floor(Date.now()/1000)+3600,sdk});
  const first=await adapter.issue('proof:r1:original',digest,manifestRef,payload);
  assert.deepEqual(first,{sasId:'attestation-address',finalized:true}); assert.equal(sends,1);
  assert.deepEqual(await adapter.issue('proof:r1:original',digest,manifestRef,payload),first);
  assert.equal(sends,1); assert.equal(semanticCalls,1);
  assert.equal(archiveReads,payload.evidence.length+1);
  await assert.rejects(()=>adapter.issue('proof:r1:original','0'.repeat(64),manifestRef,payload),/INVALID_EVIDENCE/);
  const forged=structuredClone(payload), unrelated=canonical({kind:'note',text:'unrelated'});
  archived.set('unrelated',unrelated);
  forged.evidence=[{contentHash:hash(JSON.parse(unrelated)),arweaveItemId:'unrelated',parentTransactionId:'parent'}];
  const forgedHash=payloadHash(forged);
  archived.set('forged-manifest',canonical(forged)); suppliedPacket={...packet,payloadHash:forgedHash};
  await assert.rejects(()=>adapter.issue('proof:r1:original',forgedHash,
    {contentHash:forgedHash,arweaveItemId:'forged-manifest',parentTransactionId:'parent'},forged),/INVALID_EVIDENCE/);
  await assert.rejects(()=>adapter.lookupIssue('proof:r1:original',forgedHash,
    {contentHash:forgedHash,arweaveItemId:'forged-manifest',parentTransactionId:'parent'},forged),/INVALID_EVIDENCE/);
  assert.equal(sends,1);
});

test('installed sas-lib 1.0.10 encodes the official create-attestation instruction',()=>{
  assert.deepEqual(sas.decodeAttestation({exists:false,address:'missing-address'}),
    {exists:false,address:'missing-address'});
  const address='11111111111111111111111111111111';
  const signer={address,signTransactions:async txs=>txs};
  const bytes=new TextEncoder().encode('{"payloadHash":"abc"}');
  const instruction=sas.getCreateAttestationInstruction({payer:signer,authority:signer,credential:address,
    schema:address,attestation:address,nonce:address,data:bytes,expiry:2_000_000_000});
  const decoded=sas.getCreateAttestationInstructionDataDecoder().decode(instruction.data);
  assert.equal(decoded.nonce,address); assert.deepEqual(Buffer.from(decoded.data),Buffer.from(bytes));
});
