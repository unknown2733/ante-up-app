import { createSolanaRpc } from '@solana/kit';
import { isRpcRateLimited } from './rpc-retry.ts';

type SolanaRpc = ReturnType<typeof createSolanaRpc>;
type Request = {send: (...args: unknown[]) => Promise<unknown>};

// Only idempotent reads may switch providers. In particular, sendTransaction is never replayed.
const READ_METHODS = new Set([
  'getAccountInfo', 'getBalance', 'getBlock', 'getBlockHeight', 'getGenesisHash',
  'getLatestBlockhash', 'getProgramAccounts', 'getSignatureStatuses',
  'getSignaturesForAddress', 'getSlot', 'getTransaction', 'isBlockhashValid',
]);

export function withRpcReadFailover(primary: SolanaRpc, backup: SolanaRpc, options: {
  now?: () => number; cooldownMs?: number; onFailover?: () => void; expectedGenesisHash?: string;
} = {}): SolanaRpc {
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? 60_000;
  if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 0) throw new Error('RPC_FAILOVER_COOLDOWN_INVALID');
  let primaryPausedUntil = 0;
  let backupValidation: Promise<void> | null = null;
  const validateBackup = async () => {
    if (!options.expectedGenesisHash) return;
    if (!backupValidation) backupValidation = (async () => {
      const genesis = await backup.getGenesisHash().send();
      if (genesis !== options.expectedGenesisHash) throw new Error('RPC_FAILOVER_GENESIS_MISMATCH');
    })().catch(error => { backupValidation = null; throw error; });
    await backupValidation;
  };
  return new Proxy(primary, {
    get(target, property) {
      const original = Reflect.get(target, property);
      if (typeof property !== 'string' || !READ_METHODS.has(property) || typeof original !== 'function') return original;
      return (...args: unknown[]) => ({
        send: async (...sendArgs: unknown[]) => {
          const send = (rpc: SolanaRpc) => {
            const method = Reflect.get(rpc, property) as (...args: unknown[]) => Request;
            return method.apply(rpc, args).send(...sendArgs);
          };
          if (now() < primaryPausedUntil) { await validateBackup(); return send(backup); }
          try { return await send(primary); }
          catch (error) {
            if (!isRpcRateLimited(error)) throw error;
            primaryPausedUntil = now() + cooldownMs;
            options.onFailover?.();
            await validateBackup();
            return send(backup);
          }
        },
      });
    },
  }) as SolanaRpc;
}

export function createRpcReadFailover(primaryEndpoint: string, backupEndpoint: string, options: {
  now?: () => number; cooldownMs?: number; onFailover?: () => void; expectedGenesisHash?: string;
} = {}): SolanaRpc {
  if (!/^https?:\/\//.test(primaryEndpoint) || !/^https?:\/\//.test(backupEndpoint) || primaryEndpoint === backupEndpoint)
    throw new Error('RPC_FAILOVER_ENDPOINT_INVALID');
  return withRpcReadFailover(createSolanaRpc(primaryEndpoint), createSolanaRpc(backupEndpoint), options);
}
