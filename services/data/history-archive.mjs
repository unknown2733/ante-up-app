// Lossless cold storage. A staged archive is readable before any active copy is removed.
import {readFileSync,writeFileSync,mkdirSync,readdirSync,lstatSync,existsSync,renameSync,
  unlinkSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {resolve,relative,join,dirname,sep,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {readHistoryBlob} from './state-json.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const check=(ok,code)=>{if(!ok)throw Error(code);};
const marker='__ante_history_sha256';
const posix=p=>p.split(sep).join('/');
const inside=(base,path)=>{const r=relative(resolve(base),resolve(path));return r!==''&&r!=='..'&&!r.startsWith(`..${sep}`)&&!isAbsolute(r);};
function plainFile(path){check(lstatSync(path).isFile(),'HISTORY_UNEXPECTED_FILE');return readFileSync(path);}
function checkedArchivePath(root,path){
  check(inside(root,path),'HISTORY_ARCHIVE_PATH_INVALID');
  let current=resolve(root);check(lstatSync(current).isDirectory(),'HISTORY_ARCHIVE_PATH_INVALID');
  for(const part of relative(root,dirname(path)).split(sep).filter(Boolean)){
    current=join(current,part);if(existsSync(current))check(lstatSync(current).isDirectory(),'HISTORY_ARCHIVE_PATH_INVALID');
  }return path;
}
function atomic(path,bytes){
  mkdirSync(dirname(path),{recursive:true});const tmp=`${path}.${process.pid}.tmp`;
  const fd=openSync(tmp,'w',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(tmp,path);
}
function listFiles(root){
  const files=[];
  for(const e of readdirSync(root,{withFileTypes:true})){
    const path=join(root,e.name);check(!e.isSymbolicLink(),'HISTORY_SYMLINK_UNSUPPORTED');
    if(e.isDirectory())files.push(...listFiles(path));else{check(e.isFile(),'HISTORY_UNEXPECTED_FILE');files.push(path);}
  }
  return files;
}
function refs(value){
  const out=new Set();
  function walk(v){if(!v||typeof v!=='object')return;
    if(Object.keys(v).length===1&&Object.hasOwn(v,marker)){
      check(/^[a-f0-9]{64}$/.test(v[marker]),'HISTORY_HASH_INVALID');out.add(v[marker]);return;
    }
    for(const child of Object.values(v))walk(child);
  }walk(value);return out;
}
function closure(stateFile,initial,options){
  const visited=new Set();
  function visit(h){if(visited.has(h))return;visited.add(h);
    const value=JSON.parse(readHistoryBlob(stateFile,h,options));for(const child of refs(value))visit(child);
  }
  for(const h of initial)visit(h);return visited;
}
function verifyRootReferences(plan){
  for(const r of plan.roots){const path=join(plan.stateRoot,r.path);closure(path,refs(JSON.parse(plainFile(path))),plan);}
}
function inventoryPath(path){
  check(typeof path==='string'&&!path.includes('\\')&&!path.startsWith('/')&&
    path.split('/').every(x=>x&&x!=='.'&&x!=='..')&&/\/[a-f0-9]{64}\.json\.gz$/.test(path),'HISTORY_ARCHIVE_PATH_INVALID');
}
export function validateArchiveManifest(value){
  check(value?.version===1&&value.kind==='HISTORY_ARCHIVE_INVENTORY'&&Array.isArray(value.entries),'HISTORY_ARCHIVE_MANIFEST_INVALID');
  const paths=new Set();
  for(const e of value.entries){inventoryPath(e.path);check(!paths.has(e.path),'HISTORY_ARCHIVE_DUPLICATE');paths.add(e.path);
    check(/^[a-f0-9]{64}$/.test(e.sha256)&&/^[a-f0-9]{64}$/.test(e.contentHash)&&
      e.path.endsWith(`/${e.contentHash}.json.gz`)&&Number.isSafeInteger(e.bytes)&&e.bytes>0,'HISTORY_ARCHIVE_ENTRY_INVALID');
  }return value;
}
export function verifyHistoryArchive(archiveRoot){
  archiveRoot=resolve(archiveRoot);
  const bytes=plainFile(checkedArchivePath(archiveRoot,join(archiveRoot,'manifest.json'))),manifest=validateArchiveManifest(JSON.parse(bytes));
  let total=0;
  for(const e of manifest.entries){const p=checkedArchivePath(archiveRoot,join(archiveRoot,e.path));
    const compressed=plainFile(p);check(compressed.length===e.bytes&&hash(compressed)===e.sha256,'HISTORY_ARCHIVE_BYTES_MISMATCH');
    check(hash(gunzipSync(compressed))===e.contentHash,'HISTORY_HASH_MISMATCH');total+=e.bytes;
  }
  return {kind:'HISTORY_ARCHIVE_VERIFICATION',manifestSha256:hash(bytes),hashes:'matched',entries:manifest.entries.length,bytes:total};
}
function sourceRoots(stateRoot,collections,protectedPaths){
  const roots=[];
  for(const name of collections){
    check(typeof name==='string'&&/^[a-zA-Z0-9_-]+$/.test(name),'HISTORY_COLLECTION_INVALID');
    const dir=join(stateRoot,name);check(lstatSync(dir).isDirectory(),'HISTORY_COLLECTION_INVALID');
    // Backup journals are included for reference verification, never used to infer obligations.
    for(const file of readdirSync(dir)){
      if(!(file.endsWith('.json')||file.endsWith('.bak')))continue;
      const p=join(dir,file);if(!lstatSync(p).isFile())continue;
      roots.push({path:posix(relative(stateRoot,p)),role:file==='collection.json'?'current':file==='candidates.json'?'candidates':'historical'});
    }
    check(roots.some(r=>r.path===`${name}/collection.json`)&&roots.some(r=>r.path===`${name}/candidates.json`),'HISTORY_COLLECTION_ROOT_MISSING');
  }
  for(const p of protectedPaths){
    const abs=resolve(stateRoot,p);check(inside(stateRoot,abs),'HISTORY_PROTECTED_PATH_INVALID');
    check(existsSync(abs),'HISTORY_PROTECTED_PATH_MISSING');
    const files=lstatSync(abs).isDirectory()?listFiles(abs):[abs];
    for(const f of files.filter(f=>f.endsWith('.json'))){
      const rel=posix(relative(stateRoot,f)),existing=roots.find(r=>r.path===rel);
      if(existing)existing.role='protected';else roots.push({path:rel,role:'protected'});
    }
  }
  return roots;
}
export function planHistoryArchive({stateRoot,archiveRoot,collections,protectedPaths=[]}){
  stateRoot=resolve(stateRoot);archiveRoot=resolve(archiveRoot);
  check(Array.isArray(collections)&&collections.length>0&&new Set(collections).size===collections.length,'HISTORY_COLLECTION_INVALID');
  for(const c of collections)check(!inside(join(stateRoot,c),archiveRoot)&&archiveRoot!==join(stateRoot,c),'HISTORY_ARCHIVE_IN_ACTIVE_ROOT');
  const options={stateRoot,archiveRoot},roots=sourceRoots(stateRoot,collections,protectedPaths);
  const active=new Map(collections.map(c=>[c,new Set()]));
  for(const root of roots){
    const path=join(stateRoot,root.path),bytes=plainFile(path),value=JSON.parse(bytes);root.sha256=hash(bytes);
    const all=refs(value);if(!all.size)continue;
    // Every historical reference must remain reconstructible, including nested refs.
    closure(path,all,options);
    let keep=root.role==='historical'?new Set():all;
    if(root.role==='candidates'){
      check(value.jobs&&typeof value.jobs==='object','HISTORY_CANDIDATES_INVALID');
      keep=refs({...value,jobs:Object.fromEntries(Object.entries(value.jobs).filter(([,job])=>
        job.state!=='FINALIZED'||job.published?.finality!=='finalized'))});
    }
    const namespace=root.path.split('/')[0];
    if(active.has(namespace))for(const h of closure(path,keep,options))active.get(namespace).add(h);
    else check(!keep.size,'HISTORY_PROTECTED_NAMESPACE_UNSUPPORTED');
  }
  const entries=[];let protectedBytes=0;
  for(const c of collections){const directory=join(stateRoot,c,'.history');if(!existsSync(directory))continue;
    check(lstatSync(directory).isDirectory(),'HISTORY_UNEXPECTED_FILE');
    for(const name of readdirSync(directory).sort()){
      check(/^[a-f0-9]{64}\.json\.gz$/.test(name),'HISTORY_UNEXPECTED_BLOB');
      const contentHash=name.slice(0,64),bytes=plainFile(join(directory,name));
      check(hash(gunzipSync(bytes))===contentHash,'HISTORY_HASH_MISMATCH');
      if(active.get(c).has(contentHash)){protectedBytes+=bytes.length;continue;}
      entries.push({path:`${c}/${name}`,sha256:hash(bytes),contentHash,bytes:bytes.length});
    }
  }
  return {version:1,kind:'HISTORY_ARCHIVE_PLAN',stateRoot,archiveRoot,collections,protectedPaths,roots,
    entries,protectedBytes,archiveBytes:entries.reduce((s,e)=>s+e.bytes,0)};
}
function validatePlan(plan){
  check(plan?.version===1&&plan.kind==='HISTORY_ARCHIVE_PLAN'&&Array.isArray(plan.roots),'HISTORY_ARCHIVE_PLAN_INVALID');
  validateArchiveManifest({version:1,kind:'HISTORY_ARCHIVE_INVENTORY',entries:plan.entries});
  check(resolve(plan.stateRoot)===plan.stateRoot&&resolve(plan.archiveRoot)===plan.archiveRoot,'HISTORY_ARCHIVE_PLAN_PATH_INVALID');
  check(Array.isArray(plan.collections)&&plan.collections.length>0&&plan.collections.every(c=>/^[a-zA-Z0-9_-]+$/.test(c)),'HISTORY_COLLECTION_INVALID');
  for(const c of plan.collections)check(!inside(join(plan.stateRoot,c),plan.archiveRoot)&&plan.archiveRoot!==join(plan.stateRoot,c),'HISTORY_ARCHIVE_IN_ACTIVE_ROOT');
  for(const e of plan.entries)check(plan.collections.includes(dirname(e.path)),'HISTORY_ARCHIVE_NAMESPACE_INVALID');
  for(const r of plan.roots)check(inside(plan.stateRoot,resolve(plan.stateRoot,r.path))&&/^[a-f0-9]{64}$/.test(r.sha256),'HISTORY_ROOT_INVALID');
}
function checkRoots(plan){for(const r of plan.roots)check(hash(plainFile(join(plan.stateRoot,r.path)))===r.sha256,'HISTORY_ROOT_CHANGED');}
function checkCurrentRoots(plan){
  checkRoots(plan);
  const roots=sourceRoots(plan.stateRoot,plan.collections,plan.protectedPaths);
  check(JSON.stringify(roots.map(r=>[r.path,r.role]).sort())===JSON.stringify(plan.roots.map(r=>[r.path,r.role]).sort()),'HISTORY_ROOT_SET_CHANGED');
}
function rootStamp(plan){return JSON.stringify(plan.roots.map(r=>{const s=lstatSync(join(plan.stateRoot,r.path),{bigint:true});
  check(s.isFile(),'HISTORY_UNEXPECTED_FILE');return [r.path,String(s.size),String(s.mtimeNs),String(s.ino)];}));}
function activePath(plan,e){return join(plan.stateRoot,dirname(e.path),'.history',`${e.contentHash}.json.gz`);}
export function stageHistoryArchive(plan,{quiesced=false}={}){
  validatePlan(plan);check(quiesced,'HISTORY_WRITERS_MUST_BE_QUIESCED');checkCurrentRoots(plan);
  mkdirSync(plan.archiveRoot,{recursive:true});
  check(lstatSync(plan.archiveRoot).isDirectory(),'HISTORY_ARCHIVE_PATH_INVALID');
  let existing=[];const manifestPath=join(plan.archiveRoot,'manifest.json');
  if(existsSync(manifestPath)){verifyHistoryArchive(plan.archiveRoot);existing=JSON.parse(plainFile(manifestPath)).entries;}
  const entries=new Map(existing.map(e=>[e.path,e]));
  for(const e of plan.entries){
    const source=activePath(plan,e),destination=checkedArchivePath(plan.archiveRoot,join(plan.archiveRoot,e.path));
    const bytes=existsSync(source)?plainFile(source):plainFile(destination);
    check(bytes.length===e.bytes&&hash(bytes)===e.sha256&&hash(gunzipSync(bytes))===e.contentHash,'HISTORY_SOURCE_CHANGED');
    if(existsSync(destination))check(hash(plainFile(destination))===e.sha256,'HISTORY_ARCHIVE_CONFLICT');else atomic(destination,bytes);
    if(entries.has(e.path))check(JSON.stringify(entries.get(e.path))===JSON.stringify(e),'HISTORY_ARCHIVE_CONFLICT');
    entries.set(e.path,e);
  }
  checkCurrentRoots(plan);
  atomic(manifestPath,JSON.stringify({version:1,kind:'HISTORY_ARCHIVE_INVENTORY',entries:[...entries.values()].sort((a,b)=>a.path.localeCompare(b.path))}));
  return verifyHistoryArchive(plan.archiveRoot);
}
export function pruneHistoryArchive(plan,restoreReceipt,{quiesced=false}={}){
  validatePlan(plan);check(quiesced,'HISTORY_WRITERS_MUST_BE_QUIESCED');checkCurrentRoots(plan);
  const verified=verifyHistoryArchive(plan.archiveRoot);
  check(restoreReceipt?.kind==='HISTORY_ARCHIVE_RESTORE_VERIFICATION'&&restoreReceipt.hashes==='matched'&&
    restoreReceipt.manifestSha256===verified.manifestSha256,'HISTORY_RESTORE_RECEIPT_REQUIRED');
  const inventory=new Map(JSON.parse(plainFile(join(plan.archiveRoot,'manifest.json'))).entries.map(e=>[e.path,e]));
  for(const e of plan.entries)check(JSON.stringify(inventory.get(e.path))===JSON.stringify(e),'HISTORY_ARCHIVE_NOT_IN_MANIFEST');
  // Force all refs, using fallback after prior partial prunes; no malformed/missing history is discarded.
  verifyRootReferences(plan);
  let removed=0;const initialStamp=rootStamp(plan);
  for(const e of plan.entries){
    check(rootStamp(plan)===initialStamp,'HISTORY_ROOT_CHANGED');const path=activePath(plan,e);
    if(!existsSync(path))continue;
    check(hash(plainFile(path))===e.sha256,'HISTORY_SOURCE_CHANGED');
    // Destination was verified as a whole above; recheck immediately before unlinking its duplicate.
    check(hash(plainFile(join(plan.archiveRoot,e.path)))===e.sha256,'HISTORY_ARCHIVE_BYTES_MISMATCH');
    unlinkSync(path);removed++;
  }
  checkCurrentRoots(plan);
  verifyRootReferences(plan);
  return {...verified,removed};
}

// A later backup receipt can safely prune an older inventory after writers ran:
// recompute current obligations instead of requiring the original stage's roots.
// Never add entries or alter the receipt-bound manifest in this operation.
export function pruneCurrentHistoryArchive(options,restoreReceipt,{quiesced=false}={}){
  check(quiesced,'HISTORY_WRITERS_MUST_BE_QUIESCED');
  const manifestBytes=plainFile(join(resolve(options.archiveRoot),'manifest.json'));
  const manifest=validateArchiveManifest(JSON.parse(manifestBytes));
  check(restoreReceipt?.kind==='HISTORY_ARCHIVE_RESTORE_VERIFICATION'&&restoreReceipt.hashes==='matched'&&
    restoreReceipt.manifestSha256===hash(manifestBytes),'HISTORY_RESTORE_RECEIPT_REQUIRED');
  const inventory=new Map(manifest.entries.map(e=>[e.path,e]));
  const current=planHistoryArchive(options);
  current.entries=current.entries.filter(e=>{
    const archived=inventory.get(e.path);if(!archived)return false;
    check(e.sha256===archived.sha256&&e.contentHash===archived.contentHash&&e.bytes===archived.bytes,'HISTORY_ARCHIVE_CONFLICT');
    return true;
  });
  current.archiveBytes=current.entries.reduce((sum,e)=>sum+e.bytes,0);
  // Retains all strict root/file/hash and immediate pre-delete checks.
  return pruneHistoryArchive(current,restoreReceipt,{quiesced:true});
}
