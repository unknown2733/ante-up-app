import {isRpcRateLimited} from '../../indexer/src/rpc-retry.ts';
const failures=new WeakSet<object>();
/** Created only by a transport that has not entered its signer or broadcast path. */
export class KeeperPreparationFailure extends Error {
  readonly stage='BEFORE_SIGNING' as const;
  readonly reason:'RPC_RATE_LIMITED'|'BLOCKHASH_EXPIRED'|'PREPARATION_FAILED';
  constructor(reason:KeeperPreparationFailure['reason'],code='KEEPER_PREPARATION_FAILED') {
    super(/^KEEPER_[A-Z_]{1,80}$/.test(code)?code:'KEEPER_PREPARATION_FAILED');
    this.name='KeeperPreparationFailure';this.reason=reason;failures.add(this);Object.freeze(this);
  }
}
export function isKeeperPreparationFailure(value:unknown):value is KeeperPreparationFailure {
  return typeof value==='object'&&value!==null&&failures.has(value);
}
export function keeperPreparationFailure(error:unknown):KeeperPreparationFailure {
  return new KeeperPreparationFailure(isRpcRateLimited(error)?'RPC_RATE_LIMITED':
    error instanceof Error&&error.message==='BLOCKHASH_EXPIRED_BEFORE_SIGNING'?'BLOCKHASH_EXPIRED':'PREPARATION_FAILED',
    error instanceof Error?error.message:undefined);
}
