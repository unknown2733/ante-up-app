import { createSolanaRpc } from '@solana/kit';
import { createKitChainTransport } from '../../clients/chain/dist/index.js';
import { withRpcReadFailover } from '../indexer/src/rpc-failover.ts';
import { withChainReadFailover } from '../data/transport-failover.mjs';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

/** Proof submission stays on the validated primary; only idempotent reads may switch. */
export async function createEvidenceChain(primaryEndpoint, backupEndpoint = null) {
  const primaryRpc = createSolanaRpc(primaryEndpoint);
  if (await primaryRpc.getGenesisHash().send() !== DEVNET_GENESIS) throw Error('DEVNET_REQUIRED');
  const primaryTransport = createKitChainTransport(primaryEndpoint);
  if (!backupEndpoint) return { rpc: primaryRpc, transport: primaryTransport };
  if (backupEndpoint === primaryEndpoint) throw Error('RPC_FAILOVER_ENDPOINT_INVALID');
  const backupRpc = createSolanaRpc(backupEndpoint);
  const backupTransport = createKitChainTransport(backupEndpoint);
  const validateBackup = async () => {
    if (await backupRpc.getGenesisHash().send() !== DEVNET_GENESIS)
      throw Error('RPC_FAILOVER_GENESIS_MISMATCH');
  };
  return {
    rpc: withRpcReadFailover(primaryRpc, backupRpc, { expectedGenesisHash: DEVNET_GENESIS }),
    transport: withChainReadFailover(primaryTransport, backupTransport, { validateBackup }),
  };
}
