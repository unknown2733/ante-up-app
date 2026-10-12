import { address, createSolanaRpc, type Signature, type Slot } from '@solana/kit';

export interface SignatureInfo { signature: string; slot: string; failed: boolean }
export interface FinalizedEvidence {
  signature: string; slot: string; transactionIndex: number;
  transaction: unknown; meta: unknown;
}
export interface FinalizedRpc {
  listSignatures(programId: string, before: string | null, limit: number): Promise<SignatureInfo[]>;
  getEvidence(signature: string, listedSlot: string): Promise<FinalizedEvidence>;
}

/** Kit transport, pinned by the indexer package lockfile. No submit/send method is exposed. */
export class KitFinalizedRpc implements FinalizedRpc {
  private rpc: ReturnType<typeof createSolanaRpc>;
  constructor(endpoint: string, rpc?: ReturnType<typeof createSolanaRpc>) {
    if (!/^https?:\/\//.test(endpoint)) throw new Error('RPC_URL_REQUIRED');
    this.rpc = rpc ?? createSolanaRpc(endpoint);
  }
  async listSignatures(programId: string, before: string | null, limit: number): Promise<SignatureInfo[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('INVALID_LIMIT');
    const options = { commitment: 'finalized' as const, limit, ...(before ? { before: before as Signature } : {}) };
    const rows = await this.rpc.getSignaturesForAddress(address(programId), options).send();
    return rows.map(row => {
      if (row.confirmationStatus !== 'finalized') throw new Error('SIGNATURE_NOT_FINALIZED');
      return { signature: String(row.signature), slot: row.slot.toString(), failed: row.err !== null };
    });
  }
  async getEvidence(signature: string, listedSlot: string): Promise<FinalizedEvidence> {
    if (!/^(0|[1-9][0-9]*)$/.test(listedSlot)) throw new Error('INVALID_SLOT');
    const transaction = await this.rpc.getTransaction(signature as Signature, {
      commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0
    }).send();
    if (!transaction || !transaction.meta || transaction.meta.err !== null || transaction.slot.toString() !== listedSlot) throw new Error('FINALIZED_TRANSACTION_UNAVAILABLE');
    const block = await this.rpc.getBlock(BigInt(listedSlot) as Slot, {
      commitment: 'finalized', transactionDetails: 'signatures', rewards: false
    }).send();
    if (!block?.signatures) throw new Error('FINALIZED_BLOCK_UNAVAILABLE');
    const transactionIndex = block.signatures.findIndex(item => String(item) === signature);
    if (transactionIndex < 0) throw new Error('SIGNATURE_NOT_IN_FINALIZED_BLOCK');
    return { signature, slot: listedSlot, transactionIndex, transaction: transaction.transaction, meta: transaction.meta };
  }
}
