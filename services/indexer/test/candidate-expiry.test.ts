import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {address} from '@solana/kit';
import {ANTE_UP_PROGRAM_ADDRESS,getSnapshotEncoder,DataStatus,AdmissionState} from '../../../clients/chain/dist/index.js';
import {fixtureMarkets} from '../../api/src/fixture.ts';
import {hash} from '../../data/index.mjs';
import {expireUnlandedPublication} from '../../data/publication-recovery.mjs';
import {SqliteEventRepositories} from '../src/repositories.ts';

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'candidate-expiry-')),file=join(directory,'candidates.json'),dbPath=join(directory,'index.sqlite');
  const programId=String(ANTE_UP_PROGRAM_ADDRESS),marketId='11111111111111111111111111111111';
  const scope={cluster:'devnet' as const,programId,address:programId};
  const candidate={...structuredClone(fixtureMarkets[0].snapshot!.payload),marketId,configVersion:'20',sequence:'2202'};
  const job={state:'REQUESTING',market:{address:marketId,programId,cluster:'devnet'},sequence:candidate.sequence,signature:null,candidate,candidateHash:hash(candidate),published:null};
  const proof={version:1,kind:'QUIESCENT_RECENT_BLOCKHASH_EXPIRY',marketId,programId,sequence:job.sequence,candidateHash:job.candidateHash,
    originalSignature:null,genesisHash:'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',producerId:'stopped-container',
    producerStopped:true,producerStillStopped:true,capturedAt:10,verifiedAt:90,boundaryBlockhash:'post-stop-blockhash',
    producerStoppedAt:9,boundaryBlockTime:10,boundarySlot:'100',finalizedSlot:'101',lastValidBlockHeight:'200',finalizedBlockHeight:'201',
    boundaryBlockhashValid:false,snapshotExists:false,nextSequence:job.sequence,signatureStatus:null,candidateConfigVersion:'20',configVersion:'21',
    queryVersion:candidate.queryVersion,queryHash:candidate.queryHash};
  const expired=expireUnlandedPublication(job,proof);
  const next={...job,state:'FINALIZED',candidate:{...candidate,configVersion:'21'}};next.candidateHash=hash(next.candidate);
  const encode=(value=next.candidate)=>{
    const version=new Uint8Array(16);version.set(new TextEncoder().encode(value.formulaVersion));
    return getSnapshotEncoder().encode({market:address(marketId),sequence:BigInt(value.sequence),
      payloadHash:Buffer.from(hash(value),'hex'),evidenceHash:Buffer.from(value.evidenceHash,'hex'),queryHash:Buffer.from(value.queryHash,'hex'),
      queryVersion:BigInt(value.queryVersion),configVersion:BigInt(value.configVersion),formulaVersion:version,
      dataThrough:BigInt(value.dataThrough),publishedAt:BigInt(value.computedAt),activityNowQ12:BigInt(value.activityNowQ12!),
      activity7dQ12:BigInt(value.activity7dQ12!),dataStatus:DataStatus.Valid,admission:{state:AdmissionState.Open,recoveryCount:0,reason:null}});
  };
  let chain:{ownerProgramId:string;data:Uint8Array}|null={ownerProgramId:programId,data:encode()},rpcError=false;
  const repo=new SqliteEventRepositories(dbPath,{async get(){if(rpcError)throw Error('RPC_429');return chain;}});
  repo.putCandidate(scope,marketId,candidate);
  const db=new DatabaseSync(dbPath);
  const write=(old:unknown=expired,replacement:unknown=next,snapshots:Record<string,unknown>={})=>writeFileSync(file,JSON.stringify({snapshots,jobs:{old,replacement}}));
  const row=()=>db.prepare('SELECT payload_hash FROM snapshot_candidates').get() as {payload_hash:string};
  const auditCount=()=>Number((db.prepare('SELECT COUNT(*) AS count FROM expired_snapshot_candidates').get() as {count:number}).count);
  return {scope,job,expired,next,proof,candidate,repo,db,file,write,row,auditCount,encode,
    setChain(value:typeof chain){chain=value;},setRpcError(){rpcError=true;},
    close(){repo.close();db.close();rmSync(directory,{recursive:true,force:true});}};
}

test('verified expired handoff retires only old projection, preserves audit and imports finalized replacement atomically',async()=>{
  const f=fixture();try{
    f.write();const original=readFileSync(f.file,'utf8');
    assert.equal(await f.repo.importCandidateFile(f.file,f.scope),1);
    assert.equal(f.row().payload_hash,f.next.candidateHash);assert.equal(f.auditCount(),1);
    assert.equal(readFileSync(f.file,'utf8'),original);
    assert.equal(await f.repo.importCandidateFile(f.file,f.scope),1);assert.equal(f.auditCount(),1);
    assert.throws(()=>f.repo.putCandidate(f.scope,f.candidate.marketId,f.candidate),/CANDIDATE_EXPIRED_REIMPORT/);
    const audit=f.db.prepare('SELECT candidate_json,recovery_hash FROM expired_snapshot_candidates').get() as {candidate_json:string;recovery_hash:string};
    assert.equal(hash(JSON.parse(audit.candidate_json)),f.job.candidateHash);assert.equal(audit.recovery_hash,hash(f.proof));
  }finally{f.close();}
});

test('invalid or missing receipt, tampered hash, prior finalized state and published expiry fail with no projection mutation',async()=>{
  for(const patch of [{expiryRecovery:undefined},{expiryRecoveryHash:'forged'},{previousState:'FINALIZED'},
    {published:{finality:'finalized'}},{sequence:'2203'},{expiryRecovery:{kind:'forged'}},
    {expiryRecoveryHash:hash({kind:'forged'}),expiryRecovery:{kind:'forged'}}]){
    const f=fixture();try{
      f.write({...f.expired,...patch});await assert.rejects(f.repo.importCandidateFile(f.file,f.scope),/CANDIDATE_EXPIRY_PROOF_INVALID/);
      assert.equal(f.row().payload_hash,f.job.candidateHash);assert.equal(f.auditCount(),0);
    }finally{f.close();}
  }
});

test('finalized old snapshot, RPC error and missing replacement never retire the old projection',async()=>{
  for(const mode of ['old-chain','rpc','snapshot-alias','replacement-missing','wrong-owner','wrong-sequence']){
    const f=fixture();try{
      if(mode==='old-chain')f.setChain({ownerProgramId:f.scope.programId,data:f.encode(f.candidate)});
      if(mode==='rpc')f.setRpcError();
      if(mode==='wrong-owner')f.setChain({ownerProgramId:'other',data:f.encode()});
      if(mode==='wrong-sequence')f.setChain({ownerProgramId:f.scope.programId,data:f.encode({...f.next.candidate,sequence:'2203'})});
      f.write(f.expired,mode==='replacement-missing'?{...f.next,candidate:{...f.next.candidate,configVersion:'22'},candidateHash:hash({...f.next.candidate,configVersion:'22'})}:f.next,
        mode==='snapshot-alias'?{old:f.job}:{});
      await assert.rejects(f.repo.importCandidateFile(f.file,f.scope),/CANDIDATE_EXPIRY_|RPC_429/);
      assert.equal(f.row().payload_hash,f.job.candidateHash);assert.equal(f.auditCount(),0);
    }finally{f.close();}
  }
});

test('unknown and finalized conflicting jobs are not silently filtered',async()=>{
  for(const state of ['REQUESTING','SUBMITTED','FINALIZED','UNKNOWN']){
    const f=fixture();try{
      f.write({...f.job,state});await assert.rejects(f.repo.importCandidateFile(f.file,f.scope),/CANDIDATE_CONFLICT/);
      assert.equal(f.row().payload_hash,f.job.candidateHash);assert.equal(f.auditCount(),0);
    }finally{f.close();}
  }
});

test('a conflict after expired retirement rolls back both audit insertion and projection removal',async()=>{
  const f=fixture();try{
    f.setChain(null);
    const conflict={...f.next,candidate:{...f.next.candidate,configVersion:'22'}};conflict.candidateHash=hash(conflict.candidate);
    f.write(f.expired,f.next,{conflict});
    await assert.rejects(f.repo.importCandidateFile(f.file,f.scope),/CANDIDATE_CONFLICT/);
    assert.equal(f.row().payload_hash,f.job.candidateHash);assert.equal(f.auditCount(),0);
  }finally{f.close();}
});

test('receipt plus absent finalized account permits next queued publication without inventing finality',async()=>{
  const f=fixture();try{
    f.setChain(null);f.write(f.expired,{...f.next,state:'REQUESTING'});
    await f.repo.importCandidateFile(f.file,f.scope);assert.equal(f.row().payload_hash,f.next.candidateHash);
    await assert.rejects(f.repo.resolve({marketAddress:f.candidate.marketId,sequence:f.candidate.sequence,payloadHash:f.next.candidateHash,scope:f.scope}),/SNAPSHOT_ACCOUNT_UNAVAILABLE/);
  }finally{f.close();}
});

test('already indexed finalized evidence cannot be retired even when the RPC account is absent',async()=>{
  for(const table of ['current_snapshots','finalized_events']){
    const f=fixture();try{
      const snapshot={payload:f.candidate,payloadHash:f.job.candidateHash};
      if(table==='current_snapshots'){
        f.db.exec('CREATE TABLE current_snapshots(cluster,program_id,market_id,sequence,snapshot_json)');
        f.db.prepare('INSERT INTO current_snapshots VALUES(?,?,?,?,?)').run(f.scope.cluster,f.scope.programId,f.candidate.marketId,f.candidate.sequence,JSON.stringify(snapshot));
      }else{
        f.db.exec('CREATE TABLE finalized_events(cluster,program_id,kind,event_json)');
        f.db.prepare('INSERT INTO finalized_events VALUES(?,?,?,?)').run(f.scope.cluster,f.scope.programId,'snapshot',JSON.stringify({snapshot}));
      }
      f.setChain(null);f.write();await assert.rejects(f.repo.importCandidateFile(f.file,f.scope),/CANDIDATE_EXPIRY_CONFLICT/);
      assert.equal(f.row().payload_hash,f.job.candidateHash);assert.equal(f.auditCount(),0);
    }finally{f.close();}
  }
});
