import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { deriveRegistration, ExistingMarket, SqliteFinancialRegistrationStore } from '../src/registration.ts';
import { validateFinancialIntent } from '../src/financial.ts';
import type { FinalizedFinancialAccounts } from '../src/financial-chain.ts';
import { DatabaseSync } from 'node:sqlite';

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

test('expired failed registration releases its keyword while an unresolved signed request keeps it reserved',async()=>{
  const path=resolve(work,`${randomUUID()}.sqlite`),store=new SqliteFinancialRegistrationStore(path);
  const failedId=randomUUID(),activeId=randomUUID();
  const failed=await deriveRegistration(intent(failedId,'Dubai Chocolate',[]),programId);
  const active=await deriveRegistration(intent(activeId,'New Artist',[]),programId);
  store.reserve(failed,failedId,1030,1000);
  store.reserve(active,activeId,1030,1000);
  const db=new DatabaseSync(path);
  db.exec('CREATE TABLE live_operations(request_id TEXT PRIMARY KEY,state TEXT,signature TEXT)');
  db.prepare('INSERT INTO live_operations VALUES(?,?,?)').run(failedId,'FAILED',null);
  db.prepare('INSERT INTO live_operations VALUES(?,?,?)').run(activeId,'UNKNOWN','signed-transaction');
  db.close();
  assert.deepEqual(store.expiredPending(1040),[activeId]);
  const retryId=randomUUID(),retry=await deriveRegistration(intent(retryId,'Dubai Chocolate',[]),programId);
  store.reserve(retry,retryId,1090,1040);
  assert.equal(store.pending(failedId),null);
  assert.equal(store.pending(retryId)?.address,retry.address);
  const conflict=await deriveRegistration(intent(randomUUID(),'New Artist',[]),programId);
  assert.throws(()=>store.reserve(conflict,randomUUID(),1090,1040),ExistingMarket);
  assert.equal(store.pending(activeId)?.address,active.address);
  store.close();
});

test('finalized chain accounts recover a registration after the browser closes, while failed requests are skipped',async()=>{
  const path=resolve(work,`${randomUUID()}.sqlite`),store=new SqliteFinancialRegistrationStore(path);
  const id=randomUUID(),entry=await deriveRegistration(intent(id,'New artist',[]),programId);
  const failedId=randomUUID(),failed=await deriveRegistration(intent(failedId,'Old artist',[]),programId);
  store.reserve(entry,id,1030,1000);store.reserve(failed,failedId,1030,1000);
  const db=new DatabaseSync(path);
  db.exec('CREATE TABLE live_operations(request_id TEXT PRIMARY KEY,state TEXT,signature TEXT)');
  db.prepare('INSERT INTO live_operations VALUES(?,?,?)').run(failedId,'FAILED',null);
  db.close();
  let landed=false,lookups=0;
  const accounts=({
    async market(address:string){lookups++;if(!landed)throw Error('FINANCIAL_ACCOUNT_UNAVAILABLE');assert.equal(address,entry.address);
      return {id:Buffer.from(entry.seedHex,'hex'),queryHash:Buffer.from(entry.queryHash,'hex'),queryVersion:1n};},
    async financeMarket(address:string){return {market:address};}
  }) as unknown as FinalizedFinancialAccounts;
  assert.equal(await store.reconcilePending(accounts),0);
  assert.deepEqual(store.finalized(),[]);
  landed=true;
  assert.equal(await store.reconcilePending(accounts),1);
  assert.equal(lookups,2,'failed registration must not cause a chain read');
  assert.deepEqual(store.finalized().map(m=>m.address),[entry.address]);
  store.close();
});
