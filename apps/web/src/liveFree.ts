import { ANTE_UP_PROGRAM_ADDRESS } from '@ante-up/chain-client';
import { getBase64Decoder } from '@solana/kit';
import type { Envelope, MarketView, Operation, PreparedTransaction, WalletSession, PublicProfile } from '../../../contracts/types';
import { createFreeProjectionGate } from './freeProjection';
import { sendPreparedTransaction } from './transactionBoundary';
import type { Cluster, ExecutablePrepare, SendResult, WalletContext } from './transactionBoundary';

type FreeAction = 'openFree' | 'closeFree';
type Challenge = { nonce: string; expiresAt: number; message: string };
export type FreeProgress = 'AUTH' | 'PREPARING' | 'AWAITING_SIGNATURE' | 'SUBMITTED' | 'CONFIRMED';
export type FreeOutcome = (
  | { state: 'UNAVAILABLE' | 'BUSY' | 'AWAITING_SIGNATURE'; reason: string; requestId: string | null; signature: null }
  | { state: 'SUBMITTED' | 'CONFIRMED' | 'FINALIZED'; reason?: string; requestId: string; signature: string }
  | { state: 'FAILED'; reason?: string; requestId: string; signature: string | null }
  | { state: 'UNKNOWN'; reason: string; requestId: string; signature: string | null }) & { recordId?: string };
export interface FreeRequest { market: MarketView; action: FreeAction; recordId: string | null }
/** Opaque, one-use review handle. Transaction bytes and authentication stay in this flow. */
export interface FreeReview { readonly requestId: string; readonly expiresAt: number; readonly action: FreeAction }
export type FreePreparation = { state: 'PREPARED'; review: FreeReview } | FreeOutcome;
export interface FreeFlowOptions {
  baseUrl: string;
  getWallet(): WalletContext | null;
  canSignMessage(wallet: WalletContext): boolean;
  signMessage(bytes: Uint8Array, wallet: WalletContext): Promise<Uint8Array>;
  fetcher?: typeof fetch;
  nowSeconds?: () => number;
  onServerTime?: (asOf:number, requestStarted:number) => void;
  requestId?: () => string;
  wait?: (milliseconds: number) => Promise<void>;
  pollAttempts?: number;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('API response shape is invalid.');
  return value as Record<string, unknown>;
}
function matchingWallet(expected: WalletContext, current: WalletContext | null) {
  return !!current && expected.address === current.address && expected.cluster === current.cluster && expected.signer === current.signer;
}
function operationMatches(operation: Operation, expected: { wallet: string; action: FreeAction; requestId: string; signature: string | null }) {
  return operation.wallet === expected.wallet && operation.action === expected.action && operation.requestId === expected.requestId && (!expected.signature || operation.signature === expected.signature);
}

/** Concrete HTTP/session adapter. Its fetch, wallet and clock are injectable for deterministic tests. */
export function createLiveFreeFlow(options: FreeFlowOptions) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const newRequestId = options.requestId ?? (() => crypto.randomUUID());
  const origin = options.baseUrl.replace(/\/$/, '');
  let session: WalletSession | null = null;
  let sessionGeneration = 0;
  const active = new Set<string>();
  const uncertain = new Map<string, FreeOutcome>();
  const reviews = new Map<FreeReview, { requestValue: FreeRequest; wallet: WalletContext; authorized: WalletSession; executable: ExecutablePrepare }>();
  const projection = createFreeProjectionGate(options.storage ?? (typeof sessionStorage === 'undefined' ? undefined : sessionStorage));
  const identity = (wallet: WalletContext, marketId: string) => ({ wallet: wallet.address, cluster: wallet.cluster, marketId });
  const projectionPending = (marketId: string, wallet: WalletContext | null) => wallet ? projection.pending(identity(wallet, marketId)) : null;
  const observeProfile = (marketId: string, wallet: WalletContext | null, profile: PublicProfile | null) => wallet ? projection.observe(identity(wallet, marketId), profile) : false;

  function clearSession() { session = null; sessionGeneration++; reviews.clear(); }
  function requireWallet(wallet: WalletContext) {
    if (!matchingWallet(wallet, options.getWallet())) { clearSession(); throw new Error('Wallet or cluster changed.'); }
  }
  async function request<T>(path: string, init: RequestInit, cluster: Cluster): Promise<Envelope<T>> {
    const requestStarted=performance.now();
    const response = await fetcher(`${origin}/v1${path}`, { ...init, headers: { Accept: 'application/json', ...init.headers }, cache: 'no-store' });
    const raw: unknown = await response.json();
    if (!response.ok) {
      const error = object(raw);
      throw new Error(typeof error.message === 'string' ? error.message : `API request failed (${response.status}).`);
    }
    const envelope = object(raw);
    if (envelope.schemaVersion !== '0.1' || envelope.mode !== cluster || !Number.isSafeInteger(envelope.asOf) || envelope.nextCursor !== null || !('data' in envelope)) throw new Error('API mode or envelope does not match the wallet cluster.');
    options.onServerTime?.(envelope.asOf as number,requestStarted);
    return envelope as unknown as Envelope<T>;
  }
  const jsonBody = (value: unknown) => JSON.stringify(value);
  const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  async function authorize(wallet: WalletContext): Promise<WalletSession> {
    requireWallet(wallet);
    if (session && session.wallet === wallet.address && session.cluster === wallet.cluster && session.expiresAt > now() + 30) return session;
    clearSession();
    const generation = sessionGeneration;
    const challengePage = await request<Challenge>('/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: jsonBody({ wallet: wallet.address, cluster: wallet.cluster }) }, wallet.cluster);
    requireWallet(wallet);
    const challenge = object(challengePage.data);
    if (typeof challenge.nonce !== 'string' || !challenge.nonce || !Number.isSafeInteger(challenge.expiresAt) || (challenge.expiresAt as number) <= now() || (challenge.expiresAt as number) > now() + 300) throw new Error('Wallet challenge is invalid or expired.');
    const expectedMessage = `Ante Up API v1\ncluster:${wallet.cluster}\nwallet:${wallet.address}\nnonce:${challenge.nonce}\nexpiresAt:${challenge.expiresAt}`;
    if (challenge.message !== expectedMessage) throw new Error('Wallet challenge text does not match this session.');
    const signature = await options.signMessage(new TextEncoder().encode(expectedMessage), wallet);
    requireWallet(wallet);
    if (signature.length !== 64) throw new Error('Wallet returned an invalid message signature.');
    const sessionPage = await request<WalletSession>('/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: jsonBody({ wallet: wallet.address, cluster: wallet.cluster, nonce: challenge.nonce, signature: getBase64Decoder().decode(signature) }) }, wallet.cluster);
    requireWallet(wallet);
    const received = object(sessionPage.data);
    if (generation !== sessionGeneration || typeof received.token !== 'string' || !received.token || received.wallet !== wallet.address || received.cluster !== wallet.cluster || !Number.isSafeInteger(received.expiresAt) || (received.expiresAt as number) <= now() || (received.expiresAt as number) > now() + 900) throw new Error('Wallet session response is invalid.');
    session = received as unknown as WalletSession;
    return session;
  }

  function supportReason(requestValue: FreeRequest, wallet: WalletContext | null, rechecking = false): string | null {
    if (!wallet) return 'Connect a Solana wallet.';
    if (!rechecking && !wallet.signer) return 'This wallet cannot sign and send transactions.';
    if (!options.canSignMessage(wallet)) return 'This wallet cannot sign an API authentication message.';
    const { market, action, recordId } = requestValue;
    if (!rechecking && projectionPending(market.id, wallet)) return 'Your chip action is finalized but has not appeared in your activity yet. Refresh your activity before trying again.';
    if (!market.chain || market.chain.cluster !== wallet.cluster || market.chain.programId !== ANTE_UP_PROGRAM_ADDRESS || market.chain.address !== market.id) return 'The market chain configuration does not match your wallet network.';
    if (!rechecking && market.capabilities[action]?.allowed !== true) return 'Chip participation is not currently available for this market.';
    if (action === 'closeFree' && !recordId) return 'No active chip record is available to take back.';
    if (action === 'openFree' && recordId) return 'You already have an active chip for this market.';
    return null;
  }
  const keyFor = (wallet: WalletContext, requestValue: FreeRequest) => `${wallet.cluster}:${wallet.address}:${requestValue.market.id}:${requestValue.action}`;

  async function prepare(requestValue: FreeRequest, onProgress?: (state: FreeProgress) => void): Promise<FreePreparation> {
    const wallet = options.getWallet();
    const unsupported = supportReason(requestValue, wallet);
    if (unsupported || !wallet) return { state: 'UNAVAILABLE', reason: unsupported ?? 'Wallet unavailable.', requestId: null, signature: null };
    const key = keyFor(wallet, requestValue);
    if (active.size > 0) return { state: 'BUSY', reason: 'Waiting for your earlier wallet request. Open the wallet to approve or cancel it. If it does not respond, cancel the pending request in the wallet, refresh this page, and check your activity.', requestId: null, signature: null };
    const previous = uncertain.get(key);
    if (previous) return previous;
    reviews.clear();
    active.add(key);
    const requestId = newRequestId();
    try {
      onProgress?.('AUTH');
      const authorized = await authorize(wallet);
      requireWallet(wallet);
      onProgress?.('PREPARING');
      const body = { wallet: wallet.address, action: requestValue.action, requestId, marketId: requestValue.market.id, recordId: requestValue.recordId };
      const preparePage = await request<PreparedTransaction>('/transactions/prepare', { method: 'POST', headers: authHeaders(authorized.token), body: jsonBody(body) }, wallet.cluster);
      requireWallet(wallet);
      const prepared = object(preparePage.data);
      if (prepared.kind === 'notExecutable') return { state: 'UNAVAILABLE', reason: typeof prepared.reason === 'string' ? prepared.reason : 'API execution adapter is unavailable.', requestId, signature: null };
      if (prepared.kind !== 'transaction' || prepared.wallet !== wallet.address || prepared.cluster !== wallet.cluster || prepared.programId !== ANTE_UP_PROGRAM_ADDRESS || prepared.action !== requestValue.action || prepared.requestId !== requestId || typeof prepared.recordId !== 'string' || !prepared.recordId || (requestValue.action === 'closeFree' && prepared.recordId !== requestValue.recordId) || !Number.isSafeInteger(prepared.expiresAt) || (prepared.expiresAt as number) <= now() || (prepared.expiresAt as number) > now() + 30) return { state: 'AWAITING_SIGNATURE', reason: 'Prepared transaction identity or expiry is invalid.', requestId, signature: null };
      const executable = prepared as unknown as ExecutablePrepare;
      const review: FreeReview = Object.freeze({ requestId, expiresAt: executable.expiresAt, action: requestValue.action });
      reviews.set(review, { requestValue, wallet, authorized, executable });
      return { state: 'PREPARED', review };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Could not prepare this request.';
      return { state: 'AWAITING_SIGNATURE', reason, requestId, signature: null };
    } finally { active.delete(key); }
  }

  function cancelReview(review: FreeReview) { reviews.delete(review); }
  function reviewSecondsRemaining(review: FreeReview) { return Math.max(0, review.expiresAt - now()); }

  /** Called by a second user gesture, after authentication and HTTP preparation finish. */
  async function signReviewed(review: FreeReview, onProgress?: (state: FreeProgress) => void): Promise<FreeOutcome> {
    const context = reviews.get(review);
    if (!context) return { state: 'AWAITING_SIGNATURE', reason: 'Review this chip request again before signing.', requestId: review.requestId, signature: null };
    if (active.size > 0) return { state: 'BUSY', reason: 'A request is already in progress.', requestId: review.requestId, signature: null };
    // Consume before any asynchronous work: a second tap cannot send this request twice.
    reviews.delete(review);
    const { requestValue, wallet, authorized, executable } = context;
    const requestId = review.requestId;
    const key = keyFor(wallet, requestValue);
    const previous = uncertain.get(key);
    if (previous) return previous;
    active.add(key);
    try {
      requireWallet(wallet);
      const unsupported = supportReason(requestValue, wallet);
      if (unsupported) return { state: 'UNAVAILABLE', reason: unsupported, requestId, signature: null };
      if (now() >= executable.expiresAt || now() >= authorized.expiresAt) return { state: 'AWAITING_SIGNATURE', reason: 'Chip request expired. Review it again before signing.', requestId, signature: null };
      onProgress?.('AWAITING_SIGNATURE');
      const result: SendResult = await sendPreparedTransaction({
        prepared: executable,
        intent: { action: requestValue.action, requestId, recordId: executable.recordId, programId: ANTE_UP_PROGRAM_ADDRESS, marketAddress: requestValue.market.chain!.address },
        wallet,
        getWallet: options.getWallet,
        reportSubmission: async (id, signature) => {
          requireWallet(wallet);
          const page = await request<Operation>(`/operations/${encodeURIComponent(id)}/submit`, { method: 'POST', headers: authHeaders(authorized.token), body: jsonBody({ wallet: wallet.address, signature }) }, wallet.cluster);
          return page.data;
        },
        readOperation: async (id) => {
          requireWallet(wallet);
          const page = await request<Operation>(`/operations/${encodeURIComponent(id)}?wallet=${encodeURIComponent(wallet.address)}`, { method: 'GET', headers: { Authorization: `Bearer ${authorized.token}` } }, wallet.cluster);
          return page.data;
        },
        onProgress: (state) => onProgress?.(state),
        nowSeconds: now,
        wait: options.wait,
        attempts: options.pollAttempts,
      });
      const outcome = { ...result, requestId, recordId: executable.recordId } as FreeOutcome;
      if (outcome.state === 'FINALIZED') projection.remember({ ...identity(wallet, requestValue.market.id), action: requestValue.action, recordId: executable.recordId, requestId, signature: outcome.signature });
      if (outcome.state === 'UNKNOWN' || outcome.state === 'CONFIRMED') uncertain.set(key, outcome);
      return outcome;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Could not process this request.';
      return { state: 'AWAITING_SIGNATURE', reason, requestId, signature: null };
    } finally { active.delete(key); }
  }

  // Non-UI callers retain the existing contract; mobile UI always uses the two explicit steps.
  async function run(requestValue: FreeRequest, onProgress?: (state: FreeProgress) => void): Promise<FreeOutcome> {
    const result = await prepare(requestValue, onProgress);
    return result.state === 'PREPARED' ? signReviewed(result.review, onProgress) : result;
  }

  async function recheck(requestValue: FreeRequest, requestId: string, signature: string | null): Promise<FreeOutcome> {
    const wallet = options.getWallet();
    const unsupported = supportReason(requestValue, wallet, true);
    if (unsupported || !wallet) return { state: 'UNAVAILABLE', reason: unsupported ?? 'Wallet unavailable.', requestId, signature: null };
    const key = keyFor(wallet, requestValue);
    if (active.size > 0) return { state: 'BUSY', reason: 'A request is already in progress.', requestId, signature: null };
    if (!uncertain.has(key) || uncertain.get(key)?.requestId !== requestId || uncertain.get(key)?.signature !== signature) return { state: 'UNKNOWN', reason: 'No matching earlier request is available to check.', requestId, signature };
    active.add(key);
    try {
      const authorized = await authorize(wallet);
      const page = await request<Operation>(`/operations/${encodeURIComponent(requestId)}?wallet=${encodeURIComponent(wallet.address)}`, { method: 'GET', headers: { Authorization: `Bearer ${authorized.token}` } }, wallet.cluster);
      requireWallet(wallet);
      if (!operationMatches(page.data, { wallet: wallet.address, action: requestValue.action, requestId, signature })) throw new Error('Operation identity does not match the submitted signature.');
      if (page.data.state === 'FINALIZED' || page.data.state === 'FAILED') {
        if (!page.data.signature && page.data.state==='FINALIZED') throw new Error('Final operation has no transaction signature.');
        if (!page.data.signature && !(page.data.state==='FAILED' && page.data.error?.code==='REQUOTE_REQUIRED' && !signature)) throw new Error('Final operation has no transaction signature.');
        const finalRecordId = uncertain.get(key)?.recordId ?? requestValue.recordId;
        uncertain.delete(key);
        if(page.data.state==='FINALIZED') {
          if (finalRecordId) projection.remember({ ...identity(wallet, requestValue.market.id), action: requestValue.action, recordId: finalRecordId, requestId, signature: page.data.signature! });
          return {state:'FINALIZED',requestId,signature:page.data.signature!,recordId:finalRecordId ?? undefined};
        }
        return { state:'FAILED', requestId, signature: page.data.signature, reason: page.data.error?.message };
      }
      const pending: FreeOutcome = { state: 'UNKNOWN', reason: `Not finalized yet (${page.data.state}).`, requestId, signature: page.data.signature ?? signature, recordId: uncertain.get(key)?.recordId };
      uncertain.set(key, pending);
      return pending;
    } catch (error) {
      return { state: 'UNKNOWN', reason: error instanceof Error ? error.message : 'Operation recheck failed.', requestId, signature };
    } finally { active.delete(key); }
  }
  const pending = (requestValue: FreeRequest, wallet: WalletContext | null) => wallet ? uncertain.get(keyFor(wallet, requestValue)) ?? null : null;
  return { run, prepare, signReviewed, cancelReview, reviewSecondsRemaining, recheck, supportReason, pending, clearSession, authorize, projectionPending, observeProfile };
}
