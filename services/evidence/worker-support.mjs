import {readFile,open,mkdir,rename} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

export async function durableJson(path,value){
 await mkdir(dirname(path),{recursive:true});
 const tmp=`${path}.${process.pid}.tmp`,file=await open(tmp,'w',0o600);
 try{await file.writeFile(JSON.stringify(value));await file.sync();}finally{await file.close();}
 await rename(tmp,path);
 // Directory fsync is supported by the production Linux filesystem.
 if(process.platform!=='win32'){const dir=await open(dirname(path),'r');try{await dir.sync();}finally{await dir.close();}}
}
export async function readJson(path,fallback){try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT'&&fallback!==undefined)return fallback;throw e;}}

// The evidence process never writes migrations, projections or index cursors.
export class ReadOnlyProjection {
 constructor(path){this.db=new DatabaseSync(path,{readOnly:true});this.db.exec('PRAGMA busy_timeout=5000;');}
 records(cluster,program){return this.db.prepare('SELECT record_json FROM current_free_records WHERE cluster=? AND program_id=? ORDER BY record_id').all(cluster,program).map(r=>JSON.parse(r.record_json));}
 snapshots(cluster,program){return this.db.prepare('SELECT snapshot_json FROM current_snapshots WHERE cluster=? AND program_id=?').all(cluster,program).map(r=>JSON.parse(r.snapshot_json));}
 close(){this.db.close();}
}

export function pendingRecords(records,jobs,now,{limit=3,allowlist=null}={}){
 return records.filter(r=>r.finality==='finalized'&&['CLOSED_RESULT','CLOSED_NA'].includes(r.status)&&r.exit&&(!allowlist||allowlist.includes(r.id)))
 .filter(r=>{const j=jobs[`proof:${r.id}:original`];return !r.proofId&&!['INVALID','REPLACED'].includes(j?.state)&&(!j?.retryAt||j.retryAt<=now);})
 .sort((a,b)=>a.exit.executedAt-b.exit.executedAt||a.id.localeCompare(b.id)).slice(0,limit);
}

// Quote reservations survive crashes and UTC day changes. A known signed item
// retries under its original reservation; no second item is signed on ambiguity.
export function budgetedTransport({path,totalLimit,dailyLimit,quote,balance,send,now=()=>Date.now()}){
 if(!/^\d+$/.test(String(totalLimit))||!/^\d+$/.test(String(dailyLimit)))throw Error('UPLOAD_BUDGET_REQUIRED');
 return async input=>{
  const parts=[];for await(const part of input.dataItemStreamFactory())parts.push(Buffer.from(part));
  const bytes=Buffer.concat(parts),key=createHash('sha256').update(bytes).digest('hex');
  const state=await readJson(path,{version:1,reservations:{}}),day=new Date(now()).toISOString().slice(0,10);
  const cost=BigInt(await quote(bytes.length)),prior=state.reservations[key];
  if(cost<0n)throw Error('UPLOAD_QUOTE_INVALID');
  const reserved=prior?BigInt(prior.winc):0n,extra=cost>reserved?cost-reserved:0n;
  const total=Object.values(state.reservations).reduce((sum,r)=>sum+BigInt(r.winc),0n);
  const today=Object.values(state.reservations).reduce((sum,r)=>sum+BigInt(r.byDay?.[day]??(r.day===day?r.winc:'0')),0n);
  if(total+extra>BigInt(totalLimit)||today+extra>BigInt(dailyLimit))throw Error('UPLOAD_BUDGET_EXCEEDED');
  if(BigInt(await balance())<cost)throw Error('TURBO_BALANCE_REQUIRED');
  state.reservations[key]={...prior,day:prior?.day??day,winc:(reserved+extra).toString(),bytes:bytes.length,
   byDay:{...(prior?.byDay??(prior?{[prior.day]:prior.winc}:{})),[day]:(BigInt(prior?.byDay?.[day]??(prior?.day===day?prior.winc:'0'))+extra).toString()},state:'RESERVED'};
  await durableJson(path,state);
  const receipt=await send(input); // Uncertain transport retains reservation.
  state.reservations[key].state='ACCEPTED';state.reservations[key].itemId=receipt.id;
  await durableJson(path,state);return receipt;
 };
}

export function journalTransport(transport,directory){
 return {...transport,async sendTransaction(wire){
  const key=createHash('sha256').update(wire).digest('hex'),path=join(directory,`${key}.json`);
  const prior=await readJson(path,null);
  if(prior&&prior.wire!==wire)throw Error('CHAIN_JOURNAL_CONFLICT');
  await durableJson(path,prior??{wire,state:'REQUESTING',createdAt:new Date().toISOString()});
  const signature=await transport.sendTransaction(wire);
  await durableJson(path,{wire,state:'SUBMITTED',signature,createdAt:prior?.createdAt??new Date().toISOString()});
  return signature;
 }};
}
