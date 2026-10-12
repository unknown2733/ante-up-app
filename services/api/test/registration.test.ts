import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { deriveRegistration, ExistingMarket, SqliteFinancialRegistrationStore } from '../src/registration.ts';
import { validateFinancialIntent } from '../src/financial.ts';

const work=resolve(import.meta.dirname,'../../../../work/d-registration-tests');
mkdirSync(work,{recursive:true});
const wallet='11111111111111111111111111111111';
const programId='FrMATpA81wUMYsZufQkew9K5MW2AC8rgdYQ2wUM6KDKr';
const intent=(requestId:string,keyword='Dubai Chocolate',aliases=['#DubaiChocolate'])=>validateFinancialIntent({requestId,wallet,action:'registerMarket',marketId:null,keyword,aliases});

test('registration normalization derives stable seed/query and rejects search operators',async()=>{
  const id=randomUUID();
  const first=await deriveRegistration(intent(id),programId);
  const same=await deriveRegistration(intent(id,' dubai   chocolate ',['#dubaichocolate']),programId);
  assert.equal(first.address,same.address);
  assert.equal(first.queryHash,same.queryHash);
  assert.deepEqual(first.expressions,['#dubaichocolate','dubai chocolate']);
  await assert.rejects(()=>deriveRegistration(intent(id,'cat OR dog'),programId),/INVALID_INPUT/);
  await assert.rejects(()=>deriveRegistration(intent(id,'Dubai Chocolate',['dog']),programId),/INVALID_INPUT/);
});

test('registration names and aliases reserve atomically and only finalized rows become markets',async()=>{
  const path=resolve(work,`${randomUUID()}.sqlite`);
  let store=new SqliteFinancialRegistrationStore(path);
  const id=randomUUID(),first=await deriveRegistration(intent(id),programId);
  store.reserve(first,id,1030,1000);
  assert.deepEqual(store.finalized(),[]);
  assert.equal(store.pending(id)?.address,first.address);
  const secondId=randomUUID(),other=await deriveRegistration(intent(secondId,'DubaiChocolate',[]),programId);
  store.reserve(other,secondId,1030,1000);
  assert.equal(store.pending(secondId)?.address,other.address);
  store.close();store=new SqliteFinancialRegistrationStore(path);
  assert.equal(store.pending(id)?.queryHash,first.queryHash);
  store.markFinalized(id);
  assert.equal(store.finalized()[0].address,first.address);
  assert.equal(store.pending(secondId)?.address,other.address);
  const exact=await deriveRegistration(intent(randomUUID(),'Dubai Chocolate',['dubaichocolate']),programId);
  assert.throws(()=>store.reserve(exact,randomUUID(),1030,1000),ExistingMarket);
  store.close();
});

test('an explicitly occupied joined alias conflicts with another market keyword',async()=>{
  const store=new SqliteFinancialRegistrationStore(resolve(work,`${randomUUID()}.sqlite`));
  const firstId=randomUUID(),first=await deriveRegistration(intent(firstId,'New York',['newyork']),programId);
  store.reserve(first,firstId,1030,1000);
  const secondId=randomUUID(),second=await deriveRegistration(intent(secondId,'NewYork',[]),programId);
  assert.throws(()=>store.reserve(second,secondId,1030,1000),ExistingMarket);
  store.close();
});
