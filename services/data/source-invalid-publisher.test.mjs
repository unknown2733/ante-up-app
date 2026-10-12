import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {ANTE_UP_PROGRAM_ADDRESS,findMarketPda,DataStatus,
  getPublishSnapshotInstructionDataDecoder} from '../../clients/chain/dist/index.js';
import {FileCollectionState,XCountsHttpAdapter,queryHashFor,runRegularPoll} from './live.mjs';
import {FileRawResponseRepository} from './index.mjs';
import {FileCandidateRepository,publishSnapshot,getSourceInvalidPublicationState} from './publisher.mjs';
import {runLiveCycle} from './cli.mjs';
import {hash} from './index.mjs';
import {verifyPublishedSnapshot} from '../indexer/src/snapshot.ts';

test('invalid source uses the real publisher path for an OUTAGE with no invented observation or price',async()=>{
  const directory=await mkdtemp(join(process.cwd(),'ante-source-gate-'));
  try{
    const [address]=await findMarketPda({marketId:new Uint8Array(32).fill(8)});
    const market={address,logicalId:'alpha',seedHex:'08'.repeat(32),
      cluster:'localnet',programId:ANTE_UP_PROGRAM_ADDRESS};
    const store=new FileCollectionState(join(directory,'collection.json'));
    const repository=new FileCandidateRepository(join(directory,'candidates.json'));
    const start=1_700_000_100,end=start+28*86400;
    const queryHash=queryHashFor('(\"alpha\") lang:en -is:retweet');
    await store.write({spentByDay:{},totalSpentMicros:0,batches:{},markets:{[address]:{
      queryHash,queryVersion:'1',observations:[],outageTimeline:[],
      recoveryState:{dataThrough:end,outageStartAt:null,emergencyAt:null,
        admission:{state:'OPEN',recoveryCount:0,reason:null}},lastPollAt:end}}});
    const config={directory,marketId:address,expressions:['alpha'],queryVersion:'1',
      historyStart:start,estimatedCostMicros:1000,token:'fixture'};
    const context={sequence:'7',configVersion:'2',queryVersion:'1',queryHash,
      latestDataThrough:String(end-300),latestPayloadHash:'a'.repeat(64)};
    const signer={address:market.programId,signTransactions:async transactions=>transactions};
    let sends=0,paidCalls=0,finalityReady=false,submitted=null;
    const chain={readPublishContext:async()=>context,
      async sendInstruction({instruction,candidate,candidateHash}){
        sends++;
        const decoded=getPublishSnapshotInstructionDataDecoder().decode(instruction.data);
        assert.equal(decoded.sequence,7n);
        assert.equal(decoded.dataThrough,BigInt(end-300));
        assert.equal(decoded.dataStatus,DataStatus.Outage);
        assert.equal(decoded.activityNowQ12.__option,'None');
        assert.equal(decoded.activity7dQ12.__option,'None');
        submitted={payload:candidate,payloadHash:candidateHash,
          chain:{cluster:'localnet',programId:market.programId,address:'snapshot-pda'},
          signature:'sig-outage',slot:'1',publishedAt:end+300,finality:'finalized'};
        return {signature:'sig-outage'};
      },
      async readFinalizedSnapshot(){return finalityReady?submitted:null;}};
    const publisherRuntime={repository,market,chain,publisherSigner:signer};
    const transport={async count(){paidCalls++;return {data:[{start:new Date(end*1000).toISOString(),
      end:new Date((end+60)*1000).toISOString(),tweet_count:-1}],meta:{}};}};
    const first=await runLiveCycle({config,argv:['--execute','--publish'],now:end+300,
      store,transport,publisherRuntime});
    assert.equal(first.state,'FAILED');assert.equal(first.publication.pending,true);
    assert.equal(paidCalls,1);assert.equal(sends,1);
    const saved=await store.read(),incident=saved.markets[address].outageTimeline[0];
    const job=(await repository.read()).jobs[`source-invalid:${incident.id}`];
    assert.equal(job.kind,'SOURCE_INVALID_OUTAGE');
    assert.equal(job.candidate.dataStatus,'OUTAGE');
    assert.equal(job.candidate.reason,'DATA_NOT_READY');
    assert.equal(job.candidate.dataThrough,end-300);
    assert.equal(job.candidate.activityNowQ12,null);
    assert.equal(job.candidate.activity7dQ12,null);
    assert.equal(job.candidate.admission.state,'BLOCKED');
    assert.equal(job.candidateHash,hash(job.candidate));
    assert.equal(job.replayInput.kind,'SOURCE_INVALID_OUTAGE');
    assert.equal(job.replayInput.provenance.rawHash,saved.batches[first.id].rawHash);
    assert.equal(job.replayInput.observations,undefined);
    assert.equal((await getSourceInvalidPublicationState({collectionStore:store,repository,
      marketAddress:address})).publicationState,'PENDING');
    const pending=await runLiveCycle({config,argv:['--execute','--publish'],now:end+600,
      store,transport,publisherRuntime});
    assert.equal(pending.state,'PUBLICATION_PENDING');assert.equal(paidCalls,1);assert.equal(sends,1);
    finalityReady=true;
    const finalized=await publishSnapshot({collectionStore:store,repository,batchId:job.id,
      ...publisherRuntime});
    assert.equal(finalized.finality,'finalized');assert.equal(sends,1);
    const gate=await getSourceInvalidPublicationState({collectionStore:store,repository,
      marketAddress:address});
    assert.equal(gate.publicationState,'FINALIZED');
    assert.equal(gate.finalizedSignature,'sig-outage');
    assert.equal((await repository.getPublished(address,'7')).candidateHash,job.candidateHash);
    const c=job.candidate;
    const dVerified=verifyPublishedSnapshot({cluster:'localnet',programId:market.programId,
      signature:'sig-outage',slot:'1',marketAddress:address,marketId:address,
      sequence:'7',eventPayloadHash:job.candidateHash,candidate:c,
      account:{address:'snapshot-pda',ownerProgramId:market.programId,marketAddress:address,
        sequence:'7',payloadHash:job.candidateHash,evidenceHash:c.evidenceHash,
        queryHash:c.queryHash,queryVersion:c.queryVersion,configVersion:c.configVersion,
        formulaVersion:c.formulaVersion,dataThrough:c.dataThrough,publishedAt:end+300,
        activityNowQ12:null,activity7dQ12:null,dataStatus:'OUTAGE',admission:c.admission}});
    assert.equal(dVerified.payloadHash,job.candidateHash);
    const recovered=await runLiveCycle({config,argv:['--execute','--publish'],now:end+900,
      store,transport:{async count(){paidCalls++;return {data:Array.from({length:5},(_,i)=>({
        start:new Date((end+i*60)*1000).toISOString(),
        end:new Date((end+(i+1)*60)*1000).toISOString(),tweet_count:1})),meta:{}};}},
      publisherRuntime});
    assert.equal(recovered.state,'VALIDATED');
    assert.equal(recovered.publication.finality,'finalized');
    assert.equal(sends,1); // Partial recovery cannot republish old metrics.
    const rawRepository=new FileRawResponseRepository(join(directory,'raw'));
    const driftRepo=new FileCandidateRepository(join(directory,'drift.json'));
    let reads=0,driftSends=0;
    const driftChain={...chain,
      readPublishContext:async()=>({...context,latestDataThrough:reads++===0?
        context.latestDataThrough:String(end)}),
      sendInstruction:async()=>{driftSends++;return {signature:'drift'};},
      readFinalizedSnapshot:async()=>null};
    const {publishSourceInvalidOutage}=await import('./publisher.mjs');
    await assert.rejects(()=>publishSourceInvalidOutage({collectionStore:store,rawRepository,
      repository:driftRepo,batchId:incident.provenance.batchId,now:end+900,
      market,chain:driftChain,publisherSigner:signer}),/OUTAGE_BASELINE_CHANGED/);
    assert.equal(driftSends,0);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('persisted invalid response publishes before any retry of the paid source',async()=>{
  const directory=await mkdtemp(join(process.cwd(),'ante-source-resume-'));
  try{
    const [address]=await findMarketPda({marketId:new Uint8Array(32).fill(9)});
    const market={address,logicalId:'alpha',seedHex:'09'.repeat(32),
      cluster:'localnet',programId:ANTE_UP_PROGRAM_ADDRESS};
    const store=new FileCollectionState(join(directory,'collection.json'));
    const repository=new FileCandidateRepository(join(directory,'candidates.json'));
    const start=1_700_000_100,end=start+28*86400;
    const queryHash=queryHashFor('(\"alpha\") lang:en -is:retweet');
    await store.write({spentByDay:{},totalSpentMicros:0,batches:{},markets:{[address]:{
      queryHash,queryVersion:'1',observations:[],outageTimeline:[],
      recoveryState:{dataThrough:end,outageStartAt:null,emergencyAt:null,
        admission:{state:'OPEN',recoveryCount:0,reason:null}},lastPollAt:end}}});
    const failed=await runRegularPoll({store,rawDirectory:join(directory,'raw'),marketId:address,
      expressions:['alpha'],queryVersion:'1',historyStart:start,from:end,through:end+300,
      now:end+300,estimatedCostMicros:1000,
      transport:{async count(){return {data:[{start:new Date(end*1000).toISOString(),
        end:new Date((end+60)*1000).toISOString(),tweet_count:-1}],meta:{}};}}});
    assert.equal(failed.state,'FAILED');
    assert.equal((await getSourceInvalidPublicationState({collectionStore:store,repository,
      marketAddress:address})).publicationState,'LOCAL_BLOCKED');
    let paidCalls=0,sends=0;
    const chain={readPublishContext:async()=>({sequence:'1',configVersion:'1',
      queryVersion:'1',queryHash,latestDataThrough:String(end-300),
      latestPayloadHash:'0'.repeat(64)}),
      sendInstruction:async()=>{sends++;return {signature:'sig'};},
      readFinalizedSnapshot:async()=>null};
    const result=await runLiveCycle({config:{directory,marketId:address,expressions:['alpha'],
      queryVersion:'1',historyStart:start,estimatedCostMicros:1000,token:'fixture'},
      argv:['--execute','--publish'],now:end+301,store,
      transport:{async count(){paidCalls++;throw Error('paid source should not run');}},
      publisherRuntime:{repository,market,chain,publisherSigner:{address:market.programId,
        signTransactions:async transactions=>transactions}}});
    assert.equal(result.state,'SOURCE_INVALID_OUTAGE');
    assert.equal(result.publication.pending,true);
    assert.equal(paidCalls,0);assert.equal(sends,1);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('a replay-state error after a valid response does not create a source-invalid incident',async()=>{
  const directory=await mkdtemp(join(process.cwd(),'ante-source-classify-'));
  try{
    const [address]=await findMarketPda({marketId:new Uint8Array(32).fill(10)});
    const store=new FileCollectionState(join(directory,'collection.json'));
    const start=1_700_000_100,end=start+28*86400;
    const queryHash=queryHashFor('(\"alpha\") lang:en -is:retweet');
    await store.write({spentByDay:{},totalSpentMicros:0,batches:{},markets:{[address]:{
      queryHash,queryVersion:'1',observations:[{marketId:address,queryVersion:'wrong',
        queryHash,bucketStart:start,bucketEnd:start+60,value:{kind:'count',count:'1'},
        receivedAt:start+60,validatedAt:start+60,revision:'0',rawHash:'a'.repeat(64)}],
      outageTimeline:[],recoveryState:{dataThrough:end,outageStartAt:null,
        emergencyAt:null,admission:{state:'OPEN',recoveryCount:0,reason:null}},lastPollAt:end}}});
    const result=await runRegularPoll({store,rawDirectory:join(directory,'raw'),marketId:address,
      expressions:['alpha'],queryVersion:'1',historyStart:start,from:end,through:end+300,
      now:end+300,estimatedCostMicros:1000,transport:{async count(){return {data:Array.from(
        {length:5},(_,i)=>({start:new Date((end+i*60)*1000).toISOString(),
          end:new Date((end+(i+1)*60)*1000).toISOString(),tweet_count:1})),meta:{}};}}});
    assert.equal(result.state,'FAILED');
    assert.match(result.error,/VERSION_MISMATCH/);
    const saved=(await store.read()).markets[address];
    assert.deepEqual(saved.outageTimeline,[]);
    assert.equal(saved.recoveryState.admission.state,'OPEN');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('HTTP success with malformed Counts JSON is archived and classified as source invalid',async()=>{
  const directory=await mkdtemp(join(process.cwd(),'ante-source-shape-'));
  try{
    const [address]=await findMarketPda({marketId:new Uint8Array(32).fill(11)});
    const store=new FileCollectionState(join(directory,'collection.json'));
    const start=1_700_000_100,end=start+28*86400;
    const queryHash=queryHashFor('(\"alpha\") lang:en -is:retweet');
    await store.write({spentByDay:{},totalSpentMicros:0,batches:{},markets:{[address]:{
      queryHash,queryVersion:'1',observations:[],outageTimeline:[],
      recoveryState:{dataThrough:end,outageStartAt:null,emergencyAt:null,
        admission:{state:'OPEN',recoveryCount:0,reason:null}},lastPollAt:end}}});
    const transport=new XCountsHttpAdapter({bearerToken:'fixture',fetcher:async()=>({ok:true,
      json:async()=>({data:null,meta:{}})})});
    const result=await runRegularPoll({store,rawDirectory:join(directory,'raw'),transport,
      marketId:address,expressions:['alpha'],queryVersion:'1',historyStart:start,
      from:end,through:end+300,now:end+300,estimatedCostMicros:1000});
    assert.equal(result.state,'FAILED');
    const incident=(await store.read()).markets[address].outageTimeline[0];
    assert.equal(incident.provenance.kind,'INVALID_SOURCE');
    assert.equal(incident.provenance.rawHash,result.rawHash);
    assert.deepEqual(await new FileRawResponseRepository(join(directory,'raw')).get(result.rawHash),
      {data:null,meta:{}});
  }finally{await rm(directory,{recursive:true,force:true});}
});
