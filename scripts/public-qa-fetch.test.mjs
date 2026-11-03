import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicQaFetcher} from './public-qa-fetch.mjs';
test('coalesces successful reads, serializes requests, and never forwards credentials',async()=>{
  let active=0,peak=0,calls=0;
  const read=createPublicQaFetcher({wait:async()=>{},fetcher:async(_url,init)=>{
    assert.equal(init.headers,undefined);assert.equal(init.redirect,'error');
    calls++;peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,5));active--;return new Response('observed');
  }});
  const rows=await Promise.all([read('https://ante-up.fun/api/a',{headers:{Authorization:'forbidden'}}),read('https://ante-up.fun/api/a'),read('https://ante-up.fun/api/b')]);
  assert.equal(peak,1);assert.equal(calls,2);
  assert.deepEqual(await Promise.all(rows.map(r=>r.text())),['observed','observed','observed']);
  await assert.rejects(read('https://ante-up.fun/api/a',{method:'POST'}),/READ_ONLY/);
  await assert.rejects(read('https://unapproved.test/'),/READ_ONLY/);
});
test('retries bounded 429s but does not cache errors or hide other failures',async()=>{
  const sleeps=[];let calls=0;
  const read=createPublicQaFetcher({intervalMs:0,wait:async ms=>sleeps.push(ms),fetcher:async()=>{
    calls++;return calls===1?new Response('',{status:429,headers:{'Retry-After':'1'}}):new Response('ready');
  }});
  assert.equal(await (await read('https://ante-up.fun/api/a')).text(),'ready');assert.equal(calls,2);assert.ok(sleeps.includes(1000));
  let failures=0;const fail=createPublicQaFetcher({wait:async()=>{},fetcher:async()=>{failures++;return new Response('',{status:503});}});
  await fail('https://ante-up.fun/api/a');await fail('https://ante-up.fun/api/a');assert.equal(failures,2);
});
