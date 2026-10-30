import { createPublicKey, verify } from 'node:crypto';
import { address, blockhash, createSolanaRpc, getCompiledTransactionMessageDecoder, getTransactionDecoder, type Signature } from '@solana/kit';
import { decodeBase58 } from './auth.ts';
import { LiveStore, type StoredOperation } from './live-store.ts';
import { verifyMessageIntent } from './receipt-intent.ts';
import { retryRpcRead } from '../../indexer/src/rpc-retry.ts';
import type { Operation } from '../../../contracts/types.ts';

export interface ChainReceipt { wireBase64: string; status: 'confirmed'|'finalized'|'failed' }
export interface OperationChain {
  get(signature: string): Promise<ChainReceipt | null>;
  discover(recordAddress: string): Promise<Array<{signature:string;receipt:ChainReceipt}>>;
  expiredHistory?(stored:StoredOperation): Promise<Array<{signature:string;receipt:ChainReceipt}> | null>;
}

/** Kit reads only. An RPC miss is UNKNOWN; no submit/send method is exposed. */
export class KitOperationChain implements OperationChain {
  private readonly rpc: ReturnType<typeof createSolanaRpc>;
  constructor(url: string, rpc?: ReturnType<typeof createSolanaRpc>) {
    if (!/^https?:\/\//.test(url)) throw new Error('RPC_URL_REQUIRED');
    this.rpc = rpc ?? createSolanaRpc(url);
  }
  async get(signature: string): Promise<ChainReceipt | null> {
    const statuses = await retryRpcRead(() => this.rpc.getSignatureStatuses([signature as Signature], {searchTransactionHistory:true}).send());
    const status = statuses.value[0];
    if (!status || !status.confirmationStatus || status.confirmationStatus === 'processed') return null;
    const transaction = await retryRpcRead(() => this.rpc.getTransaction(signature as Signature,
      {commitment:'confirmed', encoding:'base64', maxSupportedTransactionVersion:0}).send());
    if (!transaction) return null;
    const encoded = transaction.transaction;
    if (!Array.isArray(encoded) || encoded[1] !== 'base64' || typeof encoded[0] !== 'string') throw new Error('INVALID_RPC_TRANSACTION');
    return {wireBase64:encoded[0], status:status.err || transaction.meta?.err ? 'failed' : status.confirmationStatus};
  }
  async discover(recordAddress: string): Promise<Array<{signature:string;receipt:ChainReceipt}>> {
    const rows=await retryRpcRead(() => this.rpc.getSignaturesForAddress(address(recordAddress),{commitment:'finalized',limit:20}).send());
    const matches:Array<{signature:string;receipt:ChainReceipt}>=[];
    for (const row of rows) {
      if (row.confirmationStatus!=='finalized') continue;
      const receipt=await this.get(String(row.signature));
      if (receipt) matches.push({signature:String(row.signature),receipt});
    }
    return matches;
  }
  /** Fail closed unless lifetime ended at finality and the bounded payer history is complete. */
  async expiredHistory(stored:StoredOperation): Promise<Array<{signature:string;receipt:ChainReceipt}> | null> {
    if (!/^[0-9]+$/.test(stored.prepared.lastValidBlockHeight)) return null;
    const height=await retryRpcRead(() => this.rpc.getBlockHeight({commitment:'finalized'}).send());
    if(height<=BigInt(stored.prepared.lastValidBlockHeight))return null;
    const tx=getTransactionDecoder().decode(Buffer.from(stored.prepared.unsignedTransaction,'base64'));
    const message=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const valid=await retryRpcRead(() => this.rpc.isBlockhashValid(blockhash(message.lifetimeToken),{commitment:'finalized'}).send());
    if(valid.value)return null;
    // A full page could omit a matching receipt: retain UNKNOWN instead of guessing.
    const rows=await retryRpcRead(() => this.rpc.getSignaturesForAddress(address(stored.intent.wallet),{commitment:'finalized',minContextSlot:valid.context.slot,limit:100}).send());
    if(rows.length>=100)return null;
    const history:Array<{signature:string;receipt:ChainReceipt}>=[];
    for(const row of rows){
      if(row.confirmationStatus!=='finalized')return null;
      const receipt=await this.get(String(row.signature));
      if(!receipt || receipt.status==='confirmed')return null;
      history.push({signature:String(row.signature),receipt});
    }
    return history;
  }
}

export function verifyReceipt(stored: StoredOperation, signature: string, receipt: ChainReceipt): void {
  const expected = getTransactionDecoder().decode(Buffer.from(stored.prepared.unsignedTransaction, 'base64'));
  const actual = getTransactionDecoder().decode(Buffer.from(receipt.wireBase64, 'base64'));
  verifyMessageIntent(new Uint8Array(expected.messageBytes),new Uint8Array(actual.messageBytes));
  const sigBytes = decodeBase58(signature);
  if (sigBytes.length !== 64) throw new Error('INVALID_SIGNATURE');
  const walletSig = actual.signatures[address(stored.intent.wallet)];
  if (!walletSig || !Buffer.from(walletSig).equals(Buffer.from(sigBytes))) throw new Error('TRANSACTION_SIGNATURE_MISMATCH');
  const walletKey = decodeBase58(stored.intent.wallet);
  if (walletKey.length !== 32) throw new Error('INVALID_WALLET');
  const key = createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(walletKey)]),format:'der',type:'spki'});
  if (!verify(null,Buffer.from(actual.messageBytes),key,Buffer.from(sigBytes))) throw new Error('INVALID_WALLET_SIGNATURE');
}

export async function reconcileLiveOperation(store: LiveStore, chain: OperationChain, requestId: string, now: number) {
  const stored = store.get(requestId);
  if (!stored) throw new Error('INVALID_INPUT');
  const signature = stored.operation.signature;
  if (stored.operation.state === 'FINALIZED') return stored.operation;
  if (!signature) {
    const candidates=await chain.discover(stored.discoveryAddress);
    for (const candidate of candidates) {
      try {verifyReceipt(stored,candidate.signature,candidate.receipt);} catch {continue;}
      store.claim(requestId,candidate.signature);
      return store.mark(requestId,candidate.receipt.status==='failed'?'FAILED':candidate.receipt.status==='finalized'?'FINALIZED':'CONFIRMED').operation;
    }
    if(now>=stored.prepared.expiresAt && chain.expiredHistory){
      const history=await chain.expiredHistory(stored);
      if(history!==null){
        for(const candidate of history){
          try{verifyReceipt(stored,candidate.signature,candidate.receipt);}catch{continue;}
          store.claim(requestId,candidate.signature);
          return store.mark(requestId,candidate.receipt.status==='failed'?'FAILED':'FINALIZED').operation;
        }
        // A wallet-mutated transaction with the same lifetime may have landed.
        // A failed intent match is not evidence of non-execution.
        const lifetime=(wire:string)=>getCompiledTransactionMessageDecoder().decode(
          getTransactionDecoder().decode(Buffer.from(wire,'base64')).messageBytes).lifetimeToken;
        const originalLifetime=lifetime(stored.prepared.unsignedTransaction);
        for(const candidate of history){
          try{if(lifetime(candidate.receipt.wireBase64)===originalLifetime)return store.markUnclaimedUnknown(requestId).operation;}
          catch{return store.markUnclaimedUnknown(requestId).operation;}
        }
        if(stored.operation.state==='FAILED' && stored.operation.error?.code==='REQUOTE_REQUIRED')return stored.operation;
        return store.markExpiredUnlanded(requestId).operation;
      }
    }
    return now>=stored.prepared.expiresAt ? store.markUnclaimedUnknown(requestId).operation : stored.operation;
  }
  const receipt = await chain.get(signature);
  if (!receipt) return store.mark(requestId,'UNKNOWN').operation;
  verifyReceipt(stored,signature,receipt);
  return store.mark(requestId,receipt.status === 'failed' ? 'FAILED' : receipt.status === 'finalized' ? 'FINALIZED' : 'CONFIRMED').operation;
}

/** A slow unsigned-history scan must not hold an authenticated HTTP read past the proxy deadline. */
export class BoundedOperationReconciler {
  private readonly inflight=new Map<string,Promise<Operation>>();
  private readonly store:LiveStore;
  private readonly chain:OperationChain;
  private readonly now:()=>number;
  private readonly waitMs:number;
  constructor(store:LiveStore,chain:OperationChain,now:()=>number,waitMs=8_000) {
    if (!Number.isSafeInteger(waitMs) || waitMs<1 || waitMs>15_000) throw new Error('INVALID_RECONCILE_WAIT');
    this.store=store;
    this.chain=chain;
    this.now=now;
    this.waitMs=waitMs;
  }
  async read(requestId:string):Promise<Operation> {
    let job=this.inflight.get(requestId);
    if (!job) {
      const started=reconcileLiveOperation(this.store,this.chain,requestId,this.now());
      const tracked:Promise<Operation>=started.finally(()=>{
        if (this.inflight.get(requestId)===tracked) this.inflight.delete(requestId);
      });
      // A timed-out HTTP caller may be gone when the read-only chain scan finishes.
      void tracked.catch(()=>{});
      this.inflight.set(requestId,tracked);
      job=tracked;
    }
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      return await Promise.race([job,new Promise<Operation>(resolve=>{
        timer=setTimeout(()=>resolve(this.store.get(requestId)!.operation),this.waitMs);
      })]);
    } finally { if(timer)clearTimeout(timer); }
  }
}
