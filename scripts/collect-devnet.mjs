import {createRequire} from 'node:module';
import {readFile,mkdir,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import * as sdk from '../clients/chain/dist/index.js';
import {FileCollectionState} from '../services/data/live.mjs';
import {runLiveCycle} from '../services/data/cli.mjs';
import {FileCandidateRepository,reconcilePublications} from '../services/data/publisher.mjs';
import {createKitPublisherChain} from '../services/data/kit.mjs';
import {SqliteProjectionStore} from '../services/indexer/src/sqlite.ts';
import {KitFinalizedAccountReader,SqliteEventRepositories} from '../services/indexer/src/repositories.ts';
import {FinalizedPoller} from '../services/indexer/src/poller.ts';
import {KitFinalizedRpc} from '../services/indexer/src/rpc.ts';
import {GeneratedProgramEventDecoder} from '../services/indexer/src/generated-decoder.ts';
import { heartbeat, checkStorage } from './runtime-status.mjs';
import { collectorProjectionDbPath } from './collector-paths.mjs';
import { assertPaidXApproved } from './paid-x-approvals.mjs';
import { GlobalXBudget } from '../services/data/global-budget.mjs';

// Explicit paid-data opt-in. Files stay on the execution host; no secrets in argv.
const required=name=>{if(!process.env[name])throw Error(`MISSING_${name}`);return process.env[name];};
const args=process.argv.slice(2);
if(!args.includes('--execute')||process.env.ANTE_UP_ENABLE_PAID_X!=='yes'||args.some(a=>!['--execute','--initial','--follow'].includes(a)))throw Error('LIVE_EXECUTION_DISABLED');
const kit=createRequire(new URL('../clients/chain/package.json',import.meta.url))('@solana/kit');
let projection,repositories,globalBudget;
let stopping=false;
process.once('SIGTERM',()=>{stopping=true;});
process.once('SIGINT',()=>{stopping=true;});
try{
 const endpoint=(await readFile(required('ANTE_UP_RPC_URL_FILE'),'utf8')).trim();
 const rpc=kit.createSolanaRpc(endpoint);
 if(await rpc.getGenesisHash().send()!=='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')throw Error('DEVNET_REQUIRED');
 const config=JSON.parse(await readFile(required('ANTE_UP_COLLECTION_CONFIG'),'utf8'));
 if(typeof config.logicalId!=='string'||!config.logicalId||typeof config.directory!=='string'||!config.directory||!Number.isSafeInteger(config.historyStart)||config.historyStart%300!==0||!Number.isSafeInteger(config.estimatedCostMicros)||config.estimatedCostMicros<=0||!/^[a-f0-9]{64}$/.test(config.seedHex))throw Error('COLLECTION_CONFIG_INVALID');
 if(config.initialEstimatedCostMicros!==undefined&&(!Number.isSafeInteger(config.initialEstimatedCostMicros)||config.initialEstimatedCostMicros<config.estimatedCostMicros))
  throw Error('COLLECTION_COST_ESTIMATE_INVALID');
 for(const field of ['initialLimitMicros','dailyLimitMicros','totalLimitMicros'])
  if(config[field]!==undefined&&(!Number.isSafeInteger(config[field])||config[field]<(field==='dailyLimitMicros'?config.estimatedCostMicros:(config.initialEstimatedCostMicros??config.estimatedCostMicros))))
   throw Error('COLLECTION_BUDGET_INVALID');
 const healthName=process.env.ANTE_UP_COLLECTOR_HEALTH_NAME??'collector';
 if(!/^collector(?:-[a-z0-9]{1,24})?$/.test(healthName))throw Error('COLLECTOR_HEALTH_NAME_INVALID');
 config.directory=resolve(config.directory);await mkdir(config.directory,{recursive:true});
 const [market]=await sdk.findMarketPda({marketId:Uint8Array.from(Buffer.from(config.seedHex,'hex'))});
 if(market!==config.marketId)throw Error('MARKET_PDA_MISMATCH');
 const {buildQuery}=await import('../services/data/index.mjs');
 const {queryHashFor}=await import('../services/data/live.mjs');
 const approvedMarket={marketId:market,seedHex:config.seedHex,queryHash:queryHashFor(buildQuery(config.expressions)),queryVersion:config.queryVersion};
 const approvalPath=required('ANTE_UP_APPROVED_X_MARKETS_PATH');
 const checkApproval=async()=>assertPaidXApproved(JSON.parse(await readFile(approvalPath,'utf8')),approvedMarket);
 await checkApproval();
 const budgetPath=required('ANTE_UP_GLOBAL_X_BUDGET_DB');
 if(!(await stat(budgetPath).catch(error=>{
   if(error.code==='ENOENT')throw Error('GLOBAL_X_BUDGET_NOT_INITIALIZED');
   throw error;
 })).isFile())throw Error('GLOBAL_X_BUDGET_NOT_INITIALIZED');
 globalBudget=new GlobalXBudget(budgetPath);
 const beforeSourceRequest=({marketId,kind,costMicros,now})=>globalBudget.reserve({
   id:randomUUID(),marketId,kind,costMicros,at:now,
   day:new Date(now*1000).toISOString().slice(0,10)});
 config.token=(await readFile(required('X_BEARER_TOKEN_FILE'),'utf8')).trim();
 const publisher=await kit.createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(await readFile(required('ANTE_UP_PUBLISHER_KEYPAIR_FILE'),'utf8'))));
 const transport=sdk.createKitChainTransport(endpoint),programId=sdk.ANTE_UP_PROGRAM_ADDRESS;
 const scope={cluster:'devnet',programId,address:programId};
 // A market-specific collector journal is separate from the shared finalized
 // projection. Reconciliation must read the indexer's database, not an empty
 // database under this market's collection directory.
 const db=collectorProjectionDbPath(config.directory,process.env);
 const candidatePath=join(config.directory,'candidates.json');
 projection=new SqliteProjectionStore(db);repositories=new SqliteEventRepositories(db,new KitFinalizedAccountReader(endpoint));
 const poller=new FinalizedPoller(projection,new KitFinalizedRpc(endpoint),new GeneratedProgramEventDecoder({snapshots:repositories,proofs:repositories}),100,async key=>{
  try{await repositories.importCandidateFile(candidatePath,key);}catch(e){if(e.code!=='ENOENT')throw e;}
 });
 const chain=createKitPublisherChain({transport,programId,publisherSigner:publisher,feePayer:publisher.address,
  sign:sdk.withKitSigner(publisher),attempts:40,wait:()=>sleep(1500),
  finalizedSnapshots:{async getFinalizedSnapshot(address,sequence){if(process.env.ANTE_UP_EXTERNAL_INDEXER!=='yes')await poller.pollOnce(scope);return projection.snapshots('devnet',programId).find(s=>s.payload.marketId===address&&s.payload.sequence===sequence)??null;}}});
 // Validate the registered query and publisher before spending on a source call.
 const mapped={address:market,logicalId:config.logicalId,seedHex:config.seedHex,cluster:'devnet',programId};
 const context=await chain.readPublishContext(mapped);
 if(context.queryVersion!==config.queryVersion||context.queryHash!==queryHashFor(buildQuery(config.expressions)))throw Error('QUERY_MISMATCH');
 const store=new FileCollectionState(join(config.directory,'collection.json'));
 const publisherRuntime={repository:new FileCandidateRepository(candidatePath),market:mapped,chain,publisherSigner:publisher};
 let initial=args.includes('--initial');
 do{
  await checkStorage(config.directory);
  await reconcilePublications({collectionStore:store,...publisherRuntime});
  const state=await store.read(),stored=state.markets[market],now=Math.floor(Date.now()/1000);
  const retryAt=Math.max(0,...Object.values(state.batches).filter(b=>b.state==='FAILED').map(b=>b.retryAt??0));
  const due=Math.max(stored?.lastPollAt?stored.lastPollAt+300:0,retryAt);
  await heartbeat(healthName,{marketId:market,lastPollAt:stored?.lastPollAt??null,totalSpentMicros:state.totalSpentMicros,nextPollAt:due});
  if(!initial&&now<due){
   if(!args.includes('--follow')){console.log(JSON.stringify({state:'WAITING',nextPollAt:due}));break;}
   await sleep(Math.min(30,due-now)*1000);continue;
  }
  // Do not buy fresh data when the publisher cannot fund the next snapshots.
  if((await rpc.getBalance(publisher.address).send()).value<10_000_000n)throw Error('PUBLISHER_SOL_LOW');
  await checkApproval();
  const result=await runLiveCycle({config,argv:['--execute','--publish',...(initial?['--initial']:[])],now,store,publisherRuntime,beforeSourceRequest});
  console.log(JSON.stringify(result));
  if(result.error==='BUDGET_EXHAUSTED')throw Error('BUDGET_EXHAUSTED');
  initial=false;
  await reconcilePublications({collectionStore:store,...publisherRuntime});
  if(args.includes('--follow'))await sleep(30_000);
 }while(args.includes('--follow')&&!stopping);
}catch(error){
 // Never print SDK provider URLs or token-bearing request context.
 console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'LIVE_COLLECTION_FAILED');process.exitCode=1;
}finally{repositories?.close();projection?.close();globalBudget?.close();}
