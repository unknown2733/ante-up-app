import { randomBytes } from 'node:crypto';
import { address, appendTransactionMessageInstruction, compileTransaction, createNoopSigner,
  createSolanaRpc, createTransactionMessage, decompileTransactionMessage, getCompiledTransactionMessageDecoder,
  getTransactionDecoder, getTransactionEncoder, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, type Blockhash } from '@solana/kit';
import { getOpenFreeInstructionAsync, getCloseFreeInstructionAsync, getOpenFreeInstructionDataDecoder,
  OPEN_FREE_DISCRIMINATOR, CLOSE_FREE_DISCRIMINATOR, findRecordPda } from '../../../clients/chain/dist/index.js';
import type { Action, FreeRecord, MarketView, PreparedTransaction } from '../../../contracts/types.ts';
import type { ActionBody } from './validate.ts';

/** D/F proposed extension to shared PreparedTransaction; A owns the shared type update. */
export interface PreparedForWallet {
  kind: 'transaction'; action: Action; requestId: string;
  unsignedTransaction: string; lastValidBlockHeight: string; quoteRef: string | null;
  wallet: string; cluster: 'localnet' | 'devnet'; programId: string;
  expiresAt: number; recordId: string;
}
export interface TransactionAdapter {
  prepare(input: ActionBody): Promise<PreparedForWallet>;
}
export interface FreeStateReader {
  market(marketId: string): Promise<MarketView | null>;
  record(recordId: string): Promise<FreeRecord | null>;
}
export interface BlockhashProvider { latest(): Promise<{blockhash: string; lastValidBlockHeight: bigint}> }
export class KitBlockhashProvider implements BlockhashProvider {
  private readonly rpc: ReturnType<typeof createSolanaRpc>;
  constructor(url: string, rpc?: ReturnType<typeof createSolanaRpc>) {
    if (!/^https?:\/\//.test(url)) throw new Error('RPC_URL_REQUIRED');
    this.rpc=rpc??createSolanaRpc(url);
  }
  async latest() {
    const value=(await this.rpc.getLatestBlockhash({commitment:'finalized'}).send()).value;
    return {blockhash:String(value.blockhash),lastValidBlockHeight:value.lastValidBlockHeight};
  }
}

/** One free instruction, wallet fee payer, no server signer or submission. */
export class KitFreeTransactionAdapter implements TransactionAdapter {
  private readonly options: {
    cluster: 'localnet'|'devnet'; programId: string; read: FreeStateReader; blockhashes: BlockhashProvider;
    now: () => number; nextRecordNonce?: () => bigint;
  };
  constructor(options: KitFreeTransactionAdapter['options']) { this.options = options; }
  async prepare(input: ActionBody): Promise<PreparedForWallet> {
    if (input.action !== 'openFree' && input.action !== 'closeFree') throw new Error('UNSUPPORTED_ACTION');
    const market = await this.options.read.market(input.marketId);
    if (!market || market.id !== input.marketId || market.chain?.address !== market.id || market.chain.programId !== this.options.programId || market.chain.cluster !== this.options.cluster) throw new Error('MARKET_IDENTITY_MISMATCH');
    if (market.snapshot && (market.snapshot.finality !== 'finalized' || market.snapshot.chain.programId !== this.options.programId || market.snapshot.payload.marketId !== market.id)) throw new Error('SNAPSHOT_NOT_FINALIZED');
    const now = this.options.now();
    if (!Number.isSafeInteger(now)) throw new Error('INVALID_TIME');
    const owner = createNoopSigner(address(input.wallet));
    let recordId: string;
    let instruction;
    if (input.action === 'openFree') {
      if (market.capabilities.openFree?.allowed !== true) throw new Error('DATA_NOT_READY');
      const nonce = this.options.nextRecordNonce?.() ?? randomBytes(8).readBigUInt64LE();
      if (nonce < 0n || nonce > 18_446_744_073_709_551_615n) throw new Error('INVALID_RECORD_NONCE');
      const [recordAddress] = await findRecordPda({market: address(market.id), owner: address(input.wallet), recordId: nonce}, {programAddress: address(this.options.programId)});
      recordId = String(recordAddress);
      instruction = await getOpenFreeInstructionAsync({market: address(market.id), owner, recordId: nonce}, {programAddress: address(this.options.programId)});
    } else {
      if (!input.recordId) throw new Error('RECORD_ID_REQUIRED');
      const record = await this.options.read.record(input.recordId);
      if (!record || record.id !== input.recordId || record.wallet !== input.wallet || record.marketId !== market.id || record.status !== 'OPEN' || record.finality !== 'finalized') throw new Error('RECORD_NOT_OPEN');
      recordId = record.id;
      instruction = await getCloseFreeInstructionAsync({market: address(market.id), record: address(recordId), owner}, {programAddress: address(this.options.programId)});
    }
    const lifetime = await this.options.blockhashes.latest();
    const message = appendTransactionMessageInstruction(instruction,
      setTransactionMessageLifetimeUsingBlockhash({blockhash: lifetime.blockhash as Blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight},
        setTransactionMessageFeePayer(address(input.wallet), createTransactionMessage({version: 0}))));
    const transaction = compileTransaction(message);
    const unsignedTransaction = Buffer.from(getTransactionEncoder().encode(transaction)).toString('base64');
    return {kind:'transaction',action:input.action,requestId:input.requestId,wallet:input.wallet,
      cluster:this.options.cluster,programId:this.options.programId,expiresAt:now+30,recordId,
      unsignedTransaction,lastValidBlockHeight:lifetime.lastValidBlockHeight.toString(),
      quoteRef:market.snapshot?.payloadHash??null};
  }
}
export function validatePreparedForWallet(value: PreparedForWallet, input: ActionBody, expected: { cluster: 'localnet' | 'devnet'; programId: string; now: number }): PreparedForWallet {
  if (value.kind !== 'transaction' || value.action !== input.action || value.requestId !== input.requestId || value.wallet !== input.wallet || value.cluster !== expected.cluster || value.programId !== expected.programId) throw new Error('PREPARED_IDENTITY_MISMATCH');
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= expected.now || value.expiresAt > expected.now + 30) throw new Error('PREPARED_EXPIRED');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.unsignedTransaction) || !/^(0|[1-9][0-9]*)$/.test(value.lastValidBlockHeight)) throw new Error('PREPARED_ENCODING_INVALID');
  if (value.quoteRef !== null && !value.quoteRef) throw new Error('PREPARED_QUOTE_REF_INVALID');
  if (!value.recordId || (input.action === 'closeFree' && value.recordId !== input.recordId)) throw new Error('PREPARED_RECORD_ID_MISMATCH');
  return value;
}
/** Reject an adapter that labels unrelated bytes as a Free preparation. */
export async function validateCompiledFree(value: PreparedForWallet, input: ActionBody): Promise<string> {
  const bytes=Buffer.from(value.unsignedTransaction,'base64');
  if (bytes.toString('base64')!==value.unsignedTransaction) throw new Error('PREPARED_ENCODING_INVALID');
  const transaction=getTransactionDecoder().decode(bytes);
  const compiled=getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (compiled.version!==0) throw new Error('PREPARED_MESSAGE_INVALID');
  const message=decompileTransactionMessage(compiled);
  const ix=message.instructions[0];
  if (message.instructions.length!==1 || String(message.feePayer.address)!==input.wallet ||
      Object.keys(transaction.signatures).length!==1 || !(input.wallet in transaction.signatures) ||
      !ix || String(ix.programAddress)!==value.programId || !ix.data || !ix.accounts ||
      !('blockhash' in message.lifetimeConstraint)) throw new Error('PREPARED_MESSAGE_INVALID');
  const expectedDisc=input.action==='openFree'?OPEN_FREE_DISCRIMINATOR:CLOSE_FREE_DISCRIMINATOR;
  if (!Buffer.from(ix.data.subarray(0,8)).equals(Buffer.from(expectedDisc))) throw new Error('PREPARED_ACTION_MISMATCH');
  const addresses=ix.accounts.map(account=>String(account.address));
  if (addresses[0]!==input.marketId) throw new Error('PREPARED_MARKET_MISMATCH');
  if (input.action==='openFree') {
    if (addresses.length!==7 || addresses[5]!==input.wallet) throw new Error('PREPARED_ACCOUNTS_INVALID');
    const recordNonce=getOpenFreeInstructionDataDecoder().decode(ix.data).recordId;
    const [record]=await findRecordPda({market:address(input.marketId),owner:address(input.wallet),recordId:recordNonce},{programAddress:address(value.programId)});
    if (String(record)!==value.recordId || addresses[4]!==value.recordId) throw new Error('PREPARED_RECORD_ID_MISMATCH');
  } else {
    if (addresses.length!==5 || addresses[1]!==input.recordId || addresses[4]!==input.wallet || value.recordId!==input.recordId) throw new Error('PREPARED_ACCOUNTS_INVALID');
  }
  return Buffer.from(transaction.messageBytes).toString('base64');
}
export const notExecutable = (reason: string): Extract<PreparedTransaction, {kind:'notExecutable'}> => ({ kind: 'notExecutable', reason });
