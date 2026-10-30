import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {mkdir, mkdtemp, writeFile, readFile, rm, readdir, symlink} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createBackup, copyBackup, restoreDrill} from './backup.mjs';

async function fixture(t){
  // All transient data stays in this worktree, including synthetic key material.
  const parent=resolve('.codex-tmp/ops-tests');await mkdir(parent,{recursive:true});
  const dir=await mkdtemp(join(parent,'backup-'));
  for(const root of ['state','secrets','deployment','output','remote'])await mkdir(join(dir,root));
  await mkdir(join(dir,'state/live-smoke'),{recursive:true});
  await writeFile(join(dir,'state/live-smoke/collection.json'),JSON.stringify({totalSpentMicros:42}));
  await writeFile(join(dir,'secrets/operator.json'),'synthetic-operator-secret');
  await writeFile(join(dir,'deployment/release.env'),'ANTE_UP_RELEASE=test-only\n');
  const keyFile=join(dir,'backup-key');await writeFile(keyFile,randomBytes(32));
  const db=new DatabaseSync(join(dir,'state/live-smoke/index.sqlite'));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE ledger(id TEXT PRIMARY KEY, state TEXT); INSERT INTO ledger VALUES('uncertain-send','UNKNOWN');");
  t.after(async()=>{try{db.close();}catch{}await rm(dir,{recursive:true,force:true});});
  const config={version:1,release:'fixture-release',roots:Object.fromEntries(['state','secrets','deployment'].map(k=>[k,join(dir,k)])),
    required:['state/live-smoke/index.sqlite','state/live-smoke/collection.json','secrets/operator.json','deployment/release.env']};
  return {dir,db,config,keyFile,output:join(dir,'output/test.aub')};
}
test('encrypted complete snapshot includes committed WAL rows, secrets and config; copied restore matches',async t=>{
  const f=await fixture(t);const created=await createBackup({...f,quiesced:true});
  assert.equal(created.databases,1);assert.equal(created.files,4);
  assert.equal((await readFile(f.output)).includes(Buffer.from('synthetic-operator-secret')),false);
  const receipt=await copyBackup({input:f.output,destination:join(f.dir,'remote'),destinationId:'fixture-mount',failureDomain:'fixture-other-host'});
  assert.equal(receipt.sha256,created.sha256);assert.equal(receipt.physicalSeparationVerified,false);
  const target=join(f.dir,'restored'),report=await restoreDrill({input:join(f.dir,'remote/test.aub'),keyFile:f.keyFile,target});
  assert.equal(report.backupSha256,created.sha256);assert.equal(report.servicesStarted,false);
  assert.equal(await readFile(join(target,'secrets/operator.json'),'utf8'),'synthetic-operator-secret');
  const db=new DatabaseSync(join(target,'state/live-smoke/index.sqlite'),{readOnly:true});
  try{assert.equal(db.prepare('SELECT state FROM ledger').get().state,'UNKNOWN');}finally{db.close();}
  assert.equal((await readdir(join(target,'state/live-smoke'))).some(p=>p.endsWith('-wal')),false);
  assert.equal((await readdir(join(f.dir,'output'))).some(p=>p.startsWith('.ante-backup')),false);
});
test('immutable Snapshot SQLite is restored byte for byte while live WAL databases are normalized',async t=>{
  const f=await fixture(t),archivePath=join(f.dir,'state/archives/snapshots.sqlite');
  await mkdir(join(f.dir,'state/archives'));
  const archive=new DatabaseSync(archivePath);
  try{archive.exec("PRAGMA journal_mode=DELETE; CREATE TABLE snapshots(id INTEGER PRIMARY KEY, payload TEXT); INSERT INTO snapshots VALUES(1,'finalized');");}
  finally{archive.close();}
  const original=createHash('sha256').update(await readFile(archivePath)).digest('hex');
  f.config.required.push('state/archives/snapshots.sqlite');
  f.config.immutableSqlite=['state/archives/snapshots.sqlite'];
  const created=await createBackup({...f,quiesced:true});
  assert.equal(created.databases,2);
  const restored=join(f.dir,'restored');
  await restoreDrill({input:f.output,keyFile:f.keyFile,target:restored});
  assert.equal(createHash('sha256').update(await readFile(join(restored,'state/archives/snapshots.sqlite'))).digest('hex'),original);
  const live=new DatabaseSync(join(restored,'state/live-smoke/index.sqlite'),{readOnly:true});
  try{assert.equal(live.prepare('SELECT count(*) AS n FROM ledger').get().n,1);}
  finally{live.close();}
});
test('byte-exact SQLite must be required, present and free of WAL sidecars',async t=>{
  const f=await fixture(t);
  await assert.rejects(createBackup({...f,quiesced:true,config:{...f.config,
    immutableSqlite:['state/live-smoke/missing.sqlite']}}),/IMMUTABLE_SQLITE_CONFIG_INVALID/);
  await assert.rejects(createBackup({...f,quiesced:true,config:{...f.config,
    immutableSqlite:['state/live-smoke/index.sqlite']}}),/IMMUTABLE_SQLITE_NOT_QUIESCED/);
});
test('backup fails closed without quiescence, required file or separate key/output',async t=>{
  const f=await fixture(t);
  await assert.rejects(createBackup(f),/QUIESCED_WRITERS_REQUIRED/);
  await assert.rejects(createBackup({...f,quiesced:true,config:{...f.config,required:['state/missing']}}),/REQUIRED_FILE_MISSING/);
  await assert.rejects(createBackup({...f,quiesced:true,output:join(f.dir,'state/in-source.aub')}),/BACKUP_OUTPUT_OR_KEY_INSIDE_SOURCE/);
  await assert.rejects(createBackup({...f,quiesced:true,output:join(f.dir,'state/..hidden.aub')}),/BACKUP_OUTPUT_OR_KEY_INSIDE_SOURCE/);
  await writeFile(join(f.dir,'state/key'),randomBytes(32));
  await assert.rejects(createBackup({...f,quiesced:true,keyFile:join(f.dir,'state/key')}),/BACKUP_OUTPUT_OR_KEY_INSIDE_SOURCE/);
});
test('wrong key, tampering and truncation fail authentication and remove drill outputs',async t=>{
  const f=await fixture(t);await createBackup({...f,quiesced:true});
  const wrong=join(f.dir,'wrong');await writeFile(wrong,randomBytes(32));
  const target=join(f.dir,'bad-restore');await assert.rejects(restoreDrill({input:f.output,keyFile:wrong,target}));
  assert.equal((await readdir(f.dir)).includes('bad-restore'),false);
  const bytes=await readFile(f.output);bytes[25]^=1;const bad=join(f.dir,'tampered.aub');await writeFile(bad,bytes);
  await assert.rejects(restoreDrill({input:bad,keyFile:f.keyFile,target}));
  await writeFile(bad,bytes.subarray(0,19));await assert.rejects(restoreDrill({input:bad,keyFile:f.keyFile,target}),/INVALID_BACKUP/);
});
test('existing backup, copy and restore destinations are never overwritten',async t=>{
  const f=await fixture(t);await createBackup({...f,quiesced:true});
  await assert.rejects(createBackup({...f,quiesced:true}),/OUTPUT_EXISTS/);
  const target=join(f.dir,'existing');await mkdir(target);await writeFile(join(target,'keep'),'preserve');
  await assert.rejects(restoreDrill({input:f.output,keyFile:f.keyFile,target}));assert.equal(await readFile(join(target,'keep'),'utf8'),'preserve');
  await writeFile(join(f.dir,'remote/test.aub'),'preserve');
  await assert.rejects(copyBackup({input:f.output,destination:join(f.dir,'remote'),destinationId:'a',failureDomain:'b'}));
  assert.equal(await readFile(join(f.dir,'remote/test.aub'),'utf8'),'preserve');
});
test('source symbolic links or Windows junctions are rejected rather than escaping the backup scope',async t=>{
  const f=await fixture(t);
  try{await symlink(join(f.dir,'secrets'),join(f.dir,'state/escape'),process.platform==='win32'?'junction':'dir');}
  catch(e){if(process.platform==='win32'&&e.code==='EPERM'){t.skip('Windows sandbox disallows symlinks/junctions');return;}throw e;}
  await assert.rejects(createBackup({...f,quiesced:true}),/SOURCE_SYMLINK_UNSUPPORTED/);
});
test('missing and corrupt content-addressed history blobs fail closed; valid blobs survive recovery',async t=>{
  const f=await fixture(t),bytes=Buffer.from('[{"bucketEnd":123}]'),hash=createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(f.dir,'state/live-smoke/collection.json'),JSON.stringify({observations:{__ante_history_sha256:hash}}));
  await assert.rejects(createBackup({...f,quiesced:true}),/HISTORY_REFERENCE_MISSING/);
  const history=join(f.dir,'state/live-smoke/.history');await mkdir(history);
  const outer=Buffer.from(JSON.stringify({observations:{__ante_history_sha256:hash}})),outerHash=createHash('sha256').update(outer).digest('hex');
  await writeFile(join(history,`${outerHash}.json.gz`),gzipSync(outer));
  await writeFile(join(f.dir,'state/live-smoke/collection.json'),JSON.stringify({replayInput:{__ante_history_sha256:outerHash}}));
  await assert.rejects(createBackup({...f,quiesced:true}),/HISTORY_REFERENCE_MISSING/);
  await writeFile(join(history,`${hash}.json.gz`),gzipSync(Buffer.from('corrupt-content')));
  await assert.rejects(createBackup({...f,quiesced:true}),/HISTORY_CONTENT_HASH_MISMATCH/);
  await writeFile(join(history,`${hash}.json.gz`),gzipSync(bytes));await createBackup({...f,quiesced:true});
  await restoreDrill({input:f.output,keyFile:f.keyFile,target:join(f.dir,'restored')});
});
