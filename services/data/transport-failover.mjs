import { isRpcRateLimited } from '../indexer/src/rpc-retry.ts';

const READS = ['getFinalizedAccount', 'getLatestBlockhash', 'isBlockhashValid',
  'getSignatureStatus', 'getBlockHeight'];

/** Retain the primary-only broadcast path while falling back on rate-limited chain reads. */
export function withChainReadFailover(primary, backup, options = {}) {
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? 60_000;
  if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 0 ||
    READS.some(method => typeof primary?.[method] !== 'function' || typeof backup?.[method] !== 'function') ||
    typeof primary?.sendTransaction !== 'function') throw Error('CHAIN_FAILOVER_INVALID');
  let primaryPausedUntil = 0, backupValidation = null;
  const validateBackup = async () => {
    if (!options.validateBackup) return;
    if (!backupValidation) backupValidation = Promise.resolve().then(options.validateBackup)
      .catch(error => {backupValidation = null; throw error;});
    await backupValidation;
  };
  const result = {...primary, sendTransaction: (...args) => primary.sendTransaction(...args)};
  for (const method of READS) result[method] = async (...args) => {
    if (now() < primaryPausedUntil) { await validateBackup(); return backup[method](...args); }
    try { return await primary[method](...args); }
    catch (error) {
      if (!isRpcRateLimited(error)) throw error;
      primaryPausedUntil = now() + cooldownMs;
      options.onFailover?.();
      await validateBackup();
      return backup[method](...args);
    }
  };
  return result;
}
