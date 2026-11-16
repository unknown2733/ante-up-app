import test from 'node:test';
import assert from 'node:assert/strict';
import {runBackupCycle,verifyArtifact,verifyHistoryReport} from './backup-cycle.mjs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

function fixture(){let time=1000000,reads=0,restores=0;const saved=[];
 return {saved,get restores(){return restores;},options:{services:['api','collector'],probes:[{name:'markets'}],
 generate:async()=>0,verify:async()=>({sha256:'fixture'}),restore:async()=>{restores++;},
 inspect:async()=>++reads>3,probe:async()=>true,save:async r=>saved.push(structuredClone(r)),
 now:()=>time,wait:async ms=>{time+=ms;},recoveryTimeoutMs:30,intervalMs:5}};}
test('delayed service recovery succeeds and writes independent phases',async()=>{
 const f=fixture(),r=await runBackupCycle(f.options);assert.equal(r.status,'SUCCEEDED');assert.equal(f.restores,1);
 assert.ok(f.saved.some(s=>s.phases.serviceRecovery?.pendingServices?.length));
 assert.deepEqual(Object.keys(r.phases),['creation','serviceRecovery','artifactVerification','publicReadback']);
});
test('generation failure still restores services and cannot be hidden by valid artifact',async()=>{
 const f=fixture(),r=await runBackupCycle({...f.options,generate:async()=>1});
 assert.equal(f.restores,1);assert.equal(r.status,'FAILED');assert.equal(r.phases.creation.code,'BACKUP_RUNNER_FAILED');
 assert.equal(r.phases.artifactVerification.state,'SUCCEEDED');
});
test('artifact failure, recovery failure and API failure remain distinct',async()=>{
 const f=fixture(),r=await runBackupCycle({...f.options,inspect:async n=>n!=='collector',probe:async()=>false,
 verify:async()=>{throw Error('BACKUP_ARTIFACT_HASH_MISMATCH');}});
 assert.equal(r.status,'FAILED');assert.deepEqual(r.phases.serviceRecovery.pendingServices,['collector']);
 assert.equal(r.phases.artifactVerification.code,'BACKUP_ARTIFACT_HASH_MISMATCH');
 assert.equal(r.phases.publicReadback.code,'BACKUP_PUBLIC_READBACK_FAILED');
});
test('provider errors are redacted from phase reports',async()=>{
 const f=fixture(),r=await runBackupCycle({...f.options,verify:async()=>{throw Error('https://private/?api-key=secret');}});
 assert.equal(JSON.stringify(r).includes('secret'),false);assert.equal(r.phases.artifactVerification.code,'BACKUP_PHASE_FAILED');
});
test('failed history maintenance preserves successful backup and recovery evidence',async()=>{
 const f=fixture(),r=await runBackupCycle({...f.options,verifyHistoryMaintenance:async()=>{throw Error('BACKUP_HISTORY_MAINTENANCE_FAILED');}});
 assert.equal(r.status,'FAILED');assert.equal(r.phases.historyMaintenance.state,'FAILED');
 assert.equal(r.phases.creation.state,'SUCCEEDED');assert.equal(r.phases.artifactVerification.state,'SUCCEEDED');assert.equal(f.restores,1);
});
test('history report must belong to this run; awaiting exact restore is a safe hold',async t=>{
 const base=await mkdtemp(join(tmpdir(),'ante-history-report-'));t.after(()=>rm(base,{recursive:true,force:true}));await mkdir(join(base,'ops-reports'));
 const path=join(base,'ops-reports','history-maintenance.json');
 const report={version:1,kind:'HISTORY_ARCHIVE_MAINTENANCE',startedAt:'2026-11-16T01:00:01.000Z',finishedAt:'2026-11-16T01:00:02.000Z',status:'AWAITING_RESTORE'};
 await writeFile(path,JSON.stringify(report));assert.equal((await verifyHistoryReport(base,'2026-11-16T01:00:00.000Z')).status,'AWAITING_RESTORE');
 await assert.rejects(verifyHistoryReport(base,'2026-11-17T01:00:00.000Z'),/STALE/);
 await writeFile(path,JSON.stringify({...report,status:'FAILED'}));await assert.rejects(verifyHistoryReport(base,'2026-11-16T01:00:00.000Z'),/MAINTENANCE_FAILED/);
});
test('artifact must match current run, exact size and SHA',async t=>{
 const base=await mkdtemp(join(tmpdir(),'ante-cycle-'));t.after(()=>rm(base,{recursive:true,force:true}));await mkdir(join(base,'output'));
 const path=join(base,'output','ante-up-20261116T010000Z.aub'),bytes=Buffer.from('encrypted fixture');await writeFile(path,bytes);
 const result={kind:'encrypted-backup',createdAt:'2026-11-16T01:00:00.000Z',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 await writeFile(join(base,'artifact-path.txt'),path);await writeFile(join(base,'backup-result.json'),JSON.stringify(result));
 assert.equal((await verifyArtifact(base,'2026-11-16T00:59:59.000Z')).bytes,bytes.length);
 await assert.rejects(verifyArtifact(base,'2026-11-17T00:00:00.000Z'),/STALE/);
 await writeFile(path,'broken');await assert.rejects(verifyArtifact(base,'2026-11-16T00:59:59.000Z'),/HASH_MISMATCH/);
});
