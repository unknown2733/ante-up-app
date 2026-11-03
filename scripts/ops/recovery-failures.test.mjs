import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createBackup,restoreDrill,copyBackup} from './backup.mjs';

// Same 42 roles as the deployed contract; host names/paths and every byte are synthetic.
const required=[
  ...['compose.resolved.yml','evidence-budget.env','image-inventory.json','keeper-runner/crontab.entry',
    'keeper-runner/run-weekly-keeper.sh','ops-tool-source/backup.mjs','ops-tool-source/common.mjs',
    'ops-tool-source/monitor.mjs','release.env','run-backup-cycle.sh','run-backup.sh',
    'runtime-containers.json','runtime-images.tar','visitor-sol.env'].map(p=>'deployment/'+p),
  ...['ante-up-reference-youtube.service','ante-up-reference-youtube.service.d/oracle-prep.conf',
    'ante-up-reference-youtube.timer'].map(p=>'deployment/systemd-sources/home/operator/.config/systemd/user/'+p),
  'deployment/systemd-sources/srv/app/youtube/run-reference-youtube.sh',
  ...['devnet-deployer.json','devnet-issuer.json','devnet-keeper.json','devnet-publisher.json',
    'devnet-rpc.secondary.url','devnet-rpc.url','turbo-upload-key.json','visitor-sol.json','x-bearer.token'].map(p=>'secrets/'+p),
  'state/archives/snapshots.sqlite','state/keeper-auto/markets.json',
  ...['candidates.json','collection-config.json','collection.json','evidence/budget.json','evidence/jobs.json',
    'index.sqlite','index.sqlite.visitor-sol.sqlite','price-history.sqlite'].map(p=>'state/live-smoke/'+p),
  'state/markets.json',...['candidates.json','collection-config.json','collection.json','index.sqlite'].map(p=>'state/tariff/'+p)
];
const pcRequired=['state/keeper-auto/markets.json','secrets/devnet-rpc.secondary.url','secrets/devnet-keeper.json',
  'deployment/keeper-runner/run-weekly-keeper.sh','deployment/keeper-runner/crontab.entry'];
const sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t){
  const parent=resolve('.codex-tmp/ops-tests');await mkdir(parent,{recursive:true});
  const dir=await mkdtemp(join(parent,'recovery-faults-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const root of ['state','secrets','deployment','output','remote'])await mkdir(join(dir,root));
  for(const path of required){
    const file=join(dir,path);await mkdir(dirname(file),{recursive:true});
    if(path.endsWith('.sqlite')){const db=new DatabaseSync(file);db.exec('CREATE TABLE synthetic(id INTEGER); INSERT INTO synthetic VALUES(1)');db.close();}
    else await writeFile(file,JSON.stringify({synthetic:true,path}));
  }
  const keyFile=join(dir,'synthetic.key');await writeFile(keyFile,randomBytes(32));
  return {dir,keyFile,output:join(dir,'output/round.aub'),config:{version:1,release:'synthetic-round',
    roots:Object.fromEntries(['state','secrets','deployment'].map(p=>[p,join(dir,p)])),required,
    immutableSqlite:['state/archives/snapshots.sqlite']}};
}
async function rewrite(f,name,edit){
  const original=await readFile(f.output),key=await readFile(f.keyFile),header=original.subarray(0,20);
  const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(8));decipher.setAAD(header);decipher.setAuthTag(original.subarray(-16));
  const plain=Buffer.concat([decipher.update(original.subarray(20,-16)),decipher.final()]);
  const n=plain.readUInt32BE(),manifest=JSON.parse(plain.subarray(4,4+n)),body=plain.subarray(4+n);
  const nextBody=edit(manifest,body)??body;
  const encoded=Buffer.from(JSON.stringify(manifest)),length=Buffer.alloc(4);length.writeUInt32BE(encoded.length);
  const prefix=Buffer.concat([header.subarray(0,8),randomBytes(12)]),cipher=createCipheriv('aes-256-gcm',key,prefix.subarray(8));cipher.setAAD(prefix);
  const path=join(f.dir,'output/'+name+'.aub');
  await writeFile(path,Buffer.concat([prefix,cipher.update(Buffer.concat([length,encoded,nextBody])),cipher.final(),cipher.getAuthTag()]));return path;
}

test('all 42 required roles round-trip under the five-file PC contract',async t=>{
  assert.equal(required.length,42);assert.equal(pcRequired.length,5);
  const f=await fixture(t),created=await createBackup({...f,quiesced:true});assert.equal(created.files,42);
  const receipt=await copyBackup({input:f.output,destination:join(f.dir,'remote'),destinationId:'synthetic-pc',failureDomain:'synthetic-only'});
  const target=join(f.dir,'restored'),report=await restoreDrill({input:join(f.dir,'remote/round.aub'),keyFile:f.keyFile,target,requiredFiles:pcRequired});
  assert.equal(report.requiredFiles.length,42);assert.equal(report.backupSha256,receipt.sha256);
  for(const path of required){
    if(path.endsWith('.sqlite')&&!f.config.immutableSqlite.includes(path)){
      const db=new DatabaseSync(join(target,path),{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) AS n FROM synthetic').get().n,1);}finally{db.close();}
    }else assert.equal(sha(await readFile(join(target,path))),sha(await readFile(join(f.dir,path))));
  }
});

test('every missing required input fails preparation without an artifact or replacing prior reports',async t=>{
  const f=await fixture(t),prior=join(f.dir,'last-success.json'),priorBytes=Buffer.from('{"syntheticPreviousSuccess":true}');await writeFile(prior,priorBytes);
  for(const path of required){
    const file=join(f.dir,path),bytes=await readFile(file);await rm(file);
    await assert.rejects(createBackup({...f,quiesced:true}),/REQUIRED_FILE_MISSING|IMMUTABLE_SQLITE_MISSING/);
    assert.deepEqual(await readdir(join(f.dir,'output')),[]);assert.deepEqual(await readFile(prior),priorBytes);
    await writeFile(file,bytes);
  }
});

test('authenticated partial manifests and altered payloads fail, remove drill outputs, and preserve the archive',async t=>{
  const f=await fixture(t);await createBackup({...f,quiesced:true});const before=sha(await readFile(f.output));
  const cases=[
    ['missing-version',m=>{delete m.version},/INVALID_MANIFEST/],
    ['missing-release',m=>{delete m.release},/INVALID_MANIFEST/],
    ['missing-created',m=>{delete m.createdAt},/INVALID_MANIFEST/],
    ['invalid-created',m=>{m.createdAt='not-a-date'},/INVALID_MANIFEST/],
    ['missing-consistency',m=>{delete m.consistency},/INVALID_MANIFEST/],
    ['duplicate-required',m=>{m.required.push(m.required[0])},/INVALID_MANIFEST/],
    ['empty-required',m=>{m.required=[]},/INVALID_MANIFEST/],
    ['null-entry',m=>{m.entries[0]=null},/INVALID_MANIFEST_ENTRY/],
    ['missing-pc-declaration',m=>{m.required=m.required.filter(p=>p!==pcRequired[0])},/RESTORE_REQUIREMENT_NOT_DECLARED/],
    ['missing-non-pc-entry',(m,b)=>{const entry=m.entries.pop();return b.subarray(0,b.length-entry.bytes)},/RESTORE_REQUIRED_FILE_MISSING/],
    ['wrong-entry-hash',m=>{m.entries[0].sha256='0'.repeat(64)},/RESTORE_HASH_MISMATCH/],
    ['short-payload',(_m,b)=>b.subarray(0,-1),/TRUNCATED_BACKUP/],
    ['extra-payload',(_m,b)=>Buffer.concat([b,Buffer.from('extra')]),/TRAILING_BACKUP_BYTES/]
  ];
  for(const path of ['deployment/runtime-images.tar','deployment/keeper-runner/run-weekly-keeper.sh',
    'deployment/systemd-sources/home/operator/.config/systemd/user/ante-up-reference-youtube.service.d/oracle-prep.conf',
    'deployment/run-backup-cycle.sh'])
    cases.push(['component-hash-'+cases.length,m=>{m.entries.find(e=>e.path===path).sha256='0'.repeat(64)},/RESTORE_HASH_MISMATCH/]);
  for(const [name,edit,error] of cases){
    const input=await rewrite(f,name,edit),target=join(f.dir,'drill-'+name);
    await assert.rejects(restoreDrill({input,keyFile:f.keyFile,target,requiredFiles:pcRequired}),error,name);
    assert.ok(!(await readdir(f.dir)).includes('drill-'+name));assert.equal(sha(await readFile(f.output)),before);
  }
});

test('PC CLI drill failure publishes no success JSON and leaves the previous report untouched',async t=>{
  const f=await fixture(t);await createBackup({...f,quiesced:true});
  const input=await rewrite(f,'wrong-hash',m=>{m.entries[0].sha256='0'.repeat(64)});
  const prior=join(f.dir,'last-drill.json');await writeFile(prior,'previous-success');
  const req=join(f.dir,'requirements.json');await writeFile(req,JSON.stringify(pcRequired));
  const target=join(f.dir,'cli-drill');
  const child=spawnSync(process.execPath,['scripts/ops/backup.mjs','drill','--input',input,'--key-file',f.keyFile,'--target',target,'--requirements-file',req],{encoding:'utf8'});
  assert.equal(child.status,1);assert.equal(child.stdout.trim(),'');assert.match(child.stderr,/RESTORE_HASH_MISMATCH/);
  assert.equal(await readFile(prior,'utf8'),'previous-success');assert.ok(!(await readdir(f.dir)).includes('cli-drill'));
});

test('preparation rejects ambiguous requirements and incomplete release identity',async t=>{
  const f=await fixture(t);
  for(const extra of [required[0],required[0].toUpperCase()])
    await assert.rejects(createBackup({...f,quiesced:true,config:{...f.config,required:[...required,extra]}}),/BACKUP_REQUIREMENTS_REQUIRED/);
  await assert.rejects(createBackup({...f,quiesced:true,config:{...f.config,release:'  '}}),/BACKUP_CONFIG_INVALID/);
  assert.deepEqual(await readdir(join(f.dir,'output')),[]);
});
