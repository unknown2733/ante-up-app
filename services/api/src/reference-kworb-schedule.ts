import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectKworbReferenceStreams } from './reference-kworb.ts';

const DAY_MS=86_400_000, MIN_INTERVAL_MS=20*60*60*1000;

export class ReferenceKworbRequestBudget {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db=new DatabaseSync(resolve(path));
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS reference_kworb_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT, attempted_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('STARTED','SUCCESS','FAILED')), error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS reference_kworb_requests_time
        ON reference_kworb_requests(attempted_at_ms);`);
  }
  close() { this.db.close(); }
  reserve(nowMs: number): {id:number|null;reason:string|null} {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('INVALID_COLLECTION_TIME');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const last=this.db.prepare('SELECT MAX(attempted_at_ms) AS at_ms FROM reference_kworb_requests')
        .get() as {at_ms:number|null};
      const today=this.db.prepare('SELECT COUNT(*) AS n FROM reference_kworb_requests WHERE attempted_at_ms >= ? AND attempted_at_ms <= ?')
        .get(Math.floor(nowMs/DAY_MS)*DAY_MS,nowMs) as {n:number};
      const reason=last.at_ms!==null && nowMs-last.at_ms<MIN_INTERVAL_MS?'MIN_INTERVAL':
        today.n>=1?'DAILY_CAP':null;
      if(reason){this.db.exec('COMMIT');return {id:null,reason};}
      const result=this.db.prepare("INSERT INTO reference_kworb_requests(attempted_at_ms,status) VALUES (?,'STARTED')").run(nowMs);
      this.db.exec('COMMIT');
      return {id:Number(result.lastInsertRowid),reason:null};
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  finish(id:number,status:'SUCCESS'|'FAILED',errorCode:string|null=null) {
    const result=this.db.prepare("UPDATE reference_kworb_requests SET status=?,error_code=? WHERE id=? AND status='STARTED'")
      .run(status,errorCode,id);
    if(result.changes!==1)throw new Error('COLLECTION_ATTEMPT_NOT_PENDING');
  }
}

export async function runBoundedKworbReferenceStreams(input:{
  dbPath:string;fetcher?:typeof fetch;nowMs?:()=>number;
}) {
  const nowMs=(input.nowMs??Date.now)();
  const budget=new ReferenceKworbRequestBudget(input.dbPath);
  let reservation:ReturnType<ReferenceKworbRequestBudget['reserve']>;
  try{reservation=budget.reserve(nowMs);}finally{budget.close();}
  if(reservation.id===null)return {status:'SKIPPED' as const,reason:reservation.reason};
  try {
    const result=await collectKworbReferenceStreams({...input,nowMs:()=>nowMs});
    const journal=new ReferenceKworbRequestBudget(input.dbPath);
    try{journal.finish(reservation.id,'SUCCESS');}finally{journal.close();}
    return {status:'SUCCESS' as const,...result};
  } catch(error) {
    const code=error instanceof Error&&/^[A-Z0-9_]{1,60}$/.test(error.message)
      ?error.message:'KWORB_REQUEST_FAILED';
    const journal=new ReferenceKworbRequestBudget(input.dbPath);
    try{journal.finish(reservation.id,'FAILED',code);}finally{journal.close();}
    throw error;
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const dbPath=process.argv[2];
  if(!dbPath)throw new Error('Usage: node reference-kworb-schedule.ts <persistent-api-db.sqlite>');
  console.log(JSON.stringify(await runBoundedKworbReferenceStreams({dbPath})));
}
