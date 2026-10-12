import { getBase58Decoder, getBase64Decoder, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import type { Transaction, TransactionSendingSigner } from '@solana/kit';
import type { Operation, PreparedTransaction } from '../../../contracts/types';
import { verifyFreeInstruction } from './freeInstructionVerifier';
import { isWalletRejection } from './walletErrors';

export type Cluster = 'localnet' | 'devnet';
export interface WalletContext {
  address: string;
  cluster: Cluster;
  supportedTransactionVersions: ReadonlySet<number | 'legacy'>;
  signer: TransactionSendingSigner | null;
}
export type ExecutablePrepare = Extract<PreparedTransaction, { kind: 'transaction' }> & {
  wallet: string; cluster: Cluster; programId: string; expiresAt: number; recordId: string;
};
export type TransactionIntent = Pick<ExecutablePrepare, 'action' | 'requestId' | 'recordId' | 'programId'> & { marketAddress: string };
/** Implemented for the free-chip instructions using B's generated program client. */
export type ProgramInstructionVerifier = (transaction: Transaction, intent: TransactionIntent, wallet: WalletContext) => Promise<void>;
export type SendResult =
  | { state: 'AWAITING_SIGNATURE'; reason: string }
  | { state: 'SUBMITTED' | 'CONFIRMED' | 'FINALIZED' | 'FAILED'; signature: string; reason?: string }
  | { state: 'UNKNOWN'; signature: string | null; reason: string };

const walletChanged = (expected: WalletContext, current: WalletContext | null) =>
  !current || current.address !== expected.address || current.cluster !== expected.cluster || current.signer !== expected.signer;

/** A prepared payload is never trusted merely because it came from the API. */
export function inspectPreparedTransaction(prepared: ExecutablePrepare, intent: TransactionIntent, wallet: WalletContext, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (prepared.kind !== 'transaction' || prepared.wallet !== wallet.address || prepared.cluster !== wallet.cluster) throw new Error('Prepared wallet or cluster changed.');
  if (prepared.action !== intent.action || prepared.requestId !== intent.requestId || prepared.recordId !== intent.recordId || prepared.programId !== intent.programId) throw new Error('Prepared transaction differs from requested action.');
  if (!Number.isSafeInteger(prepared.expiresAt) || nowSeconds >= prepared.expiresAt) throw new Error('Prepared transaction expired.');
  if (!prepared.requestId || !prepared.programId || !prepared.action || !prepared.unsignedTransaction) throw new Error('Prepared transaction metadata is incomplete.');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(prepared.unsignedTransaction)) throw new Error('Prepared transaction is not base64.');
  const bytes = getBase64Encoder().encode(prepared.unsignedTransaction);
  if (getBase64Decoder().decode(bytes) !== prepared.unsignedTransaction) throw new Error('Prepared transaction is not canonical base64.');
  const transaction = getTransactionDecoder().decode(bytes);
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (message.version !== 'legacy' && message.version !== 0) throw new Error('Unsupported prepared transaction version.');
  if (!wallet.supportedTransactionVersions.has(message.version)) throw new Error('Wallet does not support this transaction version.');
  if (message.staticAccounts[0] !== wallet.address) throw new Error('Prepared transaction fee payer differs from wallet.');
  if (!Object.hasOwn(transaction.signatures, wallet.address) || Object.values(transaction.signatures).some((signature) => signature !== null)) throw new Error('Prepared transaction must be unsigned and include wallet signer.');
  if (!message.instructions.length || !message.instructions.some((instruction) => message.staticAccounts[instruction.programAddressIndex] === prepared.programId)) throw new Error('Prepared transaction omits the expected program.');
  for (const instruction of message.instructions) {
    const program = message.staticAccounts[instruction.programAddressIndex];
    if (program !== prepared.programId) throw new Error('Prepared transaction invokes an unexpected program.');
  }
  return transaction;
}

/** Send exactly once; only an operation read may establish chain finality. */
export async function sendPreparedTransaction(input: {
  prepared: ExecutablePrepare;
  intent: TransactionIntent;
  wallet: WalletContext;
  getWallet: () => WalletContext | null;
  reportSubmission: (requestId: string, signature: string) => Promise<Operation>;
  readOperation: (requestId: string) => Promise<Operation | null>;
  onProgress?: (state: 'SUBMITTED' | 'CONFIRMED') => void;
  signal?: AbortSignal;
  nowSeconds?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  attempts?: number;
}): Promise<SendResult> {
  const { prepared, intent, wallet, getWallet, readOperation } = input;
  const now = input.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  if (walletChanged(wallet, getWallet()) || input.signal?.aborted) return { state: 'AWAITING_SIGNATURE', reason: 'Wallet or cluster changed.' };
  if (!wallet.signer || !('signAndSendTransactions' in wallet.signer)) return { state: 'AWAITING_SIGNATURE', reason: 'Wallet cannot sign and send transactions.' };
  let transaction;
  try {
    transaction = inspectPreparedTransaction(prepared, intent, wallet, now());
    await verifyFreeInstruction(transaction, intent, wallet);
  }
  catch (error) { return { state: 'AWAITING_SIGNATURE', reason: error instanceof Error ? error.message : 'Invalid preparation.' }; }
  if (walletChanged(wallet, getWallet()) || input.signal?.aborted || now() >= prepared.expiresAt) return { state: 'AWAITING_SIGNATURE', reason: 'Wallet changed or preparation expired.' };
  let signature: string;
  try {
    const signatures = await wallet.signer.signAndSendTransactions([transaction]);
    if (signatures.length !== 1 || signatures[0].length !== 64) throw new Error('Wallet returned an invalid signature.');
    signature = getBase58Decoder().decode(signatures[0]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Wallet did not return a signature.';
    // Wallet Standard's explicit user rejection is safe to treat as unsigned.
    // Other errors may happen after broadcast, so their submission status is unknown.
    if (isWalletRejection(error)) return { state: 'AWAITING_SIGNATURE', reason: 'You cancelled signing in the wallet. Press the action button to try again.' };
    return { state: 'UNKNOWN', signature: null, reason };
  }
  if (walletChanged(wallet, getWallet()) || input.signal?.aborted) return { state: 'UNKNOWN', signature, reason: 'Wallet or cluster changed after submission.' };
  const sameOperation = (operation: Operation | null): operation is Operation =>
    !!operation && operation.wallet === wallet.address && operation.requestId === prepared.requestId && operation.action === intent.action && operation.signature === signature;
  try {
    const submitted = await input.reportSubmission(prepared.requestId, signature);
    if (walletChanged(wallet, getWallet()) || input.signal?.aborted) return { state: 'UNKNOWN', signature, reason: 'Wallet or cluster changed during submission reporting.' };
    if (!sameOperation(submitted)) return { state: 'UNKNOWN', signature, reason: 'Submission identity did not match.' };
    if (submitted.state === 'FAILED' || submitted.state === 'FINALIZED') return { state: submitted.state, signature, reason: submitted.error?.message };
    if (submitted.state === 'SUBMITTED' || submitted.state === 'CONFIRMED') input.onProgress?.(submitted.state);
  } catch {
    return { state: 'UNKNOWN', signature, reason: 'Submission report was not acknowledged.' };
  }
  const wait = input.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; attempt < (input.attempts ?? 8); attempt++) {
    if (walletChanged(wallet, getWallet()) || input.signal?.aborted) return { state: 'UNKNOWN', signature, reason: 'Wallet or cluster changed during finality check.' };
    try {
      const operation = await readOperation(prepared.requestId);
      if (walletChanged(wallet, getWallet()) || input.signal?.aborted) return { state: 'UNKNOWN', signature, reason: 'Wallet or cluster changed during finality check.' };
      if (sameOperation(operation)) {
        if (operation.state === 'FINALIZED' || operation.state === 'FAILED') return { state: operation.state, signature, reason: operation.error?.message };
        if (operation.state === 'SUBMITTED' || operation.state === 'CONFIRMED') input.onProgress?.(operation.state);
        if (attempt === (input.attempts ?? 8) - 1 && operation.state === 'CONFIRMED') return { state: 'CONFIRMED', signature };
      }
    } catch { /* A transient status read cannot prove success or failure. */ }
    if (attempt < (input.attempts ?? 8) - 1) await wait(1200);
  }
  return { state: 'UNKNOWN', signature, reason: 'Finality was not established.' };
}
