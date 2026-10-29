import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HISTORY_MINUTES } from './index.mjs';
import { XCountsHttpAdapter, FileCollectionState, queryHashFor, runInitialArchive, runRegularPoll } from './live.mjs';
import { runLiveCycle } from './cli.mjs';

const start = Math.floor(1_700_000_000/300)*300;
const rows = (from,through) => Array.from({length:(through-from)/60},(_,i) => ({
  start:new Date((from+i*60)*1000).toISOString(),end:new Date((from+(i+1)*60)*1000).toISOString(),tweet_count:1 }));

test('X Counts URL, bearer header, minute granularity, and archive endpoint use documented encoding', async () => {
  assert.throws(() => new XCountsHttpAdapter({bearerToken:''}),/MISSING_X_BEARER_TOKEN/);
  const calls=[];
  const adapter=new XCountsHttpAdapter({bearerToken:'fixture-token',fetcher:async (url,options) => {
    calls.push({url,options}); return {ok:true,json:async()=>({data:[],meta:{total_tweet_count:0}})};
  }});
  await adapter.count({query:'("Dubai chocolate" OR #DubaiChocolate) lang:en -is:retweet',from:start,through:start+300});
  const u=calls[0].url;
  assert.equal(u.pathname,'/2/tweets/counts/recent'); assert.equal(u.searchParams.get('granularity'),'minute');
  assert.equal(u.searchParams.get('start_time'),new Date(start*1000).toISOString());
  assert.equal(calls[0].options.headers.Authorization,'Bearer fixture-token');
  await adapter.count({query:'"Dubai chocolate" lang:en -is:retweet',from:start,through:start+300,historical:true});
  assert.equal(calls[1].url.pathname,'/2/tweets/counts/all');
  await adapter.count({query:'"Dubai chocolate" lang:en -is:retweet',from:start,through:start+300,
    historical:true,paginationToken:'page-2'});
  assert.equal(calls[2].url.searchParams.get('next_token'),'page-2');
  assert.match(queryHashFor('abc'),/^[a-f0-9]{64}$/);
});

test('archive pagination reserves budget before each page and stops at the cap',async()=>{
  const dir=await mkdtemp(join(process.cwd(),'ante-pages-'));
  try {
    const store=new FileCollectionState(join(dir,'state.json'));let calls=0;const reservations=[];
    const result=await runInitialArchive({store,rawDirectory:join(dir,'raw'),marketId:'fixture:pages',
      expressions:['alpha'],queryVersion:'1',start,through:start+HISTORY_MINUTES*60,
      now:start+HISTORY_MINUTES*60,estimatedCostMicros:1000,totalLimitMicros:1500,
      beforeSourceRequest:request=>reservations.push(request),
      transport:{async count(){calls++;return {data:[],meta:{next_token:'second'}};}}});
    assert.equal(result.state,'FAILED');assert.equal(result.error,'BUDGET_EXHAUSTED');
    assert.equal(result.pages.length,1);assert.equal(calls,1);
    assert.deepEqual(reservations.map(r=>[r.kind,r.costMicros]),[['initial',1000]]);
    assert.equal((await store.read()).totalSpentMicros,1000);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('live cycle forwards a market archive cap before a second paid page',async()=>{
  const dir=await mkdtemp(join(process.cwd(),'ante-cycle-budget-'));
  try {
    let calls=0;
    const result=await runLiveCycle({config:{directory:dir,marketId:'fixture:budget',
      expressions:['alpha'],queryVersion:'1',historyStart:start,estimatedCostMicros:500,
      initialEstimatedCostMicros:1000,
      initialLimitMicros:1000,totalLimitMicros:1000},argv:['--execute','--initial'],
      now:start+HISTORY_MINUTES*60,transport:{async count(){calls++;
        return {data:[],meta:{next_token:'second'}};}}});
    assert.equal(result.state,'FAILED');
    assert.equal(result.error,'BUDGET_EXHAUSTED');
    assert.equal(calls,1);
    assert.equal((await new FileCollectionState(join(dir,'collection.json')).read()).totalSpentMicros,1000);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('durable initial archive and regular five-minute poll charge once before transport', async () => {
  const dir=await mkdtemp(join(process.cwd(),'ante-collection-'));
  try {
    const store=new FileCollectionState(join(dir,'state.json')), rawDirectory=join(dir,'raw');
    const end=start+HISTORY_MINUTES*60;
    let calls=0;
    const transport={async count({from,through}) { calls++; return {data:rows(from,through),meta:{total_tweet_count:(through-from)/60}}; }};
    const common={store,rawDirectory,transport,marketId:'fixture:market',expressions:['Dubai chocolate','#DubaiChocolate'],queryVersion:'1'};
    const initial=await runInitialArchive({...common,start,through:end,now:end,estimatedCostMicros:1000});
    assert.equal(initial.state,'VALIDATED'); assert.equal(initial.calculation.dataStatus,'VALID');
    assert.equal(initial.calculation.sequence,undefined); assert.equal(initial.candidateHash,undefined);
    const poll=await runRegularPoll({...common,historyStart:start,from:end,through:end+300,now:end+300,
      estimatedCostMicros:5000,dailyLimitMicros:6000});
    assert.equal(poll.state,'VALIDATED'); assert.equal(poll.observationCount,5);
    assert.equal(poll.calculation.queryHash,queryHashFor('("Dubai chocolate" OR #DubaiChocolate) lang:en -is:retweet'));
    assert.equal(poll.calculation.sequence,undefined); assert.equal(poll.candidateHash,undefined);
    const repeat=await runRegularPoll({...common,historyStart:start,from:end,through:end+300,now:end+300,
      estimatedCostMicros:5000,dailyLimitMicros:6000});
    assert.deepEqual(repeat,poll); assert.equal(calls,2);
    await assert.rejects(() => runRegularPoll({...common,historyStart:start,from:end+300,through:end+600,now:end+600,
      estimatedCostMicros:5000,dailyLimitMicros:6000}),/BUDGET_EXHAUSTED/);
    assert.equal((await store.read()).spentByDay[new Date((end+300)*1000).toISOString().slice(0,10)],5000);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('failed HTTP attempt remains charged and is not silently retried', async () => {
  const dir=await mkdtemp(join(process.cwd(),'ante-collection-'));
  try {
    const store=new FileCollectionState(join(dir,'state.json')); let calls=0;const reservations=[];
    const params={store,rawDirectory:join(dir,'raw'),transport:{async count(){calls++; throw new Error('X_HTTP_429');}},
      marketId:'fixture:fail',expressions:['alpha'],queryVersion:'1',historyStart:start,
      from:start,through:start+300,now:start+300,estimatedCostMicros:5000,
      beforeSourceRequest:request=>reservations.push(request)};
    assert.equal((await runRegularPoll(params)).state,'FAILED');
    assert.equal((await runRegularPoll(params)).state,'FAILED');
    assert.equal(calls,1); assert.equal((await store.read()).totalSpentMicros,5000);
    const second=await runRegularPoll({...params,now:start+600});
    assert.equal(second.state,'FAILED'); assert.equal(second.attempts,2); assert.equal(second.retryAt,start+1500);
    assert.equal(calls,2); assert.equal((await store.read()).totalSpentMicros,10000);
    assert.deepEqual(reservations.map(r=>[r.kind,r.costMicros]),
      [['regular',5000],['regular',5000]]);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('delayed live poll catches up actual minute buckets without counting multiple recovery observations', async () => {
  const dir=await mkdtemp(join(tmpdir(),'ante-catchup-'));
  try {
    const store=new FileCollectionState(join(dir,'state.json')),end=start+HISTORY_MINUTES*60;
    const calls=[];
    const common={store,rawDirectory:join(dir,'raw'),marketId:'fixture:catchup',expressions:['solana'],queryVersion:'1',estimatedCostMicros:1000,
      transport:{async count({from,through}){calls.push({from,through});return {data:rows(from,through)};}}};
    await runInitialArchive({...common,start,through:end,now:end+700});
    const first=await runRegularPoll({...common,historyStart:start,from:end,through:end+900,now:end+1000});
    assert.equal(first.observationCount,15);
    assert.equal(first.calculation.dataThrough,end+900);
    assert.equal(first.calculation.dataStatus,'VALID');
    assert.equal(first.calculation.admission.state,'RECOVERING');
    assert.equal(first.calculation.admission.recoveryCount,1);
    const second=await runRegularPoll({...common,historyStart:start,from:end+900,through:end+1200,now:end+1300});
    assert.equal(second.calculation.admission.state,'OPEN');
    assert.equal(calls.length,3);
    assert.equal((await store.read()).totalSpentMicros,3000);
  }finally{await rm(dir,{recursive:true,force:true});}
});
