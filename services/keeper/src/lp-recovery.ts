import {hash} from '../../data/index.mjs';
import {SqliteKeeperAttempts, type KeeperAttempt} from './attempts.ts';

export interface EmptyWindowState {
  marketId:string;cycle:string;currentMaturity:number;openPositions:number;totalShares:string;
  lpGeneration:string;validityGeneration:string;lastLpMaturity:number;
  lpWindowStart:number;lpWindowEnd:number;navValid:boolean;
}
export interface EmptyWindowChain {
  readEmptyWindow(marketId:string):Promise<EmptyWindowState>;
  verifyAttempt(attempt:KeeperAttempt):Promise<'FINALIZED'|'FAILED'|'PENDING'>;
  startLpWindow(marketId:string,onSigned?:(signature:string)=>void):Promise<string>;
}
const uint=(value:string)=>/^(0|[1-9][0-9]*)$/.test(value);
const monday=(now:number)=>Math.floor((now-345_600)/604_800)*604_800+345_600;

/** Only an empty cycle can recover without a frozen settlement candidate. */
export function planEmptyLpRecovery(state:EmptyWindowState,marketId:string,now:number):
  {state:'ready'|'notDue';fingerprint:string|null} {
  if (!Number.isSafeInteger(now) || now<0 || state.marketId!==marketId || !uint(state.cycle) ||
      !uint(state.totalShares) || !uint(state.lpGeneration) || !uint(state.validityGeneration) ||
      !Number.isSafeInteger(state.currentMaturity) || !Number.isSafeInteger(state.openPositions) ||
      !Number.isSafeInteger(state.lastLpMaturity) || !Number.isSafeInteger(state.lpWindowStart) ||
      !Number.isSafeInteger(state.lpWindowEnd) || state.openPositions<0 || state.currentMaturity<0 ||
      state.lastLpMaturity<0 || state.lpWindowStart<0 || state.lpWindowEnd<state.lpWindowStart)
    throw new Error('KEEPER_EMPTY_WINDOW_INVALID');
  if (state.currentMaturity!==0 || state.openPositions!==0 || BigInt(state.totalShares)===0n ||
      !state.navValid || state.lpWindowStart<=now && now<state.lpWindowEnd &&
      state.lpGeneration===state.validityGeneration ||
      !(monday(now)>state.lastLpMaturity || state.lpGeneration!==state.validityGeneration))
    return {state:'notDue',fingerprint:null};
  return {state:'ready',fingerprint:hash({marketId,cycle:state.cycle,lpGeneration:state.lpGeneration,
    validityGeneration:state.validityGeneration,lastLpMaturity:state.lastLpMaturity})};
}

export async function advanceEmptyLpRecovery(input:{marketId:string;chain:EmptyWindowChain;
  attempts:SqliteKeeperAttempts;now:number}):Promise<{state:'notDue'|'unknown'|'submitted';signature:string|null}> {
  const state=await input.chain.readEmptyWindow(input.marketId);
  const plan=planEmptyLpRecovery(state,input.marketId,input.now);
  if (plan.state==='notDue') return {state:'notDue',signature:null};
  for (const prior of input.attempts.unresolved('RECOVER_LP_WINDOW',input.marketId)) {
    const result=await input.attempts.reconcile(prior,a=>input.chain.verifyAttempt(a),input.now);
    if (result.state==='UNKNOWN' || result.state==='SUBMITTED')
      return {state:'unknown',signature:result.signature};
  }
  const key={action:'RECOVER_LP_WINDOW' as const,marketId:input.marketId,cycle:state.cycle,
    entity:`${monday(input.now)}:${state.validityGeneration}`};
  let reservation=input.attempts.reserve(key,plan.fingerprint!,input.now);
  if (!reservation.created) {
    const reconciled=await input.attempts.reconcile(reservation.attempt,a=>input.chain.verifyAttempt(a),input.now);
    if (reconciled.state!=='FAILED') return {state:'unknown',signature:reconciled.signature};
    reservation=input.attempts.reserve(key,plan.fingerprint!,input.now);
  }
  try {
    const signature=await input.chain.startLpWindow(input.marketId,signed=>{
      input.attempts.attachSignature(reservation.attempt,signed,input.now);
    });
    if (input.attempts.get(key)?.signature!==signature)
      input.attempts.attachSignature(reservation.attempt,signature,input.now);
    return {state:'submitted',signature};
  } catch {return {state:'unknown',signature:input.attempts.get(key)?.signature??null};}
}
