import {lstat,readdir,readFile,statfs} from 'node:fs/promises';
import {resolve,relative,join,sep,isAbsolute} from 'node:path';
import {validateArchiveManifest} from '../services/data/history-archive.mjs';

const inside=(base,path)=>{const p=relative(base,path);return p===''||p!=='..'&&!p.startsWith(`..${sep}`)&&!isAbsolute(p);};
// Only inventoried, size-matching cold blobs are excluded from admission usage.
// Hash integrity is checked by migration/restore and again by every state reader.
export async function measureStateStorage(directory,{archiveRoot=process.env.ANTE_UP_HISTORY_ARCHIVE_ROOT,
  stateRoot=process.env.ANTE_UP_HISTORY_STATE_ROOT}={}){
  directory=resolve(directory);const cold=new Map();
  if(archiveRoot){
    if(!stateRoot)throw Error('HISTORY_ARCHIVE_STATE_ROOT_REQUIRED');
    archiveRoot=resolve(archiveRoot);stateRoot=resolve(stateRoot);
    if(!inside(stateRoot,archiveRoot)||archiveRoot===stateRoot)throw Error('HISTORY_ARCHIVE_PATH_INVALID');
    const manifestPath=join(archiveRoot,'manifest.json');
    try{
      if(!(await lstat(archiveRoot)).isDirectory())throw Error('HISTORY_ARCHIVE_PATH_INVALID');
      if(!(await lstat(manifestPath)).isFile())throw Error('HISTORY_ARCHIVE_MANIFEST_INVALID');
      const bytes=await readFile(manifestPath),manifest=validateArchiveManifest(JSON.parse(bytes));
      cold.set(manifestPath,bytes.length);
      for(const e of manifest.entries)cold.set(join(archiveRoot,e.path),e.bytes);
    }catch(error){
      // Fresh deployments can configure an archive before their first migration.
      // Existing archive files without a manifest are counted as active, never hidden.
      if(error.code!=='ENOENT')throw error;
    }
  }
  let activeBytes=0,archiveBytes=0;const found=new Set();
  async function walk(path){
    const s=await lstat(path);
    if(s.isDirectory()){for(const n of await readdir(path))await walk(join(path,n));}
    else if(s.isFile()){
      if(cold.has(path)){
        if(cold.get(path)!==s.size)throw Error('HISTORY_ARCHIVE_BYTES_MISMATCH');
        archiveBytes+=s.size;found.add(path);
      }else activeBytes+=s.size;
    }else throw Error('UNEXPECTED_STATE_ENTRY');
  }
  await walk(directory);
  for(const path of cold.keys())if(inside(directory,path)&&!found.has(path))throw Error('HISTORY_ARCHIVE_FILE_MISSING');
  const fs=await statfs(directory);
  return {activeBytes,archiveBytes,totalBytes:activeBytes+archiveBytes,hostFreeBytes:fs.bavail*fs.bsize};
}
