import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { SqliteKeeperAttempts } from '../src/attempts.ts';

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
