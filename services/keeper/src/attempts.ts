import { DatabaseSync } from 'node:sqlite';

export type KeeperAction='ACCEPT_SETTLEMENT'|'SETTLE_PRO'|'START_LP_WINDOW';
export interface KeeperAttemptKey {action:KeeperAction;marketId:string;cycle:string;entity:string}
export interface KeeperAttempt extends KeeperAttemptKey {
  fingerprint:string;generation:number;state:'UNKNOWN'|'SUBMITTED'|'FINALIZED'|'FAILED';signature:string|null;
}
const hash=/^[0-9a-f]{64}$/;

/** Durable single-writer reservation. UNKNOWN never expires merely because a process restarted. */
export class SqliteKeeperAttempts {
  private readonly db:DatabaseSync;
  constructor(path:string){
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS keeper_attempts(action TEXT NOT NULL,market_id TEXT NOT NULL,cycle TEXT NOT NULL,
        entity TEXT NOT NULL,fingerprint TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,
        signature TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(action,market_id,cycle,entity));`);
  }
  close(){this.db.close();}
  get(key:KeeperAttemptKey):KeeperAttempt|null {
    const row=this.db.prepare('SELECT * FROM keeper_attempts WHERE action=? AND market_id=? AND cycle=? AND entity=?')
      .get(key.action,key.marketId,key.cycle,key.entity) as Record<string,string|number|null>|undefined;
    if (!row) return null;
    return {...key,fingerprint:String(row.fingerprint),generation:Number(row.generation),state:String(row.state) as KeeperAttempt['state'],signature:row.signature===null?null:String(row.signature)};
  }
  reserve(key:KeeperAttemptKey,fingerprint:string,now:number):{created:boolean;attempt:KeeperAttempt} {
    if (!hash.test(fingerprint) || !Number.isSafeInteger(now) || now<0 || !/^(0|[1-9][0-9]*)$/.test(key.cycle) ||
        !key.marketId || key.action==='SETTLE_PRO' && !key.entity || key.action!=='SETTLE_PRO' && key.entity!=='') throw new Error('KEEPER_ATTEMPT_INVALID');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior=this.get(key);
      if (prior && prior.fingerprint!==fingerprint) throw new Error('KEEPER_ATTEMPT_IDENTITY_CHANGED');
      if (prior && prior.state!=='FAILED') {this.db.exec('COMMIT');return {created:false,attempt:prior};}
      const generation=prior?prior.generation+1:1;
      if (prior) this.db.prepare("UPDATE keeper_attempts SET generation=?,state='UNKNOWN',signature=NULL,updated_at=? WHERE action=? AND market_id=? AND cycle=? AND entity=?")
        .run(generation,now,key.action,key.marketId,key.cycle,key.entity);
      else this.db.prepare("INSERT INTO keeper_attempts VALUES(?,?,?,?,?,?,'UNKNOWN',NULL,?)")
        .run(key.action,key.marketId,key.cycle,key.entity,fingerprint,generation,now);
      this.db.exec('COMMIT');
      return {created:true,attempt:{...key,fingerprint,generation,state:'UNKNOWN',signature:null}};
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  attachSignature(attempt:KeeperAttempt,signature:string,now:number):KeeperAttempt {
    if (!signature || !Number.isSafeInteger(now) || now<0) throw new Error('KEEPER_ATTEMPT_INVALID');
    const current=this.get(attempt);
    if (!current || current.generation!==attempt.generation || current.fingerprint!==attempt.fingerprint ||
        current.state==='FAILED' || current.state==='FINALIZED' || current.signature && current.signature!==signature) throw new Error('KEEPER_ATTEMPT_STALE');
    const changed=this.db.prepare("UPDATE keeper_attempts SET state='SUBMITTED',signature=?,updated_at=? WHERE action=? AND market_id=? AND cycle=? AND entity=? AND generation=? AND state IN ('UNKNOWN','SUBMITTED') AND (signature IS NULL OR signature=?)")
      .run(signature,now,attempt.action,attempt.marketId,attempt.cycle,attempt.entity,attempt.generation,signature);
    if (changed.changes!==1) throw new Error('KEEPER_ATTEMPT_STALE');
    return this.get(attempt)!;
  }
  /** Caller supplies a receipt/PDA verifier; absent or ambiguous evidence keeps the attempt unresolved. */
  async reconcile(attempt:KeeperAttempt,verify:(attempt:KeeperAttempt)=>Promise<'FINALIZED'|'FAILED'|'PENDING'>,now:number):Promise<KeeperAttempt> {
    const current=this.get(attempt);
    if (!current || current.generation!==attempt.generation || current.fingerprint!==attempt.fingerprint) throw new Error('KEEPER_ATTEMPT_STALE');
    if (current.state==='FINALIZED' || current.state==='FAILED') return current;
    const outcome=await verify(current);
    if (outcome==='PENDING') return current;
    if (outcome!=='FINALIZED' && outcome!=='FAILED' || !Number.isSafeInteger(now) || now<0) throw new Error('KEEPER_ATTEMPT_INVALID');
    const changed=this.db.prepare('UPDATE keeper_attempts SET state=?,updated_at=? WHERE action=? AND market_id=? AND cycle=? AND entity=? AND generation=? AND state IN (\'UNKNOWN\',\'SUBMITTED\')')
      .run(outcome,now,attempt.action,attempt.marketId,attempt.cycle,attempt.entity,attempt.generation);
    if (changed.changes!==1) throw new Error('KEEPER_ATTEMPT_STALE');
    return this.get(attempt)!;
  }
}
