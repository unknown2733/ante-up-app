import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { address } from '@solana/kit';
import { findMarketPda } from '../../../clients/chain/dist/index.js';
import { buildQuery } from '../../data/index.mjs';
import { queryHashFor } from '../../data/live.mjs';
import type { FinancialIntent } from '../../../contracts/financial.ts';
import type { MarketRegistryEntry } from './live-read.ts';
import type { FinalizedFinancialAccounts } from './financial-chain.ts';

const hash=(s:string)=>createHash('sha256').update(s,'utf8').digest('hex');
const phrase=/^[a-z][a-z0-9]*(?: [a-z][a-z0-9]*)*$/;
const hashtag=/^#[a-z][a-z0-9_]*$/;
export interface DerivedRegistration extends MarketRegistryEntry {queryHash:string;queryVersion:'1';expressions:string[]}
const identityExpressions=(entry:DerivedRegistration)=>entry.expressions;
export class ExistingMarket extends Error {readonly marketAddress:string;constructor(marketAddress:string){super('ALREADY_EXECUTED');this.marketAddress=marketAddress;}}

/** Limited same-name expressions; aliases cannot inject arbitrary X query operators. */
export async function deriveRegistration(intent:FinancialIntent,programId:string):Promise<DerivedRegistration> {
  if (intent.action!=='registerMarket' || !intent.keyword || !intent.aliases) throw new Error('INVALID_INPUT');
  const keyword=intent.keyword.trim().toLowerCase().replace(/\s+/g,' ');
  if (!phrase.test(keyword)) throw new Error('INVALID_INPUT');
  const joined=keyword.replaceAll(' ','');
  const aliases=[...new Set(intent.aliases.map(a=>a.trim().toLowerCase().replace(/\s+/g,' ')))];
  if (aliases.length>7 || aliases.some(a=>!((phrase.test(a)||hashtag.test(a)) && (a===keyword || a===joined || a===`#${joined}`)))) throw new Error('INVALID_INPUT');
  const expressions=[...new Set([keyword,...aliases])].sort();
  const query=buildQuery(expressions);
  const seedHex=hash(`ante-up-market-v1:${keyword}`);
  const [pda]=await findMarketPda({marketId:Uint8Array.from(Buffer.from(seedHex,'hex'))},{programAddress:address(programId)});
  return {address:String(pda),seedHex,keyword,aliases:expressions.filter(x=>x!==keyword),queryHash:queryHashFor(query),queryVersion:'1',expressions};
}

/** Reserves only exact submitted keyword and aliases. B must enforce cross-client uniqueness on chain. */
export class SqliteFinancialRegistrationStore {
  private readonly db:DatabaseSync;
  constructor(path:string){
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS financial_registrations(market_address TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,seed_hex TEXT NOT NULL,keyword TEXT NOT NULL,aliases_json TEXT NOT NULL,query_hash TEXT NOT NULL,query_version TEXT NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('PENDING','FINALIZED')));
      CREATE TABLE IF NOT EXISTS financial_expressions(expression TEXT PRIMARY KEY,market_address TEXT NOT NULL,request_id TEXT NOT NULL);`);
  }
  close(){this.db.close();}
  reserve(entry:DerivedRegistration,requestId:string,expiresAt:number,now:number):void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const hasOperations=!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_operations'").get();
      const expired=this.db.prepare(`SELECT request_id,market_address FROM financial_registrations WHERE state='PENDING' AND expires_at<=? ${hasOperations?'AND request_id NOT IN (SELECT request_id FROM live_operations)':''}`).all(now) as Array<{request_id:string;market_address:string}>;
      for (const row of expired) {
        this.db.prepare('DELETE FROM financial_expressions WHERE request_id=?').run(row.request_id);
        this.db.prepare('DELETE FROM financial_registrations WHERE request_id=?').run(row.request_id);
      }
      const prior=this.db.prepare('SELECT * FROM financial_registrations WHERE request_id=? OR market_address=?').get(requestId,entry.address) as Record<string,string>|undefined;
      if (prior) {
        if (prior.request_id!==requestId || prior.market_address!==entry.address || prior.query_hash!==entry.queryHash) throw new ExistingMarket(prior.market_address);
        this.db.exec('COMMIT');return;
      }
      for (const expression of identityExpressions(entry)) {
        const occupied=this.db.prepare('SELECT market_address FROM financial_expressions WHERE expression=?').get(expression) as {market_address:string}|undefined;
        if (occupied) throw new ExistingMarket(occupied.market_address);
      }
      const byQuery=this.db.prepare('SELECT market_address FROM financial_registrations WHERE query_hash=?').get(entry.queryHash) as {market_address:string}|undefined;
      if (byQuery) throw new ExistingMarket(byQuery.market_address);
      this.db.prepare('INSERT INTO financial_registrations VALUES(?,?,?,?,?,?,?,?,?)')
        .run(entry.address,requestId,entry.seedHex,entry.keyword,JSON.stringify(entry.aliases),entry.queryHash,entry.queryVersion,expiresAt,'PENDING');
      for (const expression of identityExpressions(entry)) this.db.prepare('INSERT INTO financial_expressions VALUES(?,?,?)').run(expression,entry.address,requestId);
      this.db.exec('COMMIT');
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  pending(requestId:string):DerivedRegistration|null {
    const row=this.db.prepare('SELECT * FROM financial_registrations WHERE request_id=?').get(requestId) as Record<string,string>|undefined;
    if(!row)return null;
    const aliases=JSON.parse(row.aliases_json) as string[];
    return {address:row.market_address,seedHex:row.seed_hex,keyword:row.keyword,aliases,queryHash:row.query_hash,queryVersion:'1',expressions:[row.keyword,...aliases].sort()};
  }
  markFinalized(requestId:string):void {this.db.prepare("UPDATE financial_registrations SET state='FINALIZED' WHERE request_id=?").run(requestId);}
  /** Recover a finalized registration even if the browser closed before reporting its signature. */
  async reconcilePending(accounts:FinalizedFinancialAccounts,limit=5):Promise<number> {
    const hasOperations=!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_operations'").get();
    const rows=(hasOperations
      ? this.db.prepare(`SELECT r.request_id FROM financial_registrations r
          LEFT JOIN live_operations o ON o.request_id=r.request_id
          WHERE r.state='PENDING' AND (o.state IS NULL OR o.state!='FAILED')
          ORDER BY CASE WHEN o.signature IS NOT NULL THEN 0 ELSE 1 END,r.expires_at DESC LIMIT ?`).all(limit)
      : this.db.prepare("SELECT request_id FROM financial_registrations WHERE state='PENDING' ORDER BY expires_at DESC LIMIT ?").all(limit)) as Array<{request_id:string}>;
    let finalized=0;
    for(const row of rows){
      try {if(await this.verifyAndFinalize(row.request_id,accounts))finalized++;}
      catch(error){
        // A missing finalized account means the wallet has not landed yet.
        if(error instanceof Error && error.message==='FINANCIAL_ACCOUNT_UNAVAILABLE')continue;
        throw error;
      }
    }
    return finalized;
  }
  async verifyAndFinalize(requestId:string,accounts:FinalizedFinancialAccounts):Promise<boolean> {
    const entry=this.pending(requestId);
    if (!entry)return false;
    const [market,finance]=await Promise.all([accounts.market(entry.address),accounts.financeMarket(entry.address)]);
    if (Buffer.from(market.id).toString('hex')!==entry.seedHex || Buffer.from(market.queryHash).toString('hex')!==entry.queryHash ||
        market.queryVersion.toString()!==entry.queryVersion || String(finance.market)!==entry.address) throw new Error('REGISTERED_MARKET_ACCOUNT_MISMATCH');
    this.markFinalized(requestId);
    return true;
  }
  finalized():MarketRegistryEntry[] {
    return (this.db.prepare("SELECT market_address,seed_hex,keyword,aliases_json FROM financial_registrations WHERE state='FINALIZED'").all() as Array<Record<string,string>>)
      .map(r=>({address:r.market_address,seedHex:r.seed_hex,keyword:r.keyword,aliases:JSON.parse(r.aliases_json) as string[]}));
  }
}
