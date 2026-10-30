/** Prepare or freeze an observed X Counts maturity candidate. Never signs. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FileCollectionState} from '../services/data/live.mjs';
import {FileCandidateRepository} from '../services/data/publisher.mjs';
import {readEmergencySnapshot} from '../services/data/emergency-snapshot.mjs';
import {FileSettlementJournal,evaluateSettlement,settlementInputFromCollection}
  from '../services/data/settlement.mjs';
import {HISTORY_MINUTES} from '../services/data/index.mjs';
import {createKitChainTransport,readFinalizedSnapshot} from '../clients/chain/dist/index.js';

const GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PROGRAM='FrMATpA81wUMYsZufQkew9K5MW2AC8rgdYQ2wUM6KDKr';
const address=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const signature=/^[1-9A-HJ-NP-Za-km-z]{87,88}$/;
const hex=/^[0-9a-f]{64}$/;
const print=value=>console.log(JSON.stringify(value));

async function rpc(endpoint,method,params=[]){
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)});
  assert.ok(response.ok,'OBSERVED_RPC_HTTP_ERROR');
  const value=await response.json();
  assert.ok(!value.error,'OBSERVED_RPC_REJECTED');
  return value.result;
}

export function validateObservedScope(scope,config){
  assert.equal(scope.cluster,'devnet');
  assert.equal(scope.programId,PROGRAM);
  assert.equal(scope.marketId,config.marketId);
  assert.equal(scope.epoch,config.epoch);
  assert.equal(scope.maturityAt,config.maturityAt);
  assert.ok(address.test(scope.marketId)&&signature.test(config.graduationSignature));
  assert.ok(hex.test(scope.queryHash)&&/^\d+$/.test(scope.queryVersion));
  assert.ok(Number.isSafeInteger(scope.epochStartedAt)&&scope.epochStartedAt<scope.maturityAt);
  assert.ok(config.source==='X_COUNTS'&&config.synthetic===false,'OBSERVED_SOURCE_REQUIRED');
  assert.ok(typeof config.collectionPath==='string'&&config.collectionPath.startsWith('/state/'));
  return true;
}

async function main(){
  const [mode,stateDirectory,configPath]=process.argv.slice(2);
  assert.ok(['prepare','freeze'].includes(mode)&&stateDirectory&&configPath,'OBSERVED_SETTLEMENT_ARGS');
  assert.ok(process.env.ANTE_UP_RPC_URL_FILE,'OBSERVED_RPC_FILE_REQUIRED');
  const dir=resolve(stateDirectory);
  const [scope,config,endpoint]=await Promise.all([
    readFile(join(dir,'keeper-scope.json'),'utf8').then(JSON.parse),
    readFile(configPath,'utf8').then(JSON.parse),
    readFile(process.env.ANTE_UP_RPC_URL_FILE,'utf8').then(s=>s.trim())]);
  validateObservedScope(scope,config);
  assert.ok(/^https:\/\//.test(endpoint),'OBSERVED_RPC_URL_INVALID');
  assert.equal(await rpc(endpoint,'getGenesisHash'),GENESIS,'OBSERVED_DEVNET_MISMATCH');
  const status=(await rpc(endpoint,'getSignatureStatuses',[[config.graduationSignature],
    {searchTransactionHistory:true}]))?.value?.[0];
  assert.ok(status?.err===null&&status.confirmationStatus==='finalized'&&
    Number.isSafeInteger(status.slot),'OBSERVED_GRADUATION_UNVERIFIED');
  const collection=new FileCollectionState(config.collectionPath);
  const market={cluster:'devnet',programId:PROGRAM,address:scope.marketId};
  const candidates=new FileCandidateRepository(join(dirname(config.collectionPath),'candidates.json'));
  const input=await settlementInputFromCollection({store:collection,market,
    epoch:scope.epoch,epochStartedAt:scope.epochStartedAt,maturityAt:scope.maturityAt,
    historyStart:scope.maturityAt-HISTORY_MINUTES*60,now:Math.floor(Date.now()/1000),
    configVersion:scope.configVersion,anchor:scope.anchor,
    anchorProvenance:{market,slot:String(status.slot),signature:config.graduationSignature,
      finality:'finalized'},
    readLastVerifiedSnapshot:async({incident})=>readEmergencySnapshot({repository:candidates,
      market,incident,
      readAccount:(address,sequence,programId)=>readFinalizedSnapshot(
        createKitChainTransport(endpoint),address,sequence,programId),
      readSignatureStatus:signature=>rpc(endpoint,'getSignatureStatuses',[[signature],
        {searchTransactionHistory:true}]).then(result=>result?.value?.[0])})});
  assert.equal(input.queryHash,scope.queryHash,'OBSERVED_QUERY_HASH_MISMATCH');
  assert.equal(input.queryVersion,scope.queryVersion,'OBSERVED_QUERY_VERSION_MISMATCH');
  const journal=new FileSettlementJournal(join(dir,'settlements.json'));
  const result=mode==='freeze'?await journal.freeze(input):await evaluateSettlement(input);
  print({mode,marketId:scope.marketId,epoch:scope.epoch,maturityAt:scope.maturityAt,
    cutoffAt:scope.maturityAt+900,observations:input.observations.length,
    outage:input.outage?.id??null,state:result.state,candidateHash:result.candidateHash??null,
    graduationSlot:status.slot});
  if(mode==='freeze'&&result.state!=='FROZEN_LOCAL')process.exitCode=2;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(error=>{console.error(String(error?.message??error).replace(/https?:\/\/[^\s]+/g,'[RPC_REDACTED]'));process.exitCode=1;});
