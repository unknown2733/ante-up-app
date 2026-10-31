// Read-only Devnet market activation snapshot. No signer, paid source call, or transaction.
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {readFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as chain from '../clients/chain/dist/index.js';
import {KitFinalizedAccountReader} from '../services/indexer/src/repositories.ts';
import {FinalizedFinancialAccounts} from '../services/api/src/financial-chain.ts';
import {candidatePathForDirectory,validatePaidXRegistry} from './paid-x-approvals.mjs';
import {verifyCandidate} from './verify-paid-x-candidate.mjs';
import {buildQuery} from '../services/data/index.mjs';
import {queryHashFor} from '../services/data/live.mjs';
import {DEFAULT_GLOBAL_X_LIMITS} from '../services/data/global-budget.mjs';

const kit=createRequire(new URL('../clients/chain/package.json',import.meta.url))('@solana/kit');
const CORRECT_GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const UNIT=1_000_000n,CURVE_CAP=1_000n*UNIT,MIN_RESERVE=1_100n*UNIT;
const safe=error=>String(error?.message??error).replace(/https?:\/\/[^\s"'<>]+/g,'[RPC_URL_REDACTED]').slice(0,180);

/** The collector's shared X ledger is read without creating or reserving a request. */
export function inspectGlobalBudget(path,{day,costMicros,kind}){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day??'')||
      !Number.isSafeInteger(costMicros)||costMicros<=0||
      !['initial','regular'].includes(kind))throw Error('GLOBAL_X_PREFLIGHT_ARGS_INVALID');
  const db=new DatabaseSync(path,{readOnly:true});
  try{
    const row=db.prepare(`SELECT COALESCE(SUM(estimated_cost_micros),0) total,
      COALESCE(SUM(CASE WHEN day=? THEN estimated_cost_micros ELSE 0 END),0) daily,
      COALESCE(SUM(CASE WHEN kind='initial' THEN estimated_cost_micros ELSE 0 END),0) initial
      FROM x_spend`).get(day);
    if(![row?.total,row?.daily,row?.initial].every(value=>Number.isSafeInteger(value)&&value>=0))
      throw Error('GLOBAL_X_PREFLIGHT_LEDGER_INVALID');
    const limits=DEFAULT_GLOBAL_X_LIMITS;
    const available=row.total+costMicros<=limits.totalLimitMicros&&
      row.daily+costMicros<=limits.dailyLimitMicros&&
      (kind!=='initial'||row.initial+costMicros<=limits.initialLimitMicros);
    return {status:available?'READY':'EXHAUSTED',kind,estimatedCostMicros:costMicros,
      remainingTotalMicros:Math.max(0,limits.totalLimitMicros-row.total),
      remainingDailyMicros:Math.max(0,limits.dailyLimitMicros-row.daily),
      remainingInitialMicros:Math.max(0,limits.initialLimitMicros-row.initial)};
  }finally{db.close();}
}

/** Report the last regular request only; it is evidence of an outcome, not a live X billing read. */
export function lastCollectionRequest(collection,marketId,queryVersion){
  if(!collection||typeof collection!=='object'||!collection.batches||
    typeof collection.batches!=='object'||Array.isArray(collection.batches))
    throw Error('COLLECTION_PREFLIGHT_STATE_INVALID');
  const prefix=`${marketId}:${queryVersion}:`;
  let latest=null,from=-1;
  for(const [id,batch] of Object.entries(collection.batches)){
    if(!id.startsWith(prefix))continue;
    const bucket=id.slice(prefix.length);
    if(!/^(0|[1-9][0-9]*)$/.test(bucket))continue;
    if(!batch||typeof batch!=='object'||batch.id!==id)
      throw Error('COLLECTION_PREFLIGHT_STATE_INVALID');
    const value=Number(bucket);
    if(!Number.isSafeInteger(value)||value<=from)continue;
    latest=batch;from=value;
  }
  if(!latest)return {status:'NO_REGULAR_REQUEST',from:null,retryAt:null};
  const status=latest.state==='FAILED'&&latest.error==='X_SPEND_CAP_REACHED'
    ? 'LAST_SPEND_CAP_FAILURE'
    : latest.state==='VALIDATED'||latest.state==='PREPARING'
      ? 'LAST_ACCEPTED'
      : latest.state==='FAILED'?'LAST_FAILED':'IN_FLIGHT';
  return {status,from,retryAt:latest.state==='FAILED'&&Number.isSafeInteger(latest.retryAt)?latest.retryAt:null};
}

export function collectorReadiness({marketId,market,snapshot,registry,config,candidates,nowSeconds,
  globalBudget={status:'NOT_CHECKED'},lastSourceRequest={status:'NOT_CHECKED'}}) {
  validatePaidXRegistry(registry);
  const approved=registry.markets.find(item=>item.marketId===marketId);
  const legacyBudget=approved && config.initialEstimatedCostMicros===undefined &&
    config.initialLimitMicros===undefined && config.dailyLimitMicros===undefined &&
    config.totalLimitMicros===undefined;
  let verified;
  if(legacyBudget){
    const seedHex=Buffer.from(market.id).toString('hex');
    const queryHash=Buffer.from(market.queryHash).toString('hex');
    if(config.marketId!==marketId || config.seedHex!==seedHex ||
      config.queryVersion!==market.queryVersion.toString() ||
      queryHashFor(buildQuery(config.expressions))!==queryHash ||
      approved.seedHex!==seedHex || approved.queryHash!==queryHash ||
      approved.queryVersion!==config.queryVersion ||
      !Number.isSafeInteger(config.estimatedCostMicros) || config.estimatedCostMicros<=0)
      throw Error('CANDIDATE_ONCHAIN_QUERY_MISMATCH');
    verified={state:'ALREADY_APPROVED',candidatePath:candidatePathForDirectory(config.directory)};
  }else verified=verifyCandidate({marketId,config,market,registry});
  const approvedPathMatches=!!approved &&
    (approved.candidatePath===undefined || approved.candidatePath===verified.candidatePath);
  const entry=candidates?.snapshots?.[`${marketId}:${market.latestSequence}`];
  const published=entry?.published;
  const snapshotHash=snapshot?Buffer.from(snapshot.payloadHash).toString('hex'):null;
  const identityMatched=!!published && published.finality==='finalized' &&
    published.payload?.marketId===marketId &&
    published.payload?.sequence===market.latestSequence.toString() &&
    published.payload?.queryHash===Buffer.from(market.queryHash).toString('hex') &&
    published.payloadHash===snapshotHash &&
    published.payloadHash===Buffer.from(market.latestHash).toString('hex');
  const dataThrough=published?.payload?.dataThrough;
  const fresh=identityMatched && Number.isSafeInteger(dataThrough) &&
    dataThrough<=nowSeconds && nowSeconds-dataThrough<600;
  return {configState:verified.state,budgetMode:legacyBudget?'GLOBAL_LEDGER':'PER_MARKET_AND_GLOBAL',
    globalBudgetPresent:!['MISSING','NOT_CHECKED'].includes(globalBudget.status),
    globalBudget,lastSourceRequest,approved:verified.state==='ALREADY_APPROVED',
    approvedPathMatches,
    candidatePath:verified.candidatePath,latestCandidatePresent:!!entry,
    latestCandidateFinalized:published?.finality==='finalized',
    snapshotIdentityMatched:identityMatched,latestDataFresh:fresh,
    collectorFeedReady:verified.state==='ALREADY_APPROVED' && approvedPathMatches &&
      globalBudget.status==='READY' && fresh &&
      (lastSourceRequest.status==='NOT_CHECKED'||lastSourceRequest.status==='LAST_ACCEPTED')};
}

export async function readActivation({marketId,endpoint,approvalPath,collectionConfigPath,
  globalBudgetPath,nowSeconds=Math.floor(Date.now()/1000)}) {
  if(!kit.isAddress(marketId))throw Error('MARKET_ADDRESS_REQUIRED');
  if(await kit.createSolanaRpc(endpoint).getGenesisHash().send()!==CORRECT_GENESIS)
    throw Error('DEVNET_GENESIS_MISMATCH');
  const state=new FinalizedFinancialAccounts({cluster:'devnet',
    programId:String(chain.ANTE_UP_PROGRAM_ADDRESS),
    accounts:new KitFinalizedAccountReader(endpoint)});
  const [market,finance]=await Promise.all([state.market(marketId),state.financeMarket(marketId)]);
  const latestSequence=market.latestSequence;
  const snapshot=latestSequence>0n?await state.snapshot(marketId,latestSequence):null;
  let paidXApproval='NOT_CHECKED',collection=null;
  if(approvalPath){
    const registry=JSON.parse(await readFile(approvalPath,'utf8'));
    validatePaidXRegistry(registry);
    const entry=registry.markets.find(item=>item.marketId===marketId);
    paidXApproval=entry &&
      entry.seedHex===Buffer.from(market.id).toString('hex') &&
      entry.queryHash===Buffer.from(market.queryHash).toString('hex') &&
      entry.queryVersion===market.queryVersion.toString()?'APPROVED':'NOT_APPROVED';
    if(collectionConfigPath){
      const config=JSON.parse(await readFile(collectionConfigPath,'utf8'));
      const candidatePath=candidatePathForDirectory(config.directory);
      let candidates=null;
      try{candidates=JSON.parse(await readFile(candidatePath,'utf8'));}
      catch(error){if(error?.code!=='ENOENT')throw error;}
      let globalBudget={status:'MISSING'};
      if(globalBudgetPath){
        try{
          if((await stat(globalBudgetPath)).isFile())
            globalBudget=inspectGlobalBudget(globalBudgetPath,{
              day:new Date(nowSeconds*1000).toISOString().slice(0,10),
              costMicros:entry?config.estimatedCostMicros:config.initialEstimatedCostMicros,
              kind:entry?'regular':'initial'});
        }
        catch(error){if(error?.code!=='ENOENT')throw error;}
      }
      let lastSourceRequest={status:'MISSING',from:null,retryAt:null};
      try{
        const state=JSON.parse(await readFile(`${config.directory}/collection.json`,'utf8'));
        lastSourceRequest=lastCollectionRequest(state,marketId,config.queryVersion);
      }catch(error){if(error?.code!=='ENOENT')throw error;}
      collection=collectorReadiness({marketId,market,snapshot,registry,config,candidates,
        globalBudget,lastSourceRequest,nowSeconds});
    }
  }
  const sold=finance.curveSold,reserve=finance.curveReserve;
  return {
    marketId,cluster:'devnet',readOnly:true,
    phase:chain.MarketPhase[market.phase],dataStatus:chain.DataStatus[market.dataStatus],
    admission:chain.AdmissionState[market.admission.state],
    paidXApproval,collection,latestSequence:latestSequence.toString(),snapshotPresent:!!snapshot,
    curveSoldAtoms:sold.toString(),curveRemainingAtoms:(sold<CURVE_CAP?CURVE_CAP-sold:0n).toString(),
    curveReserveAtoms:reserve.toString(),
    reserveShortfallAtoms:(reserve<MIN_RESERVE?MIN_RESERVE-reserve:0n).toString(),
    preliminaryGraduationGate:{
      curveComplete:sold===CURVE_CAP&&reserve>=MIN_RESERVE,
      observationPublished:latestSequence>0n&&!!snapshot,
      dataOpen:market.dataStatus===chain.DataStatus.Valid &&
        market.admission.state===chain.AdmissionState.Open,
      paidXApproved:paidXApproval==='APPROVED'
    },
    note:'The X ledger covers internal reservations. The last saved source outcome is not a current billing-console reading. A complete graduation plan still requires separate checks.'
  };
}

async function main(){
  const [marketId]=process.argv.slice(2);
  if(process.argv.length!==3||!process.env.ANTE_UP_RPC_URL_FILE)
    throw Error('MARKET_PREFLIGHT_ARGS_INVALID');
  const endpoint=(await readFile(process.env.ANTE_UP_RPC_URL_FILE,'utf8')).trim();
  const report=await readActivation({marketId,endpoint,
    approvalPath:process.env.ANTE_UP_APPROVED_X_MARKETS_PATH,
    collectionConfigPath:process.env.ANTE_UP_COLLECTION_CONFIG,
    globalBudgetPath:process.env.ANTE_UP_GLOBAL_X_BUDGET_DB});
  console.log(JSON.stringify(report));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(error=>{console.error(safe(error));process.exitCode=1;});
