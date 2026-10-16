import {createHash, randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {open, readFile, rename, rm} from 'node:fs/promises';
import {resolve, relative, isAbsolute, dirname, sep} from 'node:path';

export const check = (ok, code) => { if (!ok) throw Error(code); };
export const inside = (root, path) => { const rel=relative(resolve(root),resolve(path)); return rel==='' || (rel!=='..'&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel)); };
export async function digest(path) {
  const hash=createHash('sha256'); for await(const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex');
}
export async function json(path) { return JSON.parse(await readFile(path,'utf8')); }
export async function syncDirectory(path) {
  if(process.platform==='win32')return;
  const file=await open(path,'r');try{await file.sync();}finally{await file.close();}
}
export async function atomicJson(path, value) {
  const tmp=`${path}.${randomUUID()}.tmp`, file=await open(tmp,'wx',0o600);
  try{
    try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}
    await rename(tmp,path);await syncDirectory(dirname(path));
  }finally{await rm(tmp,{force:true});}
}
export function args(argv, names, flags=[]) {
  const out={};for(let i=0;i<argv.length;i++){
    const name=argv[i];check(names.includes(name)||flags.includes(name),'INVALID_ARGUMENT');check(!(name in out),'DUPLICATE_ARGUMENT');
    out[name]=flags.includes(name)?true:argv[++i];check(out[name]!==undefined&&!String(out[name]).startsWith('--'),'MISSING_ARGUMENT');
  }return out;
}
