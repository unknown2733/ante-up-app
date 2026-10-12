import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createNoopSigner, createTransactionMessage, getAddressEncoder, getCompiledTransactionMessageEncoder, getProgramDerivedAddress, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from '@solana/kit';
import { ANTE_UP_PROGRAM_ADDRESS, findFinanceConfigPda, findMarketPda, findReceiptPda, getClaimFaucetInstructionAsync, getClaimFaucetInstructionDataEncoder, getFinanceConfigEncoder, getRegisterFinancialMarketInstructionAsync } from '@ante-up/chain-client';

const server = await createServer({ optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
after(() => server.close());
const { createFinancialInstructionVerifier } = await server.ssrLoadModule('/src/financialInstructionVerifier.ts');
const owner = address('Vote111111111111111111111111111111111111111');
const paymentMint = address('Stake11111111111111111111111111111111111111');
const treasury = address('BPFLoaderUpgradeab1e11111111111111111111111');
const token = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const system = address('11111111111111111111111111111111');
const associated = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const [config] = await findFinanceConfigPda();
const [receipt] = await findReceiptPda({ wallet: owner });
const [recipient] = await getProgramDerivedAddress({ programAddress: associated, seeds: [getAddressEncoder().encode(owner), getAddressEncoder().encode(token), getAddressEncoder().encode(paymentMint)] });
const wallet = { address: owner, cluster: 'devnet', supportedTransactionVersions: new Set([0]), signer: {} };
const now = 1_700_000_000;
const quote = { intent: { requestId: '00000000-0000-4000-8000-000000000001', wallet: owner, action: 'faucet', marketId: null }, chain: { address: config }, minReceiveAtoms: '1000000000', maxPaymentAtoms: '0', stateVersion: '0' };
const prepared = { kind: 'transaction', programId: ANTE_UP_PROGRAM_ADDRESS, wallet: owner, cluster: 'devnet', quote, expiresAt: now + 20 };
const transport = { async getFinalizedAccount(addressValue) {
  if (addressValue === recipient) return { exists: false, address: recipient };
  assert.equal(addressValue, config);
  return { exists: true, address: config, programAddress: ANTE_UP_PROGRAM_ADDRESS, executable: false, lamports: 1n, data: getFinanceConfigEncoder().encode({ admin: owner, paymentMint, protocolTreasury: treasury, faucetAmount: 1000000000n, faucetCooldown: 86400n, faucetTotalLimit: 10000000000n, faucetMinted: 0n, supportedMarkets: 0, supportSpent: 0n }) };
} };

function transaction({ recipientAddress = recipient, extra = false, ataCreate = false } = {}) {
  const staticAccounts = [owner, config, paymentMint, recipientAddress, receipt, token, system, ANTE_UP_PROGRAM_ADDRESS, associated];
  const instructions = [];
  if (ataCreate) instructions.push({ programAddressIndex: 8, accountIndices: [0, 3, 0, 2, 6, 5], data: new Uint8Array([1]) });
  instructions.push({ programAddressIndex: 7, accountIndices: [1, 2, 3, 4, 0, 5, 6], data: getClaimFaucetInstructionDataEncoder().encode({}) });
  if (extra) instructions.push({ programAddressIndex: 6, accountIndices: [0, 3], data: new Uint8Array([1]) });
  const messageBytes = getCompiledTransactionMessageEncoder().encode({ version: 0, header: { numSignerAccounts: 1, numReadonlySignerAccounts: 0, numReadonlyNonSignerAccounts: 4 }, staticAccounts, lifetimeToken: system, instructions, addressTableLookups: [] });
  return { messageBytes, signatures: { [owner]: null } };
}

test('generated faucet instruction binds finalized amount, recipient ATA, and exact accounts', async () => {
  const verify = createFinancialInstructionVerifier(transport, () => now);
  await verify(transaction(), prepared, wallet);
  await verify(transaction({ ataCreate: true }), prepared, wallet);
  await assert.rejects(verify(transaction({ recipientAddress: treasury }), prepared, wallet), /accounts or permissions/);
  await assert.rejects(verify(transaction({ extra: true }), prepared, wallet), /end with exactly one action/);
  await assert.rejects(verify(transaction(), { ...prepared, quote: { ...quote, minReceiveAtoms: '1' } }, wallet), /Faucet amount/);
});

test('accepts the generated Kit faucet builder with idempotent ATA setup', async () => {
  const ataSetup = { programAddress: associated, data: Uint8Array.of(1), accounts: [
    { address: owner, role: AccountRole.WRITABLE_SIGNER }, { address: recipient, role: AccountRole.WRITABLE },
    { address: owner, role: AccountRole.READONLY }, { address: paymentMint, role: AccountRole.READONLY },
    { address: system, role: AccountRole.READONLY }, { address: token, role: AccountRole.READONLY },
  ] };
  const claim = await getClaimFaucetInstructionAsync({ paymentMint, recipientPayment: recipient, receipt, wallet: createNoopSigner(owner) });
  const message = appendTransactionMessageInstructions([ataSetup, claim], setTransactionMessageLifetimeUsingBlockhash({ blockhash: system, lastValidBlockHeight: 42n }, setTransactionMessageFeePayer(owner, createTransactionMessage({ version: 0 }))));
  await createFinancialInstructionVerifier(transport, () => now)(compileTransaction(message), prepared, wallet);
});

test('registration verifier binds normalized keyword, query hash, fee and derived market', async () => {
  const hash = (value) => new Uint8Array(createHash('sha256').update(value, 'utf8').digest());
  const seed = hash('ante-up-market-v1:solana');
  const queryHash = hash('(#solana OR "solana") lang:en -is:retweet');
  const [market] = await findMarketPda({ marketId: seed });
  const registration = { ...quote, intent: { ...quote.intent, action: 'registerMarket', keyword: 'solana', aliases: ['#solana'] }, chain: { address: market }, maxPaymentAtoms: '10000000', grossAtoms: '10000000' };
  const instruction = await getRegisterFinancialMarketInstructionAsync({ paymentMint, registrantPayment: recipient, protocolTreasury: treasury, registrant: createNoopSigner(owner), marketId: seed, queryHash, queryVersion: 1n });
  const message = appendTransactionMessageInstructions([instruction], setTransactionMessageLifetimeUsingBlockhash({ blockhash: system, lastValidBlockHeight: 42n }, setTransactionMessageFeePayer(owner, createTransactionMessage({ version: 0 }))));
  const tx = compileTransaction(message);
  await createFinancialInstructionVerifier(transport, () => now)(tx, { ...prepared, quote: registration }, wallet);
  await assert.rejects(createFinancialInstructionVerifier(transport, () => now)(tx, { ...prepared, quote: { ...registration, intent: { ...registration.intent, aliases: [] } } }, wallet), /query, or version changed/);
});
