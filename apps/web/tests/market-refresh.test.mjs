import test from 'node:test';
import assert from 'node:assert/strict';
import {createMarketRefresh,mergeMarketRead,currentMarketRead} from '../src/marketRefresh.ts';
import {marketStatusView} from '../src/marketStatus.ts';
const market=(state='CURRENT',id='a')=>({id,phase:'INDEXED',dataStatus:'VALID',price:state==='CURRENT'?{kind:'indexed',atoms:'1000000',executable:true}:null,
  priceReadiness:{state,dataThrough:1000},capabilities:{openPro:{allowed:state==='CURRENT',reason:null}}});
function setup(load,id='a'){
 const states=[],timers=[];
 const reader=createMarketRefresh({id,load,publish:s=>states.push(s),visible:()=>true,
  schedule:(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer;},cancel:timer=>{timer.cancelled=true;}});
 return {reader,states,timers};
}
test('mismatch auto refreshes to current, stale stays distinct, RPC retry holds executable values',async()=>{
 let value=market('SYNCING'),fail=false;
 const {reader,states,timers}=setup(async()=>{if(fail)throw Error('HTTP 503');return {data:value};});
 await reader.retry();assert.equal(timers.at(-1).ms,5000);
 assert.equal(marketStatusView(states.at(-1).value).label,'Syncing latest observation');
 value=market();await timers.at(-1).fn();await new Promise(r=>setImmediate(r));
 assert.equal(states.at(-1).value.price.executable,true);assert.equal(timers.at(-1).ms,60000);
 fail=true;await reader.retry();
 assert.equal(states.at(-1).value.price,null);assert.equal(states.at(-1).value.capabilities.openPro.allowed,false);
 assert.match(states.at(-1).error,/data service/);assert.equal(timers.at(-1).ms,15000);
 fail=false;value=market('STALE');await reader.retry();
 assert.equal(marketStatusView(states.at(-1).value).label,'Observation delayed');
 reader.stop();assert.equal(timers.at(-1).cancelled,true);
});
test('manual retry supersedes an older response and market switch cancels old publication',async()=>{
 const requests=[];const a=setup(()=>new Promise(resolve=>requests.push(resolve)));
 const old=a.reader.retry();await a.reader.retry();await a.reader.retry();
 assert.equal(requests.length,1,'one in-flight request; repeated retry is coalesced');
 requests[0]({data:market('STALE')});await old;
 assert.equal(requests.length,2);
 requests[1]({data:market()});await new Promise(r=>setImmediate(r));
 assert.equal(a.states.at(-1).value.priceReadiness.state,'CURRENT');
 const pending=a.reader.retry(),count=a.states.length;a.reader.stop();
 const b=setup(async()=>({data:market('SYNCING','b')}),'b');await b.reader.retry();
 requests[2]({data:market()});await pending;assert.equal(a.states.length,count);
 assert.equal(b.states.at(-1).value.id,'b');
 b.reader.stop();
});
test('same-market revisions keep the financial panel mounted while blocking new actions',()=>{
 const previous={identity:'devnet:a',revision:'0',value:market(),loading:false,error:''};
 const beforeEffect=currentMarketRead(previous,'devnet:a','1');
 assert.equal(beforeEffect.value.id,'a');assert.equal(beforeEffect.value.price,null);assert.equal(beforeEffect.loading,true);
 const loading=mergeMarketRead(previous,{value:null,loading:true,error:''},'devnet:a','1');
 assert.equal(loading.value.id,'a');assert.equal(loading.value.capabilities.openPro.allowed,false);
 const failed=mergeMarketRead(loading,{value:null,loading:false,error:'RPC failed'},'devnet:a','1');
 assert.equal(failed.value.id,'a');assert.equal(failed.value.price,null);
 assert.equal(currentMarketRead(failed,'devnet:b','1').value,null);
});

test('price refresh preserves only existing fixed-claim eligibility within the same market identity',()=>{
 const previous={identity:'devnet:a',revision:'0',value:{...market(),capabilities:{claim:{allowed:true,reason:null},openPro:{allowed:true},spotBuy:{allowed:true},depositLP:{allowed:true}}},loading:false,error:''};
 const held=currentMarketRead(previous,'devnet:a','1');
 assert.equal(held.value.price,null);
 assert.equal(held.value.capabilities.claim.allowed,true);
 for(const action of ['openPro','spotBuy','depositLP'])assert.equal(held.value.capabilities[action].allowed,false);
 assert.equal(currentMarketRead(previous,'devnet:b','1').value,null);
 assert.equal(currentMarketRead(previous,'localnet:a','1').value,null);
 const denied={...previous,value:{...previous.value,capabilities:{claim:{allowed:false,reason:'LIMIT_REACHED'}}}};
 assert.equal(currentMarketRead(denied,'devnet:a','1').value.capabilities.claim.allowed,false);
});

test('a market RPC failure holds price actions but keeps fixed claims subject to their own checks',async()=>{
 let failed=false;
 const value={...market(),capabilities:{claim:{allowed:true,reason:null},spotBuy:{allowed:true},openPro:{allowed:true},depositLP:{allowed:true}}};
 const {reader,states}=setup(async()=>{if(failed)throw Error('HTTP 503');return {data:value};});
 await reader.retry();failed=true;await reader.retry();
 const held=states.at(-1);
 assert.ok(held.error);assert.equal(held.value.price,null);assert.equal(held.value.capabilities.claim.allowed,true);
 for(const action of ['spotBuy','openPro','depositLP'])assert.equal(held.value.capabilities[action].allowed,false);
 reader.stop();
});
