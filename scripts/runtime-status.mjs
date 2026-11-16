import {writeFile,rename,mkdir,statfs,readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {measureStateStorage} from './storage-accounting.mjs';
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
  const usage=await measureStateStorage(directory),bytes=usage.activeBytes,hostFreeBytes=usage.hostFreeBytes;
  return {...usage,bytes,limit,hostFreeBytes,admissionBlocked:bytes>=limit*0.8||hostFreeBytes<10*1024**3};
}
export async function checkStorage(directory,{existingObligations=false}={}) {
  if(!process.env.ANTE_UP_STATE_LIMIT_BYTES || Date.now()-checkedAt<60_000)return;
  const pressure=await storagePressure(directory);
  if(pressure.hostFreeBytes<10*1024**3)throw Error('HOST_STORAGE_LOW');
  if(pressure.bytes>=pressure.limit*(existingObligations?1:0.8))throw Error('STATE_STORAGE_LIMIT');
  checkedAt=Date.now();
}
