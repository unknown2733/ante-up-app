/** Synthetic QA minute history for the separate Devnet finance trial only. No transaction is sent. */
import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {HISTORY_MINUTES,hash,replay} from '../services/data/index.mjs';
import {FileSettlementJournal} from '../services/data/settlement.mjs';

const GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
process.umask(0o077);
const fail=code=>{throw new Error(code);};
const json=async path=>JSON.parse(await readFile(path,'utf8'));
async function rpc(endpoint,method,params=[]){
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  if(!response.ok)fail('TRIAL_RPC_UNAVAILABLE');
  const body=await response.json();
  if(body.error)fail('TRIAL_RPC_REJECTED');
  return body.result;
}
function countAt(bucketStart,maturityAt){
  // Baseline 100/day, then 162/day in the last seven days; both are explicit QA inputs.
  const minute=Math.floor((bucketStart%86400)/60);
  const dailyTarget=bucketStart<maturityAt-7*86400?100:162;
  return Math.floor((minute+1)*dailyTarget/1440)-Math.floor(minute*dailyTarget/1440);
}
async function save(path,value){
  const tmp=`${path}.${process.pid}.tmp`;
  await writeFile(tmp,JSON.stringify(value),{mode:0o600});
  await rename(tmp,path);
}
async function main(){
  const mode=process.argv[2],dir=process.env.ANTE_UP_TRIAL_STATE_DIR;
  if(!['prepare','freeze'].includes(mode) || !dir || process.env.ANTE_UP_QA_PROFILE!=='demo' ||
    !process.env.ANTE_UP_RPC_URL_FILE) fail('TRIAL_SETTLEMENT_ARGUMENTS');
  const [scope,qa]=await Promise.all([json(join(dir,'keeper-scope.json')),json(join(dir,'journal.json'))]);
  if(scope.cluster!=='devnet' || scope.epoch!=='1' || qa.synthetic!==true ||
    qa.market!==scope.marketId || qa.programId!==scope.programId) fail('TRIAL_SETTLEMENT_SCOPE_MISMATCH');
  const endpoint=(await readFile(process.env.ANTE_UP_RPC_URL_FILE,'utf8')).trim();
  if(!/^https?:\/\//.test(endpoint) || await rpc(endpoint,'getGenesisHash')!==GENESIS)
    fail('TRIAL_DEVNET_RPC_MISMATCH');
  const graduationSignature=qa.steps?.graduate?.signature;
  if(!graduationSignature || qa.steps.graduate.state!=='FINALIZED')fail('TRIAL_GRADUATION_UNVERIFIED');
  const status=(await rpc(endpoint,'getSignatureStatuses',[[graduationSignature],
    {searchTransactionHistory:true}]))?.value?.[0];
  if(!status || status.err!==null || status.confirmationStatus!=='finalized' ||
    !Number.isSafeInteger(status.slot)) fail('TRIAL_GRADUATION_UNVERIFIED');
  const market={cluster:scope.cluster,programId:scope.programId,address:scope.marketId};
  const now=Math.floor(Date.now()/1000),through=Math.min(scope.maturityAt,Math.floor(now/60)*60);
  const historyStart=scope.maturityAt-HISTORY_MINUTES*60;
  if(through<historyStart || historyStart%60!==0)fail('TRIAL_HISTORY_WINDOW_INVALID');
  const manifest={kind:'SYNTHETIC_QA',generator:'baseline-100-final-week-162-v2',market,
    epoch:scope.epoch,historyStart,maturityAt:scope.maturityAt};
  const rawHash=hash(manifest),dataPath=join(dir,'settlement-observations-v2.json');
  let data;
  try{data=await json(dataPath);}catch(error){
    if(error.code!=='ENOENT')throw error;
    data={schema:'synthetic-trial-minute-v1',manifest,rawHash,through:historyStart,observations:[]};
  }
  if(data.schema!=='synthetic-trial-minute-v1' || hash(data.manifest)!==rawHash ||
    data.rawHash!==rawHash || data.through<historyStart || data.through>through ||
    data.observations.length!==(data.through-historyStart)/60)fail('TRIAL_HISTORY_IDENTITY_MISMATCH');
  for(let i=0;i<data.observations.length;i++){
    const row=data.observations[i],start=historyStart+i*60;
    if(row.marketId!==scope.marketId || row.queryVersion!==scope.queryVersion ||
      row.queryHash!==scope.queryHash || row.bucketStart!==start || row.bucketEnd!==start+60 ||
      row.value?.kind!=='count' || row.value.count!==String(countAt(start,scope.maturityAt)) ||
      row.revision!=='0' || row.rawHash!==rawHash ||
      !Number.isSafeInteger(row.receivedAt) || row.receivedAt<row.bucketEnd ||
      row.receivedAt>now || row.validatedAt!==row.receivedAt)
      fail('TRIAL_HISTORY_ROW_MISMATCH');
  }
  if(mode==='prepare' && now>=scope.maturityAt+900)fail('TRIAL_PREPARE_AFTER_CUTOFF');
  if(mode==='freeze' && data.through!==scope.maturityAt)fail('TRIAL_TIMELY_HISTORY_MISSING');
  for(let bucketStart=data.through;bucketStart<through;bucketStart+=60){
    data.observations.push({marketId:scope.marketId,queryVersion:scope.queryVersion,
      queryHash:scope.queryHash,bucketStart,bucketEnd:bucketStart+60,
      value:{kind:'count',count:String(countAt(bucketStart,scope.maturityAt))},
      receivedAt:now,validatedAt:now,revision:'0',rawHash});
  }
  data.through=through;
  await save(dataPath,data);
  const input={market,epoch:scope.epoch,epochStartedAt:scope.epochStartedAt,
    maturityAt:scope.maturityAt,historyStart,now,queryVersion:scope.queryVersion,
    queryHash:scope.queryHash,configVersion:scope.configVersion,anchor:scope.anchor,
    anchorProvenance:{market,slot:String(status.slot),signature:graduationSignature,finality:'finalized'},
    observations:data.observations,outage:null};
  const preview=replay({observations:data.observations,marketId:scope.marketId,
    queryVersion:scope.queryVersion,queryHash:scope.queryHash,start:historyStart,end:scope.maturityAt,
    computedAt:now,configVersion:scope.configVersion});
  if(preview.candidate.dataThrough!==through)fail('TRIAL_HISTORY_REPLAY_GAP');
  if(mode==='prepare'){
    console.log(JSON.stringify({mode,synthetic:true,epoch:scope.epoch,
      historyStart,preparedThrough:through,remainingMinutes:(scope.maturityAt-through)/60,
      observationCount:data.observations.length,graduationSlot:status.slot,
      previewStatus:preview.candidate.dataStatus}));
    return;
  }
  if(now<scope.maturityAt+900 || through!==scope.maturityAt)
    fail('TRIAL_SETTLEMENT_NOT_DUE');
  const row=await new FileSettlementJournal(join(dir,'settlements.json')).freeze(input);
  if(row.state!=='FROZEN_LOCAL' || row.candidate.mode!=='NORMAL' ||
    row.candidate.source.dataThrough!==scope.maturityAt)fail('TRIAL_SETTLEMENT_NOT_NORMAL');
  console.log(JSON.stringify({mode,synthetic:true,epoch:scope.epoch,state:row.state,
    candidateHash:row.candidateHash,priceAtoms:row.candidate.source.priceAtoms,
    dataThrough:row.candidate.source.dataThrough}));
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
