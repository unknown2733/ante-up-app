import { readFile } from 'node:fs/promises';
import { AccountRole, address, appendTransactionMessageInstruction, blockhash, compileTransaction,
  createKeyPairSignerFromBytes, createSolanaRpc, createTransactionMessage, getBase64Decoder,
  getSignatureFromTransaction, getTransactionEncoder, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionWithSigners, type KeyPairSigner } from '@solana/kit';
import { SqliteSolFaucetLedger, VisitorSolFaucet, DEVNET_GENESIS, type SolFaucetPolicy, type SolFaucetRpc } from './visitor-faucet.ts';
import { createRpcReadFailover } from '../../indexer/src/rpc-failover.ts';

const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
const LAMPORTS_PER_SOL = 1_000_000_000n;
const MAX_GRANT = 50_000_000n;
const MAX_DAILY = 500_000_000n;
const MAX_TOTAL = 10n * LAMPORTS_PER_SOL;

function lamports(value: string | undefined, name: string): bigint {
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name}_INVALID`);
  return BigInt(value);
}

async function loadSigner(path: string): Promise<KeyPairSigner> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(value) || value.length !== 64 || value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255))
    throw new Error('VISITOR_SOL_KEYPAIR_INVALID');
  return createKeyPairSignerFromBytes(Uint8Array.from(value));
}

export function transferInstruction(source: KeyPairSigner, destination: string, amount: bigint) {
  if (amount <= 0n || amount > MAX_GRANT) throw new Error('VISITOR_SOL_AMOUNT_INVALID');
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0); // System Program Transfer
  data.writeBigUInt64LE(amount, 4);
  return { programAddress: SYSTEM_PROGRAM, data,
    accounts: [{ address: source.address, role: AccountRole.WRITABLE_SIGNER },
      { address: address(destination), role: AccountRole.WRITABLE }] };
}

/** A dedicated, capped funder signs one transfer. Persist its signature before broadcasting. */
export async function createVisitorSolRuntime(input: {
  endpoint: string; readFallbackEndpoint?: string; dbPath: string; env: NodeJS.ProcessEnv; nowMs?: () => number;
}) {
  const rpc = input.readFallbackEndpoint
    ? createRpcReadFailover(input.endpoint,input.readFallbackEndpoint,{expectedGenesisHash:DEVNET_GENESIS,
      onFailover:()=>console.warn('RPC_READ_FAILOVER')})
    : createSolanaRpc(input.endpoint);
  const enabled = input.env.ANTE_UP_VISITOR_SOL_ENABLED === 'true';
  const policy: SolFaucetPolicy = {
    enabled,
    grantLamports: enabled ? lamports(input.env.ANTE_UP_VISITOR_SOL_GRANT_LAMPORTS, 'VISITOR_SOL_GRANT') : MAX_GRANT,
    minimumBalanceLamports: 10_000_000n,
    dailyCapLamports: enabled ? lamports(input.env.ANTE_UP_VISITOR_SOL_DAILY_CAP_LAMPORTS, 'VISITOR_SOL_DAILY_CAP') : MAX_DAILY,
    totalCapLamports: enabled ? lamports(input.env.ANTE_UP_VISITOR_SOL_TOTAL_CAP_LAMPORTS, 'VISITOR_SOL_TOTAL_CAP') : MAX_TOTAL,
    reserveLamports: 100_000_000n,
    cooldownMs: 86_400_000,
  };
  if (policy.grantLamports > MAX_GRANT || policy.dailyCapLamports > MAX_DAILY || policy.totalCapLamports > MAX_TOTAL)
    throw new Error('VISITOR_SOL_CAP_TOO_HIGH');
  const keyPath = input.env.ANTE_UP_VISITOR_SOL_KEYPAIR_FILE;
  if (enabled && !keyPath) throw new Error('VISITOR_SOL_KEYPAIR_REQUIRED');
  const signer = enabled ? await loadSigner(keyPath!) : null;
  if (signer && input.env.ANTE_UP_VISITOR_SOL_FUNDER_ADDRESS !== String(signer.address))
    throw new Error('VISITOR_SOL_FUNDER_ADDRESS_MISMATCH');
  const ledger = new SqliteSolFaucetLedger(input.dbPath);
  const network: SolFaucetRpc = {
    genesisHash: () => rpc.getGenesisHash().send(),
    async balanceLamports(wallet) {
      const result = await rpc.getBalance(address(wallet), { commitment: 'confirmed' }).send();
      return result.value;
    },
    async sendOnce(wallet, amount, _requestId, onSigned) {
      if (!signer) throw new Error('VISITOR_SOL_DISABLED');
      if (await rpc.getGenesisHash().send() !== DEVNET_GENESIS) throw new Error('DEVNET_REQUIRED');
      const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'finalized' }).send();
      const message = appendTransactionMessageInstruction(transferInstruction(signer, wallet, amount),
        setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(lifetime.blockhash),
          lastValidBlockHeight: lifetime.lastValidBlockHeight },
        setTransactionMessageFeePayer(signer.address, createTransactionMessage({ version: 0 }))));
      const signed = await signTransactionWithSigners([signer], compileTransaction(message));
      const signature = getSignatureFromTransaction(signed);
      onSigned(signature);
      const wire = getBase64Decoder().decode(getTransactionEncoder().encode(signed));
      const returned = await rpc.sendTransaction(wire as Parameters<typeof rpc.sendTransaction>[0], {
        encoding: 'base64', preflightCommitment: 'confirmed', skipPreflight: false, maxRetries: 0n,
      }).send();
      if (returned !== signature) throw new Error('VISITOR_SOL_SIGNATURE_MISMATCH');
      return signature;
    },
    async finalized(signature) {
      const result = await rpc.getSignatureStatuses([signature as Parameters<typeof rpc.getSignatureStatuses>[0][number]],
        { searchTransactionHistory: true }).send();
      const status = result.value[0];
      return !!status && status.err === null && status.confirmationStatus === 'finalized';
    },
  };
  const faucet = new VisitorSolFaucet({ policy, rpc: network, ledger,
    fundingBalanceLamports: () => signer ? network.balanceLamports(String(signer.address)) : Promise.resolve(0n),
    nowMs: input.nowMs ?? (() => Date.now()),
  });
  return { faucet, close: () => ledger.close(), funderAddress: signer ? String(signer.address) : null };
}
