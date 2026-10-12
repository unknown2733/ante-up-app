import type { ConsumerReadApi } from '../../../contracts/consumer.ts';
import { parseConsumerFreeActionId } from '../../../contracts/consumer-identity.ts';
import type { ApiError, Envelope } from '../../../contracts/types.ts';
import { decodeBase58 } from './auth.ts';
import { ConsumerNoteService, NoteError } from './consumer-social.ts';

export interface ConsumerApiBindings {
  read: ConsumerReadApi;
  notes: ConsumerNoteService;
  namespace: string;
}

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const envelope = <T>(data: T, asOf: number, nextCursor: string | null = null): Envelope<T> =>
  ({ schemaVersion: '0.1', mode: 'devnet', asOf, data, nextCursor });
const fail = (code: ApiError['code'], message: string, status = 400) =>
  respond({ code, message, retryable: false, requestId: null } satisfies ApiError, status);
const decode = (segment: string): string => {
  const result = decodeURIComponent(segment);
  if (!result || result.length > 256 || result.includes('/')) throw new NoteError('INVALID_INPUT', 'Invalid path ID.');
  return result;
};
const address = (segment: string): string => {
  const result = decode(segment);
  try { if (decodeBase58(result).length === 32) return result; } catch { /* invalid address */ }
  throw new NoteError('INVALID_INPUT', 'Invalid wallet or market address.');
};
const pagination = (url: URL): { offset: number; limit: number } => {
  const rawLimit = url.searchParams.get('limit') ?? '50';
  const rawCursor = url.searchParams.get('cursor') ?? '0';
  if (!/^[1-9][0-9]*$/.test(rawLimit) || !/^(0|[1-9][0-9]*)$/.test(rawCursor)) throw new NoteError('INVALID_INPUT', 'Invalid pagination.');
  const limit = Number(rawLimit), offset = Number(rawCursor);
  if (!Number.isSafeInteger(limit) || limit > 100 || !Number.isSafeInteger(offset) || offset > 1_000_000)
    throw new NoteError('INVALID_INPUT', 'Pagination out of range.');
  return { offset, limit };
};
const page = <T>(items: T[], url: URL): { items: T[]; nextCursor: string | null } => {
  const { offset, limit } = pagination(url);
  return { items: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? String(offset + limit) : null };
};

/** Live Devnet only. Public reads never ask for a wallet; writes reuse app.signed. */
export function createConsumerApiRoutes(bindings: ConsumerApiBindings) {
  if (!parseConsumerFreeActionId(bindings.namespace, bindings.namespace + ':ValidationRecord:open'))
    throw new Error('INVALID_CONSUMER_NAMESPACE');
  return async (request: Request, asOf: number,
    signed: (request: Request, wallet: string) => Promise<boolean>): Promise<Response | null> => {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'v1' || parts[1] !== 'consumer') return null;
    try {
      if (parts[2] === 'markets' && parts.length === 3) {
        if (request.method !== 'GET') return fail('INVALID_INPUT', 'Method not allowed.', 405);
        const result = page(await bindings.read.listMarkets(), url);
        return respond(envelope(result.items, asOf, result.nextCursor));
      }
      if (parts[2] === 'markets' && parts.length === 5 && parts[4] === 'history') {
        if (request.method !== 'GET') return fail('INVALID_INPUT', 'Method not allowed.', 405);
        const marketId = address(parts[3]);
        const period = url.searchParams.get('period') ?? '1W';
        if (period !== '1D' && period !== '1W' && period !== '1M' && period !== 'ALL')
          return fail('INVALID_INPUT', 'Period must be 1D, 1W, 1M or ALL.');
        return respond(envelope(await bindings.read.getHistory(marketId, period), asOf));
      }
      if (parts[2] === 'profiles' && parts.length === 4) {
        if (request.method !== 'GET') return fail('INVALID_INPUT', 'Method not allowed.', 405);
        const actorId = address(parts[3]);
        const profile = await bindings.read.getProfile(actorId);
        if (!profile) return respond(envelope(null, asOf));
        const actions = page(profile.actions, url);
        return respond(envelope({ ...profile, actions: actions.items }, asOf, actions.nextCursor));
      }
      if (parts[2] === 'leaderboard' && parts.length === 3) {
        if (request.method !== 'GET') return fail('INVALID_INPUT', 'Method not allowed.', 405);
        const period = url.searchParams.get('period') ?? '7D';
        if (period !== '7D' && period !== 'ALL') return fail('INVALID_INPUT', 'Period must be 7D or ALL.');
        const board = await bindings.read.getLeaderboard(period);
        const rows = page(board.rows, url);
        return respond(envelope({ ...board, rows: rows.items }, asOf, rows.nextCursor));
      }
      if (parts[2] === 'notes' && parts.length === 4) {
        const actionId = decode(parts[3]);
        if (!parseConsumerFreeActionId(bindings.namespace, actionId)) return fail('INVALID_INPUT', 'Invalid live free action ID.');
        if (request.method === 'GET') return respond(envelope(await bindings.notes.read(actionId), asOf));
        if (request.method !== 'PUT') return fail('INVALID_INPUT', 'Method not allowed.', 405);
        const raw = await request.text();
        if (raw.length > 4096) return fail('INVALID_INPUT', 'Note request too large.');
        let value: unknown;
        try { value = JSON.parse(raw); } catch { return fail('INVALID_INPUT', 'Invalid JSON.'); }
        if (!value || typeof value !== 'object') return fail('INVALID_INPUT', 'Invalid note request.');
        const { wallet, body, expectedVersion } = value as Record<string, unknown>;
        if (typeof wallet !== 'string') return fail('UNAUTHORIZED', 'Wallet authentication required.', 403);
        // A claimed wallet is only an identity hint; signed() verifies the session/signature.
        const authenticated = await signed(request, wallet);
        const note = await bindings.notes.save({
          actionId, authenticatedWallet: authenticated ? wallet : null, body, expectedVersion: expectedVersion as number,
        });
        return respond(envelope({ note }, asOf));
      }
      return fail('INVALID_INPUT', 'Unknown consumer route.');
    } catch (error) {
      if (error instanceof URIError) return fail('INVALID_INPUT', 'Malformed path encoding.');
      if (error instanceof NoteError) {
        const status = error.code === 'UNAUTHORIZED' ? 403 : error.code === 'ALREADY_EXECUTED' || error.code === 'DATA_NOT_READY' ? 409 : 400;
        return fail(error.code, error.message, status);
      }
      throw error;
    }
  };
}
