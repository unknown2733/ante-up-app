import type { FinancialAction, FinancialIntent, FinancialPortfolio, FinancialQuote, FinancialVault } from '../../../contracts/financial.ts';
import type { MarketView } from '../../../contracts/types.ts';
import { InputError } from './validate.ts';
import { decodeBase58 } from './auth.ts';
import { decompileTransactionMessage, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import type { FinancialPrepared } from '../../../contracts/financial.ts';

const userActions: readonly FinancialAction[] = ['faucet','registerMarket','curveBuy','curveSell','spotBuy','spotSell','openPro','closePro','claim','depositLP','withdrawLP'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decimal = /^(0|[1-9][0-9]*)$/;
const u64 = (v: unknown): v is string => typeof v === 'string' && decimal.test(v) && BigInt(v) <= 18_446_744_073_709_551_615n;
const positive = (v: unknown, field: string) => {
  if (typeof v !== 'string' || !decimal.test(v) || v === '0' || BigInt(v) > 18_446_744_073_709_551_615n) throw new InputError(`${field} must be positive canonical atoms within u64`);
  return v;
};
const str = (v: unknown, field: string) => {
  if (typeof v !== 'string' || v.length === 0 || v.length > 128) throw new InputError(`${field} required`);
  return v;
};

export function validateFinancialIntent(raw: unknown): FinancialIntent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError('intent object required');
  const v = raw as Record<string, unknown>;
  if (!userActions.includes(v.action as FinancialAction)) throw new InputError('financial action invalid');
  const action = v.action as FinancialAction;
  const requestId = str(v.requestId, 'requestId');
  if (!uuid.test(requestId)) throw new InputError('requestId must be UUID');
  const wallet = str(v.wallet, 'wallet');
  if (decodeBase58(wallet).length !== 32) throw new InputError('wallet must be Solana address');
  const marketId = action === 'faucet' || action === 'registerMarket' ? null : str(v.marketId, 'marketId');
  if (marketId && decodeBase58(marketId).length !== 32) throw new InputError('marketId must be Solana address');
  if (marketId === null && v.marketId !== null && v.marketId !== undefined) throw new InputError('marketId must be null');
  const permitted = new Set(['requestId','wallet','action','marketId']);
  const output: FinancialIntent = { requestId, wallet, action, marketId };
  const put = <K extends keyof FinancialIntent>(key: K, value: FinancialIntent[K]) => { permitted.add(key); Object.assign(output, { [key]: value }); };
  if (['curveBuy','curveSell','spotBuy','spotSell','depositLP','withdrawLP'].includes(action)) put('quantityAtoms', positive(v.quantityAtoms, 'quantityAtoms'));
  if (action === 'openPro') {
    put('collateralAtoms', positive(v.collateralAtoms, 'collateralAtoms'));
    const leverageBps = positive(v.leverageBps, 'leverageBps');
    if (BigInt(leverageBps) < 10_000n || BigInt(leverageBps) > 50_000n) throw new InputError('leverageBps out of range');
    put('leverageBps', leverageBps);
    if (v.direction !== 'long' && v.direction !== 'short') throw new InputError('direction invalid');
    put('direction', v.direction);
  }
  if (action === 'closePro') put('positionId', str(v.positionId, 'positionId'));
  if (action === 'claim') put('claimId', str(v.claimId, 'claimId'));
  if (action === 'registerMarket') {
    put('keyword', str(v.keyword, 'keyword'));
    if (!Array.isArray(v.aliases) || v.aliases.length > 10) throw new InputError('aliases invalid');
    put('aliases', v.aliases.map(a => str(a, 'alias')));
  }
  for (const key of Object.keys(v)) if (!permitted.has(key)) throw new InputError(`unexpected financial field: ${key}`);
  return output;
}

/** The adapter must read finalized chain accounts; SQLite is only a quote/operation cache. */
export interface FinancialReader {
  portfolio(wallet: string): Promise<{ value: FinancialPortfolio; slot: string; cluster: 'localnet'|'devnet'; programId: string; finality: 'finalized' } | null>;
  vault(marketId: string): Promise<{ value: FinancialVault; slot: string; cluster: 'localnet'|'devnet'; programId: string; finality: 'finalized' } | null>;
  quote(intent: FinancialIntent, market: MarketView | null, now: number): Promise<FinancialQuote | null>;
}

/** FinancialIntent is flat except ordered aliases; key order is not part of its identity. */
export const financialIntentKey = (intent: FinancialIntent): string => JSON.stringify(Object.fromEntries(Object.entries(intent).sort(([a],[b])=>a.localeCompare(b))));
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,value])=>`${JSON.stringify(k)}:${canonical(value)}`).join(',')}}` : JSON.stringify(v);
export const financialQuoteKey = (quote: FinancialQuote): string => canonical(quote);

export type PreparedFinancialTransaction = Extract<FinancialPrepared,{kind:'transaction'}>;
/** B must implement an exact generated-instruction/account validator; no default exists. */
export interface FinancialTransactionAdapter {
  prepare(quote: FinancialQuote): Promise<{prepared:PreparedFinancialTransaction;discoveryAddress:string}>;
  verifyCompiled(prepared: PreparedFinancialTransaction, quote: FinancialQuote): Promise<void>;
}

export async function validatePreparedFinancial(value: {prepared:PreparedFinancialTransaction;discoveryAddress:string}, quote: FinancialQuote,
  adapter: FinancialTransactionAdapter, expected: {cluster:'localnet'|'devnet';programId:string;now:number}): Promise<{prepared:PreparedFinancialTransaction;discoveryAddress:string;messageBase64:string}> {
  const p=value.prepared;
  if (p.kind!=='transaction' || p.action!==quote.intent.action || p.requestId!==quote.intent.requestId || p.wallet!==quote.intent.wallet ||
      p.cluster!==expected.cluster || p.programId!==expected.programId || financialQuoteKey(p.quote)!==financialQuoteKey(quote) ||
      !Number.isSafeInteger(p.expiresAt) || p.expiresAt<=expected.now || p.expiresAt>Math.min(expected.now+30,quote.expiresAt) ||
      !u64(p.lastValidBlockHeight) || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.unsignedTransaction)) throw new Error('PREPARED_FINANCIAL_IDENTITY_MISMATCH');
  if (decodeBase58(value.discoveryAddress).length!==32) throw new Error('PREPARED_DISCOVERY_ADDRESS_INVALID');
  const bytes=Buffer.from(p.unsignedTransaction,'base64');
  if (bytes.toString('base64')!==p.unsignedTransaction) throw new Error('PREPARED_FINANCIAL_ENCODING_INVALID');
  const transaction=getTransactionDecoder().decode(bytes);
  const compiled=getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (compiled.version!==0) throw new Error('PREPARED_FINANCIAL_MESSAGE_INVALID');
  const message=decompileTransactionMessage(compiled);
  if (String(message.feePayer.address)!==p.wallet || Object.keys(transaction.signatures).length!==1 || !(p.wallet in transaction.signatures) ||
      !('blockhash' in message.lifetimeConstraint) || !message.instructions.some(ix=>String(ix.programAddress)===p.programId)) throw new Error('PREPARED_FINANCIAL_MESSAGE_INVALID');
  if (value.discoveryAddress!==p.wallet && !message.instructions.some(ix=>ix.accounts?.some(account=>String(account.address)===value.discoveryAddress))) throw new Error('PREPARED_DISCOVERY_ADDRESS_INVALID');
  // The B adapter checks every instruction, account, discriminator and data field.
  await adapter.verifyCompiled(p,quote);
  return {...value,messageBase64:Buffer.from(transaction.messageBytes).toString('base64')};
}

export function validateFinancialPortfolio(read: Awaited<ReturnType<FinancialReader['portfolio']>>, expected: {wallet:string;cluster:'localnet'|'devnet';programId:string}): FinancialPortfolio {
  if (!read || read.finality !== 'finalized' || read.cluster !== expected.cluster || read.programId !== expected.programId || read.value.wallet !== expected.wallet || !decimal.test(read.slot)) throw new Error('DATA_NOT_READY');
  const value = read.value;
  if (decodeBase58(value.quoteMint).length !== 32 || !u64(value.quoteBalanceAtoms) ||
      value.tokenBalances.some(b => !u64(b.atoms) || decodeBase58(b.mint).length !== 32) ||
      value.positions.some(p => p.owner !== expected.wallet || !u64(p.collateralAtoms) || !u64(p.notionalAtoms) || !u64(p.maxPayoutAtoms)) ||
      value.claims.some(c => c.owner !== expected.wallet || !u64(c.payoutAtoms) || !u64(c.refundAtoms)) ||
      value.lpShares.some(s => !u64(s.sharesAtoms) || s.withdrawableAtoms !== null && !u64(s.withdrawableAtoms))) throw new Error('DATA_NOT_READY');
  return value;
}

export function validateFinancialVault(read: Awaited<ReturnType<FinancialReader['vault']>>, expected: {marketId:string;cluster:'localnet'|'devnet';programId:string}): FinancialVault {
  if (!read || read.finality !== 'finalized' || read.cluster !== expected.cluster || read.programId !== expected.programId || read.value.marketId !== expected.marketId || !decimal.test(read.slot)) throw new Error('DATA_NOT_READY');
  for (const field of ['assetsAtoms','outsideTokensAtoms','spotReserveAtoms','proReserveAtoms','otherReserveAtoms','bufferAtoms','totalSharesAtoms','lockedSharesAtoms'] as const) if (!u64(read.value[field])) throw new Error('DATA_NOT_READY');
  if (!/^(0|-?[1-9][0-9]*)$/.test(read.value.freeCapitalAtoms) || read.value.navAtoms !== null && !u64(read.value.navAtoms)) throw new Error('DATA_NOT_READY');
  return read.value;
}

export function validateFinancialQuote(quote: FinancialQuote, intent: FinancialIntent, market: MarketView | null, expected: {cluster:'localnet'|'devnet';programId:string;now:number}): FinancialQuote {
  if (financialIntentKey(quote.intent) !== financialIntentKey(intent) || quote.chain.cluster !== expected.cluster || quote.chain.programId !== expected.programId ||
      (intent.marketId !== null && quote.chain.address !== intent.marketId) || !quote.executable || !uuid.test(quote.id) ||
      !Number.isSafeInteger(quote.quotedAt) || quote.quotedAt > expected.now || quote.quotedAt < expected.now - 30 ||
      !Number.isSafeInteger(quote.expiresAt) || quote.expiresAt <= expected.now || quote.expiresAt > expected.now + 30 ||
      !decimal.test(quote.stateVersion) || !decimal.test(quote.configVersion)) throw new Error('REQUOTE_REQUIRED');
  for (const key of ['priceAtoms','grossAtoms','tradeFeeAtoms','timePrepaidAtoms','maxPaymentAtoms','minReceiveAtoms'] as const) if (!u64(quote[key])) throw new Error('REQUOTE_REQUIRED');
  if (quote.maxPayoutAtoms !== null && !u64(quote.maxPayoutAtoms)) throw new Error('REQUOTE_REQUIRED');
  if (intent.action === 'openPro' && quote.maxPayoutAtoms === null) throw new Error('REQUOTE_REQUIRED');
  if (intent.marketId) {
    if (!market || market.id !== intent.marketId || (intent.action !== 'claim' && market.phase !== quote.phase) || market.chain?.programId !== expected.programId || market.chain.cluster !== expected.cluster) throw new Error('DATA_NOT_READY');
    if (['curveBuy','curveSell'].includes(intent.action) && market.phase !== 'CURVE') throw new Error('WRONG_PHASE');
    if (['spotBuy','spotSell','openPro','closePro','depositLP','withdrawLP'].includes(intent.action) && market.phase !== 'INDEXED') throw new Error('WRONG_PHASE');
    if (intent.action === 'openPro' && (market.epochPhase !== 'PRO_OPEN' || quote.maturityAt === null || quote.maturityAt <= expected.now + 1800 || quote.maturityAt % 604800 !== 345600)) throw new Error('WRONG_PHASE');
    if (['depositLP','withdrawLP'].includes(intent.action) && market.epochPhase !== 'LP_WINDOW' && market.epochPhase !== 'INITIAL_LP') throw new Error('LP_WINDOW_CLOSED');
    if (['spotBuy','openPro'].includes(intent.action) && market.price?.executable !== true) throw new Error('DATA_NOT_READY');
    if (['depositLP','withdrawLP'].includes(intent.action) && market.price?.kind!=='indexed') throw new Error('DATA_NOT_READY');
    if (market.phase === 'INDEXED' && intent.action !== 'claim') {
      const snapshot = market.snapshot;
      if (!snapshot || snapshot.finality !== 'finalized' || !quote.snapshot || quote.snapshot.marketId !== market.id || quote.snapshot.sequence !== snapshot.payload.sequence || quote.snapshot.payloadHash !== snapshot.payloadHash || quote.configVersion !== snapshot.payload.configVersion || expected.now - snapshot.payload.dataThrough >= 600) throw new Error('DATA_NOT_READY');
    } else if (quote.snapshot !== null) throw new Error('REQUOTE_REQUIRED');
  } else if (market || quote.snapshot !== null) throw new Error('REQUOTE_REQUIRED');
  return quote;
}
