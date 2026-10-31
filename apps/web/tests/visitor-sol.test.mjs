import test from 'node:test';
import assert from 'node:assert/strict';
import {createVisitorSolFlow} from '../src/visitorSol.ts';

const context={address:'939RPDweeCfV1s39nND2KsARHesEvaH5MqhjxV5soKQv',cluster:'devnet',signer:{}};
const envelope=data=>({schemaVersion:'0.1',mode:'devnet',asOf:1_800_000_000,nextCursor:null,data});

test('SOL readiness accepts a real capacity quote and rejects contradictory availability',async()=>{
  let available=true;
  const flow=createVisitorSolFlow({baseUrl:'https://example.test/api',getWallet:()=>context,
    authorize:async()=>{throw Error('readiness is public');},
    fetcher:async()=>new Response(JSON.stringify(envelope({
      balanceLamports:'0',minimumBalanceLamports:'10000000',needsSol:true,serverGrantEnabled:true,
      grantLamports:'20000000',grantRemaining:'15',serverGrantAvailable:available,
      grantUnavailableReason:null})))});
  assert.equal((await flow.readiness()).grantRemaining,'15');
  available=false;
  await assert.rejects(flow.readiness(),/response is invalid/);
});

test('lost response retains the same SOL grant request ID for a safe retry',async()=>{
  const saved=new Map();const requests=[];
  let failOnce=true;
  const flow=createVisitorSolFlow({baseUrl:'https://example.test/api',getWallet:()=>context,
    authorize:async()=>({wallet:context.address,cluster:'devnet',token:'session',expiresAt:1_900_000_000}),
    storage:{getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)},
    requestId:()=> 'request_0001',
    fetcher:async(_url,init)=>{
      requests.push(JSON.parse(init.body));
      if(failOnce){failOnce=false;throw Error('response lost');}
      return new Response(JSON.stringify(envelope({state:'SUBMITTED',signature:'signature1',amountLamports:'5000000'})));
    }});
  await assert.rejects(flow.claim(),/response lost/);
  assert.equal(flow.pending(),'request_0001');
  assert.equal((await flow.claim()).state,'SUBMITTED');
  assert.deepEqual(requests.map(request=>request.requestId),['request_0001','request_0001']);
});
