import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {collect, notification, runOnce, validateConfig} from './monitor.mjs';

const now=Date.parse('2026-10-16T08:00:00Z'),at=now/1000;
const market='11111111111111111111111111111111',program='22222222222222222222222222222222';
async function fixture(t){
  const parent=resolve('.codex-tmp/ops-tests');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'monitor-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const state=join(dir,'state'),live=join(state,'live-smoke');await mkdir(join(live,'evidence'),{recursive:true});await mkdir(join(state,'health'));
  const save=async(path,value)=>writeFile(path,JSON.stringify(value));
  await save(join(live,'collection.json'),{totalSpentMicros:100,spentByDay:{'2026-10-16':10},batches:{},markets:{[market]:{lastPollAt:at-100}}});
  await save(join(live,'candidates.json'),{jobs:{}});await save(join(live,'evidence/budget.json'),{version:1,reservations:{}});
  await save(join(state,'health/collector.json'),{at:now-1000});
  await save(join(state,'health/price-history.json'),{atMs:now-1000,status:'PARTIAL',valid:1,noData:2,readErrors:0});
  const dbPath=join(live,'index.sqlite'),db=new DatabaseSync(dbPath);
  db.exec('CREATE TABLE current_snapshots(cluster TEXT,program_id TEXT,market_id TEXT,sequence TEXT,snapshot_json TEXT); CREATE TABLE current_free_records(cluster TEXT,program_id TEXT,record_json TEXT);');
  db.prepare('INSERT INTO current_snapshots VALUES(?,?,?,?,?)').run('devnet',program,market,'1',JSON.stringify({finality:'finalized',payload:{marketId:market,dataThrough:at-200}}));db.close();
  const rpcUrlFile=join(dir,'rpc.url');await writeFile(rpcUrlFile,'https://rpc.invalid/secret-token');
  const sha='a'.repeat(64);await save(join(dir,'copy.json'),{version:1,kind:'backup-copy',destinationId:'remote',verification:'destination-readback-sha256',verifiedAt:new Date(now-5000).toISOString(),sha256:sha});
  await save(join(dir,'drill.json'),{kind:'isolated-restore-drill',hashes:'matched',servicesStarted:false,backupSha256:sha,verifiedAt:new Date(now-1000).toISOString()});
  const config={version:1,monitorId:'test',stateDirectory:state,runtimeDirectory:join(dir,'observer'),liveDirectory:'live-smoke',programId:program,
    markets:[{id:market,collectionMaxAgeSeconds:900,snapshotMaxAgeSeconds:900}],
    services:[{name:'collector',path:'health/collector.json',maxAgeSeconds:180},{name:'price-history',path:'health/price-history.json',maxAgeSeconds:900}],
    pendingPublishMaxAgeSeconds:900,proofMaxAgeSeconds:86400,maxProofBacklog:10,repeatSeconds:3600,intervalSeconds:60,minFreeBytes:1,
    budgetWarningPercent:80,xBudget:{dailyMicros:1000,totalMicros:10000,estimatedRequestMicros:10},proofBudget:{dailyWinc:'100000000000000000000',totalWinc:'200000000000000000000'},
    rpcUrlFile,wallets:[{role:'publisher',address:market,minLamports:'10000000'}],backup:{copyReceipt:join(dir,'copy.json'),drillReport:join(dir,'drill.json'),destinationId:'remote',maxAgeSeconds:172800}};
  const calls=[];const fetcher=async(url,request)=>{
    const body=JSON.parse(request.body);calls.push(body);
    return {ok:true,json:async()=>({result:body.method==='getGenesisHash'?'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG':{value:50000000}})};
  };
  return {dir,config,save,live,dbPath,fetcher,calls};
}
test('healthy observer accepts partial price coverage and makes only Devnet read RPCs',async t=>{
  const f=await fixture(t),report=await collect(f.config,{now,fetcher:f.fetcher});
  assert.deepEqual(report.alerts,[]);assert.equal(report.status,'OK');
  assert.deepEqual(f.calls.map(c=>c.method),['getGenesisHash','getBalance']);assert.equal(f.calls[1].params[1].commitment,'finalized');
});
test('state quota warns before the collector storage gate and fails at the cap',async t=>{
  const f=await fixture(t),baseline=await collect(f.config,{now,fetcher:f.fetcher});
  const used=baseline.metrics.stateBytes??(await collect({...f.config,maxStateBytes:1},{now,fetcher:f.fetcher})).metrics.stateBytes;
  const near=await collect({...f.config,maxStateBytes:Math.ceil(used/0.85)},{now,fetcher:f.fetcher});
  assert.ok(near.alerts.some(a=>a.code==='STATE_NEAR_LIMIT'));
  const full=await collect({...f.config,maxStateBytes:used},{now,fetcher:f.fetcher});
  assert.ok(full.alerts.some(a=>a.code==='STATE_LIMIT'));
});
test('detects stalled collection/publication, proof obligations outside allowlist, budgets and wallets',async t=>{
  const f=await fixture(t);
  await f.save(join(f.live,'collection.json'),{markets:{[market]:{lastPollAt:at-80000}},batches:{uncertain:{id:'uncertain',state:'REQUESTING',requestedAt:at-5000}},totalSpentMicros:9995,spentByDay:{'2026-10-16':800}});
  await f.save(join(f.live,'candidates.json'),{jobs:{stuck:{id:'stuck',state:'PUBLISHING',candidate:{computedAt:at-80000}}}});
  await f.save(join(f.live,'evidence/budget.json'),{version:1,reservations:{a:{day:'2026-10-15',winc:'199999999999999999999',byDay:{'2026-10-16':'100000000000000000000'}}}});
  const db=new DatabaseSync(f.dbPath);
  db.prepare('UPDATE current_snapshots SET snapshot_json=?').run(JSON.stringify({finality:'finalized',payload:{marketId:market,dataThrough:at-80000}}));
  db.prepare('INSERT INTO current_free_records VALUES(?,?,?)').run('devnet',program,JSON.stringify({id:'not-allowlisted',status:'CLOSED_NA',finality:'finalized',proofId:null,exit:{executedAt:at-90000}}));db.close();
  const fetcher=async(_url,request)=>({ok:true,json:async()=>({result:JSON.parse(request.body).method==='getGenesisHash'?'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG':{value:1}})});
  const report=await collect({...f.config,maxProofBacklog:1},{now,fetcher});const codes=new Set(report.alerts.map(a=>a.code));
  for(const code of ['COLLECTION_STALE','SNAPSHOT_STALE','PUBLICATION_STUCK','PROOF_OVERDUE','PROOF_BACKLOG','BUDGET_EXHAUSTED','BUDGET_NEAR_LIMIT','WALLET_LOW','X_REQUEST_UNCERTAIN'])assert.ok(codes.has(code),code);
  assert.equal(report.metrics.proofReservedWinc.total,'199999999999999999999');assert.equal(report.metrics.proofBacklog,1);
});
test('missing inputs, future timestamps, failed RPC, stale copy and mismatched drill never look healthy',async t=>{
  const f=await fixture(t);await rm(join(f.live,'collection.json'));
  await f.save(join(f.config.stateDirectory,'health/collector.json'),{at:now+60000});
  await f.save(join(f.dir,'copy.json'),{version:1,kind:'backup-copy',verifiedAt:new Date(now-200000000).toISOString(),sha256:'b'.repeat(64)});
  const report=await collect(f.config,{now,fetcher:async()=>{throw Error('secret-provider-url');}});
  const codes=new Set(report.alerts.map(a=>a.code));for(const code of ['INPUT_UNAVAILABLE','TIMESTAMP_INVALID','RPC_UNAVAILABLE','BACKUP_COPY_STALE','RESTORE_DRILL_MISMATCH'])assert.ok(codes.has(code));
  assert.equal(JSON.stringify(report).includes('secret-provider-url'),false);assert.equal(JSON.stringify(report).includes('secret-token'),false);
});
test('notifications deduplicate, repeat, resolve and retry failed delivery without advancing ack',async t=>{
  const f=await fixture(t);await rm(join(f.live,'collection.json'));const webhook=join(f.dir,'webhook');await writeFile(webhook,'https://notify.invalid/private-token');f.config.webhookUrlFile=webhook;
  const dry=await runOnce(f.config,{now,fetcher:f.fetcher});assert.equal(dry.delivery.enabled,false);assert.equal(dry.delivery.pending,1);
  const failed=async(url,request)=>url.includes('notify.invalid')?{ok:false}:f.fetcher(url,request);
  await assert.rejects(runOnce(f.config,{now,send:true,fetcher:failed}),/ALERT_DELIVERY_FAILED/);
  await assert.rejects(readFile(join(f.config.runtimeDirectory,'notifications.json')),/ENOENT/);
  const events=[],success=async(url,request)=>{if(url.includes('notify.invalid')){events.push(JSON.parse(request.body));return {ok:true};}return f.fetcher(url,request);};
  await runOnce(f.config,{now,send:true,fetcher:success});assert.equal(events[0].firing.length,1);
  await runOnce(f.config,{now:now+1000,send:true,fetcher:success});assert.equal(events.length,1);
  const previous=JSON.parse(await readFile(join(f.config.runtimeDirectory,'notifications.json'),'utf8'));
  assert.equal(notification({...dry,at:new Date(now+3600000).toISOString()},previous,3600).firing.length,1);
  await f.save(join(f.live,'collection.json'),{totalSpentMicros:0,spentByDay:{},batches:{},markets:{[market]:{lastPollAt:at}}});
  await runOnce(f.config,{now:now+2000,send:true,fetcher:success});assert.equal(events.length,2);assert.equal(events[1].resolved.length,1);
});
test('configuration rejects invalid budgets, scope and writable runtime inside state',async t=>{
  const f=await fixture(t);assert.throws(()=>validateConfig({...f.config,xBudget:{...f.config.xBudget,dailyMicros:NaN}}),/MONITOR_X_BUDGET_INVALID/);
  assert.throws(()=>validateConfig({...f.config,runtimeDirectory:join(f.config.stateDirectory,'observer')}),/MONITOR_DIRECTORIES_REQUIRED/);
  assert.throws(()=>validateConfig({...f.config,liveDirectory:'../escape'}),/MONITOR_SCOPE_INVALID/);
});
test('null or array input does not suppress required-state findings',async t=>{
  const f=await fixture(t);await f.save(join(f.live,'collection.json'),null);await f.save(join(f.live,'candidates.json'),[]);
  const report=await collect(f.config,{now,fetcher:f.fetcher});
  assert.ok(report.alerts.some(a=>a.id==='INPUT_INVALID:collection'));assert.ok(report.alerts.some(a=>a.id==='INPUT_INVALID:publications'));
});
test('actual loopback HTTP receiver sees JSON firing, acknowledged deduplication and recovery',async t=>{
  const f=await fixture(t),events=[];
  const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;events.push({method:req.method,type:req.headers['content-type'],data:JSON.parse(body)});res.writeHead(204);res.end();});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(done=>server.close(done)));
  const urlFile=join(f.dir,'local-webhook');await writeFile(urlFile,`http://127.0.0.1:${server.address().port}/alerts`);f.config.webhookUrlFile=urlFile;
  const fetcher=(url,request)=>url.startsWith('http://127.0.0.1:')?fetch(url,request):f.fetcher(url,request);
  await rm(join(f.live,'candidates.json'));await runOnce(f.config,{send:true,now,fetcher});await runOnce(f.config,{send:true,now:now+1000,fetcher});
  assert.equal(events.length,1);assert.equal(events[0].method,'POST');assert.equal(events[0].type,'application/json');assert.equal(events[0].data.firing[0].code,'INPUT_UNAVAILABLE');
  await f.save(join(f.live,'candidates.json'),{jobs:{}});await runOnce(f.config,{send:true,now:now+2000,fetcher});
  assert.equal(events.length,2);assert.equal(events[1].data.resolved.length,1);
});
