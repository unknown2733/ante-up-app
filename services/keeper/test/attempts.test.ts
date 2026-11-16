import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { SqliteKeeperAttempts } from '../src/attempts.ts';
import {DatabaseSync} from 'node:sqlite';
import {KeeperPreparationFailure} from '../src/preparation-failure.ts';

const work=resolve(import.meta.dirname,'../../../../work/d-keeper-attempts');
mkdirSync(work,{recursive:true});

test('two keeper processes reserve one action and UNKNOWN survives restart',async()=>{
  const path=resolve(work,`${randomUUID()}.sqlite`);
  const a=new SqliteKeeperAttempts(path),b=new SqliteKeeperAttempts(path);
  const key={action:'ACCEPT_SETTLEMENT' as const,marketId:'market',cycle:'7',entity:''};
  const first=a.reserve(key,'a'.repeat(64),100);
  assert.equal(first.created,true);
  assert.equal(b.reserve(key,'a'.repeat(64),101).created,false);
  assert.throws(()=>b.reserve(key,'b'.repeat(64),101),/KEEPER_ATTEMPT_IDENTITY_CHANGED/);
  a.close();b.close();
  const recovered=new SqliteKeeperAttempts(path);
  assert.equal(recovered.get(key)?.state,'UNKNOWN');
  assert.equal(recovered.reserve(key,'a'.repeat(64),200).created,false);
  assert.equal((await recovered.reconcile(first.attempt,async()=> 'PENDING',201)).state,'UNKNOWN');
  const sent=recovered.attachSignature(first.attempt,'signature',202);
  assert.equal(sent.state,'SUBMITTED');
  assert.equal((await recovered.reconcile(sent,async()=> 'FINALIZED',203)).state,'FINALIZED');
  assert.equal(recovered.reserve(key,'a'.repeat(64),204).created,false);
  recovered.close();
});

test('verified failed attempt permits a new generation but rejects stale receipts',async()=>{
  const store=new SqliteKeeperAttempts(resolve(work,`${randomUUID()}.sqlite`));
  const key={action:'SETTLE_PRO' as const,marketId:'market',cycle:'7',entity:'position'};
  const first=store.reserve(key,'b'.repeat(64),100).attempt;
  assert.equal((await store.reconcile(first,async()=> 'FAILED',101)).state,'FAILED');
  const second=store.reserve(key,'b'.repeat(64),102);
  assert.equal(second.created,true);
  assert.equal(second.attempt.generation,2);
  await assert.rejects(()=>store.reconcile(first,async()=> 'FINALIZED',103),/KEEPER_ATTEMPT_STALE/);
  store.close();
});

test('pre-sign failure persists a generation-bound audit and never clears an old unsigned reservation',()=>{
  const path=resolve(work,`${randomUUID()}.sqlite`),store=new SqliteKeeperAttempts(path),db=new DatabaseSync(path);
  const key={action:'RECOVER_LP_WINDOW' as const,marketId:'market',cycle:'7',entity:'monday:35'};
  try{
    const first=store.reserve(key,'a'.repeat(64),100).attempt;
    assert.throws(()=>store.failBeforeSigning(store.get(key)!,new KeeperPreparationFailure('RPC_RATE_LIMITED'),101),/INVALID/);
    assert.throws(()=>store.failBeforeSigning(first,Object.assign(Object.create(KeeperPreparationFailure.prototype),{stage:'BEFORE_SIGNING',reason:'RPC_RATE_LIMITED'}),101),/INVALID/);
    assert.equal(store.failBeforeSigning(first,new KeeperPreparationFailure('RPC_RATE_LIMITED'),101).state,'FAILED');
    const audit=db.prepare('SELECT * FROM keeper_presign_failures').get()!;
    assert.equal(audit.generation,1);assert.equal(audit.reason,'RPC_RATE_LIMITED');assert.equal(audit.stage,'BEFORE_SIGNING');
    const second=store.reserve(key,'a'.repeat(64),102);assert.equal(second.created,true);assert.equal(second.attempt.generation,2);
    assert.throws(()=>store.failBeforeSigning(first,new KeeperPreparationFailure('RPC_RATE_LIMITED'),103),/INVALID/);
    assert.equal(store.get(key)!.state,'UNKNOWN');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM keeper_presign_failures').get()!.n,1);
  }finally{store.close();db.close();}
  const restarted=new SqliteKeeperAttempts(path);
  assert.throws(()=>restarted.failBeforeSigning(restarted.get(key)!,new KeeperPreparationFailure('RPC_RATE_LIMITED'),104),/INVALID/);
  assert.equal(restarted.get(key)!.state,'UNKNOWN');restarted.close();
});

test('SQL guards reject changed generation, fingerprint, state, signature and backward clock without an audit',()=>{
  const key={action:'START_LP_WINDOW' as const,marketId:'market',cycle:'7',entity:''};
  for(const mutate of ["generation=2","fingerprint='other'","state='FINALIZED'","state='SUBMITTED',signature='sig'","signature='ambiguous'","updated_at=200"]){
    const path=resolve(work,`${randomUUID()}.sqlite`),store=new SqliteKeeperAttempts(path),db=new DatabaseSync(path);
    try{
      const first=store.reserve(key,'a'.repeat(64),100).attempt;
      db.exec(`UPDATE keeper_attempts SET ${mutate}`);
      assert.throws(()=>store.failBeforeSigning(first,new KeeperPreparationFailure('PREPARATION_FAILED'),101),/STALE/);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM keeper_presign_failures').get()!.n,0);
    }finally{store.close();db.close();}
  }
});

test('failure to write the audit rolls back FAILED and preserves UNKNOWN',()=>{
  const path=resolve(work,`${randomUUID()}.sqlite`),store=new SqliteKeeperAttempts(path),db=new DatabaseSync(path);
  const key={action:'START_LP_WINDOW' as const,marketId:'market',cycle:'7',entity:''};
  try{
    const first=store.reserve(key,'a'.repeat(64),100).attempt;
    assert.throws(()=>{first.generation=2;},TypeError);
    db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON keeper_presign_failures BEGIN SELECT RAISE(ABORT,'audit storage failed'); END");
    assert.throws(()=>store.failBeforeSigning(first,new KeeperPreparationFailure('PREPARATION_FAILED'),101),/audit storage failed/);
    assert.equal(store.get(key)!.state,'UNKNOWN');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM keeper_presign_failures').get()!.n,0);
  }finally{store.close();db.close();}
});
