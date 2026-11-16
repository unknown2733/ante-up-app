// Host-side backup supervisor. Never reads credentials or signs transactions.
import {spawn} from 'node:child_process';
import {readFile,stat,mkdir} from 'node:fs/promises';
import {join,basename,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {atomicJson,digest,check,args} from './common.mjs';

export async function runBackupCycle({generate,verify,verifyHistoryMaintenance,restore,inspect,probe,save,services,probes,
  now=Date.now,wait=sleep,recoveryTimeoutMs=180000,intervalMs=5000}) {
  check(Array.isArray(services)&&services.length>0&&services.every(n=>/^[a-z0-9-]+$/.test(n)), 'CYCLE_SERVICES_INVALID');
  check(Number.isSafeInteger(recoveryTimeoutMs)&&recoveryTimeoutMs>0&&recoveryTimeoutMs<=600000&&
    Number.isSafeInteger(intervalMs)&&intervalMs>0,'CYCLE_TIMEOUT_INVALID');
  const report={version:1,kind:'BACKUP_CYCLE',startedAt:new Date(now()).toISOString(),status:'RUNNING',phases:{}};
  async function phase(name,fn){
    report.phases[name]={state:'RUNNING',startedAt:new Date(now()).toISOString()};await save(report);
    try{const details=await fn();report.phases[name]={...report.phases[name],state:'SUCCEEDED',details};}
    catch(e){report.phases[name]={...report.phases[name],state:'FAILED',code:/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'BACKUP_PHASE_FAILED'};}
    report.phases[name].finishedAt=new Date(now()).toISOString();await save(report);
  }
  await save(report);
  try {await phase('creation',async()=>{const exitCode=await generate();check(exitCode===0,'BACKUP_RUNNER_FAILED');return {exitCode};});}
  finally {
    // The generation script retains its EXIT trap. This second check covers a
    // failed restart in that trap; restoration also runs after generation failure.
    await phase('serviceRecovery',async()=>{
      await restore(services);
      const end=now()+recoveryTimeoutMs;let pending=services;
      while(true){
        pending=[];for(const name of services){try{if(!await inspect(name))pending.push(name);}catch{pending.push(name);}}
        report.phases.serviceRecovery.pendingServices=pending;await save(report);
        if(!pending.length)return {services};
        if(now()>=end)throw Error('BACKUP_SERVICE_RECOVERY_FAILED');
        await wait(Math.min(intervalMs,end-now()));
      }
    });
  }
  if(verifyHistoryMaintenance)await phase('historyMaintenance',()=>verifyHistoryMaintenance(report.startedAt));
  await phase('artifactVerification',()=>verify(report.startedAt));
  await phase('publicReadback',async()=>{
    const end=now()+recoveryTimeoutMs;let pending;
    while(true){
      pending=[];for(const item of probes){try{if(!await probe(item))pending.push(item.name);}catch{pending.push(item.name);}}
      report.phases.publicReadback.pendingProbes=pending;await save(report);
      if(!pending.length)return {probes:probes.map(p=>p.name)};
      if(now()>=end)throw Error('BACKUP_PUBLIC_READBACK_FAILED');
      await wait(Math.min(intervalMs,end-now()));
    }
  });
  report.finishedAt=new Date(now()).toISOString();
  report.status=Object.values(report.phases).every(p=>p.state==='SUCCEEDED')?'SUCCEEDED':'FAILED';await save(report);
  return report;
}

function command(bin,argv,{capture=false}={}) {
  return new Promise((resolve,reject)=>{
    const p=spawn(bin,argv,{stdio:['ignore',capture?'pipe':'ignore','ignore']});let output='';
    if(capture)p.stdout.on('data',b=>{output+=b;if(output.length>100000)p.kill();});
    p.on('error',()=>reject(Error('BACKUP_COMMAND_FAILED')));p.on('close',code=>resolve({code,output}));
  });
}
export async function verifyArtifact(base,startedAt){
  const result=JSON.parse(await readFile(join(base,'backup-result.json'),'utf8'));
  const path=(await readFile(join(base,'artifact-path.txt'),'utf8')).trim();
  check(resolve(path)===join(resolve(base),'output',basename(path))&&/^ante-up-[0-9TZ]+\.aub$/.test(basename(path)), 'BACKUP_ARTIFACT_PATH_INVALID');
  check(Date.parse(result.createdAt)>=Date.parse(startedAt)&&result.kind==='encrypted-backup'&&
    /^[a-f0-9]{64}$/.test(result.sha256)&&Number.isSafeInteger(result.bytes)&&result.bytes>0,'BACKUP_ARTIFACT_STALE_OR_INVALID');
  check((await stat(path)).size===result.bytes&&await digest(path)===result.sha256,'BACKUP_ARTIFACT_HASH_MISMATCH');
  return {artifact:basename(path),bytes:result.bytes,sha256:result.sha256,createdAt:result.createdAt};
}
export async function verifyHistoryReport(base,startedAt){
  const report=JSON.parse(await readFile(join(base,'ops-reports','history-maintenance.json'),'utf8'));
  check(report.version===1&&report.kind==='HISTORY_ARCHIVE_MAINTENANCE'&&
    Date.parse(report.startedAt)>=Date.parse(startedAt)&&Date.parse(report.finishedAt)>=Date.parse(report.startedAt),
    'BACKUP_HISTORY_REPORT_MISSING_OR_STALE');
  check(['STAGED','PRUNED','AWAITING_RESTORE'].includes(report.status),'BACKUP_HISTORY_MAINTENANCE_FAILED');
  return {status:report.status,manifestSha256:report.manifestAfter??null};
}
async function main(){
  const a=args(process.argv.slice(2),['--base','--services']);check(a['--base']&&a['--services'],'CYCLE_ARGUMENTS_REQUIRED');
  const base=resolve(a['--base']),services=a['--services'].split(',');
  const reports=join(base,'ops-reports');await mkdir(reports,{recursive:true,mode:0o700});
  const runName=`backup-cycle-${new Date().toISOString().replaceAll(/[:.]/g,'-')}.json`;
  const report=await runBackupCycle({services,probes:[{name:'web',url:'https://ante-up.fun/'},{name:'markets',url:'https://ante-up.fun/api/v1/markets'}],
    generate:async()=>(await command('bash',[join(base,'run-backup.sh')])).code,
    verify:startedAt=>verifyArtifact(base,startedAt),
    verifyHistoryMaintenance:startedAt=>verifyHistoryReport(base,startedAt),
    restore:async names=>{for(const name of names){const r=await command('docker',['inspect','--format','{{.State.Running}}',name],{capture:true});
      if(r.code!==0||r.output.trim()!=='true')await command('docker',['start',name]);}},
    inspect:async name=>{const r=await command('docker',['inspect','--format','{{.State.Running}} {{.State.Restarting}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',name],{capture:true});return r.code===0&&['true false healthy','true false none'].includes(r.output.trim());},
    probe:async p=>{const r=await fetch(p.url,{signal:AbortSignal.timeout(12000),redirect:'error'});
      if(p.name==='markets'&&r.status===200){const body=await r.json();return body.mode==='devnet'&&Array.isArray(body.data);}
      await r.body?.cancel();return r.status===200;},
    save:async r=>{await atomicJson(join(reports,runName),r);await atomicJson(join(reports,'latest-cycle.json'),r);}});
  console.log(JSON.stringify({kind:report.kind,status:report.status,phases:Object.fromEntries(Object.entries(report.phases).map(([k,v])=>[k,v.state]))}));
  if(report.status!=='SUCCEEDED')process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('BACKUP_CYCLE_FAILED');process.exitCode=1;});
