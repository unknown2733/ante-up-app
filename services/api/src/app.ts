import type { ApiError, Envelope, FreeRecord, MarketView, Mode, OpenPreview, OperationSubmission, ProofStatus, PublicProfile } from '../../../contracts/types.ts';
import { ChallengeStore, decodeBase58, Ed25519Verifier, type SignatureVerifier } from './auth.ts';
import { fixtureMarkets, fixtureProofs, fixtureRecords, heldCalculationWallets } from './fixture.ts';
import { leaderboard, profile } from './leaderboard.ts';
import { InputError, validateActionBody, validateMarket, validateOperation, validateProof, validateRecord } from './validate.ts';
import { OperationStore } from '../../indexer/src/index.ts';
import { freeReturn } from '../../../contracts/reference.mjs';
import { notExecutable, validateCompiledFree, validatePreparedForWallet, type TransactionAdapter } from './transaction.ts';
import { LiveStore } from './live-store.ts';
import { reconcileLiveOperation, verifyReceipt, type OperationChain } from './operation-chain.ts';
import { financialIntentKey, financialQuoteKey, validateFinancialIntent, validateFinancialPortfolio, validateFinancialQuote, validateFinancialVault, validatePreparedFinancial, type FinancialReader, type FinancialTransactionAdapter } from './financial.ts';
import type { FinancialPrepareRequest } from '../../../contracts/financial.ts';
import { ExistingMarket } from './registration.ts';
import { createConsumerApiRoutes, type ConsumerApiBindings } from './consumer-api.ts';
import { consumerLiveNamespace } from '../../../contracts/consumer-identity.ts';
import type { VisitorSolFaucet } from './visitor-faucet.ts';

export interface ReadAdapter {
  mode?: Mode;
  markets(): Promise<MarketView[]>;
  records(): Promise<FreeRecord[]>;
  proofs(): Promise<ProofStatus[]>;
  heldCalculationWallets(): Promise<Set<string>>;
}
export interface AdminAuthorizer { canManage(wallet: string, action: string): Promise<boolean> }
export const denyAdmin: AdminAuthorizer = { async canManage() { return false; } };
export class FixtureReadAdapter implements ReadAdapter {
  readonly mode = 'fixture' as const;
  private now: () => number;
  constructor(now: () => number) { this.now = now; }
  async markets() {
    const markets = structuredClone(fixtureMarkets);
    const snapshot = markets[0].snapshot;
    if (snapshot) { snapshot.payload.dataThrough = this.now() - 60; snapshot.payload.computedAt = this.now() - 45; snapshot.publishedAt = this.now() - 30; }
    return markets;
  }
  async records() { return fixtureRecords(this.now()); }
  async proofs() { return structuredClone(fixtureProofs); }
  async heldCalculationWallets() { return new Set(heldCalculationWallets); }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const errorStatus: Record<string, number> = { INVALID_INPUT: 400, UNAUTHORIZED: 403, ALREADY_EXECUTED: 409, PENDING_CONFIRMATION: 409, REQUOTE_REQUIRED: 409, DATA_NOT_READY: 409, ENTRY_PAUSED: 409, LIMIT_REACHED: 409, WRONG_PHASE: 409, LP_WINDOW_CLOSED: 409 };
const fail = (code: ApiError['code'], message: string, requestId: string | null = null) => json({ code, message, retryable: code === 'PENDING_CONFIRMATION', requestId } satisfies ApiError, errorStatus[code] ?? 400);

async function parseBody(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (raw.length > 32_768) throw new InputError('body too large');
  try { return JSON.parse(raw); } catch { throw new InputError('invalid JSON'); }
}
const reduceReturn = (numerator: bigint, denominator: bigint) => {
  let a = numerator < 0n ? -numerator : numerator, b = denominator;
  while (b) [a, b] = [b, a % b];
  return { numerator: (numerator / a).toString(), denominator: (denominator / a).toString() };
};
const page = <T>(items: T[], url: URL): { items: T[]; nextCursor: string | null } => {
  const limitParam = url.searchParams.get('limit') ?? '20';
  const cursorParam = url.searchParams.get('cursor') ?? '0';
  if (!/^[1-9][0-9]*$/.test(limitParam) || !/^(0|[1-9][0-9]*)$/.test(cursorParam)) throw new InputError('invalid pagination');
  const limit = Number(limitParam), offset = Number(cursorParam);
  if (!Number.isSafeInteger(offset) || limit > 100) throw new InputError('pagination out of range');
  return { items: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? String(offset + limit) : null };
};

export function createApp(options: {
  now?: () => number; mode?: Mode; read?: ReadAdapter; verifier?: SignatureVerifier;
  admin?: AdminAuthorizer; transactions?: TransactionAdapter; operations?: OperationStore;
  liveStore?: LiveStore; chain?: OperationChain; programId?: string; financial?: FinancialReader; financialTransactions?: FinancialTransactionAdapter;
  finalizeRegistration?: (requestId:string)=>Promise<void>;
  consumer?: ConsumerApiBindings;
  visitorSol?: VisitorSolFaucet;
} = {}) {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const mode = options.mode ?? 'fixture';
  const selectedRead = options.read ?? (mode === 'fixture' ? new FixtureReadAdapter(now) : null);
  if (!selectedRead || (selectedRead.mode && selectedRead.mode !== mode) || (mode !== 'fixture' && selectedRead.mode !== mode)) throw new Error('READ_ADAPTER_MODE_MISMATCH');
  const read: ReadAdapter = selectedRead;
  if (mode !== 'fixture' && (!options.liveStore || !options.chain || !options.programId)) throw new Error('LIVE_ADAPTERS_REQUIRED');
  if (options.consumer && mode !== 'devnet') throw new Error('CONSUMER_DEVNET_ONLY');
  if (options.consumer && options.consumer.namespace !== consumerLiveNamespace('devnet', options.programId!))
    throw new Error('CONSUMER_NAMESPACE_MISMATCH');
  const envelope = <T>(data: T, asOf: number, nextCursor: string | null = null): Envelope<T> => ({ schemaVersion: '0.1', mode, asOf, data, nextCursor });
  const challenges = new ChallengeStore(options.verifier ?? new Ed25519Verifier());
  const verifier = options.verifier ?? new Ed25519Verifier();
  const operations = options.operations ?? new OperationStore();
  const admin = options.admin ?? denyAdmin;
  const audit: Array<{ at: number; wallet: string; action: string; allowed: boolean }> = [];

  async function signed(request: Request, wallet: string): Promise<boolean> {
    const bearer = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.get('authorization') ?? '');
    if (bearer && mode !== 'fixture') return options.liveStore!.authenticate(bearer[1],wallet,mode,now());
    const nonce = request.headers.get('x-ante-nonce');
    const signature = request.headers.get('x-ante-signature');
    return !!nonce && !!signature && challenges.consume(wallet, nonce, signature, now(), mode === 'fixture' ? undefined : mode);
  }
  const consumerRoutes = options.consumer ? createConsumerApiRoutes(options.consumer) : null;

  async function handle(request: Request): Promise<Response> {
    const asOf = now();
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'v1') return fail('INVALID_INPUT', 'unknown route');
    try {
      const consumerResponse = await consumerRoutes?.(request, asOf, signed);
      if (consumerResponse) return consumerResponse;
      if (parts[1] === 'visitor-sol') {
        if (mode !== 'devnet' || !options.visitorSol) return fail('DATA_NOT_READY', 'Devnet SOL balance service is unavailable');
        if (request.method === 'GET' && parts.length === 3 && parts[2] === 'readiness') {
          const wallet = url.searchParams.get('wallet');
          if (!wallet || decodeBase58(wallet).length !== 32) throw new InputError('wallet must be a Solana address');
          return json(envelope(await options.visitorSol.readiness(wallet), asOf));
        }
        if (request.method === 'POST' && parts.length === 3 && parts[2] === 'claims') {
          const body = await parseBody(request) as Record<string, unknown> | null;
          if (!body || typeof body.wallet !== 'string' || typeof body.requestId !== 'string' ||
              decodeBase58(body.wallet).length !== 32) throw new InputError('wallet and requestId required');
          if (!(await signed(request, body.wallet))) return fail('UNAUTHORIZED', 'wallet signature required', body.requestId);
          return json(envelope(await options.visitorSol.claim({wallet:body.wallet,authenticatedWallet:body.wallet,requestId:body.requestId}), asOf));
        }
        if (request.method === 'GET' && parts.length === 4 && parts[2] === 'claims') {
          const wallet = url.searchParams.get('wallet');
          if (!wallet || decodeBase58(wallet).length !== 32 || !(await signed(request, wallet)))
            return fail('UNAUTHORIZED', 'wallet signature required', parts[3]);
          return json(envelope(await options.visitorSol.reconcile(parts[3], wallet), asOf));
        }
      }
      if (parts[1] === 'financial') {
        if (request.method === 'GET' && parts.length === 3 && parts[2] === 'portfolio') {
          const wallet = url.searchParams.get('wallet');
          if (!wallet || !(await signed(request, wallet))) return fail('UNAUTHORIZED', 'portfolio owner required');
          if (mode === 'fixture' || !options.financial) return fail('DATA_NOT_READY', 'financial chain reader unavailable');
          return json(envelope(validateFinancialPortfolio(await options.financial.portfolio(wallet), {wallet,cluster:mode,programId:options.programId!}),asOf));
        }
        if (request.method === 'GET' && parts.length === 4 && parts[2] === 'vaults') {
          if (mode === 'fixture' || !options.financial) return fail('DATA_NOT_READY', 'financial chain reader unavailable');
          const marketId = decodeURIComponent(parts[3]);
          return json(envelope(validateFinancialVault(await options.financial.vault(marketId), {marketId,cluster:mode,programId:options.programId!}),asOf));
        }
        if (request.method === 'POST' && parts.length === 3 && parts[2] === 'quotes') {
          const intent = validateFinancialIntent(await parseBody(request));
          if (!(await signed(request,intent.wallet))) return fail('UNAUTHORIZED','wallet signature required',intent.requestId);
          if (mode === 'fixture' || !options.financial || !options.financialTransactions) return json(envelope(notExecutable(mode === 'fixture' ? 'FIXTURE_NO_CHAIN_ADAPTER' : 'FINANCIAL_CHAIN_ADAPTER_NOT_CONFIGURED'),asOf));
          const existing = options.liveStore!.getFinancialQuote(intent.requestId,{cluster:mode,programId:options.programId!});
          if (existing) {
            if (financialIntentKey(existing.intent) !== financialIntentKey(intent)) return fail('ALREADY_EXECUTED','request identity changed',intent.requestId);
            if (existing.expiresAt <= asOf) return fail('REQUOTE_REQUIRED','financial quote expired',intent.requestId);
            return json(envelope({kind:'quote',quote:existing},asOf));
          }
          const market = intent.marketId ? (await read.markets()).map(validateMarket).find(m => m.id === intent.marketId) ?? null : null;
          if (intent.marketId && !market) return fail('INVALID_INPUT','market not found',intent.requestId);
          const quoted = await options.financial.quote(intent,market,asOf);
          if (!quoted) return json(envelope(notExecutable('FINANCIAL_CHAIN_STATE_NOT_READY'),asOf));
          const quoteAsOf = now();
          const quote = validateFinancialQuote(quoted,intent,market,{cluster:mode,programId:options.programId!,now:quoteAsOf});
          return json(envelope({kind:'quote',quote:options.liveStore!.saveFinancialQuote(quote,mode,options.programId!)},quoteAsOf));
        }
        if (request.method === 'POST' && parts.length === 4 && parts[2] === 'transactions' && parts[3] === 'prepare') {
          const body = await parseBody(request) as Partial<FinancialPrepareRequest> | null;
          if (!body || typeof body.wallet !== 'string' || typeof body.requestId !== 'string' || typeof body.quoteId !== 'string') throw new InputError('wallet, requestId and quoteId required');
          if (!(await signed(request,body.wallet))) return fail('UNAUTHORIZED','wallet signature required',body.requestId);
          if (mode === 'fixture') return json(envelope(notExecutable('FIXTURE_NO_CHAIN_ADAPTER'),asOf));
          const quote = options.liveStore!.getFinancialQuote(body.requestId,{cluster:mode,programId:options.programId!});
          if (!quote || quote.id !== body.quoteId || quote.intent.wallet !== body.wallet) return fail('REQUOTE_REQUIRED','financial quote missing or changed',body.requestId);
          if (quote.expiresAt <= asOf) return fail('REQUOTE_REQUIRED','financial quote expired',body.requestId);
          const existing=options.liveStore!.get(body.requestId);
          if (existing) {
            if (existing.kind!=='financial' || financialQuoteKey(existing.prepared.quote)!==financialQuoteKey(quote)) return fail('ALREADY_EXECUTED','request identity changed',body.requestId);
            if (existing.prepared.expiresAt<=asOf) return fail('REQUOTE_REQUIRED','prepared transaction expired',body.requestId);
            return json(envelope(existing.prepared,asOf));
          }
          if (!options.financialTransactions) return json(envelope(notExecutable('FINANCIAL_TRANSACTION_ADAPTER_NOT_CONFIGURED'),asOf));
          const built=await validatePreparedFinancial(await options.financialTransactions.prepare(quote),quote,options.financialTransactions,{cluster:mode,programId:options.programId!,now:asOf});
          const stored=options.liveStore!.saveFinancial(quote.intent,built.prepared,built.discoveryAddress,built.messageBase64);
          return json(envelope(stored.prepared,asOf));
        }
        if ((request.method === 'GET' && parts.length === 4 && parts[2] === 'operations') ||
            (request.method === 'POST' && parts.length === 5 && parts[2] === 'operations' && parts[4] === 'submit')) {
          if (mode === 'fixture' || options.liveStore!.get(parts[3])?.kind!=='financial') return fail('INVALID_INPUT','financial operation not found',parts[3]);
          const forwarded = new URL(request.url);
          forwarded.pathname = `/v1/operations/${encodeURIComponent(parts[3])}${parts[4] === 'submit' ? '/submit' : ''}`;
          return handle(new Request(forwarded, {method:request.method,headers:request.headers,body:request.method === 'POST' ? await request.text() : undefined}));
        }
      }
      if (request.method === 'GET' && parts.length === 2 && parts[1] === 'markets') {
        const markets = (await read.markets()).map(validateMarket);
        const p = page(markets, url);
        return json(envelope(p.items, asOf, p.nextCursor));
      }
      if (request.method === 'GET' && parts[1] === 'markets' && parts[2]) {
        const market = (await read.markets()).map(validateMarket).find(m => m.id === decodeURIComponent(parts[2]));
        if (!market) return fail('INVALID_INPUT', 'market not found');
        if (parts.length === 3) return json(envelope(market, asOf));
        if (parts.length === 4 && parts[3] === 'snapshots') return json(envelope(market.snapshot ? [market.snapshot] : [], asOf));
      }
      if (request.method === 'GET' && parts.length === 3 && parts[1] === 'records') {
        const record = (await read.records()).map(validateRecord).find(r => r.id === decodeURIComponent(parts[2]));
        return record ? json(envelope(record, asOf)) : fail('INVALID_INPUT', 'record not found');
      }
      if (request.method === 'GET' && parts.length === 3 && parts[1] === 'proofs') {
        const proofId = decodeURIComponent(parts[2]);
        const proof = (await read.proofs()).map(validateProof).find(p => p.id === proofId) ?? null;
        return json(envelope(proof, asOf));
      }
      if (request.method === 'GET' && parts.length === 3 && parts[1] === 'profiles') {
        const wallet = decodeURIComponent(parts[2]);
        const records = (await read.records()).map(validateRecord);
        const held = await read.heldCalculationWallets();
        const data = profile(records, wallet, held);
        const markets = (await read.markets()).map(validateMarket);
        const openPreviews = data.openRecords.map<OpenPreview>(record => {
          const market = markets.find(m => m.id === record.marketId);
          const snapshot = market?.snapshot;
          const entry = record.entry.h;
          if (!entry || !snapshot || snapshot.finality !== 'finalized' || !['VALID','LOW_ACTIVITY'].includes(market?.dataStatus??'') || asOf - snapshot.payload.dataThrough >= 600 || !snapshot.payload.activityNowQ12 || !snapshot.payload.activity7dQ12 || BigInt(snapshot.payload.activity7dQ12) === 0n) {
            return { recordId: record.id, referenceReturn: null, status: 'UNAVAILABLE', observedAt: snapshot?.payload.dataThrough ?? null };
          }
          const currentNum = BigInt(snapshot.payload.activityNowQ12);
          const currentDen = BigInt(snapshot.payload.activity7dQ12);
          const cappedNum = currentNum > 5n * currentDen ? 5n * currentDen : currentNum;
          try {
            const value = freeReturn(BigInt(entry.numerator), BigInt(entry.denominator), cappedNum, currentDen) as unknown as { numerator: bigint; denominator: bigint };
            return { recordId: record.id, referenceReturn: reduceReturn(value.numerator, value.denominator), status: 'REFERENCE', observedAt: snapshot.payload.dataThrough };
          } catch { return { recordId: record.id, referenceReturn: null, status: 'UNAVAILABLE', observedAt: snapshot.payload.dataThrough }; }
        });
        const publicProfile: PublicProfile = { ...data, openPreviews };
        return json(envelope(publicProfile, asOf));
      }
      if (request.method === 'GET' && parts.length === 2 && parts[1] === 'leaderboard') {
        const period = url.searchParams.get('period') ?? '7d';
        if (period !== '7d' && period !== 'all') throw new InputError('period must be 7d or all');
        const result = leaderboard((await read.records()).map(validateRecord), period, asOf, await read.heldCalculationWallets());
        const p = page(result.rows, url);
        return json(envelope({ period, rows: p.items, heldWallets: result.heldWallets }, asOf, p.nextCursor));
      }
      if (request.method === 'GET' && parts.length === 3 && parts[1] === 'operations') {
        const liveOperation = mode === 'fixture' ? null : options.liveStore!.get(parts[2]);
        const operation = mode === 'fixture' ? operations.get(parts[2]) : liveOperation?.operation ?? null;
        if (!operation) return fail('INVALID_INPUT', 'operation not found', parts[2]);
        if (liveOperation && (liveOperation.prepared.cluster !== mode || liveOperation.prepared.programId !== options.programId)) return fail('UNAUTHORIZED','operation network mismatch',parts[2]);
        const wallet = url.searchParams.get('wallet') ?? request.headers.get('x-ante-wallet');
        if (wallet !== operation.wallet || !(await signed(request, wallet))) return fail('UNAUTHORIZED', 'wallet signature required', parts[2]);
        const current = mode === 'fixture' ? operation : await reconcileLiveOperation(options.liveStore!,options.chain!,parts[2],asOf);
        if (current.state==='FINALIZED' && liveOperation?.kind==='financial' && liveOperation.intent.action==='registerMarket') {
          try {await options.finalizeRegistration?.(parts[2]);} catch { /* Keep receipt visible; retry metadata verification on next read. */ }
        }
        return json(envelope(validateOperation(current), asOf));
      }
      if (request.method === 'POST' && parts.length === 2 && parts[1] === 'auth') {
        const body = await parseBody(request) as Record<string, unknown>;
        if (!body || typeof body.wallet !== 'string' || (body.cluster !== 'localnet' && body.cluster !== 'devnet')) throw new InputError('wallet and cluster required');
        if (mode !== 'fixture' && body.cluster !== mode) return fail('UNAUTHORIZED','cluster mismatch');
        if (decodeBase58(body.wallet).length !== 32) throw new InputError('wallet must be Solana address');
        return json(envelope(mode === 'fixture' ? challenges.issue(body.wallet, body.cluster, asOf) : options.liveStore!.issue(body.wallet,body.cluster,asOf), asOf));
      }
      if (request.method === 'POST' && parts.length === 3 && parts[1] === 'auth' && parts[2] === 'session') {
        if (mode === 'fixture') return fail('INVALID_INPUT','session unavailable in fixture');
        const body = await parseBody(request) as Record<string, unknown>;
        if (!body || typeof body.wallet !== 'string' || body.cluster !== mode || typeof body.nonce !== 'string' || typeof body.signature !== 'string') throw new InputError('session identity required');
        const session = await options.liveStore!.exchange({wallet:body.wallet,cluster:mode,nonce:body.nonce,signature:body.signature},asOf,verifier);
        return session ? json(envelope(session,asOf)) : fail('UNAUTHORIZED','invalid or used challenge');
      }
      if (request.method === 'POST' && parts.length === 2 && (parts[1] === 'quotes' || parts[1] === 'transactions')) {
        // /transactions/prepare is handled below; /transactions itself is intentionally absent.
        if (parts[1] === 'transactions') return fail('INVALID_INPUT', 'unknown route');
        const body = validateActionBody(await parseBody(request));
        if (!(await signed(request, body.wallet))) return fail('UNAUTHORIZED', 'wallet signature required', body.requestId);
        if (!(await read.markets()).some(m => m.id === body.marketId)) return fail('INVALID_INPUT', 'market not found', body.requestId);
        return json(envelope(notExecutable(mode === 'fixture' ? 'FIXTURE_NO_CHAIN_ADAPTER' : 'CHAIN_ADAPTER_NOT_CONFIGURED'), asOf));
      }
      if (request.method === 'POST' && parts.length === 3 && parts[1] === 'transactions' && parts[2] === 'prepare') {
        const body = validateActionBody(await parseBody(request));
        if (!(await signed(request, body.wallet))) return fail('UNAUTHORIZED', 'wallet signature required', body.requestId);
        if (!(await read.markets()).some(m => m.id === body.marketId)) return fail('INVALID_INPUT', 'market not found', body.requestId);
        if (mode === 'fixture') return json(envelope(notExecutable('FIXTURE_NO_CHAIN_ADAPTER'),asOf));
        if (body.action !== 'openFree' && body.action !== 'closeFree') return json(envelope(notExecutable('UNSUPPORTED_ACTION'),asOf));
        if (!options.transactions) return json(envelope(notExecutable('CHAIN_ADAPTER_NOT_CONFIGURED'),asOf));
        const existing = options.liveStore!.get(body.requestId);
        if (existing) {
          if (JSON.stringify(existing.intent) !== JSON.stringify(body)) return fail('ALREADY_EXECUTED','request identity changed',body.requestId);
          if (existing.prepared.expiresAt <= asOf) return fail('REQUOTE_REQUIRED','prepared transaction expired',body.requestId);
          return json(envelope(existing.prepared,asOf));
        }
        const candidate = await options.transactions.prepare(body);
        // RPC reads can cross a second boundary. Validate the returned lifetime
        // against completion time, rather than the older request-start time.
        const prepared = validatePreparedForWallet(candidate,body,{cluster:mode,programId:options.programId!,now:now()});
        const messageBase64=await validateCompiledFree(prepared,body);
        const stored = options.liveStore!.save(body,prepared,messageBase64);
        if (stored.prepared.expiresAt <= now()) return fail('REQUOTE_REQUIRED','prepared transaction expired',body.requestId);
        return json(envelope(stored.prepared,asOf));
      }
      if (request.method === 'POST' && parts.length === 4 && parts[1] === 'operations' && parts[3] === 'submit') {
        if (mode === 'fixture') return fail('INVALID_INPUT','submission unavailable in fixture',parts[2]);
        const body = await parseBody(request) as Partial<OperationSubmission> | null;
        if (!body || typeof body.wallet !== 'string' || typeof body.signature !== 'string' || decodeBase58(body.signature).length !== 64) throw new InputError('wallet and transaction signature required');
        const stored = options.liveStore!.get(parts[2]);
        if (!stored || stored.prepared.cluster !== mode || stored.prepared.programId !== options.programId || stored.operation.wallet !== body.wallet || !(await signed(request,body.wallet))) return fail('UNAUTHORIZED','operation owner required',parts[2]);
        if (stored.operation.signature && stored.operation.signature !== body.signature) return fail('ALREADY_EXECUTED','different signature already claimed',parts[2]);
        const receipt = await options.chain!.get(body.signature);
        if (receipt) verifyReceipt(stored,body.signature,receipt);
        options.liveStore!.claim(parts[2],body.signature);
        const current = receipt ? options.liveStore!.mark(parts[2],receipt.status === 'failed' ? 'FAILED' : receipt.status === 'finalized' ? 'FINALIZED' : 'CONFIRMED').operation : options.liveStore!.get(parts[2])!.operation;
        if (current.state==='FINALIZED' && stored.kind==='financial' && stored.intent.action==='registerMarket') {
          try {await options.finalizeRegistration?.(parts[2]);} catch { /* Operation stays finalized; market metadata waits for verified account. */ }
        }
        return json(envelope(validateOperation(current),asOf));
      }
      if (request.method === 'POST' && parts.length === 3 && parts[1] === 'faucet' && parts[2] === 'claims') {
        return fail('PENDING_CONFIRMATION', 'faucet has no configured live adapter');
      }
      if (request.method === 'POST' && parts.length === 3 && parts[1] === 'admin' && parts[2] === 'actions') {
        const body = await parseBody(request) as Record<string, unknown>;
        if (!body || typeof body.wallet !== 'string' || typeof body.action !== 'string') throw new InputError('wallet and action required');
        const authenticated = await signed(request, body.wallet);
        const allowed = authenticated && await admin.canManage(body.wallet, body.action);
        audit.push({ at: asOf, wallet: body.wallet, action: body.action, allowed });
        return fail('UNAUTHORIZED', allowed ? 'admin execution adapter unavailable' : 'admin role required');
      }
      return fail('INVALID_INPUT', 'unknown route');
    } catch (e) {
      if (e instanceof InputError || e instanceof SyntaxError) return fail('INVALID_INPUT', e.message);
      if (e instanceof ExistingMarket) return fail('ALREADY_EXECUTED',`existing market: ${e.marketAddress}`);
      if (e instanceof Error && (e.message === 'INVALID_INPUT' || e.message === 'ALREADY_EXECUTED' || e.message === 'DATA_NOT_READY' || e.message === 'ENTRY_PAUSED' || e.message === 'LIMIT_REACHED' || e.message === 'REQUOTE_REQUIRED' || e.message === 'WRONG_PHASE' || e.message === 'LP_WINDOW_CLOSED')) return fail(e.message, e.message==='ENTRY_PAUSED'?'New chips are temporarily paused. Existing chips can still be taken back.':e.message==='LIMIT_REACHED'?'The shared chip limit has been reached. Existing chips can still be taken back.':e.message);
      return fail('INVALID_INPUT', 'request could not be processed');
    }
  }
  return { handle, audit, operations };
}
