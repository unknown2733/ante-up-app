import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,cpSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {writeStateJson} from '../../services/data/state-json.mjs';
import {verifyHistoryArchive} from '../../services/data/history-archive.mjs';
import {runHistoryMaintenance,main} from './history-maintenance.mjs';

const now=Date.parse('2026-11-16T03:30:00Z');
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'ante-maintenance-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const stateRoot=join(root,'state'),archiveRoot=join(stateRoot,'history-archive'),receiptDir=join(root,'receipts');
  const dir=join(stateRoot,'market'),collection=join(dir,'collection.json'),candidates=join(dir,'candidates.json');
  mkdirSync(dir,{recursive:true});mkdirSync(join(stateRoot,'keeper-auto'));mkdirSync(receiptDir);
  writeStateJson(collection,{markets:{m:{observations:[{at:0,count:1}]}}});
  writeStateJson(collection,{markets:{m:{observations:[{at:10,count:2}]}}});
  writeStateJson(candidates,{jobs:{old:{state:'FINALIZED',published:{finality:'finalized'},replayInput:{observations:[{at:1,count:3}],start:1}},
    pending:{state:'SUBMITTED',replayInput:{observations:[{at:2,count:4}],start:2}}}});
  const input={stateRoot,archiveRoot,receiptDir,report:join(root,'report.json'),collections:['market'],quiesced:true};
  const run=extra=>runHistoryMaintenance({...input,...extra},{now});
  function receipts(changes={}){
    const restored=join(root,'restored');rmSync(restored,{recursive:true,force:true});cpSync(archiveRoot,restored,{recursive:true});
    const archive={...verifyHistoryArchive(restored),kind:'HISTORY_ARCHIVE_RESTORE_VERIFICATION'};
    const copy={version:1,kind:'backup-copy',artifact:'backup.aub',bytes:1000,sha256:'a'.repeat(64),destinationId:'test-pc',
      verifiedAt:'2026-11-16T01:00:00Z',verification:'destination-readback-sha256',...changes.copy};
    const drill={version:1,kind:'isolated-restore-drill',backupSha256:'a'.repeat(64),hashes:'matched',sqlite:'quick_check-schema-row-counts-matched',
      backupCreatedAt:'2026-11-16T00:00:00Z',verifiedAt:'2026-11-16T02:00:00Z',historyArchive:archive,...changes.drill};
    writeFileSync(join(receiptDir,'latest-copy.json'),JSON.stringify(copy));writeFileSync(join(receiptDir,'latest-drill.json'),JSON.stringify(drill));return {copy,drill};
  }
  return {root,stateRoot,archiveRoot,receiptDir,dir,collection,candidates,input,run,receipts};
}
test('first maintenance stages without deleting or requiring an old offhost receipt',t=>{
  const f=fixture(t),before=readdirSync(join(f.dir,'.history')).sort(),report=f.run();
  assert.equal(report.status,'STAGED');assert.ok(report.manifestAfter);
  assert.equal(report.phases.some(p=>p.name==='prune'),false);
  assert.deepEqual(readdirSync(join(f.dir,'.history')).sort(),before);
  assert.equal(JSON.parse(readFileSync(f.input.report)).status,'STAGED');
});
test('missing and old-manifest receipts hold inventory unchanged and do not stage newly obsolete history',t=>{
  const f=fixture(t);f.run();const manifest=readFileSync(join(f.archiveRoot,'manifest.json'));
  writeStateJson(f.collection,{markets:{m:{observations:[{at:20,count:6}]}}});const before=readdirSync(join(f.dir,'.history')).sort();
  assert.equal(f.run().status,'AWAITING_RESTORE');
  const r=f.receipts();f.receipts({drill:{historyArchive:{...r.drill.historyArchive,manifestSha256:'b'.repeat(64)}}});
  const report=f.run();assert.equal(report.status,'AWAITING_RESTORE');
  assert.equal(report.phases[0].reason,'ARCHIVE_RECEIPT_MANIFEST_MISMATCH');
  assert.deepEqual(readdirSync(join(f.dir,'.history')).sort(),before);
  assert.equal(readFileSync(join(f.archiveRoot,'manifest.json')).compare(manifest),0);
});
test('matching copy plus isolated restore prunes prior inventory then stages fresh history for the next backup',t=>{
  const f=fixture(t);f.run();f.receipts();const beforeManifest=readFileSync(join(f.archiveRoot,'manifest.json'));
  const oldInventory=JSON.parse(beforeManifest).entries;
  writeStateJson(f.collection,{markets:{m:{observations:[{at:20,count:6}]}}});
  const report=f.run();assert.equal(report.status,'STAGED');
  assert.equal(report.phases.find(p=>p.name==='prune'&&p.status==='COMPLETE').removed,oldInventory.length);
  assert.notEqual(report.manifestBefore,report.manifestAfter);
  for(const e of oldInventory)assert.equal(existsSync(join(f.dir,'.history',`${e.contentHash}.json.gz`)),false);
  assert.equal(f.run().status,'AWAITING_RESTORE'); // The old restore cannot authorize this new inventory.
  f.receipts();assert.equal(f.run().status,'PRUNED');
});
test('mixed copy/drill generations and legacy restore without archive verification wait without mutation',t=>{
  const f=fixture(t);f.run();f.receipts({copy:{sha256:'c'.repeat(64)}});
  assert.equal(f.run().phases[0].reason,'COPY_DRILL_BACKUP_MISMATCH');
  f.receipts({drill:{historyArchive:undefined}});assert.equal(f.run().phases[0].reason,'ARCHIVE_RESTORE_NOT_AVAILABLE');
});
test('failed restore or invalid copy verification reports FAILED without treating backup as complete',t=>{
  const f=fixture(t);f.run();const before=readdirSync(join(f.dir,'.history')).sort();
  f.receipts({drill:{hashes:'mismatch'}});let report=f.run();
  assert.equal(report.status,'FAILED');assert.equal(report.error,'HISTORY_MAINTENANCE_RESTORE_FAILED');
  f.receipts({copy:{verification:'unverified'}});report=f.run();
  assert.equal(report.error,'HISTORY_MAINTENANCE_COPY_INVALID');
  assert.deepEqual(readdirSync(join(f.dir,'.history')).sort(),before);
});
test('receipt destination, chronological timestamps and inventory count must match',t=>{
  const f=fixture(t);f.run();f.receipts();assert.equal(f.run({expectedDestinationId:'different-pc'}).error,'HISTORY_MAINTENANCE_DESTINATION_MISMATCH');
  f.receipts({drill:{verifiedAt:'2026-11-15T00:00:00Z'}});assert.equal(f.run().error,'HISTORY_MAINTENANCE_RECEIPT_TIME_INVALID');
  const r=f.receipts();f.receipts({drill:{historyArchive:{...r.drill.historyArchive,entries:999}}});
  assert.equal(f.run().error,'HISTORY_MAINTENANCE_RECEIPT_COUNT_MISMATCH');
});
test('unquiesced and unsafe report targets cannot run state maintenance',t=>{
  const f=fixture(t);assert.equal(f.run({quiesced:false}).error,'HISTORY_WRITERS_MUST_BE_QUIESCED');
  assert.equal(existsSync(join(f.archiveRoot,'manifest.json')),false);
  assert.throws(()=>f.run({report:f.collection}),/HISTORY_MAINTENANCE_REPORT_PATH_INVALID/);
  assert.throws(()=>f.run({report:join(f.receiptDir,'latest-copy.json')}),/HISTORY_MAINTENANCE_RECEIPT_PATH_REQUIRED/);
});
test('CLI accepts explicit receipts and collections and rejects accidental unsupported flags',t=>{
  const f=fixture(t);
  const args=['--state-root',f.stateRoot,'--archive-root',f.archiveRoot,'--report',f.input.report,
    '--copy-receipt',join(f.receiptDir,'latest-copy.json'),'--drill-receipt',join(f.receiptDir,'latest-drill.json'),
    '--collection','market','--quiesced'];
  assert.equal(main(args).status,'STAGED');
  assert.throws(()=>main([...args,'--force']),/HISTORY_MAINTENANCE_ARGUMENTS_INVALID/);
});
