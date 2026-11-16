import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {hash} from '../../data/index.mjs';
import {GENESIS,PROGRAM,validateLegacyExpiry,commitLegacyExpiry} from '../src/legacy-lp-expiry.mjs';
import {proveLegacyLpExpiry,validateHeldLock} from '../../../scripts/recover-keeper-lp-quiescent.mjs';
const week=1794787200;
const state={marketId:'market',cycle:'4',currentMaturity:1794182400,lpGeneration:'32',validityGeneration:'33',lastLpMaturity:1793577600,openPositions:0};
const {openPositions,...fingerprintState}=state;
const attempt={action:'RECOVER_LP_WINDOW',market_id:'market',cycle:'4',entity:`${week}:33`,fingerprint:hash(fingerprintState),generation:1,state:'UNKNOWN',signature:null,updated_at:week+100};
const proof={kind:'KEEPER_QUIESCENT_LP_EXPIRY',version:1,attemptHash:hash(attempt),programId:PROGRAM,genesisHash:GENESIS,recentBlockhashOnly:true,
 guards:{weeklyLock:true,backupLock:true,noKeeperProducer:true},state,stoppedAt:week+200,capturedAt:week+201,verifiedAt:week+300,
 boundaryBlockTime:week+201,boundaryBlockhash:'fixture-hash',boundarySlot:'100',lastValidBlockHeight:'200',finalizedBlockHeight:'201',finalizedSlot:'101',accountSlot:'101',blockhashValid:false};
function database(){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE keeper_attempts(action TEXT,market_id TEXT,cycle TEXT,entity TEXT,fingerprint TEXT,generation INTEGER,state TEXT,signature TEXT,updated_at INTEGER)');db.prepare('INSERT INTO keeper_attempts VALUES(?,?,?,?,?,?,?,?,?)').run(...Object.values(attempt));return db;}
test('valid expired unsigned attempt retains original receipt and only changes that reservation',()=>{
 const db=database();try{const receipt=commitLegacyExpiry(db,attempt,proof,()=>{},week+400);
  assert.equal(db.prepare('SELECT state FROM keeper_attempts').get().state,'FAILED');
  const row=db.prepare('SELECT * FROM keeper_expiry_receipts').get();assert.equal(row.receipt_hash,receipt);assert.deepEqual(JSON.parse(row.attempt_json),attempt);assert.deepEqual(JSON.parse(row.proof_json),proof);
 }finally{db.close();}
});
test('forged boundary, active producer, changed cycle or generation and signed/wrong action fail closed',()=>{
 for(const patch of [{attemptHash:'bad'},{recentBlockhashOnly:false},{blockhashValid:true},{finalizedBlockHeight:'200'},{accountSlot:'99'},{accountSlot:'100'},
  {boundaryBlockTime:week+99},{genesisHash:'other'},{guards:{...proof.guards,weeklyLock:false}},
  {state:{...state,cycle:'5'}},{state:{...state,validityGeneration:'34'}},{state:{...state,currentMaturity:0}}])
  assert.throws(()=>validateLegacyExpiry(attempt,{...proof,...patch}));
 for(const patch of [{action:'START_LP_WINDOW'},{signature:'signed'},{state:'SUBMITTED'},{entity:`${week}:34`}])
  assert.throws(()=>validateLegacyExpiry({...attempt,...patch},proof));
});
test('changed reservation or another unresolved action prevents cleanup',()=>{
 for(const sql of ["UPDATE keeper_attempts SET updated_at=updated_at+1", "UPDATE keeper_attempts SET generation=2",
  "INSERT INTO keeper_attempts SELECT 'ACCEPT_SETTLEMENT',market_id,cycle,'',fingerprint,1,'UNKNOWN',NULL,updated_at FROM keeper_attempts"]){
  const db=database();try{db.exec(sql);assert.throws(()=>commitLegacyExpiry(db,attempt,proof,()=>{}),/ATTEMPT_CHANGED/);
   assert.equal(db.prepare("SELECT COUNT(*) AS n FROM keeper_attempts WHERE state='FAILED'").get().n,0);
  }finally{db.close();}
 }
});
test('guard loss during transaction rolls back state AND audit receipt',()=>{
 const db=database();let calls=0;try{
  assert.throws(()=>commitLegacyExpiry(db,attempt,proof,()=>{if(++calls===3)throw Error('LOST_LOCK');}),/LOST_LOCK/);
  assert.equal(db.prepare('SELECT state FROM keeper_attempts').get().state,'UNKNOWN');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='keeper_expiry_receipts'").get().n,0);
 }finally{db.close();}
});
function flow(patch={}){let commits=0,time=week+200;const events=[];
 const input={attempt,guard:()=>proof.guards,now:()=>time++,wait:async()=>{},
  captureBoundary:async()=>({genesisHash:GENESIS,slot:100,blockhash:'fixture-hash',lastValidBlockHeight:'200'}),
  blockTime:async()=>week+202,finality:async()=>({slot:101,height:'201',blockhashValid:false}),readState:async()=>({slot:101,state}),
  save:async e=>events.push(e),commit:async(a,p)=>{validateLegacyExpiry(a,p);commits++;return hash(p);},...patch};
 return {input,events,get commits(){return commits;}};
}
test('orchestrator proves expiry once; no sender or signing capability exists',async()=>{
 const f=flow();await proveLegacyLpExpiry(f.input);assert.equal(f.commits,1);assert.deepEqual(f.events.map(e=>e.stage),['BOUNDARY_CAPTURED','PROVEN_UNLANDED','RECONCILED']);
});
test('RPC 429 or advanced finalized state leaves the journal untouched',async()=>{
 const limited=flow({finality:async()=>{throw Error('RECOVERY_RPC_RATE_LIMITED');}});
 await assert.rejects(()=>proveLegacyLpExpiry(limited.input),/RATE_LIMITED/);assert.equal(limited.commits,0);
 let reads=0;const advanced=flow({readState:async()=>({slot:101,state:++reads===1?state:{...state,lastLpMaturity:week}})});
 await assert.rejects(()=>proveLegacyLpExpiry(advanced.input),/FINGERPRINT_CHANGED/);assert.equal(advanced.commits,0);
});
test('host lock proof requires current process exclusive FLOCK and the unchanged inode',()=>{
 const input={expectedPath:'/state/weekly.lock',actualPath:'/state/weekly.lock',fdStat:{ino:12,dev:3},pathStat:{ino:12,dev:3},pid:77,
  lines:['1: FLOCK ADVISORY WRITE 77 00:03:12 0 EOF']};
 validateHeldLock(input);
 for(const patch of [{actualPath:'/other/lock'},{pid:78},{pathStat:{ino:13,dev:3}},
  {lines:['1: FLOCK ADVISORY READ 77 00:03:12 0 EOF']},{lines:[]}])assert.throws(()=>validateHeldLock({...input,...patch}));
});
test('an unexpired boundary times out and never mutates an attempt',async()=>{
 const f=flow({timeoutSeconds:3,finality:async()=>({slot:101,height:'200',blockhashValid:true})});
 await assert.rejects(()=>proveLegacyLpExpiry(f.input),/TIMEOUT/);assert.equal(f.commits,0);
});
