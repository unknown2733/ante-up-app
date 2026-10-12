import {
  ANTE_UP_PROGRAM_ADDRESS, MarketPhase, PositionDirection, PositionState, decodeLpHolding, decodeMarket, decodeProClaim, decodeProPosition, findClaimPda, findConfigPda, findCurveInventoryPda, findFinanceConfigPda, findFinanceMarketPda, findHoldingPda, findKeywordMintPda, findMarketPda, findPaymentVaultPda, findPositionPda, findReceiptPda, findVaultInventoryPda,
  getClaimFaucetInstructionDataEncoder, getCurveBuyDiscriminatorBytes, getCurveBuyInstructionDataDecoder, getCurveSellDiscriminatorBytes, getCurveSellInstructionDataDecoder, getRegisterFinancialMarketInstructionDataDecoder, getSpotBuyDiscriminatorBytes, getSpotBuyInstructionDataDecoder, getSpotSellDiscriminatorBytes, getSpotSellInstructionDataDecoder,
  getClaimProInstructionDataEncoder, getCloseProDiscriminatorBytes, getCloseProInstructionDataDecoder, getDepositLpDiscriminatorBytes, getDepositLpInstructionDataDecoder, getLpHoldingDiscriminatorBytes, getMarketDiscriminatorBytes, getOpenProDiscriminatorBytes, getOpenProInstructionDataDecoder, getProClaimDiscriminatorBytes, getProPositionDiscriminatorBytes, getWithdrawLpDiscriminatorBytes, getWithdrawLpInstructionDataDecoder,
  readFinalizedConfig, readFinalizedFinanceConfig, readFinalizedFinanceMarket, readFinalizedSnapshot,
} from '@ante-up/chain-client';
import type { ChainTransport } from '@ante-up/chain-client';
import { address, getAddressEncoder, getBytesEncoder, getCompiledTransactionMessageDecoder, getProgramDerivedAddress, getU64Encoder } from '@solana/kit';
import type { Transaction } from '@solana/kit';
import type { FinancialPrepared } from '../../../contracts/financial';
import type { WalletContext } from './transactionBoundary';

const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const RENT_SYSVAR = address('SysvarRent111111111111111111111111111111111');
type Prepared = Extract<FinancialPrepared, { kind: 'transaction' }>;
type AccountExpectation = { address: string; writable: boolean; signer?: boolean };

const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((value, index) => value === b[index]);
const acct = (value: string, writable = false, signer = false): AccountExpectation => ({ address: value, writable, signer });
async function digest(value: string) { return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))); }
async function positionIdForRequest(requestId: string) { return new DataView((await digest(`ante-up-pro-position-v1:${requestId}`)).buffer).getBigUint64(0, true); }
function normalizedRegistration(keyword: string, aliases: string[]) {
  const phrase = /^[a-z][a-z0-9]*(?: [a-z][a-z0-9]*)*$/;
  const hashtag = /^#[a-z][a-z0-9_]*$/;
  const word = keyword.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!phrase.test(word) || word !== keyword) throw new Error('Registration keyword is not normalized English.');
  const joined = word.replaceAll(' ', '');
  const alternate = [...new Set(aliases.map((value) => value.trim().toLowerCase().replace(/\s+/g, ' ')))];
  if (alternate.length > 7 || alternate.some((value) => !((phrase.test(value) || hashtag.test(value)) && (value === word || value === joined || value === `#${joined}`)))) throw new Error('Registration aliases changed.');
  const expressions = [...new Set([word, ...alternate])].sort();
  const query = `(${expressions.map((value) => value.startsWith('#') ? value : `"${value}"`).join(' OR ')}) lang:en -is:retweet`;
  if (query.length > 512) throw new Error('Registration query is too long.');
  return { word, query };
}
async function ata(owner: string, mint: string) {
  const [pda] = await getProgramDerivedAddress({ programAddress: ATA_PROGRAM, seeds: [getAddressEncoder().encode(address(owner)), getAddressEncoder().encode(TOKEN_PROGRAM), getAddressEncoder().encode(address(mint))] });
  return pda;
}
async function settlementPda(market: string, cycle: bigint) {
  return (await getProgramDerivedAddress({ programAddress: ANTE_UP_PROGRAM_ADDRESS, seeds: [getBytesEncoder().encode(new TextEncoder().encode('settlement')), getAddressEncoder().encode(address(market)), getU64Encoder().encode(cycle)] }))[0];
}

/** The browser validates every compiled instruction before Wallet Standard can receive it. */
export function createFinancialInstructionVerifier(transport: ChainTransport, nowSeconds = () => Math.floor(Date.now() / 1000)) {
  return async (transaction: Transaction, prepared: Prepared, wallet: WalletContext): Promise<void> => {
    const intent = prepared.quote.intent;
    if (prepared.programId !== ANTE_UP_PROGRAM_ADDRESS || prepared.wallet !== wallet.address || intent.wallet !== wallet.address || prepared.cluster !== wallet.cluster) throw new Error('Financial signer, cluster, or program differs from the quote.');
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    if (message.version !== 0 || ('addressTableLookups' in message && message.addressTableLookups?.length)) throw new Error('Financial transaction must use a static version-0 message.');
    if (Object.keys(transaction.signatures).length !== 1 || !Object.hasOwn(transaction.signatures, wallet.address) || Object.values(transaction.signatures)[0] !== null) throw new Error('Financial transaction has an unexpected signer.');
    const staticAccounts = message.staticAccounts;
    if (staticAccounts[0] !== wallet.address) throw new Error('Financial fee payer changed.');
    const writable = (index: number) => index < message.header.numSignerAccounts - message.header.numReadonlySignerAccounts || index >= message.header.numSignerAccounts && index < staticAccounts.length - message.header.numReadonlyNonSignerAccounts;
    const signer = (index: number) => index < message.header.numSignerAccounts;
    const instructions = message.instructions.map((instruction) => {
      const program = staticAccounts[instruction.programAddressIndex];
      if (!program || !instruction.accountIndices || instruction.accountIndices.some((index) => index >= staticAccounts.length)) throw new Error('Financial instruction account index is invalid.');
      return { program, accounts: instruction.accountIndices.map((index) => ({ address: staticAccounts[index], writable: writable(index), signer: signer(index) })), data: instruction.data ?? new Uint8Array() };
    });
    const financial = instructions.filter((instruction) => instruction.program === prepared.programId);
    if (financial.length !== 1 || instructions.at(-1) !== financial[0]) throw new Error('Financial transaction must end with exactly one action.');
    const config = await readFinalizedFinanceConfig(transport);
    const financeConfig = (await findFinanceConfigPda())[0];
    const paymentMint = config.data.paymentMint;
    const expectedAta = async (mint: string) => ata(wallet.address, mint);
    const allowedCreate = new Set<string>();

    function expectAccounts(actual: typeof financial[number]['accounts'], expected: AccountExpectation[]) {
      if (actual.length !== expected.length || actual.some((item, index) => item.address !== expected[index].address || item.writable !== expected[index].writable || item.signer !== !!expected[index].signer)) throw new Error('Financial instruction accounts or permissions changed.');
    }
    if (intent.action === 'faucet') {
      if (intent.marketId !== null || prepared.quote.chain.address !== financeConfig || prepared.quote.minReceiveAtoms !== config.data.faucetAmount.toString() || prepared.quote.maxPaymentAtoms !== '0' || prepared.quote.stateVersion !== config.data.faucetMinted.toString() || config.data.faucetAmount <= 0n) throw new Error('Faucet amount or quote changed.');
      const recipient = await expectedAta(paymentMint);
      const receipt = (await findReceiptPda({ wallet: address(wallet.address) }))[0];
      expectAccounts(financial[0].accounts, [acct(financeConfig, true), acct(paymentMint, true), acct(recipient, true), acct(receipt, true), acct(wallet.address, true, true), acct(TOKEN_PROGRAM), acct(SYSTEM_PROGRAM)]);
      if (!sameBytes(financial[0].data, getClaimFaucetInstructionDataEncoder().encode({}))) throw new Error('Faucet instruction discriminator changed.');
      allowedCreate.add(recipient);
    } else if (intent.action === 'registerMarket') {
      if (!intent.keyword || !intent.aliases || intent.marketId !== null || prepared.quote.maxPaymentAtoms !== '10000000' || prepared.quote.grossAtoms !== '10000000') throw new Error('Registration payment or identity changed.');
      const { word, query } = normalizedRegistration(intent.keyword, intent.aliases);
      const marketSeed = await digest(`ante-up-market-v1:${word}`);
      const queryHash = await digest(query);
      const marketAddress = (await findMarketPda({ marketId: marketSeed }))[0];
      if (prepared.quote.chain.address !== marketAddress) throw new Error('Registration market PDA changed.');
      const financeMarket = (await findFinanceMarketPda({ market: marketAddress }))[0];
      const keywordMint = (await findKeywordMintPda({ market: marketAddress }))[0];
      const curveInventory = (await findCurveInventoryPda({ market: marketAddress }))[0];
      const vaultInventory = (await findVaultInventoryPda({ market: marketAddress }))[0];
      const paymentVault = (await findPaymentVaultPda({ market: marketAddress }))[0];
      const registrantPayment = await expectedAta(paymentMint);
      expectAccounts(financial[0].accounts, [acct(financeConfig), acct(marketAddress, true), acct(financeMarket, true), acct(keywordMint, true), acct(curveInventory, true), acct(vaultInventory, true), acct(paymentVault, true), acct(paymentMint), acct(registrantPayment, true), acct(config.data.protocolTreasury, true), acct(wallet.address, true, true), acct(TOKEN_PROGRAM), acct(SYSTEM_PROGRAM)]);
      const data = getRegisterFinancialMarketInstructionDataDecoder().decode(financial[0].data);
      if (!sameBytes(data.discriminator, new Uint8Array([136, 72, 198, 28, 178, 209, 167, 129])) || !sameBytes(data.marketId, marketSeed) || !sameBytes(data.queryHash, queryHash) || data.queryVersion !== 1n) throw new Error('Registration seed, query, or version changed.');
    } else if (['curveBuy', 'curveSell', 'spotBuy', 'spotSell'].includes(intent.action)) {
      const curve = intent.action === 'curveBuy' || intent.action === 'curveSell';
      const buy = intent.action === 'curveBuy' || intent.action === 'spotBuy';
      if (!intent.marketId || !intent.quantityAtoms || prepared.quote.phase !== (curve ? 'CURVE' : 'INDEXED') || (curve ? prepared.quote.snapshot !== null : !prepared.quote.snapshot)) throw new Error('Trade quote identity changed.');
      const marketAddress = address(intent.marketId);
      // Independent finalized reads: retain every validation, without caching across quotes.
      const [marketAccount, financeMarket, chainConfig] = await Promise.all([
        transport.getFinalizedAccount(marketAddress),
        readFinalizedFinanceMarket(transport, marketAddress),
        readFinalizedConfig(transport),
      ]);
      if (!marketAccount.exists || marketAccount.programAddress !== ANTE_UP_PROGRAM_ADDRESS || !sameBytes(marketAccount.data.slice(0, 8), getMarketDiscriminatorBytes())) throw new Error('Trade market account is not finalized or owned by Ante Up.');
      const market = decodeMarket(marketAccount);
      if ((await findMarketPda({ marketId: market.data.id }))[0] !== marketAddress || market.data.phase !== (curve ? MarketPhase.Curve : MarketPhase.Indexed)) throw new Error('Trade market identity or phase changed.');
      if (!curve) {
        const reference = prepared.quote.snapshot!;
        const snapshot = await readFinalizedSnapshot(transport, marketAddress, BigInt(reference.sequence));
        const hex = (bytes: ArrayLike<number>) => Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
        if (reference.marketId !== marketAddress || reference.payloadHash !== hex(snapshot.data.payloadHash) || reference.payloadHash !== hex(market.data.latestHash) || market.data.latestSequence !== BigInt(reference.sequence) || nowSeconds() - Number(market.data.latestDataThrough) >= 600) throw new Error('Spot snapshot is stale or differs from finalized market.');
      }
      const protocolTreasury = config.data.protocolTreasury;
      const configAccount = (await findConfigPda())[0];
      const keywordMint = financeMarket.data.keywordMint;
      const userKeyword = await expectedAta(keywordMint);
      const userPayment = await expectedAta(paymentMint);
      expectAccounts(financial[0].accounts, [acct(configAccount), acct(financeConfig), acct(marketAddress), acct(financeMarket.address, true), acct(keywordMint), acct(curve ? financeMarket.data.curveInventory : financeMarket.data.vaultInventory, true), acct(financeMarket.data.paymentVault, true), acct(paymentMint), acct(userKeyword, true), acct(userPayment, true), acct(protocolTreasury, true), acct(wallet.address, true, true), acct(TOKEN_PROGRAM)]);
      const data = intent.action === 'curveBuy' ? getCurveBuyInstructionDataDecoder().decode(financial[0].data) : intent.action === 'curveSell' ? getCurveSellInstructionDataDecoder().decode(financial[0].data) : intent.action === 'spotBuy' ? getSpotBuyInstructionDataDecoder().decode(financial[0].data) : getSpotSellInstructionDataDecoder().decode(financial[0].data);
      const expectedDiscriminator = intent.action === 'curveBuy' ? getCurveBuyDiscriminatorBytes() : intent.action === 'curveSell' ? getCurveSellDiscriminatorBytes() : intent.action === 'spotBuy' ? getSpotBuyDiscriminatorBytes() : getSpotSellDiscriminatorBytes();
      if (!sameBytes(data.discriminator, expectedDiscriminator) || data.quantity !== BigInt(intent.quantityAtoms) || data.expectedSequence !== (curve ? 0n : BigInt(prepared.quote.snapshot!.sequence)) || data.expectedConfigVersion !== BigInt(prepared.quote.configVersion) || data.expectedStateVersion !== BigInt(prepared.quote.stateVersion) || data.deadline < BigInt(nowSeconds()) || data.deadline > BigInt(prepared.quote.expiresAt) || data.deadline > BigInt(prepared.expiresAt)) throw new Error('Trade instruction data differs from confirmed quote.');
      if (buy && !('maxPayment' in data && data.maxPayment === BigInt(prepared.quote.maxPaymentAtoms))) throw new Error('Trade payment limit changed.');
      if (!buy && !('minReceipt' in data && data.minReceipt === BigInt(prepared.quote.minReceiveAtoms))) throw new Error('Trade receipt limit changed.');
      if (chainConfig.data.configVersion !== BigInt(prepared.quote.configVersion) || financeMarket.data.stateVersion !== BigInt(prepared.quote.stateVersion)) throw new Error('Trade configuration or state changed; request a new quote.');
      allowedCreate.add(buy ? userKeyword : userPayment);
    } else if (['openPro', 'closePro', 'claim', 'depositLP', 'withdrawLP'].includes(intent.action)) {
      if (!intent.marketId) throw new Error('Indexed action market is missing.');
      const marketAddress = address(intent.marketId);
      const marketAccount = await transport.getFinalizedAccount(marketAddress);
      if (!marketAccount.exists || marketAccount.programAddress !== ANTE_UP_PROGRAM_ADDRESS || !sameBytes(marketAccount.data.slice(0, 8), getMarketDiscriminatorBytes())) throw new Error('Indexed market account is not finalized.');
      const market = decodeMarket(marketAccount);
      if ((await findMarketPda({ marketId: market.data.id }))[0] !== marketAddress) throw new Error('Indexed market PDA changed.');
      const financeMarket = await readFinalizedFinanceMarket(transport, marketAddress);
      const configAccount = (await findConfigPda())[0];
      const ownerPayment = await expectedAta(paymentMint);
      const positionAddress = intent.positionId ? address(intent.positionId) : null;
      const claimAddress = intent.claimId ? address(intent.claimId) : null;
      async function position(value: string) {
        const encoded = await transport.getFinalizedAccount(address(value));
        if (!encoded.exists || encoded.programAddress !== ANTE_UP_PROGRAM_ADDRESS || !sameBytes(encoded.data.slice(0, 8), getProPositionDiscriminatorBytes())) throw new Error('Position account is not finalized.');
        const decoded = decodeProPosition(encoded);
        if (decoded.data.market !== marketAddress || decoded.data.owner !== wallet.address || (await findPositionPda({ market: marketAddress, owner: address(wallet.address), positionId: decoded.data.id }))[0] !== value) throw new Error('Position is not owned by this wallet and market.');
        return decoded;
      }
      if (intent.action !== 'claim') {
        if (market.data.phase !== MarketPhase.Indexed || prepared.quote.phase !== 'INDEXED' || !prepared.quote.snapshot) throw new Error('Indexed quote phase or snapshot is missing.');
        const reference = prepared.quote.snapshot;
        const snapshot = await readFinalizedSnapshot(transport, marketAddress, BigInt(reference.sequence));
        const hex = (bytes: ArrayLike<number>) => Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
        if (reference.marketId !== marketAddress || reference.payloadHash !== hex(snapshot.data.payloadHash) || reference.payloadHash !== hex(market.data.latestHash) || market.data.latestSequence !== BigInt(reference.sequence) || market.data.latestDataThrough > BigInt(nowSeconds()) || BigInt(nowSeconds()) - market.data.latestDataThrough >= 600n) throw new Error('Indexed snapshot differs from finalized market or is stale.');
        const chainConfig = await readFinalizedConfig(transport);
        if (chainConfig.data.configVersion !== BigInt(prepared.quote.configVersion) || financeMarket.data.stateVersion !== BigInt(prepared.quote.stateVersion)) throw new Error('Indexed configuration or vault state changed.');
      }
      const expectedVersion = (data: { expectedSequence: bigint; expectedConfigVersion: bigint; expectedStateVersion: bigint; deadline: bigint }) => {
        if (data.expectedSequence !== BigInt(prepared.quote.snapshot!.sequence) || data.expectedConfigVersion !== BigInt(prepared.quote.configVersion) || data.expectedStateVersion !== BigInt(prepared.quote.stateVersion) || data.deadline < BigInt(nowSeconds()) || data.deadline > BigInt(prepared.quote.expiresAt) || data.deadline > BigInt(prepared.expiresAt)) throw new Error('Indexed instruction version or deadline changed.');
      };
      if (intent.action === 'openPro') {
        const data = getOpenProInstructionDataDecoder().decode(financial[0].data);
        const positionPda = (await findPositionPda({ market: marketAddress, owner: address(wallet.address), positionId: data.positionId }))[0];
        const nextMaturity = (BigInt(nowSeconds() - 345600) / 604800n + 1n) * 604800n + 345600n;
        if (!intent.collateralAtoms || !intent.leverageBps || !intent.direction || !sameBytes(data.discriminator, getOpenProDiscriminatorBytes()) || data.positionId !== await positionIdForRequest(intent.requestId) || data.collateral !== BigInt(intent.collateralAtoms) || data.leverageBps !== BigInt(intent.leverageBps) || data.direction !== (intent.direction === 'long' ? PositionDirection.Long : PositionDirection.Short) || data.maxPayment !== BigInt(prepared.quote.maxPaymentAtoms) || prepared.quote.maxPayoutAtoms === null || prepared.quote.maturityAt !== Number(nextMaturity) || financeMarket.data.currentMaturity !== 0n && financeMarket.data.currentMaturity !== nextMaturity) throw new Error('Pro open terms changed.');
        expectedVersion(data);
        expectAccounts(financial[0].accounts, [acct(configAccount), acct(financeConfig), acct(marketAddress), acct(financeMarket.address, true), acct(positionPda, true), acct(paymentMint), acct(financeMarket.data.paymentVault, true), acct(ownerPayment, true), acct(config.data.protocolTreasury, true), acct(wallet.address, true, true), acct(TOKEN_PROGRAM), acct(SYSTEM_PROGRAM)]);
        if ((await transport.getFinalizedAccount(positionPda)).exists) throw new Error('Pro position already exists.');
      } else if (intent.action === 'closePro') {
        if (!positionAddress) throw new Error('Pro position ID is missing.');
        const held = await position(positionAddress);
        const claimPda = (await findClaimPda({ position: positionAddress }))[0];
        const data = getCloseProInstructionDataDecoder().decode(financial[0].data);
        if (held.data.state !== PositionState.Open || !sameBytes(data.discriminator, getCloseProDiscriminatorBytes()) || data.minReceipt !== BigInt(prepared.quote.minReceiveAtoms)) throw new Error('Pro close position or receipt limit changed.');
        expectedVersion(data);
        expectAccounts(financial[0].accounts, [acct(configAccount), acct(financeConfig), acct(marketAddress), acct(financeMarket.address, true), acct(positionAddress, true), acct(claimPda, true), acct(await settlementPda(marketAddress, held.data.cycle)), acct(wallet.address, true, true), acct(SYSTEM_PROGRAM)]);
      } else if (intent.action === 'claim') {
        if (!claimAddress) throw new Error('Claim ID is missing.');
        const encoded = await transport.getFinalizedAccount(claimAddress);
        if (!encoded.exists || encoded.programAddress !== ANTE_UP_PROGRAM_ADDRESS || !sameBytes(encoded.data.slice(0, 8), getProClaimDiscriminatorBytes())) throw new Error('Claim account is not finalized.');
        const claim = decodeProClaim(encoded);
        const held = await position(claim.data.position);
        if (claim.data.owner !== wallet.address || claim.data.market !== marketAddress || claim.data.paid || held.data.state !== PositionState.Settled || prepared.quote.snapshot !== null || (await findClaimPda({ position: claim.data.position }))[0] !== claimAddress || prepared.quote.minReceiveAtoms !== (claim.data.payout + claim.data.refund).toString() || !sameBytes(financial[0].data, getClaimProInstructionDataEncoder().encode({}))) throw new Error('Claim payout or owner changed.');
        expectAccounts(financial[0].accounts, [acct(financeConfig), acct(marketAddress), acct(financeMarket.address, true), acct(held.address), acct(claimAddress, true), acct(paymentMint), acct(financeMarket.data.paymentVault, true), acct(ownerPayment, true), acct(wallet.address, true, true), acct(TOKEN_PROGRAM)]);
        allowedCreate.add(ownerPayment);
      } else {
        const holdingPda = (await findHoldingPda({ market: marketAddress, owner: address(wallet.address) }))[0];
        const deposit = intent.action === 'depositLP';
        const data = deposit ? getDepositLpInstructionDataDecoder().decode(financial[0].data) : getWithdrawLpInstructionDataDecoder().decode(financial[0].data);
        if (!intent.quantityAtoms || !sameBytes(data.discriminator, deposit ? getDepositLpDiscriminatorBytes() : getWithdrawLpDiscriminatorBytes()) || !('amount' in data ? data.amount === BigInt(intent.quantityAtoms) && data.minShares === BigInt(prepared.quote.minReceiveAtoms) : data.shares === BigInt(intent.quantityAtoms) && data.minReceipt === BigInt(prepared.quote.minReceiveAtoms))) throw new Error('LP amount or minimum receipt changed.');
        expectedVersion(data);
        if (financeMarket.data.lpWindowStart > BigInt(nowSeconds()) || financeMarket.data.lpWindowEnd <= BigInt(nowSeconds())) throw new Error('LP processing window is closed.');
        if (!deposit) {
          const encoded = await transport.getFinalizedAccount(holdingPda);
          if (!encoded.exists || encoded.programAddress !== ANTE_UP_PROGRAM_ADDRESS || !sameBytes(encoded.data.slice(0, 8), getLpHoldingDiscriminatorBytes())) throw new Error('LP holding is not finalized.');
          const holding = decodeLpHolding(encoded);
          if (holding.data.market !== marketAddress || holding.data.owner !== wallet.address || holding.data.shares < BigInt(intent.quantityAtoms)) throw new Error('LP shares differ from the wallet holding.');
        }
        expectAccounts(financial[0].accounts, [acct(configAccount), acct(financeConfig), acct(marketAddress), acct(financeMarket.address, true), acct(holdingPda, true), acct(paymentMint), acct(financeMarket.data.paymentVault, true), acct(ownerPayment, true), acct(wallet.address, true, true), acct(TOKEN_PROGRAM), acct(SYSTEM_PROGRAM)]);
        if (!deposit) allowedCreate.add(ownerPayment);
      }
    } else {
      throw new Error(`${intent.action} has no generated instruction verifier yet.`);
    }
    const created = new Set<string>();
    for (const instruction of instructions) {
      if (instruction === financial[0]) continue;
      if (instruction.program !== ATA_PROGRAM || !allowedCreate.has(instruction.accounts[1]?.address ?? '') || instruction.data.length !== 1 || instruction.data[0] !== 1 || created.has(instruction.accounts[1].address)) throw new Error('Unexpected instruction before financial action.');
      const mint = instruction.accounts[3]?.address;
      if (!mint || instruction.accounts[1].address !== await expectedAta(mint)) throw new Error('Associated token account derivation changed.');
      if ((await transport.getFinalizedAccount(address(instruction.accounts[1].address))).exists) throw new Error('Associated token account already exists.');
      const mintWritableInAction = financial[0].accounts.find((item) => item.address === mint)?.writable ?? false;
      const expected = [acct(wallet.address, true, true), acct(instruction.accounts[1].address, true), acct(wallet.address, true, true), acct(mint, mintWritableInAction), acct(SYSTEM_PROGRAM), acct(TOKEN_PROGRAM)];
      if (instruction.accounts.length === 7) expected.push(acct(RENT_SYSVAR));
      expectAccounts(instruction.accounts, expected);
      created.add(instruction.accounts[1].address);
    }
  };
}
