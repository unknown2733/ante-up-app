import { createSolanaRpc } from '@solana/kit';
import { createKitChainTransport } from '../../clients/chain/dist/index.js';
import { withRpcReadFailover } from '../indexer/src/rpc-failover.ts';
import { withChainReadFailover } from '../data/transport-failover.mjs';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

/** Proof submission stays on the validated primary; only idempotent reads may switch. */
export async function createEvidenceChain(primaryEndpoint, backupEndpoint = null) {
  if (backupEndpoint === primaryEndpoint) throw Error('RPC_FAILOVER_ENDPOINT_INVALID');
  const primaryRpc = createSolanaRpc(primaryEndpoint);
  const primaryTransport = createKitChainTransport(primaryEndpoint);
  let primaryValidated = false;
  try {
    if (await primaryRpc.getGenesisHash().send() !== DEVNET_GENESIS) throw Error('DEVNET_REQUIRED');
    primaryValidated = true;
  } catch (error) {
    if (!backupEndpoint || error.message === 'DEVNET_REQUIRED') throw error;
  }
  if (!backupEndpoint) return { rpc: primaryRpc, transport: primaryTransport };
  const backupRpc = createSolanaRpc(backupEndpoint);
  const backupTransport = createKitChainTransport(backupEndpoint);
  const validateBackup = async () => {
    if (await backupRpc.getGenesisHash().send() !== DEVNET_GENESIS)
      throw Error('RPC_FAILOVER_GENESIS_MISMATCH');
  };
  if (!primaryValidated) {
    await validateBackup();
    // A failed primary genesis check permits Devnet reads only. Never submit
    // until the primary has independently proven its own cluster again.
    return {
      rpc: backupRpc,
      transport: {
        ...backupTransport,
        sendTransaction: async (...args) => {
          if (await primaryRpc.getGenesisHash().send() !== DEVNET_GENESIS)
            throw Error('DEVNET_REQUIRED');
          return primaryTransport.sendTransaction(...args);
        },
      },
    };
  }
  return {
    rpc: withRpcReadFailover(primaryRpc, backupRpc, { expectedGenesisHash: DEVNET_GENESIS }),
    transport: withChainReadFailover(primaryTransport, backupTransport, { validateBackup }),
  };
}
