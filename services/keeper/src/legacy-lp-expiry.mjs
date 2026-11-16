import {hash} from '../../data/index.mjs';
const check=(ok,code='KEEPER_EXPIRY_PROOF_INVALID')=>{if(!ok)throw Error(code);};
const dec=x=>typeof x==='string'&&/^(0|[1-9][0-9]*)$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const integer=x=>Number.isSafeInteger(x)&&x>=0;
export const GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const PROGRAM='FrMATpA81wUMYsZufQkew9K5MW2AC8rgdYQ2wUM6KDKr';
const monday=t=>Math.floor((t-345600)/604800)*604800+345600;
export function validateLegacyAttempt(a){
 check(a?.action==='RECOVER_LP_WINDOW'&&a.state==='UNKNOWN'&&a.signature===null&&
   dec(a.cycle)&&a.market_id&&hex(a.fingerprint)&&Number.isSafeInteger(a.generation)&&a.generation>0&&integer(a.updated_at),
   'KEEPER_EXPIRY_ATTEMPT_INVALID');
 const parts=String(a.entity).split(':');
 check(parts.length===2&&parts.every(dec)&&Number(parts[0])===monday(a.updated_at),'KEEPER_EXPIRY_ENTITY_INVALID');
 return {week:Number(parts[0]),generation:parts[1]};
}
export function validateBeforeState(a,s){
 const entity=validateLegacyAttempt(a);
 check(s?.marketId===a.market_id&&s.cycle===a.cycle&&integer(s.currentMaturity)&&
   dec(s.lpGeneration)&&dec(s.validityGeneration)&&integer(s.lastLpMaturity)&&
   s.validityGeneration===entity.generation&&s.openPositions===0&&
   (s.currentMaturity>0||s.lastLpMaturity<entity.week||s.lpGeneration!==s.validityGeneration),
   'KEEPER_EXPIRY_STATE_CHANGED');
 check(hash({marketId:s.marketId,cycle:s.cycle,currentMaturity:s.currentMaturity,
   lpGeneration:s.lpGeneration,validityGeneration:s.validityGeneration,lastLpMaturity:s.lastLpMaturity})===a.fingerprint,
   'KEEPER_EXPIRY_FINGERPRINT_CHANGED');
 return true;
}
export function validateLegacyExpiry(a,p){
 validateLegacyAttempt(a);validateBeforeState(a,p?.state);
 check(p?.kind==='KEEPER_QUIESCENT_LP_EXPIRY'&&p.version===1&&p.attemptHash===hash(a)&&
   p.programId===PROGRAM&&p.genesisHash===GENESIS&&p.recentBlockhashOnly===true&&
   p.guards?.weeklyLock===true&&p.guards?.backupLock===true&&p.guards?.noKeeperProducer===true&&
   integer(p.stoppedAt)&&integer(p.capturedAt)&&integer(p.verifiedAt)&&integer(p.boundaryBlockTime)&&
   p.stoppedAt>=a.updated_at&&p.capturedAt>=p.stoppedAt&&p.boundaryBlockTime>=p.stoppedAt&&p.verifiedAt>=p.capturedAt&&
   typeof p.boundaryBlockhash==='string'&&p.boundaryBlockhash.length>0&&
   dec(p.boundarySlot)&&dec(p.finalizedSlot)&&dec(p.accountSlot)&&dec(p.lastValidBlockHeight)&&dec(p.finalizedBlockHeight)&&
   BigInt(p.finalizedSlot)>=BigInt(p.boundarySlot)&&BigInt(p.accountSlot)>=BigInt(p.finalizedSlot)&&
   BigInt(p.finalizedBlockHeight)>BigInt(p.lastValidBlockHeight)&&p.blockhashValid===false);
 return true;
}
// Preserve the original attempt in an append-only receipt inside the SAME SQL transaction.
// Only this exact unsigned reservation can become FAILED and eligible for normal replanning.
export function commitLegacyExpiry(db,a,p,verifyGuard,now=Math.floor(Date.now()/1000)){
 validateLegacyExpiry(a,p);verifyGuard();
 db.exec('BEGIN IMMEDIATE');
 try{
  const pending=db.prepare("SELECT * FROM keeper_attempts WHERE market_id=? AND state IN ('UNKNOWN','SUBMITTED')").all(a.market_id);
  check(pending.length===1&&hash(pending[0])===hash(a),'KEEPER_EXPIRY_ATTEMPT_CHANGED');
  verifyGuard();
  db.exec('CREATE TABLE IF NOT EXISTS keeper_expiry_receipts(receipt_hash TEXT PRIMARY KEY,attempt_hash TEXT NOT NULL UNIQUE,attempt_json TEXT NOT NULL,proof_json TEXT NOT NULL,recorded_at INTEGER NOT NULL)');
  const receiptHash=hash({attempt:a,proof:p});
  db.prepare('INSERT INTO keeper_expiry_receipts VALUES(?,?,?,?,?)').run(receiptHash,hash(a),JSON.stringify(a),JSON.stringify(p),now);
  const changed=db.prepare("UPDATE keeper_attempts SET state='FAILED',updated_at=? WHERE action=? AND market_id=? AND cycle=? AND entity=? AND generation=? AND state='UNKNOWN' AND signature IS NULL AND fingerprint=? AND updated_at=?")
   .run(now,a.action,a.market_id,a.cycle,a.entity,a.generation,a.fingerprint,a.updated_at);
  check(changed.changes===1,'KEEPER_EXPIRY_ATTEMPT_CHANGED');
  verifyGuard();db.exec('COMMIT');return receiptHash;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
