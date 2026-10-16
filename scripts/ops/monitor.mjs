// Read-only operational observer. No X requests, transaction sends or private keys.
import {readFile, mkdir, readdir, stat, statfs} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as sleep} from 'node:timers/promises';
import {check, json, atomicJson, args, inside} from './common.mjs';

const DECIMAL=/^(0|[1-9][0-9]*)$/;
const positive=x=>Number.isSafeInteger(x)&&x>0;
const address=x=>typeof x==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x);
const safeRelative=x=>typeof x==='string'&&x.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!/[\\:\x00]/.test(p));
export function validateConfig(c) {
  check(c.version===1&&typeof c.monitorId==='string'&&/^[a-z0-9-]{1,64}$/.test(c.monitorId),'MONITOR_CONFIG_INVALID');
  check(typeof c.stateDirectory==='string'&&typeof c.runtimeDirectory==='string'&&!inside(c.stateDirectory,c.runtimeDirectory)&&!inside(c.runtimeDirectory,c.stateDirectory),'MONITOR_DIRECTORIES_REQUIRED');
  check(safeRelative(c.liveDirectory)&&address(c.programId),'MONITOR_SCOPE_INVALID');
  check(Array.isArray(c.markets)&&c.markets.length>0&&c.markets.every(m=>address(m.id)&&positive(m.collectionMaxAgeSeconds)&&positive(m.snapshotMaxAgeSeconds)),'MONITOR_MARKETS_INVALID');
  check(Array.isArray(c.services)&&c.services.length>0&&c.services.every(s=>safeRelative(s.path)&&typeof s.name==='string'&&/^[a-z0-9-]+$/.test(s.name)&&positive(s.maxAgeSeconds)),'MONITOR_SERVICES_INVALID');
  check(positive(c.pendingPublishMaxAgeSeconds)&&positive(c.proofMaxAgeSeconds)&&positive(c.maxProofBacklog)&&positive(c.repeatSeconds)&&positive(c.intervalSeconds)&&positive(c.minFreeBytes),'MONITOR_THRESHOLDS_INVALID');
  if(c.maxStateBytes!==undefined)check(positive(c.maxStateBytes),'MONITOR_STATE_LIMIT_INVALID');
  check(positive(c.xBudget?.dailyMicros)&&positive(c.xBudget?.totalMicros)&&positive(c.xBudget?.estimatedRequestMicros),'MONITOR_X_BUDGET_INVALID');
  check(c.budgetWarningPercent>0&&c.budgetWarningPercent<100&&Number.isInteger(c.budgetWarningPercent),'MONITOR_BUDGET_THRESHOLD_INVALID');
  check(DECIMAL.test(c.proofBudget?.dailyWinc)&&DECIMAL.test(c.proofBudget?.totalWinc)&&BigInt(c.proofBudget.dailyWinc)>0n&&BigInt(c.proofBudget.totalWinc)>0n,'MONITOR_PROOF_BUDGET_INVALID');
  check(Array.isArray(c.wallets)&&c.wallets.length>0&&c.wallets.every(w=>typeof w.role==='string'&&/^[a-z0-9-]+$/.test(w.role)&&address(w.address)&&DECIMAL.test(w.minLamports)),'MONITOR_WALLETS_INVALID');
  check(new Set(c.markets.map(m=>m.id)).size===c.markets.length&&new Set(c.wallets.map(w=>w.role)).size===c.wallets.length&&new Set(c.services.map(s=>s.name)).size===c.services.length,'DUPLICATE_MONITOR_SCOPE');
  check(typeof c.rpcUrlFile==='string','MONITOR_RPC_REQUIRED');
  if(c.httpChecks)check(Array.isArray(c.httpChecks)&&c.httpChecks.every(h=>/^[a-z0-9-]+$/.test(h.name)&&/^https?:\/\//.test(h.url)&&(!h.expectMode||h.expectMode==='devnet')),'MONITOR_HTTP_CHECKS_INVALID');
  if(c.backup)check(typeof c.backup.copyReceipt==='string'&&typeof c.backup.drillReport==='string'&&positive(c.backup.maxAgeSeconds)&&typeof c.backup.destinationId==='string','MONITOR_BACKUP_CONFIG_INVALID');
  return c;
}
export async function rpcCall(endpoint, method, params, fetcher=fetch) {
  const response=await fetcher(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(10000),redirect:'error'});
  check(response.ok,'RPC_UNAVAILABLE');const body=await response.json();check(!body.error&&body.result!==undefined,'RPC_UNAVAILABLE');return body.result;
}
export async function collect(c,{now=Date.now(),fetcher=fetch}={}) {
  validateConfig(c);const alerts=[],metrics={},at=Math.floor(now/1000),live=join(c.stateDirectory,c.liveDirectory);
  const add=(code,scope,severity='critical',values={})=>alerts.push({id:`${code}:${scope}`,code,scope,severity,metrics:values});
  async function load(path,scope){
    try{const value=await json(path);if(value===null||typeof value!=='object'||Array.isArray(value)){add('INPUT_INVALID',scope);return null;}return value;}
    catch{add('INPUT_UNAVAILABLE',scope);return null;}
  }
  function age(seconds,limit,code,scope){
    if(!Number.isSafeInteger(seconds)||seconds<=0||seconds>at+30){add('TIMESTAMP_INVALID',scope);return;}
    if(at-seconds>=limit)add(code,scope,'critical',{ageSeconds:at-seconds,limitSeconds:limit});
  }
  for(const service of c.services){
    const health=await load(join(c.stateDirectory,service.path),`service-${service.name}`);if(!health)continue;
    age(Math.floor((health.at??health.atMs)/1000),service.maxAgeSeconds,'SERVICE_STALE',service.name);
    if(service.name==='price-history'&&!(health.status==='OK'||health.status==='PARTIAL'&&health.valid>0&&health.readErrors===0))add('SERVICE_ERROR',service.name);
    if(service.name==='evidence'&&health.held>0)add('PROOF_WORKER_HELD','evidence','warning',{held:health.held});
  }
  await Promise.all((c.httpChecks??[]).map(async probe=>{
    try{const response=await fetcher(probe.url,{signal:AbortSignal.timeout(10000),redirect:'error'});check(response.ok,'HTTP_UNAVAILABLE');
      if(probe.expectMode)check((await response.json()).mode===probe.expectMode,'HTTP_MODE_MISMATCH');
      else await response.body?.cancel();
    }catch{add('HTTP_UNAVAILABLE',probe.name);}
  }));
  try{const fs=await statfs(c.stateDirectory);metrics.freeBytes=fs.bavail*fs.bsize;if(metrics.freeBytes<c.minFreeBytes)add('DISK_LOW','state','critical',{freeBytes:metrics.freeBytes,minFreeBytes:c.minFreeBytes});}catch{add('INPUT_UNAVAILABLE','disk');}
  if(c.maxStateBytes!==undefined){
    try{
      async function usedBytes(directory){
        let used=0;
        for(const entry of await readdir(directory,{withFileTypes:true})){
          const path=join(directory,entry.name);
          if(entry.isDirectory())used+=await usedBytes(path);
          else if(entry.isFile())used+=(await stat(path)).size;
          else throw Error('UNEXPECTED_STATE_ENTRY');
        }
        return used;
      }
      metrics.stateBytes=await usedBytes(c.stateDirectory);
      const ratio=metrics.stateBytes/c.maxStateBytes;
      if(ratio>=1)add('STATE_LIMIT','state','critical',{usedBytes:metrics.stateBytes,maxStateBytes:c.maxStateBytes});
      else if(ratio>=0.8)add('STATE_NEAR_LIMIT','state','warning',{usedBytes:metrics.stateBytes,maxStateBytes:c.maxStateBytes});
    }catch{add('INPUT_UNAVAILABLE','state-usage');}
  }
  const collection=await load(join(live,'collection.json'),'collection');
  for(const market of c.markets){
    if(collection)age(collection.markets?.[market.id]?.lastPollAt,market.collectionMaxAgeSeconds,'COLLECTION_STALE',market.id);
  }
  const day=new Date(now).toISOString().slice(0,10);
  function budget(value,limit,scope,next=0n){
    const used=BigInt(value),cap=BigInt(limit);check(used>=0n,'BUDGET_VALUE_INVALID');
    if(used+next>cap||used>=cap)add('BUDGET_EXHAUSTED',scope,'critical',{reserved:used.toString(),limit:cap.toString()});
    else if(used*100n>=cap*BigInt(c.budgetWarningPercent))add('BUDGET_NEAR_LIMIT',scope,'warning',{reserved:used.toString(),limit:cap.toString()});
  }
  if(collection)try{
    check(Number.isSafeInteger(collection.totalSpentMicros)&&collection.totalSpentMicros>=0&&collection.spentByDay&&typeof collection.spentByDay==='object','INVALID_X_LEDGER');
    const today=collection.spentByDay[day]??0;check(Number.isSafeInteger(today)&&today>=0,'INVALID_X_LEDGER');
    metrics.xReservedMicros={total:collection.totalSpentMicros,today};
    budget(today,c.xBudget.dailyMicros,'x-daily',BigInt(c.xBudget.estimatedRequestMicros));budget(collection.totalSpentMicros,c.xBudget.totalMicros,'x-total',BigInt(c.xBudget.estimatedRequestMicros));
    for(const batch of Object.values(collection.batches??{}))if(batch.state==='REQUESTING')age(batch.requestedAt,c.pendingPublishMaxAgeSeconds,'X_REQUEST_UNCERTAIN',batch.id);
  }catch{add('INPUT_INVALID','x-budget');}
  const candidates=await load(join(live,'candidates.json'),'publications');
  if(candidates){
    if(!candidates.jobs||typeof candidates.jobs!=='object')add('INPUT_INVALID','publications');
    else {
      const pending=Object.values(candidates.jobs).filter(j=>j.state!=='FINALIZED');metrics.pendingPublications=pending.length;
      for(const job of pending)age(job.candidate?.computedAt,c.pendingPublishMaxAgeSeconds,'PUBLICATION_STUCK',job.id??'unknown');
    }
  }
  let db;
  try{
    db=new DatabaseSync(join(live,'index.sqlite'),{readOnly:true});db.exec('PRAGMA busy_timeout=3000');
    for(const market of c.markets){
      const row=db.prepare('SELECT snapshot_json FROM current_snapshots WHERE cluster=? AND program_id=? AND market_id=? ORDER BY length(sequence) DESC, sequence DESC LIMIT 1').get('devnet',c.programId,market.id);
      const snapshot=row?JSON.parse(row.snapshot_json):null;
      if(snapshot?.finality!=='finalized'||snapshot?.payload?.marketId!==market.id)add('SNAPSHOT_MISSING',market.id);
      else age(snapshot.payload.dataThrough,market.snapshotMaxAgeSeconds,'SNAPSHOT_STALE',market.id);
    }
    const records=db.prepare('SELECT record_json FROM current_free_records WHERE cluster=? AND program_id=?').all('devnet',c.programId).map(r=>JSON.parse(r.record_json));
    const pending=records.filter(r=>r.finality==='finalized'&&['CLOSED_RESULT','CLOSED_NA'].includes(r.status)&&!r.proofId);
    metrics.proofBacklog=pending.length;
    if(pending.length>=c.maxProofBacklog)add('PROOF_BACKLOG','closed-records','critical',{pending:pending.length,limit:c.maxProofBacklog});
    // Counts all closed obligations, including records outside the worker allowlist.
    for(const record of pending)age(record.exit?.executedAt,c.proofMaxAgeSeconds,'PROOF_OVERDUE',record.id);
  }catch{add('INPUT_UNAVAILABLE','projection');}finally{db?.close();}
  // Do not parse the multi-hundred-MB evidence payload journal every minute.
  // Obligations come from finalized projections; worker failures from heartbeat.
  const ledger=await load(join(live,'evidence/budget.json'),'proof-budget');
  if(ledger)try{
    check(ledger.version===1&&ledger.reservations&&typeof ledger.reservations==='object','INVALID_PROOF_LEDGER');
    let total=0n,today=0n;for(const item of Object.values(ledger.reservations)){
      const daily=item.byDay?.[day]??(item.day===day?item.winc:'0');check(DECIMAL.test(item.winc)&&DECIMAL.test(daily),'INVALID_PROOF_LEDGER');total+=BigInt(item.winc);today+=BigInt(daily);
    }
    metrics.proofReservedWinc={total:total.toString(),today:today.toString()};budget(total,c.proofBudget.totalWinc,'proof-total');budget(today,c.proofBudget.dailyWinc,'proof-daily');
  }catch{add('INPUT_INVALID','proof-budget');}
  try{
    const endpoint=(await readFile(c.rpcUrlFile,'utf8')).trim();check(/^https?:\/\//.test(endpoint),'INVALID_RPC_URL');
    check(await rpcCall(endpoint,'getGenesisHash',[],fetcher)==='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG','DEVNET_REQUIRED');
    metrics.walletLamports={};
    // All requests read finalized balance; only public addresses are needed.
    await Promise.all(c.wallets.map(async wallet=>{
      try{
        const result=await rpcCall(endpoint,'getBalance',[wallet.address,{commitment:'finalized'}],fetcher);
        check(Number.isSafeInteger(result.value)&&result.value>=0,'INVALID_BALANCE');metrics.walletLamports[wallet.role]=String(result.value);
        if(BigInt(result.value)<BigInt(wallet.minLamports))add('WALLET_LOW',wallet.role,'critical',{lamports:String(result.value),minLamports:wallet.minLamports});
      }catch{add('WALLET_UNAVAILABLE',wallet.role);}
    }));
  }catch{add('RPC_UNAVAILABLE','devnet');}
  if(c.backup){
    const receipt=await load(c.backup.copyReceipt,'backup-copy'),drill=await load(c.backup.drillReport,'restore-drill');
    if(receipt){
      if(receipt.version!==1||receipt.kind!=='backup-copy'||receipt.destinationId!==c.backup.destinationId||receipt.verification!=='destination-readback-sha256'||!/^[a-f0-9]{64}$/.test(receipt.sha256))add('INPUT_INVALID','backup-copy');
      age(Math.floor(Date.parse(receipt.verifiedAt)/1000),c.backup.maxAgeSeconds,'BACKUP_COPY_STALE','backup');
    }
    if(drill){
      if(drill.kind!=='isolated-restore-drill'||drill.hashes!=='matched'||drill.servicesStarted!==false||drill.backupSha256!==receipt?.sha256)add('RESTORE_DRILL_MISMATCH','backup');
      age(Math.floor(Date.parse(drill.verifiedAt)/1000),c.backup.maxAgeSeconds,'RESTORE_DRILL_STALE','backup');
    }
  }else add('BACKUP_MONITOR_UNCONFIGURED','backup','warning');
  alerts.sort((a,b)=>a.id.localeCompare(b.id));
  return {version:1,monitorId:c.monitorId,at:new Date(now).toISOString(),status:alerts.length?'ALERTING':'OK',metrics,alerts};
}

// delivered state is advanced only after acknowledged HTTP delivery. Observing
// a problem in dry mode never suppresses its first actual notification.
export function notification(report,previous={},repeatSeconds=3600) {
  const now=Date.parse(report.at),active=new Map(report.alerts.map(a=>[a.id,a]));
  const firing=report.alerts.filter(a=>!previous[a.id]||previous[a.id].severity!==a.severity||now-Date.parse(previous[a.id].sentAt)>=repeatSeconds*1000);
  const resolved=Object.keys(previous).filter(id=>!active.has(id)).map(id=>({id,code:previous[id].code,scope:previous[id].scope}));
  return {version:1,monitorId:report.monitorId,at:report.at,firing,resolved};
}
export async function deliver(urlFile,event,fetcher=fetch) {
  const endpoint=(await readFile(urlFile,'utf8')).trim();check(/^https:\/\//.test(endpoint)||/^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(endpoint),'HTTPS_WEBHOOK_REQUIRED');
  const response=await fetcher(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(event),signal:AbortSignal.timeout(10000),redirect:'error'});
  check(response.ok,'ALERT_DELIVERY_FAILED'); // Provider body can contain private data.
}
export async function runOnce(c,{send=false,now=Date.now(),fetcher=fetch}={}) {
  validateConfig(c);await mkdir(c.runtimeDirectory,{recursive:true,mode:0o700});
  const report=await collect(c,{now,fetcher});let previous;
  try{previous=await json(join(c.runtimeDirectory,'notifications.json'));}catch(e){if(e.code!=='ENOENT')throw Error('NOTIFICATION_STATE_INVALID');previous={};}
  const event=notification(report,previous,c.repeatSeconds);report.delivery={enabled:send,pending:event.firing.length+event.resolved.length};
  await atomicJson(join(c.runtimeDirectory,'report.json'),report);
  if(send){
    check(c.webhookUrlFile,'WEBHOOK_NOT_CONFIGURED');
    if(event.firing.length||event.resolved.length){
      await deliver(c.webhookUrlFile,event,fetcher);
      for(const a of event.firing)previous[a.id]={code:a.code,scope:a.scope,severity:a.severity,sentAt:report.at};
      for(const a of event.resolved)delete previous[a.id];
      await atomicJson(join(c.runtimeDirectory,'notifications.json'),previous);
      report.delivery.sent=event.firing.length+event.resolved.length;report.delivery.pending=0;
    }
    await atomicJson(join(c.runtimeDirectory,'report.json'),report);
    if(c.deadmanUrlFile)await deliver(c.deadmanUrlFile,{version:1,monitorId:c.monitorId,at:report.at,status:report.status},fetcher);
  }
  await atomicJson(join(c.runtimeDirectory,'health.json'),{at:now,status:report.status,deliveryEnabled:send});return report;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{
    process.umask(0o077);const a=args(process.argv.slice(2),['--config'],['--follow','--deliver','--check','--health']);const c=validateConfig(await json(a['--config']));
    if(a['--health']){const health=await json(join(c.runtimeDirectory,'health.json'));check(Number.isSafeInteger(health.at)&&Date.now()-health.at<c.intervalSeconds*3000&&health.at<=Date.now()+30000,'MONITOR_STALE');}
    else if(a['--check']){const report=await collect(c);console.log(JSON.stringify(report));if(report.alerts.length)process.exitCode=2;}
    else {
      let stopping=false;const abort=new AbortController();for(const s of ['SIGTERM','SIGINT'])process.once(s,()=>{stopping=true;abort.abort();});
      do{
        try{const report=await runOnce(c,{send:a['--deliver']===true});console.log(JSON.stringify(report));}
        catch{console.error('MONITOR_CYCLE_FAILED');if(!a['--follow']){process.exitCode=1;break;}}
        if(!a['--follow']||stopping)break;await sleep(c.intervalSeconds*1000,undefined,{signal:abort.signal}).catch(()=>{});
      }while(!stopping);
    }
  }catch(e){console.error(/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'MONITOR_FAILED');process.exitCode=1;}
}
