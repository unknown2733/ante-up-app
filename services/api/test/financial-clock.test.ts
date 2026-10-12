import test from 'node:test';
import assert from 'node:assert/strict';
import { type createSolanaRpc } from '@solana/kit';
import { CLOCK_ADDRESS, financialQuoteDeadline, KitConfirmedFinancialClock } from '../src/financial-clock.ts';

const now=1_800_000_000;
test('deadline keeps contract and server ceilings with either sign of one-second clock skew',()=>{
  assert.equal(financialQuoteDeadline(now,now,{unixTimestamp:now-1,observedAt:now}),now+28);
  assert.equal(financialQuoteDeadline(now,now,{unixTimestamp:now+1,observedAt:now}),now+30);
  assert.equal(financialQuoteDeadline(now,now,{unixTimestamp:now+10,observedAt:now}),now+30);
  assert.equal(financialQuoteDeadline(now,now,{unixTimestamp:now-10,observedAt:now}),now+19);
  assert.equal(financialQuoteDeadline(now-3,now,{unixTimestamp:now,observedAt:now}),now+27);
});
test('stale, invalid, large past/future skew and already expired quotes fail closed',()=>{
  for(const sample of [
    {unixTimestamp:now-11,observedAt:now},{unixTimestamp:now+11,observedAt:now},
    {unixTimestamp:now,observedAt:now-6},{unixTimestamp:now,observedAt:now+1},
    {unixTimestamp:NaN,observedAt:now},{unixTimestamp:now+.5,observedAt:now},
    {unixTimestamp:-1,observedAt:now}]) {
    assert.throws(()=>financialQuoteDeadline(now,now,sample),/REQUOTE_REQUIRED/);
  }
  assert.throws(()=>financialQuoteDeadline(now-30,now,{unixTimestamp:now,observedAt:now}),/REQUOTE_REQUIRED/);
});

function setup() {
  const bytes=Buffer.alloc(40);bytes.writeBigUInt64LE(100n,0);bytes.writeBigInt64LE(BigInt(now-1),32);
  const response={context:{slot:100n},value:{owner:'Sysvar1111111111111111111111111111111111111',executable:false,data:[bytes.toString('base64'),'base64']}};
  let elapsed=0;
  let calls=0;
  const rpc={getSlot(options:unknown){assert.deepEqual(options,{commitment:'confirmed'});return {async send(){calls++;return 100n;}};},
    getAccountInfo(account:unknown,options:unknown){assert.equal(account,CLOCK_ADDRESS);assert.deepEqual(options,{commitment:'confirmed',encoding:'base64',minContextSlot:100n});return {async send(){calls++;return response;}};}} as unknown as ReturnType<typeof createSolanaRpc>;
  const clock=new KitConfirmedFinancialClock('https://invalid.test',{rpc,now:()=>now,monotonic:()=>calls===0?0:elapsed});
  return {clock,response,setElapsed:(n:number)=>{elapsed=n;}};
}
test('clock reads confirmed slot and account with minimum context, validates sysvar bytes',async()=>{
  const f=setup();assert.deepEqual(await f.clock.read(),{unixTimestamp:now-1,observedAt:now});
});
test('slow response, stale context, invalid owner and corrupt Clock fail closed',async()=>{
  for (const mutate of [
    (f:ReturnType<typeof setup>)=>f.setElapsed(5001),
    (f:ReturnType<typeof setup>)=>{f.response.context.slot=99n;},
    (f:ReturnType<typeof setup>)=>{f.response.value.owner='wrong';},
    (f:ReturnType<typeof setup>)=>{f.response.value.data[0]=Buffer.alloc(39).toString('base64');},
    (f:ReturnType<typeof setup>)=>{const b=Buffer.alloc(40);b.writeBigInt64LE(BigInt(now-11),32);f.response.value.data[0]=b.toString('base64');},
  ]) {const f=setup();mutate(f);await assert.rejects(()=>f.clock.read(),/^Error: REQUOTE_REQUIRED$/);}
});
