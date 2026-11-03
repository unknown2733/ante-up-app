import {SqliteKeeperAttempts, type KeeperAction, type KeeperAttempt} from './attempts.ts';

const actions:KeeperAction[]=['ACCEPT_SETTLEMENT','SETTLE_PRO','START_LP_WINDOW','RECOVER_LP_WINDOW'];

/** Reconcile durable attempts even when the next financial plan is idle. Never signs. */
export async function reconcileKeeperAttempts(input:{marketId:string;attempts:SqliteKeeperAttempts;
  verify:(attempt:KeeperAttempt)=>Promise<'FINALIZED'|'FAILED'|'PENDING'>;now:number}) {
  const results:KeeperAttempt[]=[];
  for(const action of actions) {
    for(const attempt of input.attempts.unresolved(action,input.marketId))
      results.push(await input.attempts.reconcile(attempt,input.verify,input.now));
  }
  return {checked:results.length,finalized:results.filter(a=>a.state==='FINALIZED').length,
    failed:results.filter(a=>a.state==='FAILED').length,
    pending:results.filter(a=>a.state==='UNKNOWN'||a.state==='SUBMITTED').length};
}
