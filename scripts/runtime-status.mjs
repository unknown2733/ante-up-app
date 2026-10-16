import {writeFile,rename,mkdir,statfs,readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
export async function heartbeat(role, detail={}) {
  const directory=process.env.ANTE_UP_HEALTH_DIRECTORY;
  if(!directory)return;
  await mkdir(directory,{recursive:true});
  const path=join(directory,`${role}.json`),tmp=`${path}.${process.pid}.tmp`;
  await writeFile(tmp,JSON.stringify({role,at:Date.now(),...detail}));await rename(tmp,path);
}
let checkedAt=0;
export async function storagePressure(directory){
  if(!process.env.ANTE_UP_STATE_LIMIT_BYTES)return null;
  const limit=Number(process.env.ANTE_UP_STATE_LIMIT_BYTES);
  if(!Number.isSafeInteger(limit)||limit<=0)throw Error('INVALID_STORAGE_LIMIT');
  const fs=await statfs(directory);
  async function size(path){let bytes=0;for(const e of await readdir(path,{withFileTypes:true})){const p=join(path,e.name);if(e.isDirectory())bytes+=await size(p);else if(e.isFile())bytes+=(await stat(p)).size;}return bytes;}
  const bytes=await size(directory),hostFreeBytes=fs.bavail*fs.bsize;
  return {bytes,limit,hostFreeBytes,admissionBlocked:bytes>=limit*0.8||hostFreeBytes<10*1024**3};
}
export async function checkStorage(directory,{existingObligations=false}={}) {
  if(!process.env.ANTE_UP_STATE_LIMIT_BYTES || Date.now()-checkedAt<60_000)return;
  const pressure=await storagePressure(directory);
  if(pressure.hostFreeBytes<10*1024**3)throw Error('HOST_STORAGE_LOW');
  if(pressure.bytes>=pressure.limit*(existingObligations?1:0.8))throw Error('STATE_STORAGE_LIMIT');
  checkedAt=Date.now();
}
