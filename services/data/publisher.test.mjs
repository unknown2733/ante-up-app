import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ANTE_UP_PROGRAM_ADDRESS, findMarketPda, getPublishSnapshotInstructionDataDecoder } from '../../clients/chain/dist/index.js';
import { HISTORY_MINUTES, hash } from './index.mjs';
import { FileCollectionState, runInitialArchive, runRegularPoll, runGapFill, queryHashFor } from './live.mjs';
import { FileCandidateRepository, publishSnapshot } from './publisher.mjs';
import { runLiveCycle } from './cli.mjs';

const start=Math.floor(1_700_000_000/300)*300,end=start+HISTORY_MINUTES*60;
const rows=(from,through)=>Array.from({length:(through-from)/60},(_,i)=>({
  start:new Date((from+i*60)*1000).toISOString(),end:new Date((from+(i+1)*60)*1000).toISOString(),tweet_count:1}));

test('paged archive, gap repair, and generated publisher persist exact finalized replay',async()=>{
  const dir=await mkdtemp(join(process.cwd(),'ante-publisher-'));
  try {
    const [address]=await findMarketPda({marketId:new Uint8Array(32).fill(1)});
    const store=new FileCollectionState(join(dir,'collection.json'));
    const repository=new FileCandidateRepository(join(dir,'candidates.json'));
    const market={address,logicalId:'Dubai chocolate',seedHex:'01'.repeat(32),
      cluster:'localnet',programId:ANTE_UP_PROGRAM_ADDRESS};
    const common={store,rawDirectory:join(dir,'raw'),marketId:address,expressions:['Dubai chocolate'],queryVersion:'1',estimatedCostMicros:1000};
    const archiveTransport={async count({paginationToken}){return paginationToken ?
      {data:rows(start+14*86400,end),meta:{total_tweet_count:14*1440}} :
      {data:rows(start,start+14*86400),meta:{next_token:'page-2',total_tweet_count:14*1440}};}};
    const archive=await runInitialArchive({...common,transport:archiveTransport,start,through:end,now:end});
    assert.equal(archive.state,'VALIDATED');assert.equal(archive.pageHashes.length,2);
    assert.equal((await store.read()).totalSpentMicros,2000);
    const poll=await runRegularPoll({...common,transport:{async count(){return {data:rows(end,end+300).filter((_,i)=>i!==1),meta:{}};}},
      historyStart:start,from:end,through:end+300,now:end+300});
    assert.equal(poll.state,'VALIDATED');assert.equal(poll.calculation.dataThrough,end+60);
    const repaired=await runGapFill({...common,transport:{async count(){return {data:rows(end,end+300),meta:{}};}},
      historyStart:start,now:end+600});
    assert.equal(repaired.state,'VALIDATED');assert.equal(repaired.calculation.dataThrough,end+300);
    assert.equal((await store.read()).totalSpentMicros,4000);
    const queryHash=queryHashFor('("Dubai chocolate") lang:en -is:retweet');
    const submitted=new Map();let sends=0,finalityReady=false,paidCalls=0;
    const context={sequence:'1',configVersion:'2',queryVersion:'1',queryHash};
    const chain={readPublishContext:async()=>({...context,sequence:finalityReady?'2':'1'}),
      async sendInstruction({instruction,candidate,candidateHash}){
        sends++;const decoded=getPublishSnapshotInstructionDataDecoder().decode(instruction.data);
        assert.equal(decoded.sequence,BigInt(candidate.sequence));assert.equal(decoded.configVersion,2n);
        assert.equal(Buffer.from(decoded.payloadHash).toString('hex'),candidateHash);
        submitted.set(candidate.sequence,{payload:candidate,payloadHash:candidateHash,chain:{cluster:'localnet',programId:market.programId,
          address:'snapshot-pda'},signature:'sig',slot:'1',publishedAt:end+600,finality:'finalized'});
        return {signature:'sig'};},
      async readFinalizedSnapshot({sequence}){return finalityReady?submitted.get(sequence)??null:null;}};
    const signer={address:market.programId,signTransactions:async txs=>txs};
    const pending=await publishSnapshot({collectionStore:store,repository,batchId:repaired.id,market,chain,publisherSigner:signer});
    assert.equal(pending.pending,true);assert.equal(sends,1);
    assert.equal((await repository.getCandidate(address,'1',pending.payloadHash)).publicationState,'SUBMITTED');
    assert.equal(await repository.getPublished(address,'1'),null);
    const config={directory:dir,marketId:address,expressions:['Dubai chocolate'],queryVersion:'1',
      estimatedCostMicros:1000,historyStart:start,token:'fixture'};
    const publisherRuntime={repository,market,chain,publisherSigner:signer};
    const transport={async count({from,through}){paidCalls++;return {data:rows(from,through),meta:{}};}};
    const blocked=await runLiveCycle({config,argv:['--execute','--publish'],now:end+900,store,transport,publisherRuntime});
    assert.equal(blocked.state,'PUBLICATION_PENDING');
    assert.equal(blocked.collectionState,'VALIDATED');
    assert.equal(blocked.publication.reason,'PRIOR_PUBLICATION_PENDING');
    assert.equal(paidCalls,1);assert.equal(sends,1);
    finalityReady=true;
    const resumed=await runLiveCycle({config,argv:['--execute','--publish'],now:end+1200,store,transport,publisherRuntime});
    assert.equal(resumed.state,'VALIDATED');assert.equal(resumed.publication.pending,true);
    assert.equal(paidCalls,2);assert.equal(sends,2);
    const final=await publishSnapshot({collectionStore:store,repository:new FileCandidateRepository(repository.path),
      batchId:repaired.id,market,chain,publisherSigner:signer});
    assert.equal(final.finality,'finalized');assert.equal(final.payload.configVersion,'2');
    assert.equal(final.payload.marketId,address);assert.equal(sends,2);
    const archived=await repository.getPublished(address,'1');
    assert.equal(hash(archived.candidate),final.payloadHash);
    assert.equal(archived.replayInput.sequence,'1');
  } finally {await rm(dir,{recursive:true,force:true});}
});
