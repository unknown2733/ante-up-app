import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FileCollectionState, XCountsHttpAdapter, runInitialArchive, runRegularPoll, runGapFill } from './live.mjs';
import { FileCandidateRepository, publishSnapshot, publishSourceInvalidOutage,
  reconcilePublications } from './publisher.mjs';
import { getAdmissionGateIntent } from './outage.mjs';
import { FileRawResponseRepository } from './index.mjs';
import { createKitPublisherChain } from './kit.mjs';

export function requiredLiveConfig(env,argv) {
  if (!argv.includes('--execute') || env.ANTE_UP_ENABLE_PAID_X !== 'yes') throw new Error('LIVE_X_DISABLED');
  const fields=['X_BEARER_TOKEN','ANTE_UP_COLLECTION_DIR','ANTE_UP_MARKET_ID','ANTE_UP_EXPRESSIONS_JSON',
    'ANTE_UP_QUERY_VERSION','ANTE_UP_HISTORY_START','ANTE_UP_X_ESTIMATED_COST_MICROS'];
  for (const name of fields) if (!env[name]) throw new Error(`MISSING_${name}`);
  const estimatedCostMicros=Number(env.ANTE_UP_X_ESTIMATED_COST_MICROS);
  if (!Number.isSafeInteger(estimatedCostMicros) || estimatedCostMicros<=0) throw new Error('INVALID_COST_ESTIMATE');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(env.ANTE_UP_MARKET_ID)) throw new Error('MARKET_PDA_REQUIRED');
  return {directory:env.ANTE_UP_COLLECTION_DIR,marketId:env.ANTE_UP_MARKET_ID,
    expressions:JSON.parse(env.ANTE_UP_EXPRESSIONS_JSON),queryVersion:env.ANTE_UP_QUERY_VERSION,
    historyStart:Number(env.ANTE_UP_HISTORY_START),estimatedCostMicros,token:env.X_BEARER_TOKEN};
}

export async function runLiveCycle({config,argv,now,store,transport,publisherRuntime=null}) {
  store??=new FileCollectionState(join(config.directory,'collection.json'));
  transport??=new XCountsHttpAdapter({bearerToken:config.token});
  if (argv.includes('--publish')) {
    if (!publisherRuntime) throw new Error('PUBLISH_RUNTIME_REQUIRED');
    const reconciliation=await reconcilePublications({collectionStore:store,...publisherRuntime});
    if (reconciliation.unresolved) return {state:'PUBLICATION_PENDING',reconciliation};
    const stored=(await store.read()).markets[config.marketId];
    const intent=stored && getAdmissionGateIntent(stored,config.marketId);
    if(intent?.provenance.reason==='SOURCE_INVALID'){
      const id=`source-invalid:${intent.incidentId}`;
      if(!(await publisherRuntime.repository.read()).jobs[id]){
        const publication=await publishSourceInvalidOutage({collectionStore:store,
          rawRepository:new FileRawResponseRepository(join(config.directory,'raw')),
          batchId:intent.provenance.batchId,now,...publisherRuntime});
        return {id,state:'SOURCE_INVALID_OUTAGE',error:null,publication};
      }
    }
  }
  const common={store,rawDirectory:join(config.directory,'raw'),transport,
    marketId:config.marketId,expressions:config.expressions,queryVersion:config.queryVersion,
    estimatedCostMicros:config.estimatedCostMicros};
  const latestComplete=Math.floor(now/300)*300;
  const market=(await store.read()).markets[config.marketId];
  const from=market?.recoveryState?.dataThrough ?? latestComplete-300;
  if (!argv.includes('--initial') && latestComplete-from>7*86400) throw new Error('HISTORY_OUT_OF_RECENT_RANGE');
  const hasGap=market && market.observations.some(o=>o.bucketEnd>from);
  const result=argv.includes('--initial') ? await runInitialArchive({...common,start:config.historyStart,
    through:config.historyStart+28*86400,now}) : hasGap ? await runGapFill({...common,historyStart:config.historyStart,now}) :
    // A delayed worker must catch up to the latest complete boundary. Advancing
    // only five minutes per five-minute poll would preserve an outage forever.
    // This remains ONE recovery observation, regardless of the range fetched.
    await runRegularPoll({...common,historyStart:config.historyStart,from,through:latestComplete,now});
  let publication=null;
  if (argv.includes('--publish')) {
    const current=(await store.read()).markets[config.marketId];
    const intent=current && getAdmissionGateIntent(current,config.marketId);
    if(intent?.provenance.reason==='SOURCE_INVALID')
      publication=await publishSourceInvalidOutage({collectionStore:store,
        rawRepository:new FileRawResponseRepository(join(config.directory,'raw')),
        batchId:intent.provenance.batchId,now,...publisherRuntime});
    else if(result.state==='VALIDATED')
      publication=await publishSnapshot({collectionStore:store,batchId:result.id,...publisherRuntime});
    else throw new Error('DATA_NOT_READY');
  }
  return {id:result.id,state:result.state,error:result.error??null,publication};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  try {
    const config=requiredLiveConfig(process.env,process.argv.slice(2));
    const now=Math.floor(Date.now()/1000), store=new FileCollectionState(join(config.directory,'collection.json'));
    let publisherRuntime=null;
    if (process.argv.includes('--publish')) {
      for (const name of ['ANTE_UP_CANDIDATE_FILE','ANTE_UP_PUBLISH_RUNTIME_MODULE','ANTE_UP_LOGICAL_MARKET_ID','ANTE_UP_MARKET_SEED_HEX'])
        if (!process.env[name]) throw new Error(`MISSING_${name}`);
      const runtime=await import(pathToFileURL(resolve(process.env.ANTE_UP_PUBLISH_RUNTIME_MODULE)).href);
      const chainSdk=await import('../../clients/chain/dist/index.js');
      const transport=runtime.transport??chainSdk.createKitChainTransport(runtime.endpoint);
      const finalSnapshots=runtime.finalizedSnapshots??{
        getFinalizedSnapshot:async (marketId,sequence)=>runtime.projection?.snapshots(runtime.cluster,runtime.programId)
          .find(s=>s.payload.marketId===marketId && s.payload.sequence===sequence)??null};
      const chain=createKitPublisherChain({transport,programId:runtime.programId,
        publisherSigner:runtime.publisherSigner,feePayer:runtime.feePayer??runtime.publisherSigner.address,
        sign:runtime.sign??chainSdk.withKitSigner(runtime.publisherSigner),finalizedSnapshots:finalSnapshots});
      publisherRuntime={
        repository:new FileCandidateRepository(process.env.ANTE_UP_CANDIDATE_FILE),
        market:{address:config.marketId,logicalId:process.env.ANTE_UP_LOGICAL_MARKET_ID,
          seedHex:process.env.ANTE_UP_MARKET_SEED_HEX,cluster:runtime.cluster,programId:runtime.programId},
        chain,publisherSigner:runtime.publisherSigner};
    }
    const result=await runLiveCycle({config,argv:process.argv.slice(2),now,store,publisherRuntime});
    process.stdout.write(JSON.stringify(result)+'\n');
  } catch(e) { process.stderr.write(String(e.message??e)+'\n'); process.exitCode=1; }
}
