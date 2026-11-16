import test from 'node:test';import assert from 'node:assert/strict';
import {proveAndExpire,rpcReader} from './recover-publication-quiescent.mjs';
import {hash} from '../services/data/index.mjs';
import {expireUnlandedPublication} from '../services/data/publication-recovery.mjs';
import {readFinalizedExpiry} from './ops/recovery-rpc.mjs';
const GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',PROGRAM='FrMATpA81wUMYsZufQkew9K5MW2AC8rgdYQ2wUM6KDKr';
function fixture(){let time=100,committed=0;const events=[];
 const candidate={marketId:'market',sequence:'7',configVersion:'2',queryVersion:'1',queryHash:'abc'};
 const job={id:'pending',state:'REQUESTING',market:{address:'market',cluster:'devnet',programId:PROGRAM},signature:null,sequence:'7',candidate,candidateHash:hash(candidate)};
 return {get committed(){return committed;},events,options:{job,producerId:'same',stoppedAt:100,now:()=>time,wait:async()=>{time+=3;},timeoutSeconds:12,
 inspect:async()=>({id:'same',running:false,restarting:false}),captureBoundary:async()=>({genesisHash:GENESIS,slot:10,blockhash:'boundary',lastValidBlockHeight:'20'}),
 blockTime:async()=>100,finality:async()=>({slot:12,height:'21',blockhashValid:false}),
 readContext:async()=>({genesisHash:GENESIS,minContextSlot:12,snapshotAddress:'snapshot',snapshotExists:false,nextSequence:'7',signatureStatus:null,configVersion:'2',queryVersion:'1',queryHash:'abc'}),
 expire:expireUnlandedPublication,save:async e=>events.push(e),commit:async()=>{committed++;}}};}
test('fresh stopped-producer boundary and finalized absence permit one journal-only commit',async()=>{
 const f=fixture(),p=await proveAndExpire(f.options);assert.equal(f.committed,1);assert.equal(p.boundaryBlockTime,100);assert.equal(p.finalizedContextSlot,12);
 assert.deepEqual(f.events.map(e=>e.stage),['BOUNDARY_CAPTURED','CHAIN_CONTEXT_READBACK','PROVEN_UNLANDED','JOURNAL_UPDATED']);
});
test('lagging boundary and finalized context wait without committing early',async()=>{
 const f=fixture();let bt=0,ft=0;
 await proveAndExpire({...f.options,blockTime:async()=>++bt===1?99:100,finality:async()=>++ft===1?{slot:9,height:'19',blockhashValid:true}:{slot:12,height:'21',blockhashValid:false}});
 assert.equal(f.committed,1);assert.equal(bt,2);assert.equal(ft,2);
});
test('unknown block time waits boundedly and cannot release the pending job',async()=>{
 const f=fixture();await assert.rejects(proveAndExpire({...f.options,blockTime:async()=>null}),/WAIT_TIMEOUT/);assert.equal(f.committed,0);
});
test('landed, mismatched, stale-context and unavailable reads never commit',async()=>{
 for(const patch of [{snapshotExists:true},{nextSequence:'8'},{signatureStatus:{confirmationStatus:'processed'}},{minContextSlot:9},{queryVersion:'2'},{genesisHash:'other'},{configVersion:'1'},{configVersion:'invalid'}]){
  const f=fixture();await assert.rejects(proveAndExpire({...f.options,readContext:async()=>({...await f.options.readContext(),...patch})}),/CHAIN_CONTEXT_CHANGED/);assert.equal(f.committed,0);
 }
 const f=fixture();await assert.rejects(proveAndExpire({...f.options,finality:async()=>{throw Error('RECOVERY_RPC_UNAVAILABLE');}}),/RPC_UNAVAILABLE/);assert.equal(f.committed,0);
});
test('configuration advancement is recorded separately and passes the real receipt validator',async()=>{
 const f=fixture(),before=JSON.stringify(f.options.job);
 const proof=await proveAndExpire({...f.options,readContext:async()=>({...await f.options.readContext(),configVersion:'3'})});
 assert.equal(f.committed,1);assert.equal(proof.candidateConfigVersion,'2');assert.equal(proof.configVersion,'3');
 assert.equal(JSON.stringify(f.options.job),before);
 const readback=f.events.find(e=>e.stage==='CHAIN_CONTEXT_READBACK');
 assert.equal(readback.expected.configVersion,'2');assert.equal(readback.observed.configVersion,'3');
});
test('producer restarting or replaced before commit aborts',async()=>{
 for(const changed of [{id:'same',running:true,restarting:false},{id:'different',running:false,restarting:false}]){
  const f=fixture();let calls=0;await assert.rejects(proveAndExpire({...f.options,inspect:async()=>++calls>=3?changed:{id:'same',running:false,restarting:false}}),/NOT_QUIESCENT/);assert.equal(f.committed,0);
 }
});
test('candidate mutation cannot be hidden by a saved candidateHash',async()=>{
 const f=fixture();f.options.job.candidate.queryVersion='9';await assert.rejects(proveAndExpire(f.options),/JOB_INVALID/);assert.equal(f.committed,0);
});

const response=(status,body)=>({ok:status>=200&&status<300,status,body:{cancel:async()=>{}},json:async()=>body});
test('read-only minimum context error is retried and retains the same request',async()=>{
 const waits=[],calls=[];let n=0;
 const rpc=rpcReader(['primary'],{wait:async ms=>waits.push(ms),fetcher:async(url,init)=>{
  calls.push(JSON.parse(init.body));return ++n<3?response(200,{error:{code:-32016,message:'private provider text'}}):response(200,{result:123});}});
 assert.equal(await rpc('getBlockHeight',[{commitment:'finalized',minContextSlot:99}]),123);
 assert.deepEqual(waits,[500,1000]);assert.equal(calls.length,3);assert.deepEqual(calls[0],calls[2]);
});
test('429 or unavailable provider can use healthy fallback without another pass',async()=>{
 let n=0;const waits=[];
 const rpc=rpcReader(['primary','backup'],{wait:async ms=>waits.push(ms),fetcher:async()=>++n===1?response(429,{}):response(200,{result:{ok:true}})});
 assert.deepEqual(await rpc('getSlot'),{ok:true});assert.equal(n,2);assert.deepEqual(waits,[]);
});
test('transient errors exhaust after three passes and expose only classified code',async()=>{
 for(const [fixture,code] of [[()=>response(429,{}),'RECOVERY_RPC_RATE_LIMITED'],[()=>response(503,{}),'RECOVERY_RPC_UNAVAILABLE'],
  [()=>response(200,{error:{code:-32016,message:'https://secret?key=secret'}}),'RECOVERY_RPC_CONTEXT_NOT_READY'],
  [()=>{throw new DOMException('private','TimeoutError');},'RECOVERY_RPC_UNAVAILABLE']]){
  let calls=0;const waits=[];const rpc=rpcReader(['one','two'],{wait:async ms=>waits.push(ms),fetcher:async()=>{calls++;return fixture();}});
  await assert.rejects(rpc('getBlockHeight'),e=>e.message===code);assert.equal(calls,6);assert.deepEqual(waits,[500,1000]);
 }
});
test('semantic rejection and authorization failures are not retried',async()=>{
 for(const r of [response(403,{}),response(200,{error:{code:-32602,message:'invalid params private'}})]){
  let calls=0;const rpc=rpcReader(['one'],{wait:async()=>assert.fail('no wait'),fetcher:async()=>{calls++;return r;}});
  await assert.rejects(rpc('getAccountInfo'),/RECOVERY_RPC_REJECTED/);assert.equal(calls,1);
 }
});
test('a not-yet-available block time returns pending without inventing time',async()=>{
 let calls=0;const rpc=rpcReader(['one'],{wait:async()=>assert.fail('outer boundary wait owns timing'),fetcher:async()=>{calls++;return response(200,{error:{code:-32004}});}});
 assert.equal(await rpc('getBlockTime',[100]),null);assert.equal(calls,1);
});
test('the retrier cannot submit transactions or request airdrops',async()=>{
 const rpc=rpcReader(['one'],{fetcher:async()=>assert.fail('must not call transport')});
 for(const method of ['sendTransaction','requestAirdrop'])await assert.rejects(rpc(method),/METHOD_NOT_READ_ONLY/);
});

test('finalized expiry height comes from getBlock at the exact slot; unavailable blocks fail closed',async()=>{
 const calls=[];
 const rpc=async(method,params)=>{calls.push([method,params]);return method==='getSlot'?120:method==='getBlock'?{blockHeight:201}:{context:{slot:120},value:false};};
 assert.deepEqual(await readFinalizedExpiry(rpc,{slot:100,blockhash:'hash'}),{slot:120,height:'201',blockhashValid:false});
 assert.equal(calls[1][0],'getBlock');assert.equal(calls[1][1][0],120);assert.equal(calls[2][1][1].minContextSlot,120);
 for(const block of [null,{}, {blockHeight:null}])await assert.rejects(()=>readFinalizedExpiry(async method=>method==='getSlot'?120:block,{slot:100,blockhash:'hash'}),/BLOCK_UNAVAILABLE/);
});
test('new helper refuses account context after boundary but before expiry slot',async()=>{
 const f=fixture();
 await assert.rejects(()=>proveAndExpire({...f.options,finality:async()=>({slot:20,height:'201',blockhashValid:false})}),/CHAIN_CONTEXT_CHANGED/);
 assert.equal(f.committed,0);
 const good=fixture(),p=await proveAndExpire(good.options);assert.equal(p.version,2);assert.deepEqual(p.expiryBlock,{slot:p.finalizedSlot,height:p.finalizedBlockHeight});
});
