import test from 'node:test';
import assert from 'node:assert/strict';
import {getBase58Decoder,createSolanaRpc} from '@solana/kit';
import {KitFinalizedAccountReader} from '../src/repositories.ts';
import {withRpcReadFailover} from '../src/rpc-failover.ts';

type Rpc=ReturnType<typeof createSolanaRpc>;
const key=(id:number)=>{const bytes=new Uint8Array(32);new DataView(bytes.buffer).setUint32(0,id);return getBase58Decoder().decode(bytes);};
const account=(n=1)=>({owner:key(99),data:[Buffer.from([n]).toString('base64'),'base64']});

test('concurrent addresses batch at finalized commitment, same address dedupes and callers own their bytes',async()=>{
  const calls:string[][]=[];let complete!:(value:unknown)=>void;
  const rpc={getMultipleAccounts:(keys:string[],options:unknown)=>({send:()=>{
    assert.deepEqual(options,{commitment:'finalized',encoding:'base64'});calls.push(keys);
    return new Promise(resolve=>{complete=resolve;});
  }})} as unknown as Rpc;
  const reader=new KitFinalizedAccountReader('https://unused.invalid',rpc);
  const a=reader.get(key(1)),b=reader.get(key(2)),same=reader.get(key(1));
  await Promise.resolve();assert.deepEqual(calls,[[key(1),key(2)]]);
  const lateSame=reader.get(key(1));complete({value:[account(7),null]});
  const [av,bv,sv,lv]=await Promise.all([a,b,same,lateSame]);
  assert.equal(bv,null);assert.equal(av!.data[0],7);assert.equal(sv!.data[0],7);assert.equal(lv!.data[0],7);
  av!.data[0]=0;assert.equal(sv!.data[0],7);assert.equal(lv!.data[0],7);
  const fresh=reader.get(key(1));await Promise.resolve();assert.equal(calls.length,2);
  complete({value:[account(8)]});assert.equal((await fresh)!.data[0],8);
});

test('large bursts split into at most 100 accounts and at most one outstanding batch',async()=>{
  const counts:number[]=[];let active=0,maximum=0;
  const rpc={getMultipleAccounts:(keys:string[])=>({send:async()=>{
    counts.push(keys.length);active++;maximum=Math.max(maximum,active);await Promise.resolve();active--;
    return {value:keys.map(()=>account())};
  }})} as unknown as Rpc;
  const reader=new KitFinalizedAccountReader('https://unused.invalid',rpc);
  const result=await Promise.all(Array.from({length:205},(_,i)=>reader.get(key(i+1))));
  assert.deepEqual(counts,[100,100,5]);assert.equal(maximum,1);assert.equal(result.length,205);
});

test('a new address arriving during an in-flight batch waits for a separate fresh request',async()=>{
  const batches:string[][]=[];const completions:Array<(value:unknown)=>void>=[];
  const rpc={getMultipleAccounts:(keys:string[])=>({send:()=>{batches.push(keys);return new Promise(resolve=>completions.push(resolve));}})} as unknown as Rpc;
  const reader=new KitFinalizedAccountReader('https://unused.invalid',rpc);
  const first=reader.get(key(1));await Promise.resolve();
  const second=reader.get(key(2));await Promise.resolve();assert.equal(batches.length,1);
  completions[0]({value:[null]});await first;
  assert.deepEqual(batches,[[key(1)],[key(2)]]);
  completions[1]({value:[account(9)]});assert.equal((await second)!.data[0],9);
});

test('malformed count, data, owner or encoding rejects whole batch and does not cache failure',async()=>{
  for(const bad of [[],[account()],[account(),undefined],[account(),{owner:key(9),data:['%%%','base64']}],
    [account(),{owner:key(9),data:['AA==','base58']}],[account(),{owner:'invalid',data:['AA==','base64']}],
    [account(),{owner:key(9),data:['AA','base64']}],{not:'array'}]){
    let calls=0;
    const rpc={getMultipleAccounts:(keys:string[])=>({send:async()=>({value:++calls===1?bad:keys.map(()=>account(3))})})} as unknown as Rpc;
    const reader=new KitFinalizedAccountReader('https://unused.invalid',rpc);
    const outcomes=await Promise.allSettled([reader.get(key(1)),reader.get(key(2))]);
    assert(outcomes.every(result=>result.status==='rejected'));
    assert.equal((await reader.get(key(1)))!.data[0],3);assert.equal(calls,2);
  }
});

test('transport failure rejects all waiters then a subsequent request reads anew',async()=>{
  let calls=0;
  const rpc={getMultipleAccounts:()=>({send:async()=>{if(++calls===1)throw Error('NETWORK_DOWN');return {value:[account(4)]};}})} as unknown as Rpc;
  const reader=new KitFinalizedAccountReader('https://unused.invalid',rpc);
  const result=await Promise.allSettled([reader.get(key(1)),reader.get(key(1))]);
  assert(result.every(item=>item.status==='rejected'));assert.equal(calls,1);
  assert.equal((await reader.get(key(1)))!.data[0],4);assert.equal(calls,2);
});

test('batched finalized reads fail over on 429 while transaction submission never replays',async()=>{
  let primaryReads=0,backupReads=0,backupSends=0,genesis=0;
  const primary={getMultipleAccounts:()=>({send:async()=>{primaryReads++;throw Error('HTTP 429');}}),
    sendTransaction:()=>({send:async()=>{throw Error('HTTP 429');}})} as unknown as Rpc;
  const backup={getGenesisHash:()=>({send:async()=>{genesis++;return 'devnet';}}),
    getMultipleAccounts:(keys:string[],options:unknown)=>({send:async()=>{backupReads++;assert.deepEqual(options,{commitment:'finalized',encoding:'base64'});return {value:keys.map(()=>account())};}}),
    sendTransaction:()=>({send:async()=>{backupSends++;return 'signature';}})} as unknown as Rpc;
  const rpc=withRpcReadFailover(primary,backup,{expectedGenesisHash:'devnet'});
  const reader=new KitFinalizedAccountReader('https://unused.invalid',rpc);
  await Promise.all([reader.get(key(1)),reader.get(key(2))]);
  assert.deepEqual([primaryReads,backupReads,genesis],[1,1,1]);
  await assert.rejects(rpc.sendTransaction('wire' as any).send(),/429/);assert.equal(backupSends,0);
});
