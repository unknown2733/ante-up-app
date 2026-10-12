import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Operation, WalletSession } from '../../../contracts/types.ts';
import type { ActionBody } from './validate.ts';
import type { PreparedForWallet } from './transaction.ts';
import type { SignatureVerifier } from './auth.ts';
import type { FinancialIntent, FinancialQuote } from '../../../contracts/financial.ts';
import { financialIntentKey, type PreparedFinancialTransaction } from './financial.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export type StoredOperation =
  | {kind:'free';intent:ActionBody;prepared:PreparedForWallet;discoveryAddress:string;messageBase64:string;operation:Operation}
  | {kind:'financial';intent:FinancialIntent;prepared:PreparedFinancialTransaction;discoveryAddress:string;messageBase64:string;operation:Operation};

/** One SQLite file may be shared with the finalized indexer; WAL serializes writes. */
export class LiveStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS live_challenges(nonce TEXT PRIMARY KEY,wallet TEXT NOT NULL,cluster TEXT NOT NULL,expires_at INTEGER NOT NULL,used_at INTEGER);
      CREATE TABLE IF NOT EXISTS live_sessions(token_hash TEXT PRIMARY KEY,wallet TEXT NOT NULL,cluster TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS live_operations(request_id TEXT PRIMARY KEY,wallet TEXT NOT NULL,action TEXT NOT NULL,intent_json TEXT NOT NULL,prepared_json TEXT NOT NULL,message_base64 TEXT NOT NULL UNIQUE,state TEXT NOT NULL,signature TEXT UNIQUE,error_json TEXT);
      CREATE TABLE IF NOT EXISTS live_financial_quotes(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,wallet TEXT NOT NULL,cluster TEXT NOT NULL,program_id TEXT NOT NULL,quote_json TEXT NOT NULL,expires_at INTEGER NOT NULL);`);
    const columns=(this.db.prepare('PRAGMA table_info(live_operations)').all() as Array<{name:string}>).map(c=>c.name);
    if (!columns.includes('operation_kind')) this.db.exec("ALTER TABLE live_operations ADD COLUMN operation_kind TEXT NOT NULL DEFAULT 'free'");
    if (!columns.includes('discovery_address')) this.db.exec('ALTER TABLE live_operations ADD COLUMN discovery_address TEXT');
  }
  close() { this.db.close(); }
  issue(wallet: string, cluster: 'localnet' | 'devnet', now: number) {
    const nonce = randomUUID(), expiresAt = now + 300;
    this.db.prepare('INSERT INTO live_challenges(nonce,wallet,cluster,expires_at) VALUES(?,?,?,?)').run(nonce,wallet,cluster,expiresAt);
    return {nonce, expiresAt, message: `Ante Up API v1\ncluster:${cluster}\nwallet:${wallet}\nnonce:${nonce}\nexpiresAt:${expiresAt}`};
  }
  async exchange(input: {wallet:string;cluster:'localnet'|'devnet';nonce:string;signature:string}, now: number, verifier: SignatureVerifier): Promise<WalletSession | null> {
    const row = this.db.prepare('SELECT wallet,cluster,expires_at,used_at FROM live_challenges WHERE nonce=?').get(input.nonce) as
      {wallet:string;cluster:string;expires_at:number;used_at:number|null}|undefined;
    if (!row || row.wallet !== input.wallet || row.cluster !== input.cluster || row.used_at !== null || now > row.expires_at) return null;
    const message = `Ante Up API v1\ncluster:${input.cluster}\nwallet:${input.wallet}\nnonce:${input.nonce}\nexpiresAt:${row.expires_at}`;
    if (!(await verifier.verify(input.wallet, message, input.signature))) return null;
    const token = randomBytes(32).toString('base64url'), expiresAt = now + 900;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const update = this.db.prepare('UPDATE live_challenges SET used_at=? WHERE nonce=? AND wallet=? AND cluster=? AND used_at IS NULL AND expires_at>=?').run(now,input.nonce,input.wallet,input.cluster,now);
      if (update.changes !== 1) { this.db.exec('ROLLBACK'); return null; }
      this.db.prepare('INSERT INTO live_sessions(token_hash,wallet,cluster,expires_at) VALUES(?,?,?,?)').run(digest(token),input.wallet,input.cluster,expiresAt);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return {token, expiresAt, wallet:input.wallet, cluster:input.cluster};
  }
  authenticate(token: string, wallet: string, cluster: 'localnet'|'devnet', now: number): boolean {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const row = this.db.prepare('SELECT wallet,cluster,expires_at FROM live_sessions WHERE token_hash=?').get(digest(token)) as
      {wallet:string;cluster:string;expires_at:number}|undefined;
    return !!row && row.wallet === wallet && row.cluster === cluster && now < row.expires_at;
  }
  getFinancialQuote(requestId: string, expected?: {cluster:'localnet'|'devnet';programId:string}): FinancialQuote | null {
    const row = this.db.prepare('SELECT quote_json,cluster,program_id FROM live_financial_quotes WHERE request_id=?').get(requestId) as {quote_json:string;cluster:string;program_id:string}|undefined;
    if (!row) return null;
    if (expected && (row.cluster!==expected.cluster || row.program_id!==expected.programId)) throw new Error('ALREADY_EXECUTED');
    return JSON.parse(row.quote_json) as FinancialQuote;
  }
  saveFinancialQuote(quote: FinancialQuote, cluster: 'localnet'|'devnet', programId: string): FinancialQuote {
    const existing = this.getFinancialQuote(quote.intent.requestId,{cluster,programId});
    if (existing) {
      if (financialIntentKey(existing.intent) !== financialIntentKey(quote.intent)) throw new Error('ALREADY_EXECUTED');
      return existing;
    }
    this.db.prepare('INSERT OR IGNORE INTO live_financial_quotes(id,request_id,wallet,cluster,program_id,quote_json,expires_at) VALUES(?,?,?,?,?,?,?)')
      .run(quote.id,quote.intent.requestId,quote.intent.wallet,cluster,programId,JSON.stringify(quote),quote.expiresAt);
    const stored = this.getFinancialQuote(quote.intent.requestId,{cluster,programId});
    if (!stored || stored.id !== quote.id) throw new Error('ALREADY_EXECUTED');
    return stored;
  }
  get(requestId: string): StoredOperation | null {
    const row = this.db.prepare('SELECT * FROM live_operations WHERE request_id=?').get(requestId) as Record<string,string|null>|undefined;
    if (!row) return null;
    const operation:Operation={requestId,wallet:row.wallet!,action:row.action!,state:row.state! as Operation['state'],signature:row.signature,error:row.error_json?JSON.parse(row.error_json):null};
    if (row.operation_kind==='financial') return {kind:'financial',intent:JSON.parse(row.intent_json!) as FinancialIntent,
      prepared:JSON.parse(row.prepared_json!) as PreparedFinancialTransaction,discoveryAddress:row.discovery_address!,messageBase64:row.message_base64!,operation};
    const prepared=JSON.parse(row.prepared_json!) as PreparedForWallet;
    return {kind:'free',intent:JSON.parse(row.intent_json!) as ActionBody,prepared,
      discoveryAddress:row.discovery_address??prepared.recordId,messageBase64:row.message_base64!,operation};
  }
  save(intent: ActionBody, prepared: PreparedForWallet, messageBase64: string): StoredOperation {
    this.db.prepare(`INSERT OR IGNORE INTO live_operations(request_id,wallet,action,intent_json,prepared_json,message_base64,state,operation_kind,discovery_address)
      VALUES(?,?,?,?,?,?,'AWAITING_SIGNATURE','free',?)`).run(intent.requestId,intent.wallet,intent.action,JSON.stringify(intent),JSON.stringify(prepared),messageBase64,prepared.recordId);
    const stored = this.get(intent.requestId);
    if (!stored || stored.kind!=='free') throw new Error('ALREADY_EXECUTED');
    if (JSON.stringify(stored.intent) !== JSON.stringify(intent)) throw new Error('ALREADY_EXECUTED');
    return stored;
  }
  saveFinancial(intent: FinancialIntent, prepared: PreparedFinancialTransaction, discoveryAddress: string, messageBase64: string): StoredOperation {
    this.db.prepare(`INSERT OR IGNORE INTO live_operations(request_id,wallet,action,intent_json,prepared_json,message_base64,state,operation_kind,discovery_address)
      VALUES(?,?,?,?,?,?,'AWAITING_SIGNATURE','financial',?)`).run(intent.requestId,intent.wallet,intent.action,JSON.stringify(intent),JSON.stringify(prepared),messageBase64,discoveryAddress);
    const stored=this.get(intent.requestId);
    if (!stored || stored.kind!=='financial' || financialIntentKey(stored.intent)!==financialIntentKey(intent) ||
        stored.prepared.quote.id!==prepared.quote.id || stored.messageBase64!==messageBase64) throw new Error('ALREADY_EXECUTED');
    return stored;
  }
  claim(requestId: string, signature: string): StoredOperation {
    const stored = this.get(requestId);
    if (!stored) throw new Error('INVALID_INPUT');
    if (stored.operation.signature && stored.operation.signature !== signature) throw new Error('ALREADY_EXECUTED');
    try {this.db.prepare(`UPDATE live_operations SET signature=?,state=CASE WHEN state='AWAITING_SIGNATURE' THEN 'UNKNOWN' ELSE state END WHERE request_id=?`).run(signature,requestId);}
    catch {throw new Error('ALREADY_EXECUTED');}
    return this.get(requestId)!;
  }
  mark(requestId: string, state: Operation['state'], error: Operation['error'] = null): StoredOperation {
    const old = this.get(requestId);
    if (!old || !old.operation.signature) throw new Error('INVALID_INPUT');
    if (old.operation.state === 'FINALIZED' && state !== 'FINALIZED') throw new Error('ALREADY_EXECUTED');
    this.db.prepare('UPDATE live_operations SET state=?,error_json=? WHERE request_id=?').run(state,error?JSON.stringify(error):null,requestId);
    return this.get(requestId)!;
  }
  markUnclaimedUnknown(requestId: string): StoredOperation {
    const old=this.get(requestId);
    if (!old || old.operation.signature || old.operation.state === 'FINALIZED') throw new Error('INVALID_INPUT');
    this.db.prepare("UPDATE live_operations SET state='UNKNOWN',error_json=NULL WHERE request_id=?").run(requestId);
    return this.get(requestId)!;
  }
  markExpiredUnlanded(requestId:string):StoredOperation {
    const error={code:'REQUOTE_REQUIRED',message:'기존 요청은 체결 없이 만료됐습니다. 새 견적을 받아 다시 서명하세요.',retryable:true,requestId};
    const changed=this.db.prepare("UPDATE live_operations SET state='FAILED',error_json=? WHERE request_id=? AND signature IS NULL AND state IN ('AWAITING_SIGNATURE','UNKNOWN')").run(JSON.stringify(error),requestId);
    if(changed.changes!==1)throw new Error('ALREADY_EXECUTED');
    return this.get(requestId)!;
  }
}
