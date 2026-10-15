import type { Envelope, WalletSession } from '../../../contracts/types';
import type { WalletContext } from './transactionBoundary';

export type SolReadiness = {
  balanceLamports: string;
  minimumBalanceLamports: string;
  needsSol: boolean;
  serverGrantEnabled: boolean;
};
export type SolClaim = {
  state: 'DISABLED'|'ENOUGH_SOL'|'LIMIT_REACHED'|'RESERVED'|'UNKNOWN'|'SUBMITTED'|'FINALIZED';
  signature: string|null;
  amountLamports: string|null;
};

const amount = (value: unknown) => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);

export function createVisitorSolFlow(input: {
  baseUrl: string;
  getWallet: () => WalletContext|null;
  authorize: (wallet: WalletContext) => Promise<WalletSession>;
  fetcher?: typeof fetch;
  storage?: Pick<Storage,'getItem'|'setItem'|'removeItem'>;
  requestId?: () => string;
}) {
  const fetcher = input.fetcher ?? fetch;
  const storage = input.storage ?? (typeof sessionStorage === 'undefined' ? undefined : sessionStorage);
  const origin = input.baseUrl.replace(/\/$/, '');
  const key = (wallet: WalletContext) => `ante-up-visitor-sol:${wallet.cluster}:${wallet.address}`;
  function wallet() {
    const value = input.getWallet();
    if (!value || value.cluster !== 'devnet') throw new Error('Connect a Devnet wallet first.');
    return value;
  }
  async function request<T>(path: string, init?: RequestInit, context?: WalletContext): Promise<T> {
    const session = context ? await input.authorize(context) : null;
    if (context && (session?.wallet !== context.address || session.cluster !== context.cluster))
      throw new Error('Wallet session changed.');
    const response = await fetcher(`${origin}/v1/visitor-sol${path}`, {
      ...init, cache:'no-store', headers: {Accept:'application/json',
        ...(session ? {Authorization:`Bearer ${session.token}`} : {}),
        ...(init?.body ? {'Content-Type':'application/json'} : {}), ...init?.headers},
    });
    const raw: unknown = await response.json();
    if (!response.ok) throw new Error(raw && typeof raw === 'object' && 'message' in raw && typeof raw.message === 'string'
      ? raw.message : `Devnet SOL check failed (${response.status}).`);
    if (!raw || typeof raw !== 'object' || !('schemaVersion' in raw) || !('mode' in raw) || !('data' in raw))
      throw new Error('Devnet SOL response is invalid.');
    const result = raw as Envelope<T>;
    if (result.schemaVersion !== '0.1' || result.mode !== 'devnet') throw new Error('Devnet SOL response network changed.');
    if (context && input.getWallet()?.address !== context.address) throw new Error('Wallet changed.');
    return result.data;
  }
  async function readiness(): Promise<SolReadiness> {
    const context = wallet();
    const data = await request<SolReadiness>(`/readiness?wallet=${encodeURIComponent(context.address)}`);
    if (!data || !amount(data.balanceLamports) || !amount(data.minimumBalanceLamports) ||
        typeof data.needsSol !== 'boolean' || typeof data.serverGrantEnabled !== 'boolean' ||
        data.needsSol !== (BigInt(data.balanceLamports) < BigInt(data.minimumBalanceLamports)))
      throw new Error('Devnet SOL balance response is invalid.');
    return data;
  }
  function pending() {
    const context = wallet();
    const value = storage?.getItem(key(context));
    return value && /^[A-Za-z0-9_-]{8,80}$/.test(value) ? value : null;
  }
  async function claim(): Promise<SolClaim> {
    const context = wallet();
    if (!storage) throw new Error('Request recovery storage is unavailable.');
    const requestId = pending() ?? (input.requestId ?? (() => crypto.randomUUID()))();
    storage.setItem(key(context), requestId);
    const result = await request<SolClaim>('/claims', {method:'POST',body:JSON.stringify({wallet:context.address,requestId})},context);
    if (!result || !['DISABLED','ENOUGH_SOL','LIMIT_REACHED','RESERVED','UNKNOWN','SUBMITTED','FINALIZED'].includes(result.state))
      throw new Error('Devnet SOL request response is invalid.');
    if (['DISABLED','ENOUGH_SOL','LIMIT_REACHED','FINALIZED'].includes(result.state)) storage.removeItem(key(context));
    return result;
  }
  async function recheck(): Promise<SolClaim> {
    const context = wallet();
    const requestId = pending();
    if (!requestId) throw new Error('No pending Devnet SOL request.');
    const result = await request<SolClaim>(`/claims/${encodeURIComponent(requestId)}?wallet=${encodeURIComponent(context.address)}`,undefined,context);
    if (!result || !['RESERVED','UNKNOWN','SUBMITTED','FINALIZED'].includes(result.state))
      throw new Error('Devnet SOL request status is invalid.');
    if (result.state === 'FINALIZED') storage?.removeItem(key(context));
    return result;
  }
  return {readiness,pending,claim,recheck};
}
