import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {collect, notification, runOnce, validateConfig} from './monitor.mjs';
import {GlobalXBudget} from '../../services/data/global-budget.mjs';

const now=Date.parse('2026-10-16T08:00:00Z'),at=now/1000;
const market='11111111111111111111111111111111',program='22222222222222222222222222222222';
async function fixture(t){
  const parent=resolve('.codex-tmp/ops-tests');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'monitor-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const state=join(dir,'state'),live=join(state,'live-smoke');await mkdir(join(live,'evidence'),{recursive:true});await mkdir(join(state,'health'));
  const save=async(path,value)=>writeFile(path,JSON.stringify(value));
  await save(join(live,'collection.json'),{totalSpentMicros:100,spentByDay:{'2026-10-16':10},batches:{},markets:{[market]:{lastPollAt:at-100}}});
  await save(join(live,'candidates.json'),{jobs:{}});await save(join(live,'evidence/budget.json'),{version:1,reservations:{}});
  await save(join(state,'health/collector.json'),{at:now-1000,lastPollAt:at-100});
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

test('an evidence admission guard failure raises an operational alert',async t=>{
  const f=await fixture(t);
  f.config.services.push({name:'evidence',path:'health/evidence.json',maxAgeSeconds:180});
  await f.save(join(f.config.stateDirectory,'health/evidence.json'),{at:now-1000,held:0,admissionGuard:'UNSAFE'});
  const report=await collect(f.config,{now,fetcher:f.fetcher});
  assert.ok(report.alerts.some(alert=>alert.id==='PROOF_ADMISSION_UNSAFE:evidence'));
});

test('an additional keyword is monitored from its own collection journal and shared finalized index',async t=>{
  const f=await fixture(t),extra='33333333333333333333333333333333';
  await mkdir(join(f.config.stateDirectory,'tariff'));
  await f.save(join(f.config.stateDirectory,'tariff/collection.json'),
    {markets:{[extra]:{lastPollAt:at-100}},batches:{},totalSpentMicros:15000,spentByDay:{}});
  await f.save(join(f.config.stateDirectory,'health/collector-tariff.json'),{at:now-1000,lastPollAt:at-100});
  const db=new DatabaseSync(f.dbPath);
  db.prepare('INSERT INTO current_snapshots VALUES(?,?,?,?,?)').run('devnet',program,extra,'1',
    JSON.stringify({finality:'finalized',payload:{marketId:extra,dataThrough:at-200}}));
  db.close();
  f.config.markets.push({id:extra,collectionDirectory:'tariff',collectionMaxAgeSeconds:900,snapshotMaxAgeSeconds:900});
  f.config.services.push({name:'collector-tariff',path:'health/collector-tariff.json',maxAgeSeconds:180});
  assert.deepEqual((await collect(f.config,{now,fetcher:f.fetcher})).alerts,[]);
  await f.save(join(f.config.stateDirectory,'tariff/collection.json'),
    {markets:{[extra]:{lastPollAt:at-1800}},batches:{},totalSpentMicros:15000,spentByDay:{}});
  await f.save(join(f.config.stateDirectory,'health/collector-tariff.json'),{at:now-1000,lastPollAt:at-1800});
  const stale=await collect(f.config,{now,fetcher:f.fetcher});
  assert.ok(stale.alerts.some(a=>a.id===`COLLECTION_STALE:${extra}`));
  assert.ok(stale.alerts.some(a=>a.id==='COLLECTION_STALE:collector-tariff'));
  assert.throws(()=>validateConfig({...f.config,markets:[{...f.config.markets[1],collectionDirectory:'../outside'}]}),
    /MONITOR_MARKETS_INVALID/);
});
test('operations alerts use the shared X ledger across approved markets',async t=>{
  const f=await fixture(t),path=join(f.config.stateDirectory,'global-x-budget.sqlite');
  const ledger=new GlobalXBudget(path,{dailyLimitMicros:1000,totalLimitMicros:10000,initialLimitMicros:5000});
  try{
    ledger.reserve({id:'solana',marketId:market,day:'2026-10-16',kind:'regular',costMicros:600,at});
    ledger.reserve({id:'tariff',marketId:'33333333333333333333333333333333',
      day:'2026-10-16',kind:'regular',costMicros:350,at});
  }finally{ledger.close();}
  f.config.xBudget={dailyMicros:1000,totalMicros:10000,initialMicros:5000,
    estimatedRequestMicros:100,ledgerPath:'global-x-budget.sqlite'};
  const report=await collect(f.config,{now,fetcher:f.fetcher});
  assert.deepEqual(report.metrics.xReservedMicros,{total:950,today:950,initial:0});
  assert.ok(report.alerts.some(a=>a.id==='BUDGET_EXHAUSTED:x-daily'));
  assert.throws(()=>validateConfig({...f.config,xBudget:{...f.config.xBudget,ledgerPath:'../private'}}),
    /MONITOR_X_LEDGER_INVALID/);
  await rm(path);
  assert.ok((await collect(f.config,{now,fetcher:f.fetcher})).alerts.some(a=>a.id==='INPUT_UNAVAILABLE:global-x-budget'));
});
test('state quota warns before the collector storage gate and fails at the cap',async t=>{
  const f=await fixture(t),baseline=await collect(f.config,{now,fetcher:f.fetcher});
  const used=baseline.metrics.stateBytes??(await collect({...f.config,maxStateBytes:1},{now,fetcher:f.fetcher})).metrics.stateBytes;
  const near=await collect({...f.config,maxStateBytes:Math.ceil(used/0.85)},{now,fetcher:f.fetcher});
  assert.ok(near.alerts.some(a=>a.code==='STATE_NEAR_LIMIT'));
  const full=await collect({...f.config,maxStateBytes:used},{now,fetcher:f.fetcher});
  assert.ok(full.alerts.some(a=>a.code==='STATE_LIMIT'));
});
test('visitor SOL grant reservations warn before daily and total caps stop first-time visitors',async t=>{
  const f=await fixture(t),path=join(f.live,'index.sqlite.visitor-sol.sqlite');
  const db=new DatabaseSync(path);
  db.exec('CREATE TABLE visitor_sol_grants(request_id TEXT PRIMARY KEY,wallet TEXT,amount TEXT,state TEXT,signature TEXT,at_ms INTEGER)');
  const insert=db.prepare('INSERT INTO visitor_sol_grants VALUES(?,?,?,?,?,?)');
  insert.run('earlier','wallet-a','60000000','FINALIZED',null,now-86400000);
  insert.run('today','wallet-b','20000000','RESERVED',null,now-1000);
  db.close();
  f.config.visitorFaucet={ledgerPath:'live-smoke/index.sqlite.visitor-sol.sqlite',grantLamports:'20000000',dailyCapLamports:'40000000',totalCapLamports:'100000000'};
  const near=await collect(f.config,{now,fetcher:f.fetcher});
  assert.deepEqual(near.metrics.visitorSolReservedLamports,{total:'80000000',today:'20000000'});
  assert.ok(near.alerts.some(a=>a.id==='BUDGET_NEAR_LIMIT:visitor-sol-total'));
  assert.ok(!near.alerts.some(a=>a.id==='BUDGET_EXHAUSTED:visitor-sol-daily'));
  const exhausted=await collect({...f.config,visitorFaucet:{...f.config.visitorFaucet,totalCapLamports:'90000000',dailyCapLamports:'30000000'}},{now,fetcher:f.fetcher});
  assert.ok(exhausted.alerts.some(a=>a.id==='BUDGET_EXHAUSTED:visitor-sol-total'));
  assert.ok(exhausted.alerts.some(a=>a.id==='BUDGET_EXHAUSTED:visitor-sol-daily'));
  assert.throws(()=>validateConfig({...f.config,visitorFaucet:{...f.config.visitorFaucet,ledgerPath:'../private'}}),/MONITOR_VISITOR_FAUCET_INVALID/);
  await rm(path);
  assert.ok((await collect(f.config,{now,fetcher:f.fetcher})).alerts.some(a=>a.id==='INPUT_UNAVAILABLE:visitor-sol'));
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
test('dedicated Telegram alerts send and resolve without exposing the bot token',async t=>{
  const f=await fixture(t),token='123456:'+('a'.repeat(24)),sent=[];
  f.config.telegramTokenFile=join(f.dir,'telegram.token');
  f.config.telegramChatIdFile=join(f.dir,'telegram.chat-id');
  await writeFile(f.config.telegramTokenFile,token);
  await writeFile(f.config.telegramChatIdFile,'-1001234567890');
  await rm(join(f.live,'collection.json'));
  const fetcher=async(url,request)=>{
    if(url.startsWith('https://api.telegram.org/')) {
      sent.push({url,body:JSON.parse(request.body)});
      return {ok:true,json:async()=>({ok:true})};
    }
    return f.fetcher(url,request);
  };
  await runOnce(f.config,{now,send:true,fetcher});
  assert.equal(sent.length,1);
  assert.equal(sent[0].body.chat_id,'-1001234567890');
  assert.match(sent[0].body.text,/ALERT critical: INPUT_UNAVAILABLE \(collection\)/);
  assert.equal(JSON.stringify(sent[0].body).includes(token),false);
  await runOnce(f.config,{now:now+1000,send:true,fetcher});
  assert.equal(sent.length,1);
  await f.save(join(f.live,'collection.json'),{totalSpentMicros:0,spentByDay:{},batches:{},markets:{[market]:{lastPollAt:at}}});
  await runOnce(f.config,{now:now+2000,send:true,fetcher});
  assert.equal(sent.length,2);
  assert.match(sent[1].body.text,/RESOLVED: INPUT_UNAVAILABLE \(collection\)/);
  await rm(join(f.live,'collection.json'));
  const failed=async(url,request)=>url.startsWith('https://api.telegram.org/')?{ok:false,json:async()=>({ok:false,description:'private'})}:f.fetcher(url,request);
  await assert.rejects(runOnce(f.config,{now:now+3000,send:true,fetcher:failed}),error=>error.message==='ALERT_DELIVERY_FAILED'&&!error.message.includes(token));
  const ack=JSON.parse(await readFile(join(f.config.runtimeDirectory,'notifications.json'),'utf8'));
  assert.equal(Object.keys(ack).length,0);
});
test('configuration rejects invalid budgets, scope and writable runtime inside state',async t=>{
  const f=await fixture(t);assert.throws(()=>validateConfig({...f.config,xBudget:{...f.config.xBudget,dailyMicros:NaN}}),/MONITOR_X_BUDGET_INVALID/);
  assert.throws(()=>validateConfig({...f.config,runtimeDirectory:join(f.config.stateDirectory,'observer')}),/MONITOR_DIRECTORIES_REQUIRED/);
  assert.throws(()=>validateConfig({...f.config,liveDirectory:'../escape'}),/MONITOR_SCOPE_INVALID/);
  assert.throws(()=>validateConfig({...f.config,telegramTokenFile:'/private/token'}),/MONITOR_ALERT_CHANNEL_INVALID/);
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
