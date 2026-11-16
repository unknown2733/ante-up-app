import test from 'node:test';
import assert from 'node:assert/strict';
import type {AddressInfo} from 'node:net';
import {createApp} from '../src/app.ts';
import {createApiServer} from '../src/server.ts';
import {LiveStore} from '../src/live-store.ts';
import {consumerLiveNamespace} from '../../../contracts/consumer-identity.ts';
import {checkHttpHealth} from '../../../scripts/service-health.mjs';

test('HTTP liveness bypasses every source, consumer and RPC read even during a provider outage',async()=>{
  const calls:string[]=[],programId='1'.repeat(32),liveStore=new LiveStore(':memory:');
  const unavailable=(name:string)=>async()=>{calls.push(name);throw Error('RPC_RATE_LIMITED');};
  const app=createApp({mode:'devnet',programId,liveStore,
    read:{mode:'devnet',markets:unavailable('markets'),records:unavailable('records'),proofs:unavailable('proofs'),heldCalculationWallets:unavailable('wallets')},
    chain:{get:unavailable('chain.get'),discover:unavailable('chain.discover')},
    consumer:{namespace:consumerLiveNamespace('devnet',programId),
      read:{listMarkets:unavailable('consumer.markets'),getHistory:unavailable('consumer.history'),getProfile:unavailable('consumer.profile'),getLeaderboard:unavailable('consumer.leaderboard')},
      notes:{} as any}});
  const server=createApiServer(app);
  try{
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response=await fetch(base+'/health');
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual(await response.json(),{service:'ante-up-api',kind:'liveness',status:'ok',mode:'devnet',cluster:'devnet',configurationReady:true});
    await checkHttpHealth('api',async(url:string,options:RequestInit)=>{
      assert.equal(new URL(url).pathname,'/health');return fetch(base+'/health',options);
    });
    assert.deepEqual(calls,[]);
    // A healthy process must not make unavailable financial data look available.
    const markets=await fetch(base+'/v1/markets');assert.notEqual(markets.status,200);
    assert.deepEqual(calls,['markets']);
    assert.equal((await fetch(base+'/health')).status,200);assert.deepEqual(calls,['markets']);
    assert.notEqual((await fetch(base+'/health',{method:'POST'})).status,200);
  }finally{
    await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeIdleConnections();});
    liveStore.close();
  }
});

test('fixture health is explicit and cannot satisfy the live Docker check; incomplete live config cannot start',async()=>{
  const app=createApp();
  const response=await app.handle(new Request('http://localhost/health'));
  assert.equal((await response.clone().json()).mode,'fixture');
  assert.equal((await response.clone().json()).cluster,null);
  await assert.rejects(checkHttpHealth('api',async()=>response),/API_LIVENESS_INVALID/);
  assert.throws(()=>createApp({mode:'devnet'}),/READ_ADAPTER_MODE_MISMATCH/);
});
