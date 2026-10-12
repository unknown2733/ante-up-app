import { AccountRole, address, getCompiledTransactionMessageDecoder } from '@solana/kit';
import type { AccountMeta, ReadonlyUint8Array, Transaction } from '@solana/kit';
import { ANTE_UP_PROGRAM_ADDRESS, findAdmissionPda, findRecordPda, findWalletMarketPda, findWalletStatsPda, getCloseFreeDiscriminatorBytes, getOpenFreeDiscriminatorBytes, parseCloseFreeInstruction, parseOpenFreeInstruction } from '@ante-up/chain-client';
import type { ProgramInstructionVerifier } from './transactionBoundary';

function sameBytes(a: ReadonlyUint8Array, b: ReadonlyUint8Array) { return a.length === b.length && a.every((byte, index) => byte === b[index]); }
function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(`Free instruction mismatch: ${message}`); }

/** Decode only free open/close instructions from B's generated Anchor client. */
export const verifyFreeInstruction: ProgramInstructionVerifier = async (transaction: Transaction, intent, wallet) => {
  expect(intent.programId === ANTE_UP_PROGRAM_ADDRESS, 'unexpected program ID');
  expect(intent.action === 'openFree' || intent.action === 'closeFree', 'unsupported action');
  const program = address(intent.programId);
  const market = address(intent.marketAddress);
  const record = address(intent.recordId);
  const owner = address(wallet.address);
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  expect(message.version === 'legacy' || message.version === 0, 'unsupported version');
  expect(message.header.numSignerAccounts === 1, 'unexpected signer count');
  const freeInstructions = message.instructions.filter((instruction) => message.staticAccounts[instruction.programAddressIndex] === program);
  expect(freeInstructions.length === 1, 'expected one free instruction');
  const compiled = freeInstructions[0];
  const indices = compiled.accountIndices ?? [];
  expect(indices.length === (intent.action === 'openFree' ? 7 : 5), 'account count');
  expect(indices.every((index) => index < message.staticAccounts.length), 'lookup account unsupported');
  const signerCount = message.header.numSignerAccounts;
  const readonlySignerStart = signerCount - message.header.numReadonlySignerAccounts;
  const readonlyNonSignerStart = message.staticAccounts.length - message.header.numReadonlyNonSignerAccounts;
  const accounts: AccountMeta[] = indices.map((index) => ({
    address: message.staticAccounts[index],
    role: index < signerCount
      ? index >= readonlySignerStart ? AccountRole.READONLY_SIGNER : AccountRole.WRITABLE_SIGNER
      : index >= readonlyNonSignerStart ? AccountRole.READONLY : AccountRole.WRITABLE,
  }));
  const data = compiled.data ?? new Uint8Array();
  const instruction = { programAddress: program, accounts, data };
  const [walletStats] = await findWalletStatsPda({ owner }, { programAddress: program });
  const [walletMarket] = await findWalletMarketPda({ owner, market }, { programAddress: program });
  const signer = (meta: AccountMeta) => meta.role === AccountRole.READONLY_SIGNER || meta.role === AccountRole.WRITABLE_SIGNER;
  const writable = (meta: AccountMeta) => meta.role === AccountRole.WRITABLE || meta.role === AccountRole.WRITABLE_SIGNER;
  if (intent.action === 'openFree') {
    expect(data.length === 16 && sameBytes(data.slice(0, 8), getOpenFreeDiscriminatorBytes()), 'open discriminator');
    const parsed = parseOpenFreeInstruction(instruction);
    const [admission] = await findAdmissionPda({ programAddress: program });
    const [derivedRecord] = await findRecordPda({ market, owner, recordId: parsed.data.recordId }, { programAddress: program });
    expect(parsed.accounts.market.address === market, 'market');
    expect(parsed.accounts.admission.address === admission && writable(parsed.accounts.admission), 'admission PDA');
    expect(parsed.accounts.walletStats.address === walletStats && writable(parsed.accounts.walletStats), 'wallet stats PDA');
    expect(parsed.accounts.walletMarket.address === walletMarket && writable(parsed.accounts.walletMarket), 'wallet market PDA');
    expect(parsed.accounts.record.address === record && record === derivedRecord && writable(parsed.accounts.record), 'record PDA');
    expect(parsed.accounts.owner.address === owner && signer(parsed.accounts.owner), 'owner signer');
    expect(parsed.accounts.systemProgram.address === '11111111111111111111111111111111', 'system program');
  } else {
    expect(data.length === 8 && sameBytes(data, getCloseFreeDiscriminatorBytes()), 'close discriminator');
    const parsed = parseCloseFreeInstruction(instruction);
    expect(parsed.accounts.market.address === market, 'market');
    expect(parsed.accounts.record.address === record && writable(parsed.accounts.record), 'record PDA');
    expect(parsed.accounts.walletStats.address === walletStats && writable(parsed.accounts.walletStats), 'wallet stats PDA');
    expect(parsed.accounts.walletMarket.address === walletMarket && writable(parsed.accounts.walletMarket), 'wallet market PDA');
    expect(parsed.accounts.owner.address === owner && signer(parsed.accounts.owner), 'owner signer');
  }
};
