import { ANTE_UP_PROGRAM_ADDRESS } from '@ante-up/chain-client';
import { getBase58Decoder, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import type { Transaction } from '@solana/kit';
import type { Envelope, Operation, WalletSession } from '../../../contracts/types';
import type { FinancialAction, FinancialIntent, FinancialPortfolio, FinancialPrepared, FinancialQuote, FinancialQuoteResult, FinancialVault } from '../../../contracts/financial';
import type { WalletContext } from './transactionBoundary';
import { isWalletRejection } from './walletErrors';
import { startFinancialTiming } from './financialTiming';

export type FinancialProgress = 'AUTH' | 'QUOTING' | 'PREPARING' | 'AWAITING_SIGNATURE' | 'SUBMITTED' | 'CONFIRMED';
export type FinancialOutcome = { state: 'UNAVAILABLE' | 'AWAITING_SIGNATURE' | 'SUBMITTED' | 'CONFIRMED' | 'FINALIZED' | 'FAILED' | 'UNKNOWN'; requestId: string; signature: string | null; reason?: string };
export type FinancialPending = { requestId: string; action: FinancialAction; wallet: string; cluster: WalletContext['cluster']; signature: string | null; marketId: string | null };
export type FinancialInstructionVerifier = (transaction: Transaction, prepared: Extract<FinancialPrepared, { kind: 'transaction' }>, wallet: WalletContext) => Promise<void>;

export interface FinancialFlowOptions {
  baseUrl: string;
  getWallet(): WalletContext | null;
  authorize(wallet: WalletContext): Promise<WalletSession>;
  fetcher?: typeof fetch;
  nowSeconds?: () => number;
  onServerTime?: (asOf:number, requestStarted:number) => void;
  requestId?: () => string;
  verifyInstruction?: FinancialInstructionVerifier;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  wait?: (milliseconds: number) => Promise<void>;
  pollAttempts?: number;
}

const uint = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
const positive = (value: unknown): value is string => uint(value) && value !== '0';
const sameWallet = (expected: WalletContext, current: WalletContext | null) => !!current && expected.address === current.address && expected.cluster === current.cluster && expected.signer === current.signer;
const pendingKey = (wallet: WalletContext) => `ante-up-financial-pending:${wallet.cluster}:${wallet.address}`;
const actionNeedsMarket = (action: FinancialAction) => action !== 'faucet' && action !== 'registerMarket';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
const sameIntent = (a: FinancialIntent, b: FinancialIntent) => canonical(a) === canonical(b);

function checkIntent(intent: FinancialIntent) {
  if (!intent.requestId || !intent.wallet || (actionNeedsMarket(intent.action) && !intent.marketId) || (!actionNeedsMarket(intent.action) && intent.marketId !== null)) throw new Error('Financial intent identity is incomplete.');
  if (['curveBuy', 'curveSell', 'spotBuy', 'spotSell', 'depositLP', 'withdrawLP'].includes(intent.action) && !positive(intent.quantityAtoms)) throw new Error('Enter a positive amount.');
  if (intent.action === 'openPro' && (!positive(intent.collateralAtoms) || !uint(intent.leverageBps) || BigInt(intent.leverageBps) < 10000n || BigInt(intent.leverageBps) > 50000n || !['long', 'short'].includes(intent.direction ?? ''))) throw new Error('Pro collateral, direction, or leverage is invalid.');
  if (intent.action === 'closePro' && !intent.positionId) throw new Error('Choose an open position.');
  if (intent.action === 'claim' && !intent.claimId) throw new Error('Choose an unpaid claim.');
  if (intent.action === 'registerMarket' && (!intent.keyword || !/^[a-z][a-z0-9]*(?: [a-z][a-z0-9]*)*$/.test(intent.keyword) || !Array.isArray(intent.aliases) || intent.aliases.length > 7)) throw new Error('Enter a normalized English keyword and up to seven aliases.');
}

function checkQuote(quote: FinancialQuote, intent: FinancialIntent, wallet: WalletContext, now: number) {
  if (!quote || !quote.id || !sameIntent(quote.intent, intent) || quote.chain.cluster !== wallet.cluster || quote.chain.programId !== ANTE_UP_PROGRAM_ADDRESS || (intent.marketId && quote.chain.address !== intent.marketId)) throw new Error('Quote identity, market, or program changed.');
  if (!Number.isSafeInteger(quote.quotedAt) || !Number.isSafeInteger(quote.expiresAt) || quote.quotedAt > now + 5 || quote.expiresAt <= now || quote.expiresAt > now + 30) throw new Error('Quote is expired or has an invalid lifetime.');
  for (const value of [quote.configVersion, quote.stateVersion, quote.priceAtoms, quote.grossAtoms, quote.tradeFeeAtoms, quote.timePrepaidAtoms, quote.maxPaymentAtoms, quote.minReceiveAtoms]) if (!uint(value)) throw new Error('Quote amount or version is invalid.');
  if (quote.maxPayoutAtoms !== null && !uint(quote.maxPayoutAtoms)) throw new Error('Quote maximum payout is invalid.');
  if (quote.snapshot && (quote.snapshot.marketId !== intent.marketId || !uint(quote.snapshot.sequence))) throw new Error('Quote snapshot does not match the market.');
  if (quote.maturityAt !== null && (!Number.isSafeInteger(quote.maturityAt) || (intent.action === 'openPro' && quote.maturityAt <= now))) throw new Error('Quote maturity is invalid.');
  if (!quote.executable) throw new Error('This quote is not executable.');
}

/** Authenticated quote and execution adapter. Only a supplied generated-instruction verifier can enable signing. */
export function createLiveFinancialFlow(options: FinancialFlowOptions) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const makeId = options.requestId ?? (() => crypto.randomUUID());
  const origin = options.baseUrl.replace(/\/$/, '');
  const storage = options.storage ?? (typeof sessionStorage === 'undefined' ? undefined : sessionStorage);
  let active = false;
  let lastAuthorization: WalletSession | null = null;
  const quoted = new Map<string, FinancialQuote>();
  const timings = new WeakMap<FinancialQuote, ReturnType<typeof startFinancialTiming>>();
  const verified = new Map<FinancialQuote, { wallet: WalletContext; transaction: Transaction; result: Extract<FinancialPrepared, {kind:'transaction'}>; session: WalletSession; fingerprint: string }>();

  function requireWallet(wallet: WalletContext) { if (!sameWallet(wallet, options.getWallet())) throw new Error('Wallet or cluster changed.'); }
  async function request<T>(path: string, wallet: WalletContext, init: RequestInit = {}, existingSession?: WalletSession): Promise<T> {
    const authorized = existingSession ?? await options.authorize(wallet);
    if (authorized.wallet !== wallet.address || authorized.cluster !== wallet.cluster || authorized.expiresAt <= now()) throw new Error('Financial session expired or changed.');
    lastAuthorization = authorized;
    requireWallet(wallet);
    const requestStarted=performance.now();
    const response = await fetcher(`${origin}/v1/financial${path}`, { ...init, cache: 'no-store', headers: { Accept: 'application/json', Authorization: `Bearer ${authorized.token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
    const raw: unknown = await response.json();
    if (!response.ok) throw new Error(raw && typeof raw === 'object' && 'message' in raw && typeof raw.message === 'string' ? raw.message : `Financial API request failed (${response.status}).`);
    if (!raw || typeof raw !== 'object' || !('schemaVersion' in raw) || !('mode' in raw) || !('asOf' in raw) || !('nextCursor' in raw) || !('data' in raw)) throw new Error('Financial API envelope is invalid.');
    const page = raw as Envelope<T>;
    if (page.schemaVersion !== '0.1' || page.mode !== wallet.cluster || !Number.isSafeInteger(page.asOf) || page.nextCursor !== null) throw new Error('Financial API mode differs from the wallet cluster.');
    options.onServerTime?.(page.asOf,requestStarted);
    requireWallet(wallet);
    return page.data;
  }
  const post = <T,>(path: string, wallet: WalletContext, body: unknown, existingSession?: WalletSession) => request<T>(path, wallet, { method: 'POST', body: JSON.stringify(body) }, existingSession);
  function pending(wallet: WalletContext): FinancialPending | null {
    let value: string | null | undefined;
    try { value = storage?.getItem(pendingKey(wallet)); } catch { return null; }
    if (!value) return null;
    try {
      const data: unknown = JSON.parse(value);
      if (!data || typeof data !== 'object') return null;
      const p = data as FinancialPending;
      return p.wallet === wallet.address && p.cluster === wallet.cluster && typeof p.requestId === 'string' && typeof p.action === 'string' && (p.signature === null || typeof p.signature === 'string') ? p : null;
    } catch { return null; }
  }
  function savePending(wallet: WalletContext, value: FinancialPending | null) {
    if (value) storage?.setItem(pendingKey(wallet), JSON.stringify(value));
    else storage?.removeItem(pendingKey(wallet));
  }
  function canExecute(action: FinancialAction) { return !!options.verifyInstruction && !!storage && action !== 'graduate'; }

  async function portfolio(): Promise<FinancialPortfolio> {
    const wallet = options.getWallet();
    if (!wallet) throw new Error('Connect a wallet to view private balances.');
    const data = await request<FinancialPortfolio>(`/portfolio?wallet=${encodeURIComponent(wallet.address)}`, wallet);
    if (!data || data.wallet !== wallet.address || !uint(data.quoteBalanceAtoms) || !Array.isArray(data.positions) || !Array.isArray(data.claims) || !Array.isArray(data.lpShares) || !Array.isArray(data.tokenBalances) || data.positions.some((item) => item.owner !== wallet.address) || data.claims.some((item) => item.owner !== wallet.address)) throw new Error('Private portfolio does not match this wallet.');
    return data;
  }
  async function vault(marketId: string): Promise<FinancialVault> {
    const wallet = options.getWallet();
    if (!wallet) throw new Error('Connect a wallet to view the vault.');
    const data = await request<FinancialVault>(`/vaults/${encodeURIComponent(marketId)}`, wallet);
    if (!data || data.marketId !== marketId || !uint(data.assetsAtoms) || !uint(data.totalSharesAtoms)) throw new Error('Vault data does not match the market.');
    return data;
  }
  async function quote(fields: Omit<FinancialIntent, 'requestId' | 'wallet'>): Promise<FinancialQuoteResult> {
    const wallet = options.getWallet();
    if (!wallet) throw new Error('Connect a wallet before requesting a quote.');
    if (active) throw new Error('Another financial action is in progress.');
    if (pending(wallet)) throw new Error('Resolve the pending financial request before another action.');
    verified.clear();
    const intent: FinancialIntent = { requestId: makeId(), wallet: wallet.address, ...fields };
    checkIntent(intent);
    const timing = startFinancialTiming(); timing('quote.start');
    try {
    const result = await post<FinancialQuoteResult>('/quotes', wallet, intent);
    if (result.kind === 'notExecutable') return result;
    if (result.kind !== 'quote') throw new Error('Financial quote response is invalid.');
    checkQuote(result.quote, intent, wallet, now());
    quoted.set(result.quote.id, result.quote);
    timings.set(result.quote, timing); timing('quote.ready', result.quote.expiresAt - now());
    return result;
    } catch (error) { timing('quote.failed'); throw error; }
  }

  async function prepareQuote(quoteValue: FinancialQuote, onProgress?: (state: FinancialProgress) => void): Promise<FinancialOutcome | null> {
    const wallet = options.getWallet();
    const requestId = quoteValue.intent.requestId;
    if (!wallet) return { state: 'UNAVAILABLE', reason: 'Connect a wallet.', requestId, signature: null };
    const verifier = options.verifyInstruction;
    if (!canExecute(quoteValue.intent.action) || !verifier || !storage || !wallet.signer) return { state: 'UNAVAILABLE', reason: 'Verified on-chain financial signing or pending-request storage is not available.', requestId, signature: null };
    if (active || pending(wallet)) return { state: 'UNAVAILABLE', reason: 'Another financial request is pending.', requestId, signature: null };
    if (quoted.get(quoteValue.id) !== quoteValue) return { state: 'UNAVAILABLE', reason: 'Request a fresh quote.', requestId, signature: null };
    verified.delete(quoteValue);
    const timing = timings.get(quoteValue) ?? startFinancialTiming();
    active = true;
    try {
      checkQuote(quoteValue, quoteValue.intent, wallet, now());
      onProgress?.('PREPARING');
      timing('prepare.start', quoteValue.expiresAt - now());
      const result = await post<FinancialPrepared>('/transactions/prepare', wallet, { wallet: wallet.address, requestId, quoteId: quoteValue.id });
      timing('prepare.ready', quoteValue.expiresAt - now());
      if (result.kind === 'notExecutable') return { state: 'UNAVAILABLE', reason: result.reason, requestId, signature: null };
      if (result.kind !== 'transaction' || result.wallet !== wallet.address || result.cluster !== wallet.cluster || result.programId !== ANTE_UP_PROGRAM_ADDRESS || result.action !== quoteValue.intent.action || result.requestId !== requestId || canonical(result.quote) !== canonical(quoteValue) || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= now() || result.expiresAt > now() + 30) throw new Error('Prepared transaction does not match the confirmed quote.');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(result.unsignedTransaction)) throw new Error('Prepared transaction is not base64.');
      const bytes = getBase64Encoder().encode(result.unsignedTransaction);
      const transaction = getTransactionDecoder().decode(bytes);
      const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
      if (message.version !== 'legacy' && message.version !== 0) throw new Error('Unsupported transaction version.');
      if (!wallet.supportedTransactionVersions.has(message.version) || message.staticAccounts[0] !== wallet.address || !Object.hasOwn(transaction.signatures, wallet.address) || Object.values(transaction.signatures).some((value) => value !== null)) throw new Error('Prepared financial transaction signer or fee payer is invalid.');
      if (!message.instructions.length || !message.instructions.some((instruction) => message.staticAccounts[instruction.programAddressIndex] === result.programId)) throw new Error('Prepared financial transaction omits the expected program.');
      timing('verify.start', quoteValue.expiresAt - now());
      await verifier(transaction, result, wallet);
      timing('verify.ready', quoteValue.expiresAt - now());
      requireWallet(wallet);
      if (now() >= result.expiresAt || now() >= quoteValue.expiresAt) throw new Error('Quote or prepared transaction expired.');
      const session = lastAuthorization;
      if (!session || session.wallet !== wallet.address || session.cluster !== wallet.cluster || session.expiresAt <= now()) throw new Error('Financial session expired or changed.');
      verified.set(quoteValue, {wallet, transaction, result, session, fingerprint: canonical(quoteValue)});
      return null;
    } catch (error) {
      timing('execute.failed', quoteValue.expiresAt - now());
      return {state:'AWAITING_SIGNATURE', reason:error instanceof Error ? error.message : 'Financial preparation failed.', requestId, signature:null};
    } finally { active = false; }
  }

  async function signReviewed(quoteValue: FinancialQuote, onProgress?: (state: FinancialProgress) => void): Promise<FinancialOutcome> {
    const wallet = options.getWallet();
    const requestId = quoteValue.intent.requestId;
    if (!wallet) return { state: 'UNAVAILABLE', reason: 'Connect a wallet.', requestId, signature: null };
    const verifier = options.verifyInstruction;
    if (!canExecute(quoteValue.intent.action) || !verifier || !storage || !wallet.signer) return { state: 'UNAVAILABLE', reason: 'Verified on-chain financial signing or pending-request storage is not available.', requestId, signature: null };
    if (active || pending(wallet)) return { state: 'UNAVAILABLE', reason: 'Another financial request is pending.', requestId, signature: null };
    if (quoted.get(quoteValue.id) !== quoteValue) return { state: 'UNAVAILABLE', reason: 'Request a fresh quote.', requestId, signature: null };
    const timing = timings.get(quoteValue) ?? startFinancialTiming();
    active = true;
    try {
      const ready = verified.get(quoteValue);
      verified.delete(quoteValue);
      if (!ready || ready.fingerprint !== canonical(quoteValue)) throw new Error('Review a fresh quote before signing.');
      requireWallet(ready.wallet);
      checkQuote(quoteValue, quoteValue.intent, wallet, now());
      const {transaction, result, session} = ready;
      if (now() >= result.expiresAt || now() >= session.expiresAt) throw new Error('Quote or prepared transaction expired.');
      quoted.delete(quoteValue.id);
      const pendingValue: FinancialPending = { requestId, wallet: wallet.address, cluster: wallet.cluster, action: quoteValue.intent.action, marketId: quoteValue.intent.marketId, signature: null };
      savePending(wallet, pendingValue);
      onProgress?.('AWAITING_SIGNATURE');
      let signature: string;
      try {
        timing('wallet.start', quoteValue.expiresAt - now());
        let stopped = false;
        const walletResult = wallet.signer.signAndSendTransactions([transaction]).then(
          signed => ({ kind: 'wallet' as const, signed }),
          error => ({ kind: 'error' as const, error }),
        );
        const reconciled = (async () => {
          const wait = options.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
          for (let i = 0; i < Math.min(options.pollAttempts ?? 8, 8); i++) {
            await wait(2500);
            if (stopped) return null;
            if (!sameWallet(wallet, options.getWallet()) || !session || session.expiresAt <= now()) break;
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              const operation = await Promise.race([
                request<Operation>(`/operations/${encodeURIComponent(requestId)}?wallet=${encodeURIComponent(wallet.address)}`, wallet, { signal: controller.signal }, session),
                new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Status read timed out.')); }, 2500); }),
              ]);
              if (stopped) return null;
              if (!sameWallet(wallet, options.getWallet())) break;
              if (operation.requestId !== requestId || operation.wallet !== wallet.address || operation.action !== pendingValue.action) continue;
              if (operation.state === 'FINALIZED' || operation.state === 'FAILED') {
                if (!(typeof operation.signature === 'string' && operation.signature.length > 0) && !(operation.state === 'FAILED' && operation.error?.code === 'REQUOTE_REQUIRED' && operation.signature === null)) continue;
                return { state: operation.state, requestId, signature: operation.signature, reason: operation.error?.code === 'REQUOTE_REQUIRED' ? 'REQUOTE_REQUIRED' : operation.error?.message } as FinancialOutcome;
              }
            } catch { /* No status response can prove nonexecution; keep the pending marker. */ }
            finally { if (timer) clearTimeout(timer); controller.abort(); }
          }
          return { state: 'UNKNOWN', requestId, signature: null, reason: 'The wallet response or chain finality check is delayed. Check the existing request status before trying again.' } as FinancialOutcome;
        })();
        let raced;
        try { raced = await Promise.race([walletResult, reconciled.then(outcome => ({ kind: 'status' as const, outcome }))]); }
        finally { stopped = true; }
        if (raced.kind === 'status') {
          const outcome = raced.outcome!;
          if ((outcome.state === 'FINALIZED' || outcome.state === 'FAILED') && pending(wallet)?.requestId === requestId) savePending(wallet, null);
          return outcome;
        }
        if (raced.kind === 'error') throw raced.error;
        const signed = raced.signed;
        timing('wallet.response', quoteValue.expiresAt - now());
        if (signed.length !== 1 || signed[0].length !== 64) throw new Error('Wallet returned an invalid transaction signature.');
        signature = getBase58Decoder().decode(signed[0]);
      } catch (error) {
        timing('wallet.failed', quoteValue.expiresAt - now());
        if (isWalletRejection(error)) {
          savePending(wallet, null);
          return { state: 'AWAITING_SIGNATURE', reason: error instanceof Error ? error.message : 'Wallet rejected signing.', requestId, signature: null };
        }
        return { state: 'UNKNOWN', reason: error instanceof Error ? error.message : 'Wallet send result is unknown.', requestId, signature: null };
      }
      try { savePending(wallet, { ...pendingValue, signature }); }
      catch { return { state: 'UNKNOWN', reason: 'Signature returned, but pending record update failed. Recheck by request ID.', requestId, signature }; }
      if (!sameWallet(wallet, options.getWallet())) return { state: 'UNKNOWN', reason: 'Wallet changed after send.', requestId, signature };
      try {
        const reported = await post<Operation>(`/operations/${encodeURIComponent(requestId)}/submit`, wallet, { wallet: wallet.address, signature }, session);
        if (reported.requestId !== requestId || reported.wallet !== wallet.address || reported.action !== quoteValue.intent.action || reported.signature !== signature) throw new Error('Submission identity differs from the signed transaction.');
        if (reported.state === 'FINALIZED' || reported.state === 'FAILED') {
          savePending(wallet, null);
          return { state: reported.state, requestId, signature, reason: reported.error?.code === 'REQUOTE_REQUIRED' ? 'REQUOTE_REQUIRED' : reported.error?.message };
        }
        if (reported.state === 'SUBMITTED' || reported.state === 'CONFIRMED') onProgress?.(reported.state);
      } catch { return { state: 'UNKNOWN', reason: 'Submission report was not acknowledged.', requestId, signature }; }
      const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
      for (let i = 0; i < (options.pollAttempts ?? 8); i++) {
        if (!sameWallet(wallet, options.getWallet())) return { state: 'UNKNOWN', reason: 'Wallet changed during finality check.', requestId, signature };
        try {
          const operation = await request<Operation>(`/operations/${encodeURIComponent(requestId)}?wallet=${encodeURIComponent(wallet.address)}`, wallet, {}, session);
          if (operation.requestId === requestId && operation.wallet === wallet.address && operation.action === quoteValue.intent.action && operation.signature === signature) {
            if (operation.state === 'FINALIZED' || operation.state === 'FAILED') {
              savePending(wallet, null);
              return { state: operation.state, requestId, signature, reason: operation.error?.code === 'REQUOTE_REQUIRED' ? 'REQUOTE_REQUIRED' : operation.error?.message };
            }
            if (operation.state === 'SUBMITTED' || operation.state === 'CONFIRMED') onProgress?.(operation.state);
          }
        } catch { /* A status read cannot establish failure or finality. */ }
        if (i + 1 < (options.pollAttempts ?? 8)) await wait(1200);
      }
      return { state: 'UNKNOWN', reason: 'Finality is not established. Recheck this request.', requestId, signature };
    } catch (error) {
      timing('execute.failed', quoteValue.expiresAt - now());
      return { state: 'AWAITING_SIGNATURE', reason: error instanceof Error ? error.message : 'Financial preparation failed.', requestId, signature: null };
    } finally { active = false; }
  }

  async function execute(quoteValue: FinancialQuote, onProgress?: (state: FinancialProgress) => void): Promise<FinancialOutcome> {
    const failure = await prepareQuote(quoteValue, onProgress);
    return failure ?? signReviewed(quoteValue, onProgress);
  }
  function cancelReview(quoteValue: FinancialQuote) { verified.delete(quoteValue); quoted.delete(quoteValue.id); }

  async function recheck(): Promise<FinancialOutcome> {
    const wallet = options.getWallet();
    if (!wallet) throw new Error('Connect the original wallet to recheck.');
    if (active) throw new Error('Another financial action is in progress.');
    const p = pending(wallet);
    if (!p) throw new Error('No pending financial request for this wallet.');
    active = true;
    try {
      const operation = await request<Operation>(`/operations/${encodeURIComponent(p.requestId)}?wallet=${encodeURIComponent(wallet.address)}`, wallet);
      if (operation.requestId !== p.requestId || operation.wallet !== p.wallet || operation.action !== p.action || (p.signature && operation.signature !== p.signature)) throw new Error('Operation identity does not match the pending request.');
      if (operation.state === 'FINALIZED' || operation.state === 'FAILED') {
        if (!operation.signature && !(operation.state==='FAILED' && operation.error?.code==='REQUOTE_REQUIRED' && !p.signature)) throw new Error('Final operation has no transaction signature.');
        savePending(wallet, null);
        return { state: operation.state, requestId: p.requestId, signature: operation.signature, reason: operation.error?.code === 'REQUOTE_REQUIRED' ? 'REQUOTE_REQUIRED' : operation.error?.message };
      }
      const next = { ...p, signature: operation.signature ?? p.signature };
      savePending(wallet, next);
      return { state: 'UNKNOWN', reason: `Operation is ${operation.state}.`, requestId: p.requestId, signature: next.signature };
    } finally { active = false; }
  }

  return { portfolio, vault, quote, prepareQuote, signReviewed, cancelReview, execute, recheck, pending, canExecute };
}
