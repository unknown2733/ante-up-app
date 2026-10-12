/** Executable free-path boundary. All RPC and signing effects are injected. */
import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  fetchEncodedAccount,
  getBase64Decoder,
  getBase64Encoder,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  getU64Encoder,
  isFullySignedTransaction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionWithSigners,
  type Address,
  type EncodedAccount,
  type Instruction,
  type MaybeEncodedAccount,
  type ReadonlyUint8Array,
  type Transaction,
  type TransactionPartialSigner,
  type TransactionWithLifetime,
} from '@solana/kit';
import {
  ANTE_UP_PROGRAM_ADDRESS,
  decodeAdmission,
  decodeConfig,
  decodeFinanceConfig,
  decodeFinanceMarket,
  decodeFreeRecord,
  decodeMarket,
  decodeSnapshot,
  findAdmissionPda,
  findConfigPda,
  findFinanceConfigPda,
  findFinanceMarketPda,
  findMarketPda,
  findRecordPda,
  findSnapshotPda,
  getAdmissionDiscriminatorBytes,
  getCloseFreeInstructionAsync,
  getCompleteProofInstructionAsync,
  getConfigDiscriminatorBytes,
  getFinanceConfigDiscriminatorBytes,
  getFinanceMarketDiscriminatorBytes,
  getFreeRecordDiscriminatorBytes,
  getInitializeInstructionAsync,
  getMarketDiscriminatorBytes,
  getOpenFreeInstructionAsync,
  getPublishSnapshotInstructionAsync,
  getRegisterMarketInstructionAsync,
  getSnapshotDiscriminatorBytes,
  type PublishSnapshotInstructionDataArgs,
} from './generated/index.js';

export type ProgramAddress = Address;
export const DEFAULT_PROGRAM_ADDRESS = ANTE_UP_PROGRAM_ADDRESS;

export interface ChainTransport {
  /** Must fetch with finalized commitment. Missing accounts are represented by exists:false. */
  getFinalizedAccount(account: Address): Promise<MaybeEncodedAccount>;
  getLatestBlockhash(): Promise<{blockhash: string; lastValidBlockHeight: bigint}>;
  isBlockhashValid(blockhash: string): Promise<boolean>;
  sendTransaction(wireBase64: string): Promise<string>;
  getSignatureStatus(signature: string): Promise<{confirmationStatus: string | null; err: unknown} | null>;
  getBlockHeight(): Promise<bigint>;
}

/** Kit RPC adapter. An endpoint is only a transport; it does not authorize deployment. */
export function createKitChainTransport(endpoint: string): ChainTransport {
  if (!/^https?:\/\//.test(endpoint)) throw new Error('RPC_ENDPOINT_REQUIRED');
  const rpc = createSolanaRpc(endpoint);
  return {
    getFinalizedAccount: account => fetchEncodedAccount(rpc, account, {commitment: 'finalized'}),
    async getLatestBlockhash() {
      const {value} = await rpc.getLatestBlockhash({commitment: 'finalized'}).send();
      return {blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight};
    },
    async isBlockhashValid(value) {
      const result = await rpc.isBlockhashValid(blockhash(value), {commitment: 'finalized'}).send();
      return result.value;
    },
    async sendTransaction(wireBase64) {
      return rpc.sendTransaction(wireBase64 as Parameters<typeof rpc.sendTransaction>[0], {
        encoding: 'base64', preflightCommitment: 'confirmed', skipPreflight: false,
      }).send();
    },
    async getSignatureStatus(signature) {
      const {value} = await rpc.getSignatureStatuses([signature as Parameters<typeof rpc.getSignatureStatuses>[0][number]],
        {searchTransactionHistory: true}).send();
      const status = value[0];
      return status ? {confirmationStatus: status.confirmationStatus, err: status.err} : null;
    },
    getBlockHeight: () => rpc.getBlockHeight({commitment: 'finalized'}).send(),
  };
}

async function ownedAccount(transport: ChainTransport, account: Address, programAddress: Address,
  discriminator: ReadonlyUint8Array): Promise<EncodedAccount> {
  const result = await transport.getFinalizedAccount(account);
  if (!result.exists || result.address !== account) throw new Error('ACCOUNT_MISSING_OR_ADDRESS_MISMATCH');
  if (result.programAddress !== programAddress || result.executable) throw new Error('ACCOUNT_OWNER_MISMATCH');
  if (!equalBytes(result.data.slice(0, discriminator.length), discriminator)) throw new Error('ACCOUNT_DISCRIMINATOR_MISMATCH');
  return result;
}

function equalBytes(a: ReadonlyUint8Array, b: ReadonlyUint8Array) {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Every read checks finalized RPC data, program ownership, derived address and stored identity. */
export async function readFinalizedConfig(transport: ChainTransport, programAddress: Address = DEFAULT_PROGRAM_ADDRESS) {
  const [pda] = await findConfigPda({programAddress});
  return decodeConfig(await ownedAccount(transport, pda, programAddress, getConfigDiscriminatorBytes()));
}
export async function readFinalizedAdmission(transport: ChainTransport, programAddress: Address = DEFAULT_PROGRAM_ADDRESS) {
  const [pda] = await findAdmissionPda({programAddress});
  return decodeAdmission(await ownedAccount(transport, pda, programAddress, getAdmissionDiscriminatorBytes()));
}
export async function readFinalizedFinanceConfig(transport: ChainTransport, programAddress: Address = DEFAULT_PROGRAM_ADDRESS) {
  const [pda] = await findFinanceConfigPda({programAddress});
  return decodeFinanceConfig(await ownedAccount(transport, pda, programAddress, getFinanceConfigDiscriminatorBytes()));
}
export async function readFinalizedFinanceMarket(transport: ChainTransport, marketAddress: Address,
  programAddress: Address = DEFAULT_PROGRAM_ADDRESS) {
  const [pda] = await findFinanceMarketPda({market: marketAddress}, {programAddress});
  const result = decodeFinanceMarket(await ownedAccount(transport, pda, programAddress, getFinanceMarketDiscriminatorBytes()));
  if (result.data.market !== marketAddress) throw new Error('FINANCE_MARKET_IDENTITY_MISMATCH');
  return result;
}
/** Settlement is keyed by the FinanceMarket.currentCycle, including a same-week reopen. */
export async function findSettlementPda(marketAddress: Address, cycle: bigint,
  programAddress: Address = DEFAULT_PROGRAM_ADDRESS) {
  if (cycle < 0n || cycle > 0xffff_ffff_ffff_ffffn) throw new Error('SETTLEMENT_CYCLE_RANGE');
  return getProgramDerivedAddress({programAddress, seeds: [
    new TextEncoder().encode('settlement'), getAddressEncoder().encode(marketAddress),
    getU64Encoder().encode(cycle),
  ]});
}
export async function readFinalizedMarket(transport: ChainTransport, marketId: Uint8Array, programAddress: Address = DEFAULT_PROGRAM_ADDRESS) {
  if (marketId.length !== 32) throw new Error('MARKET_ID_LENGTH');
  const [pda] = await findMarketPda({marketId}, {programAddress});
  const result = decodeMarket(await ownedAccount(transport, pda, programAddress, getMarketDiscriminatorBytes()));
  if (!equalBytes(result.data.id, marketId)) throw new Error('MARKET_ID_MISMATCH');
  return result;
}
export async function readFinalizedSnapshot(transport: ChainTransport, marketAddress: Address, sequence: bigint,
  programAddress: Address = DEFAULT_PROGRAM_ADDRESS) {
  const [pda] = await findSnapshotPda({market: marketAddress, sequence}, {programAddress});
  const result = decodeSnapshot(await ownedAccount(transport, pda, programAddress, getSnapshotDiscriminatorBytes()));
  if (result.data.market !== marketAddress || result.data.sequence !== sequence) throw new Error('SNAPSHOT_IDENTITY_MISMATCH');
  return result;
}
export async function readFinalizedFreeRecord(transport: ChainTransport, marketAddress: Address, owner: Address,
  recordId: bigint, programAddress: Address = DEFAULT_PROGRAM_ADDRESS) {
  const [pda] = await findRecordPda({market: marketAddress, owner, recordId}, {programAddress});
  const result = decodeFreeRecord(await ownedAccount(transport, pda, programAddress, getFreeRecordDiscriminatorBytes()));
  if (result.data.market !== marketAddress || result.data.owner !== owner || result.data.id !== recordId) {
    throw new Error('RECORD_IDENTITY_MISMATCH');
  }
  return result;
}

// The generated async builders derive their optional PDAs. Noop signers mark
// required signer metas in an unsigned transaction; they never sign anything.
export async function createInitializeInstruction(input: {
  admin: Address; publisher: Address; proofAuthority: Address; formulaVersion: Uint8Array;
}, programAddress: Address = DEFAULT_PROGRAM_ADDRESS) {
  return getInitializeInstructionAsync({...input, admin: createNoopSigner(input.admin)}, {programAddress});
}
export async function createRegisterMarketInstruction(input: {
  admin: Address; marketId: Uint8Array; queryHash: Uint8Array; queryVersion: bigint;
}, programAddress: Address = DEFAULT_PROGRAM_ADDRESS) {
  if (input.marketId.length !== 32) throw new Error('MARKET_ID_LENGTH');
  const [marketAddress] = await findMarketPda({marketId: input.marketId}, {programAddress});
  return {marketAddress, instruction: await getRegisterMarketInstructionAsync({
    ...input, admin: createNoopSigner(input.admin),
  }, {programAddress})};
}
export async function createPublishSnapshotInstruction(input: {
  marketAddress: Address; publisher: Address;
} & PublishSnapshotInstructionDataArgs, programAddress: Address = DEFAULT_PROGRAM_ADDRESS) {
  const {marketAddress, publisher, ...data} = input;
  const [snapshotAddress] = await findSnapshotPda({market: marketAddress, sequence: input.sequence}, {programAddress});
  return {snapshotAddress, instruction: await getPublishSnapshotInstructionAsync({
    ...data, market: marketAddress, publisher: createNoopSigner(publisher),
  }, {programAddress})};
}
export async function createOpenFreeInstruction(input: {
  marketAddress: Address; owner: Address; recordId: bigint;
}, programAddress: Address = DEFAULT_PROGRAM_ADDRESS) {
  const [recordAddress] = await findRecordPda({market: input.marketAddress, owner: input.owner, recordId: input.recordId}, {programAddress});
  return {recordAddress, instruction: await getOpenFreeInstructionAsync({
    market: input.marketAddress, owner: createNoopSigner(input.owner), recordId: input.recordId,
  }, {programAddress})};
}
export async function createCloseFreeInstruction(input: {
  marketAddress: Address; owner: Address; recordId: bigint;
}, programAddress: Address = DEFAULT_PROGRAM_ADDRESS) {
  const [recordAddress] = await findRecordPda({market: input.marketAddress, owner: input.owner, recordId: input.recordId}, {programAddress});
  return {recordAddress, instruction: await getCloseFreeInstructionAsync({
    market: input.marketAddress, record: recordAddress, owner: createNoopSigner(input.owner),
  }, {programAddress})};
}
export async function createCompleteProofInstruction(input: {
  marketAddress: Address; owner: Address; recordId: bigint; proofAuthority: Address; proofHash: Uint8Array;
}, programAddress: Address = DEFAULT_PROGRAM_ADDRESS) {
  const [recordAddress] = await findRecordPda({market: input.marketAddress, owner: input.owner, recordId: input.recordId}, {programAddress});
  return {recordAddress, instruction: await getCompleteProofInstructionAsync({
    record: recordAddress, proofAuthority: createNoopSigner(input.proofAuthority), proofHash: input.proofHash,
  }, {programAddress})};
}

export interface PreparedChainTransaction {
  unsignedTransaction: string; // canonical base64 wire transaction
  feePayer: Address;
  programAddress: Address;
  blockhash: string;
  lastValidBlockHeight: string;
}

function compileExpectedInstruction(instruction: Instruction, feePayer: Address, blockhashValue: string,
  lastValidBlockHeight: bigint) {
  const message = appendTransactionMessageInstruction(instruction,
    setTransactionMessageLifetimeUsingBlockhash({blockhash: blockhash(blockhashValue), lastValidBlockHeight},
      setTransactionMessageFeePayer(feePayer, createTransactionMessage({version: 0}))));
  return compileTransaction(message);
}

/** Compiles one generated instruction with a recent blockhash; no signature is produced. */
export async function prepareUnsignedTransaction(input: {
  transport: ChainTransport; instruction: Instruction; feePayer: Address; programAddress?: Address;
}): Promise<PreparedChainTransaction> {
  const programAddress = input.programAddress ?? DEFAULT_PROGRAM_ADDRESS;
  if (input.instruction.programAddress !== programAddress) throw new Error('INSTRUCTION_PROGRAM_MISMATCH');
  const lifetime = await input.transport.getLatestBlockhash();
  if (lifetime.lastValidBlockHeight < 0n) throw new Error('INVALID_BLOCK_HEIGHT');
  const transaction = compileExpectedInstruction(input.instruction, input.feePayer,
    lifetime.blockhash, lifetime.lastValidBlockHeight);
  return {
    unsignedTransaction: getBase64Decoder().decode(getTransactionEncoder().encode(transaction)),
    feePayer: input.feePayer, programAddress, blockhash: lifetime.blockhash,
    lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(),
  };
}

export type SignPreparedTransaction = (transaction: Transaction) => Promise<Transaction>;
/** Adapt a Kit partial signer without letting preparation access its secret. */
export function withKitSigner(signer: TransactionPartialSigner): SignPreparedTransaction {
  return transaction => signTransactionWithSigners([signer], transaction as Transaction & TransactionWithLifetime);
}

export type FinalityResult =
  | {state: 'FINALIZED'; signature: string}
  | {state: 'FAILED'; signature: string; reason: string}
  | {state: 'UNKNOWN'; signature: string | null; reason: string};

/** Submit once, then require finalized status with no transaction error. */
export async function submitAndConfirmFinalized(input: {
  transport: ChainTransport; prepared: PreparedChainTransaction; expectedInstruction: Instruction;
  sign: SignPreparedTransaction;
  attempts?: number; wait?: (milliseconds: number) => Promise<void>;
}): Promise<FinalityResult> {
  const {transport, prepared} = input;
  const attempts = input.attempts ?? 8;
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error('INVALID_FINALITY_ATTEMPTS');
  const unsignedBytes = getBase64Encoder().encode(prepared.unsignedTransaction);
  if (getBase64Decoder().decode(unsignedBytes) !== prepared.unsignedTransaction) throw new Error('NONCANONICAL_TRANSACTION_BASE64');
  const unsigned = getTransactionDecoder().decode(unsignedBytes);
  const message = getCompiledTransactionMessageDecoder().decode(unsigned.messageBytes);
  if (input.expectedInstruction.programAddress !== prepared.programAddress) throw new Error('EXPECTED_PROGRAM_MISMATCH');
  const expected = compileExpectedInstruction(input.expectedInstruction, prepared.feePayer,
    prepared.blockhash, BigInt(prepared.lastValidBlockHeight));
  if (message.version !== 0 || message.staticAccounts[0] !== prepared.feePayer ||
      message.lifetimeToken !== prepared.blockhash || message.instructions.length !== 1 ||
      message.staticAccounts[message.instructions[0].programAddressIndex] !== prepared.programAddress ||
      !equalBytes(unsigned.messageBytes, expected.messageBytes) ||
      !Object.hasOwn(unsigned.signatures, prepared.feePayer) ||
      Object.values(unsigned.signatures).some(value => value !== null)) throw new Error('PREPARED_TRANSACTION_IDENTITY_MISMATCH');
  const lastValid = BigInt(prepared.lastValidBlockHeight);
  if (await transport.getBlockHeight() > lastValid || !await transport.isBlockhashValid(prepared.blockhash)) {
    throw new Error('BLOCKHASH_EXPIRED_BEFORE_SIGNING');
  }
  const signed = await input.sign(unsigned);
  if (!equalBytes(signed.messageBytes, unsigned.messageBytes) ||
      Object.keys(signed.signatures).sort().join(',') !== Object.keys(unsigned.signatures).sort().join(',') ||
      !isFullySignedTransaction(signed)) throw new Error('SIGNED_TRANSACTION_IDENTITY_MISMATCH');
  const signature = getSignatureFromTransaction(signed);
  const wire = getBase64Decoder().decode(getTransactionEncoder().encode(signed));
  let returned: string;
  try { returned = await transport.sendTransaction(wire); }
  catch { return {state: 'UNKNOWN', signature, reason: 'SUBMISSION_UNCERTAIN'}; }
  if (returned !== signature) return {state: 'UNKNOWN', signature, reason: 'SUBMITTED_SIGNATURE_MISMATCH'};
  const wait = input.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (let i = 0; i < attempts; i++) {
    try {
      const status = await transport.getSignatureStatus(signature);
      if (status?.err != null) return {state: 'FAILED', signature, reason: 'TRANSACTION_FAILED'};
      if (status?.confirmationStatus === 'finalized') return {state: 'FINALIZED', signature};
    } catch { /* A status read failure cannot establish finality. */ }
    try {
      if (await transport.getBlockHeight() > lastValid) return {state: 'UNKNOWN', signature, reason: 'BLOCKHASH_EXPIRED_WITHOUT_FINALITY'};
    } catch { return {state: 'UNKNOWN', signature, reason: 'FINALITY_HEIGHT_UNAVAILABLE'}; }
    if (i < attempts - 1) await wait(400);
  }
  return {state: 'UNKNOWN', signature, reason: 'FINALITY_NOT_ESTABLISHED'};
}
