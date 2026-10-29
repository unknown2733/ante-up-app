// Read-only operational observer. No X requests, transaction sends or private keys.
import {readFile, mkdir, readdir, stat, statfs, lstat} from 'node:fs/promises';
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
  check(Array.isArray(c.markets)&&c.markets.length>0&&c.markets.every(m=>address(m.id)&&positive(m.collectionMaxAgeSeconds)&&positive(m.snapshotMaxAgeSeconds)&&
    (m.collectionDirectory===undefined||safeRelative(m.collectionDirectory))),'MONITOR_MARKETS_INVALID');
  check(Array.isArray(c.services)&&c.services.length>0&&c.services.every(s=>safeRelative(s.path)&&typeof s.name==='string'&&/^[a-z0-9-]+$/.test(s.name)&&positive(s.maxAgeSeconds)),'MONITOR_SERVICES_INVALID');
  check(positive(c.pendingPublishMaxAgeSeconds)&&positive(c.proofMaxAgeSeconds)&&positive(c.maxProofBacklog)&&positive(c.repeatSeconds)&&positive(c.intervalSeconds)&&positive(c.minFreeBytes),'MONITOR_THRESHOLDS_INVALID');
  if(c.maxStateBytes!==undefined)check(positive(c.maxStateBytes),'MONITOR_STATE_LIMIT_INVALID');
  if(c.activeStorage!==undefined)check(Array.isArray(c.activeStorage)&&c.activeStorage.every(s=>
    typeof s.name==='string'&&/^[a-z0-9-]+$/.test(s.name)&&safeRelative(s.path)&&positive(s.limitBytes))&&
    new Set(c.activeStorage.map(s=>s.name)).size===c.activeStorage.length,'MONITOR_ACTIVE_STORAGE_INVALID');
  check(positive(c.xBudget?.dailyMicros)&&positive(c.xBudget?.totalMicros)&&positive(c.xBudget?.estimatedRequestMicros),'MONITOR_X_BUDGET_INVALID');
  if(c.xBudget.ledgerPath!==undefined)
    check(safeRelative(c.xBudget.ledgerPath)&&positive(c.xBudget.initialMicros)&&
      c.xBudget.initialMicros<=c.xBudget.totalMicros,'MONITOR_X_LEDGER_INVALID');
  check(c.budgetWarningPercent>0&&c.budgetWarningPercent<100&&Number.isInteger(c.budgetWarningPercent),'MONITOR_BUDGET_THRESHOLD_INVALID');
  check(DECIMAL.test(c.proofBudget?.dailyWinc)&&DECIMAL.test(c.proofBudget?.totalWinc)&&BigInt(c.proofBudget.dailyWinc)>0n&&BigInt(c.proofBudget.totalWinc)>0n,'MONITOR_PROOF_BUDGET_INVALID');
  if(c.visitorFaucet){
    const v=c.visitorFaucet;
    check(safeRelative(v.ledgerPath)&&DECIMAL.test(v.grantLamports)&&DECIMAL.test(v.dailyCapLamports)&&DECIMAL.test(v.totalCapLamports)&&
      BigInt(v.grantLamports)>0n&&BigInt(v.grantLamports)<=BigInt(v.dailyCapLamports)&&BigInt(v.dailyCapLamports)<=BigInt(v.totalCapLamports),
      'MONITOR_VISITOR_FAUCET_INVALID');
  }
  if(c.referenceKworb)
    check(safeRelative(c.referenceKworb.ledgerPath)&&positive(c.referenceKworb.maxAgeSeconds),
      'MONITOR_REFERENCE_KWORB_INVALID');
  if(c.referenceYouTube)
    check(safeRelative(c.referenceYouTube.ledgerPath)&&positive(c.referenceYouTube.maxAgeSeconds),
      'MONITOR_REFERENCE_YOUTUBE_INVALID');
  check(Array.isArray(c.wallets)&&c.wallets.length>0&&c.wallets.every(w=>typeof w.role==='string'&&/^[a-z0-9-]+$/.test(w.role)&&address(w.address)&&DECIMAL.test(w.minLamports)),'MONITOR_WALLETS_INVALID');
  check(new Set(c.markets.map(m=>m.id)).size===c.markets.length&&new Set(c.wallets.map(w=>w.role)).size===c.wallets.length&&new Set(c.services.map(s=>s.name)).size===c.services.length,'DUPLICATE_MONITOR_SCOPE');
  if(c.snapshotFunding){
    const f=c.snapshotFunding;
    check(c.wallets.some(w=>w.role==='publisher')&&DECIMAL.test(f.rentLamports)&&BigInt(f.rentLamports)>0n&&
      DECIMAL.test(f.reserveLamports)&&positive(f.publishIntervalSeconds)&&positive(f.warningHorizonSeconds)&&
      positive(f.criticalHorizonSeconds)&&f.criticalHorizonSeconds<f.warningHorizonSeconds&&
      c.markets.length<=5,'MONITOR_SNAPSHOT_FUNDING_INVALID');
  }
  check(typeof c.rpcUrlFile==='string','MONITOR_RPC_REQUIRED');
  if(c.httpChecks)check(Array.isArray(c.httpChecks)&&c.httpChecks.every(h=>/^[a-z0-9-]+$/.test(h.name)&&/^https?:\/\//.test(h.url)&&(!h.expectMode||h.expectMode==='devnet')),'MONITOR_HTTP_CHECKS_INVALID');
  if(c.backup)check(typeof c.backup.copyReceipt==='string'&&typeof c.backup.drillReport==='string'&&positive(c.backup.maxAgeSeconds)&&typeof c.backup.destinationId==='string','MONITOR_BACKUP_CONFIG_INVALID');
  if(c.telegramTokenFile!==undefined||c.telegramChatIdFile!==undefined)
    check(typeof c.telegramTokenFile==='string'&&c.telegramTokenFile.length>0&&typeof c.telegramChatIdFile==='string'&&c.telegramChatIdFile.length>0&&!c.webhookUrlFile,'MONITOR_ALERT_CHANNEL_INVALID');
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
    if(service.name==='collector'||service.name.startsWith('collector-'))
      age(health.lastPollAt,900,'COLLECTION_STALE',service.name);
    if(service.name==='price-history'&&!(health.status==='OK'||health.status==='PARTIAL'&&health.valid>0&&health.readErrors===0))add('SERVICE_ERROR',service.name);
    if(service.name==='evidence'&&health.held>0)add('PROOF_WORKER_HELD','evidence','warning',{held:health.held});
    if(service.name==='evidence'&&health.admissionGuard==='UNSAFE')add('PROOF_ADMISSION_UNSAFE','evidence');
  }
  await Promise.all((c.httpChecks??[]).map(async probe=>{
    try{const response=await fetcher(probe.url,{signal:AbortSignal.timeout(10000),redirect:'error'});check(response.ok,'HTTP_UNAVAILABLE');
      if(probe.expectMode)check((await response.json()).mode===probe.expectMode,'HTTP_MODE_MISMATCH');
      else await response.body?.cancel();
    }catch{add('HTTP_UNAVAILABLE',probe.name);}
  }));
  try{const fs=await statfs(c.stateDirectory);metrics.freeBytes=fs.bavail*fs.bsize;if(metrics.freeBytes<c.minFreeBytes)add('DISK_LOW','state','critical',{freeBytes:metrics.freeBytes,minFreeBytes:c.minFreeBytes});}catch{add('INPUT_UNAVAILABLE','disk');}
  async function usedBytes(directory){
    if(!(await lstat(directory)).isDirectory())throw Error('UNEXPECTED_STATE_ENTRY');
    let used=0;
    for(const entry of await readdir(directory,{withFileTypes:true})){
      const path=join(directory,entry.name);
      if(entry.isDirectory())used+=await usedBytes(path);
      else if(entry.isFile())used+=(await stat(path)).size;
      else throw Error('UNEXPECTED_STATE_ENTRY');
    }
    return used;
  }
  if(c.maxStateBytes!==undefined){
    try{
      metrics.stateBytes=await usedBytes(c.stateDirectory);
      const ratio=metrics.stateBytes/c.maxStateBytes;
      if(ratio>=1)add('STATE_LIMIT','state','critical',{usedBytes:metrics.stateBytes,maxStateBytes:c.maxStateBytes});
      else if(ratio>=0.8)add('STATE_NEAR_LIMIT','state','warning',{usedBytes:metrics.stateBytes,maxStateBytes:c.maxStateBytes});
    }catch{add('INPUT_UNAVAILABLE','state-usage');}
  }
  if(c.activeStorage){
    metrics.activeStateBytes={};
    for(const scope of c.activeStorage){
      try{
        const bytes=await usedBytes(join(c.stateDirectory,scope.path));
        metrics.activeStateBytes[scope.name]=bytes;
        const ratio=bytes/scope.limitBytes;
        if(ratio>=0.8)add('ACTIVE_STORAGE_ADMISSION_BLOCKED',scope.name,'critical',{usedBytes:bytes,limitBytes:scope.limitBytes});
        else if(ratio>=0.7)add('ACTIVE_STORAGE_NEAR_LIMIT',scope.name,'warning',{usedBytes:bytes,limitBytes:scope.limitBytes});
      }catch{add('INPUT_UNAVAILABLE',`active-storage-${scope.name}`);}
    }
  }
  const collection=await load(join(live,'collection.json'),'collection');
  for(const market of c.markets){
    const marketCollection=market.collectionDirectory
      ? await load(join(c.stateDirectory,market.collectionDirectory,'collection.json'),`collection-${market.id}`)
      : collection;
    if(marketCollection)age(marketCollection.markets?.[market.id]?.lastPollAt,market.collectionMaxAgeSeconds,'COLLECTION_STALE',market.id);
  }
  const day=new Date(now).toISOString().slice(0,10);
  function budget(value,limit,scope,next=0n){
    const used=BigInt(value),cap=BigInt(limit);check(used>=0n,'BUDGET_VALUE_INVALID');
    if(used+next>cap||used>=cap)add('BUDGET_EXHAUSTED',scope,'critical',{reserved:used.toString(),limit:cap.toString()});
    else if(used*100n>=cap*BigInt(c.budgetWarningPercent))add('BUDGET_NEAR_LIMIT',scope,'warning',{reserved:used.toString(),limit:cap.toString()});
  }
  let xSpending=null;
  if(collection)try{
    check(Number.isSafeInteger(collection.totalSpentMicros)&&collection.totalSpentMicros>=0&&collection.spentByDay&&typeof collection.spentByDay==='object','INVALID_X_LEDGER');
    const today=collection.spentByDay[day]??0;check(Number.isSafeInteger(today)&&today>=0,'INVALID_X_LEDGER');
    if(!c.xBudget.ledgerPath)xSpending={total:collection.totalSpentMicros,today};
    for(const batch of Object.values(collection.batches??{}))if(batch.state==='REQUESTING')age(batch.requestedAt,c.pendingPublishMaxAgeSeconds,'X_REQUEST_UNCERTAIN',batch.id);
  }catch{add('INPUT_INVALID','x-budget');}
  if(c.xBudget.ledgerPath){
    let xdb;
    try{
      xdb=new DatabaseSync(join(c.stateDirectory,c.xBudget.ledgerPath),{readOnly:true});
      xdb.exec('PRAGMA busy_timeout=3000');
      const row=xdb.prepare(`SELECT COALESCE(SUM(estimated_cost_micros),0) total,
        COALESCE(SUM(CASE WHEN day=? THEN estimated_cost_micros ELSE 0 END),0) today,
        COALESCE(SUM(CASE WHEN kind='initial' THEN estimated_cost_micros ELSE 0 END),0) initial
        FROM x_spend`).get(day);
      check([row.total,row.today,row.initial].every(n=>Number.isSafeInteger(n)&&n>=0),'INVALID_GLOBAL_X_LEDGER');
      xSpending={total:row.total,today:row.today,initial:row.initial};
    }catch{add('INPUT_UNAVAILABLE','global-x-budget');}
    finally{xdb?.close();}
  }
  if(xSpending){
    metrics.xReservedMicros=xSpending;
    budget(xSpending.today,c.xBudget.dailyMicros,'x-daily',BigInt(c.xBudget.estimatedRequestMicros));
    budget(xSpending.total,c.xBudget.totalMicros,'x-total',BigInt(c.xBudget.estimatedRequestMicros));
    if(xSpending.initial!==undefined)budget(xSpending.initial,c.xBudget.initialMicros,'x-initial');
  }
  const publicationDirectories=new Map([[c.liveDirectory,'publications']]);
  for(const market of c.markets)if(market.collectionDirectory)
    publicationDirectories.set(market.collectionDirectory,`publications-${market.id}`);
  metrics.pendingPublications=0;
  for(const [directory,scope] of publicationDirectories){
    const candidates=await load(join(c.stateDirectory,directory,'candidates.json'),scope);
    if(!candidates)continue;
    if(!candidates.jobs||typeof candidates.jobs!=='object'||Array.isArray(candidates.jobs)){
      add('INPUT_INVALID',scope);continue;
    }
    const pending=Object.values(candidates.jobs).filter(j=>j.state!=='FINALIZED');
    metrics.pendingPublications+=pending.length;
    for(const job of pending)age(job.candidate?.computedAt,c.pendingPublishMaxAgeSeconds,'PUBLICATION_STUCK',job.id??'unknown');
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
  if(c.visitorFaucet){
    let grantDb;
    try{
      grantDb=new DatabaseSync(join(c.stateDirectory,c.visitorFaucet.ledgerPath),{readOnly:true});
      grantDb.exec('PRAGMA busy_timeout=3000');
      const rows=grantDb.prepare('SELECT amount,at_ms,state FROM visitor_sol_grants').all();
      let total=0n,today=0n;
      const dayStart=Math.floor(now/86400000)*86400000;
      for(const row of rows){
        check(typeof row.amount==='string'&&DECIMAL.test(row.amount)&&BigInt(row.amount)>0n&&
          Number.isSafeInteger(row.at_ms)&&row.at_ms>0&&row.at_ms<=now+30000&&
          ['RESERVED','UNKNOWN','SUBMITTED','FINALIZED'].includes(row.state),'VISITOR_LEDGER_INVALID');
        const amount=BigInt(row.amount);total+=amount;
        if(row.at_ms>=dayStart)today+=amount;
      }
      metrics.visitorSolReservedLamports={total:total.toString(),today:today.toString()};
      budget(today,c.visitorFaucet.dailyCapLamports,'visitor-sol-daily',BigInt(c.visitorFaucet.grantLamports));
      budget(total,c.visitorFaucet.totalCapLamports,'visitor-sol-total',BigInt(c.visitorFaucet.grantLamports));
    }catch(error){add(error.message==='VISITOR_LEDGER_INVALID'?'INPUT_INVALID':'INPUT_UNAVAILABLE','visitor-sol');}
    finally{grantDb?.close();}
  }
  if(c.referenceKworb){
    let referenceDb;
    try{
      referenceDb=new DatabaseSync(join(c.stateDirectory,c.referenceKworb.ledgerPath),{readOnly:true});
      referenceDb.exec('PRAGMA busy_timeout=3000');
      const row=referenceDb.prepare('SELECT attempted_at_ms,status,error_code FROM reference_kworb_requests ORDER BY attempted_at_ms DESC,id DESC LIMIT 1').get();
      if(!row)add('REFERENCE_COLLECTION_MISSING','kworb');
      else{
        metrics.kworbLastRun={attemptedAtMs:row.attempted_at_ms,status:row.status};
        age(Math.floor(row.attempted_at_ms/1000),c.referenceKworb.maxAgeSeconds,'REFERENCE_COLLECTION_STALE','kworb');
        if(row.status!=='SUCCESS')add('REFERENCE_COLLECTION_FAILED','kworb','critical',{status:row.status,errorCode:row.error_code??null});
      }
    }catch{add('INPUT_UNAVAILABLE','kworb');}
    finally{referenceDb?.close();}
  }
  if(c.referenceYouTube){
    let referenceDb;
    try{
      referenceDb=new DatabaseSync(join(c.stateDirectory,c.referenceYouTube.ledgerPath),{readOnly:true});
      referenceDb.exec('PRAGMA busy_timeout=3000');
      const row=referenceDb.prepare('SELECT attempted_at_ms,status,error_code FROM reference_youtube_oracle_prep_requests ORDER BY attempted_at_ms DESC,id DESC LIMIT 1').get();
      if(!row)add('REFERENCE_COLLECTION_MISSING','youtube');
      else{
        metrics.youtubeLastRun={attemptedAtMs:row.attempted_at_ms,status:row.status};
        age(Math.floor(row.attempted_at_ms/1000),c.referenceYouTube.maxAgeSeconds,'REFERENCE_COLLECTION_STALE','youtube');
        if(row.status!=='SUCCESS')add('REFERENCE_COLLECTION_FAILED','youtube','critical',{status:row.status,errorCode:row.error_code??null});
      }
    }catch{add('INPUT_UNAVAILABLE','youtube');}
    finally{referenceDb?.close();}
  }
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
    if(c.snapshotFunding&&metrics.walletLamports.publisher!==undefined){
      const f=c.snapshotFunding,balance=BigInt(metrics.walletLamports.publisher);
      const rent=BigInt(f.rentLamports),reserve=BigInt(f.reserveLamports),count=BigInt(c.markets.length);
      const required=seconds=>reserve+BigInt(Math.ceil(seconds/f.publishIntervalSeconds))*count*rent;
      const warning=required(f.warningHorizonSeconds),critical=required(f.criticalHorizonSeconds);
      const available=balance>reserve?balance-reserve:0n;
      const estimatedRunwaySeconds=available*BigInt(f.publishIntervalSeconds)/(count*rent);
      metrics.snapshotFunding={marketCount:c.markets.length,rentLamports:f.rentLamports,
        requiredLamports:warning.toString(),estimatedRunwaySeconds:estimatedRunwaySeconds.toString()};
      if(balance<warning)add('PUBLISHER_RENT_RUNWAY_LOW','publisher',balance<critical?'critical':'warning',
        {lamports:balance.toString(),requiredLamports:warning.toString(),estimatedRunwaySeconds:estimatedRunwaySeconds.toString(),marketCount:c.markets.length});
    }
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
export async function deliverTelegram(tokenFile,chatIdFile,event,fetcher=fetch) {
  const [token,chatId]=await Promise.all([readFile(tokenFile,'utf8'),readFile(chatIdFile,'utf8')]).then(values=>values.map(value=>value.trim()));
  check(/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)&&/^-?\d{1,20}$/.test(chatId),'TELEGRAM_CONFIG_INVALID');
  const rows=[
    `Ante Up Devnet operations · ${event.at}`,
    ...event.firing.map(alert=>`ALERT ${alert.severity}: ${alert.code} (${alert.scope})${Object.keys(alert.metrics??{}).length?` · ${JSON.stringify(alert.metrics).slice(0,180)}`:''}`),
    ...event.resolved.map(alert=>`RESOLVED: ${alert.code} (${alert.scope})`)
  ];
  const message=rows.join('\n').slice(0,4000);
  // The token stays in a mounted secret file; never include the provider URL or response body in errors.
  try {
    const response=await fetcher(`https://api.telegram.org/bot${token}/sendMessage`,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({chat_id:chatId,text:message,disable_web_page_preview:true}),
      signal:AbortSignal.timeout(10000),redirect:'error'
    });
    if(!response.ok||(await response.json()).ok!==true)throw Error('ALERT_DELIVERY_FAILED');
  } catch {throw Error('ALERT_DELIVERY_FAILED');}
}
export async function runOnce(c,{send=false,now=Date.now(),fetcher=fetch}={}) {
  validateConfig(c);await mkdir(c.runtimeDirectory,{recursive:true,mode:0o700});
  const report=await collect(c,{now,fetcher});let previous;
  try{previous=await json(join(c.runtimeDirectory,'notifications.json'));}catch(e){if(e.code!=='ENOENT')throw Error('NOTIFICATION_STATE_INVALID');previous={};}
  const event=notification(report,previous,c.repeatSeconds);report.delivery={enabled:send,pending:event.firing.length+event.resolved.length};
  await atomicJson(join(c.runtimeDirectory,'report.json'),report);
  if(send){
    check(c.webhookUrlFile||c.telegramTokenFile,'ALERT_CHANNEL_NOT_CONFIGURED');
    if(event.firing.length||event.resolved.length){
      if(c.telegramTokenFile)await deliverTelegram(c.telegramTokenFile,c.telegramChatIdFile,event,fetcher);
      else await deliver(c.webhookUrlFile,event,fetcher);
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
