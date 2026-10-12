import { hash } from '../../data/index.mjs';
import { readFrozenSettlement, type AcceptedCandidate, type SettlementScope } from './candidate.ts';
import { SqliteKeeperAttempts, type KeeperAction, type KeeperAttempt, type KeeperAttemptKey } from './attempts.ts';

export interface FinalizedEpochState {
  marketId:string;cycle:string;epochStartedAt:number;maturityAt:number;
  settlement:null|{marketId:string;cycle:string;epoch:string;maturityAt:number;candidateHash:string;priceAtoms:string;
    mode:'NORMAL'|'RECOVERY'|'EMERGENCY';effectiveCloseAt:number;acceptedAt:number};
  openPositions:{address:string;marketId:string;cycle:string}[];
  openPositionCount:number;
  lpWindowStart:number;lpWindowEnd:number;
  navValid:boolean;
}
export interface FinancialEpochChain {
  /** All values, including position enumeration, must come from finalized B accounts. */
  read(scope:SettlementScope):Promise<FinalizedEpochState>;
  verifyAttempt(attempt:KeeperAttempt):Promise<'FINALIZED'|'FAILED'|'PENDING'>;
  accept(candidate:AcceptedCandidate,onSigned?:(signature:string)=>void):Promise<string>;
  settle(marketId:string,positionAddress:string,onSigned?:(signature:string)=>void):Promise<string>;
  startLpWindow(marketId:string,onSigned?:(signature:string)=>void):Promise<string>;
}
type Progress={state:'notDue'|'unknown'|'submitted'|'complete';action:KeeperAction|null;signature:string|null};
export type FinancialEpochPlan={state:'notDue'|'ready'|'complete';action:KeeperAction|null;entity:string|null;
  candidate:AcceptedCandidate|null;finalized:FinalizedEpochState|null};
const hex=(s:string)=>/^[0-9a-f]{64}$/.test(s);

/** Read-only preview. It validates the frozen journal against finalized B accounts. */
export async function planFinancialEpoch(input:{journalPath:string;scope:SettlementScope;chain:FinancialEpochChain;now:number}):Promise<FinancialEpochPlan> {
  const {scope,chain,now}=input;
  if (!Number.isSafeInteger(now) || now<0) throw new Error('KEEPER_TIME_INVALID');
  const candidate=await readFrozenSettlement(input.journalPath,scope);
  if (!candidate) return {state:'notDue',action:null,entity:null,candidate:null,finalized:null};
  const state=await chain.read(scope);
  if (state.marketId!==scope.marketId || state.cycle!==scope.epoch || state.epochStartedAt!==scope.epochStartedAt ||
      (state.maturityAt!==scope.maturityAt &&
      !(state.maturityAt===0 && state.settlement && state.lpWindowStart>=state.settlement.acceptedAt)) ||
      !/^(0|[1-9][0-9]*)$/.test(state.cycle) ||
      !Number.isSafeInteger(state.openPositionCount) || state.openPositionCount<0 ||
      state.openPositions.length!==state.openPositionCount ||
      state.openPositions.some(p=>p.marketId!==scope.marketId || p.cycle!==state.cycle || !p.address) ||
      new Set(state.openPositions.map(p=>p.address)).size!==state.openPositions.length) throw new Error('KEEPER_CHAIN_STATE_MISMATCH');
  const candidateHash=Buffer.from(candidate.candidateHash).toString('hex');
  if (!state.settlement) return now<Number(candidate.eligibleAt)
    ? {state:'notDue',action:null,entity:null,candidate,finalized:state}
    : {state:'ready',action:'ACCEPT_SETTLEMENT',entity:'',candidate,finalized:state};
  const settled=state.settlement;
  if (!hex(settled.candidateHash) || settled.marketId!==scope.marketId || settled.cycle!==state.cycle ||
      settled.epoch!==scope.epoch || settled.maturityAt!==scope.maturityAt || settled.candidateHash!==candidateHash ||
      settled.priceAtoms!==candidate.settlementPrice.toString() || settled.mode!==candidate.mode ||
      settled.effectiveCloseAt!==Number(candidate.effectiveCloseAt) || !Number.isSafeInteger(settled.acceptedAt) ||
      settled.acceptedAt<Number(candidate.eligibleAt)) throw new Error('KEEPER_SETTLEMENT_ACCOUNT_MISMATCH');
  if (state.openPositions.length) return now<Number(candidate.eligibleAt)
    ? {state:'notDue',action:null,entity:null,candidate,finalized:state}
    : {state:'ready',action:'SETTLE_PRO',entity:state.openPositions.slice().sort((a,b)=>a.address.localeCompare(b.address))[0].address,candidate,finalized:state};
  if (state.lpWindowStart>=settled.acceptedAt && state.lpWindowEnd>state.lpWindowStart)
    return {state:'complete',action:null,entity:null,candidate,finalized:state};
  if (!state.navValid) return {state:'notDue',action:null,entity:null,candidate,finalized:state};
  return {state:'ready',action:'START_LP_WINDOW',entity:'',candidate,finalized:state};
}

/** One chain mutation at most per call. Re-read finalized accounts before each subsequent stage. */
export async function advanceFinancialEpoch(input:{journalPath:string;scope:SettlementScope;attempts:SqliteKeeperAttempts;
  chain:FinancialEpochChain;now:number}):Promise<Progress> {
  const {scope,attempts,chain,now}=input;
  const plan=await planFinancialEpoch(input);
  if (plan.state!=='ready' || !plan.action || !plan.candidate || !plan.finalized)
    return {state:plan.state==='complete'?'complete':'notDue',action:null,signature:null};
  const candidate=plan.candidate,state=plan.finalized;
  const candidateHash=Buffer.from(candidate.candidateHash).toString('hex');
  async function submit(action:KeeperAction,entity:string,fingerprint:string,
    send:(onSigned:(signature:string)=>void)=>Promise<string>):Promise<Progress> {
    const key:KeeperAttemptKey={action,marketId:scope.marketId,cycle:state.cycle,entity};
    let reservation=attempts.reserve(key,fingerprint,now);
    if (!reservation.created) {
      const reconciled=await attempts.reconcile(reservation.attempt,a=>chain.verifyAttempt(a),now);
      if (reconciled.state==='FINALIZED') return {state:'unknown',action,signature:reconciled.signature};
      if (reconciled.state!=='FAILED') return {state:'unknown',action,signature:reconciled.signature};
      reservation=attempts.reserve(key,fingerprint,now);
    }
    try {
      const signature=await send(signature=>{attempts.attachSignature(reservation.attempt,signature,now);});
      if (attempts.get(key)?.signature!==signature) attempts.attachSignature(reservation.attempt,signature,now);
      return {state:'submitted',action,signature};
    } catch {return {state:'unknown',action,signature:attempts.get(key)?.signature??null};}
  }
  if (plan.action==='ACCEPT_SETTLEMENT') {
    return submit('ACCEPT_SETTLEMENT','',candidateHash,onSigned=>chain.accept(candidate,onSigned));
  }
  if (plan.action==='SETTLE_PRO') {
    const position=plan.entity!;
    const fingerprint=hash({candidateHash,position,cycle:state.cycle});
    return submit('SETTLE_PRO',position,fingerprint,onSigned=>chain.settle(scope.marketId,position,onSigned));
  }
  return submit('START_LP_WINDOW','',candidateHash,onSigned=>chain.startLpWindow(scope.marketId,onSigned));
}
