import { DatabaseSync } from 'node:sqlite';

// Opt-in Devnet SOL assistance. This never mints tUSD or modifies the existing
// wallet-signed financial faucet. Root must wire authenticated live sessions.
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const REQUEST = /^[A-Za-z0-9_-]{8,80}$/;
const DAY_MS = 86_400_000;

export interface SolFaucetPolicy {
  enabled: boolean;
  grantLamports: bigint;
  minimumBalanceLamports: bigint;
  dailyCapLamports: bigint;
  totalCapLamports: bigint;
  reserveLamports: bigint;
  cooldownMs: number;
}
export interface SolFaucetRpc {
  genesisHash(): Promise<string>;
  balanceLamports(wallet: string): Promise<bigint>;
  // Sends once. An error is treated as an uncertain outcome, never as proof of non-execution.
  sendOnce(wallet: string, lamports: bigint, requestId: string, onSigned: (signature: string) => void): Promise<string>;
  finalized(signature: string): Promise<boolean>;
}
export type SolClaim = { state: 'DISABLED'|'ENOUGH_SOL'|'LIMIT_REACHED'|'RESERVED'|'UNKNOWN'|'SUBMITTED'|'FINALIZED'; signature: string|null; amountLamports: string|null; };

function positive(value: bigint) { return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER); }
function validatePolicy(policy: SolFaucetPolicy) {
  if (!positive(policy.grantLamports) || !positive(policy.minimumBalanceLamports) ||
      !positive(policy.dailyCapLamports) || !positive(policy.totalCapLamports) ||
      policy.dailyCapLamports > policy.totalCapLamports ||
      policy.grantLamports > policy.dailyCapLamports || policy.reserveLamports < 0n ||
      !Number.isSafeInteger(policy.cooldownMs) || policy.cooldownMs < DAY_MS) throw Error('INVALID_SOL_FAUCET_POLICY');
}
type Row = { wallet:string; amount:string; state:SolClaim['state']; signature:string|null; at_ms:number };

/** Single SQLite writer/atomic reservation. Keep this DB on durable state storage. */
export class SqliteSolFaucetLedger {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS visitor_sol_grants (
        request_id TEXT PRIMARY KEY, wallet TEXT NOT NULL, amount TEXT NOT NULL,
        state TEXT NOT NULL, signature TEXT UNIQUE, at_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS visitor_sol_grants_wallet ON visitor_sol_grants(wallet,at_ms);`);
  }
  close() { this.db.close(); }
  get(requestId: string): Row | null {
    return (this.db.prepare('SELECT wallet,amount,state,signature,at_ms FROM visitor_sol_grants WHERE request_id=?').get(requestId) as Row|undefined) ?? null;
  }
  reserve(requestId: string, wallet: string, atMs: number, policy: SolFaucetPolicy): {row:Row;created:boolean} | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.get(requestId);
      if (previous) { this.db.exec('COMMIT'); if (previous.wallet !== wallet) throw Error('REQUEST_ID_CONFLICT'); return {row:previous,created:false}; }
      const rows = this.db.prepare('SELECT wallet,amount,at_ms FROM visitor_sol_grants').all() as Row[];
      const total = rows.reduce((sum,row) => sum + BigInt(row.amount),0n);
      const dayStart = Math.floor(atMs / DAY_MS) * DAY_MS;
      const day = rows.filter(row=>row.at_ms>=dayStart && row.at_ms<dayStart+DAY_MS)
        .reduce((sum,row)=>sum+BigInt(row.amount),0n);
      const recentlyGranted = rows.some(row=>row.wallet===wallet && atMs-row.at_ms < policy.cooldownMs);
      if (recentlyGranted || total+policy.grantLamports>policy.totalCapLamports ||
          day+policy.grantLamports>policy.dailyCapLamports) { this.db.exec('COMMIT'); return null; }
      this.db.prepare('INSERT INTO visitor_sol_grants VALUES(?,?,?,?,?,?)')
        .run(requestId,wallet,policy.grantLamports.toString(),'RESERVED',null,atMs);
      this.db.exec('COMMIT');
      return {row:this.get(requestId)!,created:true};
    } catch(error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  mark(requestId: string, state:'UNKNOWN'|'SUBMITTED'|'FINALIZED', signature:string|null) {
    this.db.prepare('UPDATE visitor_sol_grants SET state=?,signature=COALESCE(?,signature) WHERE request_id=?')
      .run(state,signature,requestId);
  }
}

/** Public reads are allowed; a write requires root's existing wallet session. */
export class VisitorSolFaucet {
  private readonly options:{policy:SolFaucetPolicy;rpc:SolFaucetRpc;ledger:SqliteSolFaucetLedger;
    fundingBalanceLamports:()=>Promise<bigint>;nowMs:()=>number};
  constructor(options:{policy:SolFaucetPolicy;rpc:SolFaucetRpc;ledger:SqliteSolFaucetLedger;
    fundingBalanceLamports:()=>Promise<bigint>;nowMs:()=>number}) { validatePolicy(options.policy);this.options=options; }
  async readiness(wallet:string) {
    if (!WALLET.test(wallet)) throw Error('INVALID_WALLET');
    if (await this.options.rpc.genesisHash() !== DEVNET_GENESIS) throw Error('DEVNET_REQUIRED');
    const balance = await this.options.rpc.balanceLamports(wallet);
    return {balanceLamports:balance.toString(),minimumBalanceLamports:this.options.policy.minimumBalanceLamports.toString(),
      needsSol:balance<this.options.policy.minimumBalanceLamports,
      serverGrantEnabled:this.options.policy.enabled};
  }
  async claim(input:{wallet:string;authenticatedWallet:string;requestId:string}):Promise<SolClaim> {
    const {wallet,authenticatedWallet,requestId}=input, {policy,rpc,ledger}=this.options;
    if (!WALLET.test(wallet) || !REQUEST.test(requestId) || wallet!==authenticatedWallet) throw Error('UNAUTHORIZED');
    if (!policy.enabled) return {state:'DISABLED',signature:null,amountLamports:null};
    if (await rpc.genesisHash()!==DEVNET_GENESIS) throw Error('DEVNET_REQUIRED');
    const old=ledger.get(requestId);
    if (old) { if(old.wallet!==wallet)throw Error('REQUEST_ID_CONFLICT'); return this.result(old); }
    if (await rpc.balanceLamports(wallet)>=policy.minimumBalanceLamports) return {state:'ENOUGH_SOL',signature:null,amountLamports:null};
    if (await this.options.fundingBalanceLamports()<policy.grantLamports+policy.reserveLamports)
      return {state:'LIMIT_REACHED',signature:null,amountLamports:null};
    const reservation=ledger.reserve(requestId,wallet,this.options.nowMs(),policy);
    if (!reservation) return {state:'LIMIT_REACHED',signature:null,amountLamports:null};
    const {row,created}=reservation;
    if (!created) return this.result(row);
    try {
      const signature=await rpc.sendOnce(wallet,policy.grantLamports,requestId,signature=>ledger.mark(requestId,'SUBMITTED',signature));
      ledger.mark(requestId,'SUBMITTED',signature);
      return {state:'SUBMITTED',signature,amountLamports:row.amount};
    } catch {
      ledger.mark(requestId,'UNKNOWN',null);
      return this.result(ledger.get(requestId)!);
    }
  }
  async reconcile(requestId:string,authenticatedWallet:string):Promise<SolClaim> {
    const row=this.options.ledger.get(requestId);
    if (!row || row.wallet!==authenticatedWallet) throw Error('UNAUTHORIZED');
    if (row.signature && await this.options.rpc.finalized(row.signature)) {
      this.options.ledger.mark(requestId,'FINALIZED',row.signature);
      return {state:'FINALIZED',signature:row.signature,amountLamports:row.amount};
    }
    return this.result(row);
  }
  private result(row:Row):SolClaim {return {state:row.state,signature:row.signature,amountLamports:row.amount};}
}
