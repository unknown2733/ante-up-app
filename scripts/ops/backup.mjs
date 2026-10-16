// Builtins only, Node 24+. No provider calls, signing, service start/stop or live restore.
import {createCipheriv, createDecipheriv, randomBytes, createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {open, readFile, lstat, realpath, readdir, mkdir, mkdtemp, copyFile, rm, stat} from 'node:fs/promises';
import {resolve, dirname, join, posix} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGunzip} from 'node:zlib';
import {DatabaseSync, backup as sqliteBackup} from 'node:sqlite';
import {check, inside, digest, json, args, syncDirectory} from './common.mjs';

const MAGIC=Buffer.from('ANTEUPB1'), HEADER=20, TAG=16, MAX_MANIFEST=16*1024**2;
const safePath=p=>typeof p==='string'&&p.length<4096&&p.split('/').every(s=>/^[^\\:\x00-\x1f]+$/.test(s)&&s!=='.'&&s!=='..');
async function keyFrom(path) {
  const key=await readFile(path);check(key.length===32,'BACKUP_KEY_MUST_BE_32_RANDOM_BYTES');return key;
}
async function exists(path) { try{await lstat(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;} }
async function files(root, prefix='') {
  const result=[];
  for(const name of (await readdir(join(root,prefix))).sort()){
    const path=prefix?`${prefix}/${name}`:name;check(safePath(path),'UNSAFE_SOURCE_PATH');
    const info=await lstat(join(root,path));
    check(!info.isSymbolicLink(),'SOURCE_SYMLINK_UNSUPPORTED');
    if(info.isDirectory())result.push(...await files(root,path));
    else {check(info.isFile()&&info.nlink===1,'SOURCE_SPECIAL_OR_HARDLINK_UNSUPPORTED');result.push(path);}
  }return result;
}
async function inventory(roots){
  const result=[];for(const [name,root] of Object.entries(roots))for(const path of await files(root)){
    const s=await lstat(join(root,path),{bigint:true});result.push([`${name}/${path}`,s.size.toString(),s.mtimeNs.toString(),s.ino.toString()]);
  }return JSON.stringify(result);
}
async function validateHistory(root, entries){
  const paths=new Set(entries.map(e=>e.path));
  function references(text,directory){
    for(const match of text.matchAll(/"__ante_history_sha256"\s*:\s*"([a-f0-9]{64})"/g))
      check(paths.has(`${directory}/.history/${match[1]}.json.gz`),'HISTORY_REFERENCE_MISSING');
  }
  for(const e of entries){
    const blob=e.path.match(/\/\.history\/([a-f0-9]{64})\.json\.gz$/);
    if(blob){
      const hash=createHash('sha256'), stream=createReadStream(join(root,e.path)).pipe(createGunzip());
      let tail='';
      for await(const chunk of stream){
        hash.update(chunk);const text=tail+chunk.toString('utf8');references(text,posix.dirname(posix.dirname(e.path)));tail=text.slice(-160);
      }
      check(hash.digest('hex')===blob[1],'HISTORY_CONTENT_HASH_MISMATCH');
    }
    if(!e.path.endsWith('/collection.json')&&!e.path.endsWith('/candidates.json'))continue;
    let tail='';
    for await(const chunk of createReadStream(join(root,e.path),{encoding:'utf8'})){
      const text=tail+chunk;
      references(text,posix.dirname(e.path));
      tail=text.slice(-160);
    }
  }
}
async function isSqlite(path) {
  const f=await open(path,'r');try{const b=Buffer.alloc(16);await f.read(b,0,16,0);return b.equals(Buffer.from('SQLite format 3\0'));}finally{await f.close();}
}
function inspectSqlite(path) {
  const db=new DatabaseSync(path,{readOnly:true});
  try{
    const result=db.prepare('PRAGMA quick_check').all();check(result.length===1&&Object.values(result[0])[0]==='ok','SQLITE_QUICK_CHECK_FAILED');
    // Schema fingerprint plus row counts detect lost ledgers/cursors without logging rows.
    const tables=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return {quickCheck:'ok',schemaHash:createHash('sha256').update(JSON.stringify(tables)).digest('hex'),
      tables:tables.map(t=>({name:t.name,rows:db.prepare(`SELECT count(*) AS n FROM "${t.name.replaceAll('"','""')}"`).get().n}))};
  }finally{db.close();}
}
async function exclusiveJson(path,value) {
  const f=await open(path,'wx',0o600);try{await f.writeFile(JSON.stringify(value,null,2)+'\n');await f.sync();}finally{await f.close();}
  await syncDirectory(dirname(path));
}

export async function createBackup({config,keyFile,output,quiesced=false}) {
  check(quiesced===true,'QUIESCED_WRITERS_REQUIRED');
  check(config.version===1&&typeof config.release==='string'&&config.release.length>0,'BACKUP_CONFIG_INVALID');
  check(config.roots&&['state','secrets','deployment'].every(k=>typeof config.roots[k]==='string'),'BACKUP_ROOTS_REQUIRED');
  check(Array.isArray(config.required)&&config.required.length>0&&config.required.every(safePath),'BACKUP_REQUIREMENTS_REQUIRED');
  const key=await keyFrom(keyFile), roots={};output=resolve(output);
  for(const [name,path] of Object.entries(config.roots)){
    check(/^[a-z][a-z0-9-]*$/.test(name),'INVALID_ROOT_NAME');
    check(!(await lstat(path)).isSymbolicLink()&&(await stat(path)).isDirectory(),'INVALID_SOURCE_ROOT');
    roots[name]=await realpath(path);
  }
  const parent=await realpath(dirname(output));output=join(parent,posix.basename(output.replaceAll('\\','/')));
  const keyPath=await realpath(keyFile);
  for(const a of Object.values(roots)){
    check(!inside(a,output)&&!inside(a,keyPath),'BACKUP_OUTPUT_OR_KEY_INSIDE_SOURCE');
    for(const b of Object.values(roots))if(a!==b)check(!inside(a,b),'OVERLAPPING_ROOTS');
  }
  check(new Set(Object.values(roots)).size===Object.keys(roots).length,'OVERLAPPING_ROOTS');
  check(!await exists(output),'OUTPUT_EXISTS');
  const stage=await mkdtemp(join(parent,'.ante-backup-'));let created=false;
  try{
    const before=await inventory(roots);
    const manifest={version:1,createdAt:new Date().toISOString(),release:config.release,consistency:'operator-quiesced',required:config.required,entries:[]};
    for(const [name,root] of Object.entries(roots)){
      const paths=await files(root);check(paths.length>0,'EMPTY_BACKUP_ROOT');
      const databases=new Set();for(const path of paths)if(await isSqlite(join(root,path)))databases.add(path);
      for(const path of paths){
        // SQLite backup folds committed WAL pages into a self-contained DB.
        if([...databases].some(db=>path===`${db}-wal`||path===`${db}-shm`))continue;
        const archivePath=`${name}/${path}`, source=join(root,path), dest=join(stage,archivePath);
        await mkdir(dirname(dest),{recursive:true,mode:0o700});let sqlite=null;
        if(databases.has(path)){
          // Copy quiesced DB/WAL first. SQLite may need to create shared memory,
          // which must happen in scratch, never in the read-only source mount.
          const scratch=await mkdtemp(join(stage,'.sqlite-')), clone=join(scratch,'source.sqlite');
          try{
            await copyFile(source,clone);if(await exists(`${source}-wal`))await copyFile(`${source}-wal`,`${clone}-wal`);
            const db=new DatabaseSync(clone);try{await sqliteBackup(db,dest);}finally{db.close();}
            const normalized=new DatabaseSync(dest);try{normalized.exec('PRAGMA journal_mode=DELETE');}finally{normalized.close();}
          }finally{await rm(scratch,{recursive:true,force:true});}
          sqlite=inspectSqlite(dest);
        }else await copyFile(source,dest);
        manifest.entries.push({path:archivePath,bytes:(await stat(dest)).size,sha256:await digest(dest),sqlite});
      }
    }
    check(await inventory(roots)===before,'SOURCE_CHANGED_DURING_BACKUP');
    for(const path of manifest.required)check(manifest.entries.some(e=>e.path===path),'REQUIRED_FILE_MISSING');
    await validateHistory(stage,manifest.entries);
    const encoded=Buffer.from(JSON.stringify(manifest));check(encoded.length<=MAX_MANIFEST,'MANIFEST_TOO_LARGE');
    const size=Buffer.alloc(4);size.writeUInt32BE(encoded.length);
    const iv=randomBytes(12), prefix=Buffer.concat([MAGIC,iv]), cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(prefix);
    const out=await open(output,'wx',0o600);created=true;
    try{
      await out.write(prefix);
      async function* content(){yield size;yield encoded;for(const e of manifest.entries)yield* createReadStream(join(stage,e.path));}
      // autoClose:false keeps the descriptor open until the tag and fsync land.
      await pipeline(Readable.from(content()),cipher,createWriteStream(output,{fd:out.fd,start:HEADER,autoClose:false}));
      await out.write(cipher.getAuthTag(),0,TAG,(await out.stat()).size);await out.sync();
    }finally{await out.close();}
    await syncDirectory(parent);
    return {version:1,kind:'encrypted-backup',createdAt:manifest.createdAt,release:manifest.release,files:manifest.entries.length,
      databases:manifest.entries.filter(e=>e.sqlite).length,bytes:(await stat(output)).size,sha256:await digest(output)};
  }catch(e){if(created)await rm(output,{force:true});throw e;}
  finally{key.fill(0);await rm(stage,{recursive:true,force:true});}
}

// Authentication completes before any manifest paths are parsed. Target must
// not exist; the tool cannot overwrite a live state or secret directory.
export async function restoreDrill({input,keyFile,target}) {
  const key=await keyFrom(keyFile);target=resolve(target);
  await mkdir(target,{mode:0o700});const plain=join(target,'.authenticated-payload');
  try{
    const f=await open(input,'r');let prefix,tag,length;
    try{
      length=(await f.stat()).size;check(length>HEADER+TAG+4,'INVALID_BACKUP');
      prefix=Buffer.alloc(HEADER);tag=Buffer.alloc(TAG);await f.read(prefix,0,HEADER,0);await f.read(tag,0,TAG,length-TAG);
    }finally{await f.close();}
    check(prefix.subarray(0,8).equals(MAGIC),'INVALID_BACKUP_VERSION');
    const decipher=createDecipheriv('aes-256-gcm',key,prefix.subarray(8));decipher.setAAD(prefix);decipher.setAuthTag(tag);
    await pipeline(createReadStream(input,{start:HEADER,end:length-TAG-1}),decipher,createWriteStream(plain,{flags:'wx',mode:0o600}));
    const payload=await open(plain,'r');let manifest;
    try{
      let position=0;
      async function read(n){const b=Buffer.alloc(n);let offset=0;while(offset<n){const r=await payload.read(b,offset,n-offset,position);check(r.bytesRead>0,'TRUNCATED_BACKUP');position+=r.bytesRead;offset+=r.bytesRead;}return b;}
      const n=(await read(4)).readUInt32BE();check(n>0&&n<=MAX_MANIFEST,'INVALID_MANIFEST_SIZE');manifest=JSON.parse((await read(n)).toString());
      check(manifest.version===1&&Array.isArray(manifest.entries)&&manifest.entries.length>0&&Array.isArray(manifest.required),'INVALID_MANIFEST');
      const seen=new Set();
      for(const entry of manifest.entries){
        check(safePath(entry.path)&&entry.path.split('/').length>=2&&entry.path!=='.authenticated-payload'&&!seen.has(entry.path.toLowerCase()),'UNSAFE_ARCHIVE_PATH');
        check(Number.isSafeInteger(entry.bytes)&&entry.bytes>=0&&/^[a-f0-9]{64}$/.test(entry.sha256),'INVALID_MANIFEST_ENTRY');seen.add(entry.path.toLowerCase());
        const path=join(target,entry.path);check(inside(target,path),'UNSAFE_ARCHIVE_PATH');await mkdir(dirname(path),{recursive:true,mode:0o700});
        const dest=await open(path,'wx',0o600),hash=createHash('sha256');
        try{let remaining=entry.bytes;while(remaining>0){const chunk=await read(Math.min(remaining,1024**2));hash.update(chunk);await dest.writeFile(chunk);remaining-=chunk.length;}await dest.sync();}finally{await dest.close();}
        check(hash.digest('hex')===entry.sha256,'RESTORE_HASH_MISMATCH');
        if(entry.sqlite)check(JSON.stringify(inspectSqlite(path))===JSON.stringify(entry.sqlite),'RESTORE_SQLITE_MISMATCH');
      }
      check(position===(await payload.stat()).size,'TRAILING_BACKUP_BYTES');
      for(const path of manifest.required)check(safePath(path)&&seen.has(path.toLowerCase()),'RESTORE_REQUIRED_FILE_MISSING');
    }finally{await payload.close();}
    await validateHistory(target,manifest.entries);
    await rm(plain);await exclusiveJson(join(target,'restore-report.json'),{version:1,kind:'isolated-restore-drill',verifiedAt:new Date().toISOString(),
      backupSha256:await digest(input),release:manifest.release,files:manifest.entries.length,databases:manifest.entries.filter(e=>e.sqlite).length,
      hashes:'matched',sqlite:'quick_check-schema-row-counts-matched',servicesStarted:false,chainReconciled:false});
    return json(join(target,'restore-report.json'));
  }catch(e){await rm(target,{recursive:true,force:true});throw e;}
  finally{key.fill(0);}
}

// A mounted destination can be NFS, SSHFS, removable media, etc. Its actual
// failure domain must be checked by an operator; a path name cannot prove it.
export async function copyBackup({input,destination,destinationId,failureDomain}) {
  check(typeof destinationId==='string'&&destinationId.length>0&&typeof failureDomain==='string'&&failureDomain.length>0,'DESTINATION_IDENTITY_REQUIRED');
  const source=await realpath(input), root=await realpath(destination), name=posix.basename(source.replaceAll('\\','/'));
  const header=await open(source,'r');try{const magic=Buffer.alloc(8);await header.read(magic,0,8,0);check(magic.equals(MAGIC)&&(await header.stat()).size>HEADER+TAG,'ENCRYPTED_BACKUP_REQUIRED');}finally{await header.close();}
  check(!inside(root,source),'COPY_DESTINATION_CONTAINS_SOURCE');
  const output=join(root,name);let created=false;
  try{
    const f=await open(output,'wx',0o600);created=true;
    try{for await(const chunk of createReadStream(source))await f.writeFile(chunk);await f.sync();}finally{await f.close();}
    const sha256=await digest(source);check(await digest(output)===sha256,'COPY_HASH_MISMATCH');
    const receipt={version:1,kind:'backup-copy',verifiedAt:new Date().toISOString(),artifact:name,sha256,bytes:(await stat(output)).size,
      destinationId,declaredFailureDomain:failureDomain,verification:'destination-readback-sha256',physicalSeparationVerified:false};
    await exclusiveJson(`${output}.receipt.json`,receipt);await syncDirectory(root);return receipt;
  }catch(e){if(created)await rm(output,{force:true});throw e;}
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{
    process.umask(0o077);
    const [command,...argv]=process.argv.slice(2);
    const a=args(argv,['--config','--key-file','--output','--input','--target','--destination','--destination-id','--failure-domain'],['--quiesced']);let result;
    if(command==='create')result=await createBackup({config:await json(a['--config']),keyFile:a['--key-file'],output:a['--output'],quiesced:a['--quiesced']});
    else if(command==='drill')result=await restoreDrill({input:a['--input'],keyFile:a['--key-file'],target:a['--target']});
    else if(command==='copy')result=await copyBackup({input:a['--input'],destination:a['--destination'],destinationId:a['--destination-id'],failureDomain:a['--failure-domain']});
    else throw Error('INVALID_COMMAND');
    console.log(JSON.stringify(result));
  }catch(e){console.error(/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'BACKUP_OPERATION_FAILED');process.exitCode=1;}
}
