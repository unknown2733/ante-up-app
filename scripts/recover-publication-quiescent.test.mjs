import test from 'node:test';import assert from 'node:assert/strict';
import {proveAndExpire} from './recover-publication-quiescent.mjs';
import {hash} from '../services/data/index.mjs';
const GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',PROGRAM='FrMATpA81wUMYsZufQkew9K5MW2AC8rgdYQ2wUM6KDKr';
function fixture(){let time=100,committed=0;const events=[];
 const candidate={marketId:'market',sequence:'7',configVersion:'2',queryVersion:'1',queryHash:'abc'};
 const job={id:'pending',state:'REQUESTING',market:{address:'market',cluster:'devnet',programId:PROGRAM},signature:null,sequence:'7',candidate,candidateHash:hash(candidate)};
 return {get committed(){return committed;},events,options:{job,producerId:'same',stoppedAt:100,now:()=>time,wait:async()=>{time+=3;},timeoutSeconds:12,
 inspect:async()=>({id:'same',running:false,restarting:false}),captureBoundary:async()=>({genesisHash:GENESIS,slot:10,blockhash:'boundary',lastValidBlockHeight:'20'}),
 blockTime:async()=>100,finality:async()=>({slot:12,height:'21',blockhashValid:false}),
 readContext:async()=>({genesisHash:GENESIS,minContextSlot:12,snapshotAddress:'snapshot',snapshotExists:false,nextSequence:'7',signatureStatus:null,configVersion:'2',queryVersion:'1',queryHash:'abc'}),
 expire:(j,p)=>({...j,state:'EXPIRED_UNLANDED',expiryRecovery:p}),save:async e=>events.push(e),commit:async()=>{committed++;}}};}
test('fresh stopped-producer boundary and finalized absence permit one journal-only commit',async()=>{
 const f=fixture(),p=await proveAndExpire(f.options);assert.equal(f.committed,1);assert.equal(p.boundaryBlockTime,100);assert.equal(p.finalizedContextSlot,12);
 assert.deepEqual(f.events.map(e=>e.stage),['BOUNDARY_CAPTURED','PROVEN_UNLANDED','JOURNAL_UPDATED']);
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
 for(const patch of [{snapshotExists:true},{nextSequence:'8'},{signatureStatus:{confirmationStatus:'processed'}},{minContextSlot:9},{queryVersion:'2'},{genesisHash:'other'}]){
  const f=fixture();await assert.rejects(proveAndExpire({...f.options,readContext:async()=>({...await f.options.readContext(),...patch})}),/CHAIN_CONTEXT_CHANGED/);assert.equal(f.committed,0);
 }
 const f=fixture();await assert.rejects(proveAndExpire({...f.options,finality:async()=>{throw Error('RECOVERY_RPC_UNAVAILABLE');}}),/RPC_UNAVAILABLE/);assert.equal(f.committed,0);
});
test('producer restarting or replaced before commit aborts',async()=>{
 for(const changed of [{id:'same',running:true,restarting:false},{id:'different',running:false,restarting:false}]){
  const f=fixture();let calls=0;await assert.rejects(proveAndExpire({...f.options,inspect:async()=>++calls>=3?changed:{id:'same',running:false,restarting:false}}),/NOT_QUIESCENT/);assert.equal(f.committed,0);
 }
});
test('candidate mutation cannot be hidden by a saved candidateHash',async()=>{
 const f=fixture();f.options.job.candidate.queryVersion='9';await assert.rejects(proveAndExpire(f.options),/JOB_INVALID/);assert.equal(f.committed,0);
});
