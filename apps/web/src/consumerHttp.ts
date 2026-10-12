import type { ConsumerLeaderboard, ConsumerMarket, ConsumerNote, ConsumerPeriod, ConsumerProfile, ConsumerReadApi, MarketHistory } from '../../../contracts/consumer';

export interface NoteRead { note: ConsumerNote | null; revisions: Array<ConsumerNote & { revisedAtMs: number }> }

/** Public Devnet reads and the separately authenticated note write. */
export function createLiveConsumerHttp(baseUrl: string, fetcher: typeof fetch = fetch) {
  const origin = baseUrl.replace(/\/$/, '');
  async function request<T>(path: string, init?: RequestInit): Promise<{ data: T; nextCursor: string | null }> {
    const response = await fetcher(`${origin}/v1/consumer${path}`, { ...init, cache: 'no-store', headers: { Accept: 'application/json', ...init?.headers } });
    let body: unknown;
    try { body = await response.json(); } catch { throw new Error(`Consumer API returned an invalid response (${response.status}).`); }
    if (!response.ok) {
      const message = body && typeof body === 'object' && 'message' in body && typeof body.message === 'string' ? body.message : `Consumer API request failed (${response.status}).`;
      throw new Error(message);
    }
    if (!body || typeof body !== 'object' || !('schemaVersion' in body) || body.schemaVersion !== '0.1' || !('mode' in body) || body.mode !== 'devnet' || !('asOf' in body) || !Number.isSafeInteger(body.asOf) || !('nextCursor' in body) || (body.nextCursor !== null && (typeof body.nextCursor !== 'string' || !body.nextCursor)) || !('data' in body)) {
      throw new Error('Consumer API envelope or network is invalid.');
    }
    return { data: body.data as T, nextCursor: body.nextCursor as string | null };
  }
  async function allPages<T>(path: string, merge: (first: T, next: T) => T): Promise<T> {
    let result: T | undefined;
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const response: { data: T; nextCursor: string | null } = await request<T>(cursor ? `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : path);
      result = result === undefined ? response.data : merge(result, response.data);
      if (response.nextCursor === null) return result;
      if (seen.has(response.nextCursor)) throw new Error('Consumer API pagination repeated a cursor.');
      seen.add(response.nextCursor);
      cursor = response.nextCursor;
    }
    throw new Error('Consumer API pagination exceeded the supported page limit.');
  }
  const getHistory = async (marketId: string, period: ConsumerPeriod, signal?: AbortSignal) =>
    (await request<MarketHistory | null>(`/markets/${encodeURIComponent(marketId)}/history?period=${period}`, { signal })).data;
  const read: ConsumerReadApi = {
    listMarkets: () => allPages<ConsumerMarket[]>('/markets', (first, next) => {
      if (!Array.isArray(first) || !Array.isArray(next)) throw new Error('Consumer market page is invalid.');
      return [...first, ...next];
    }),
    getHistory,
    getProfile: (actorId: string) => allPages<ConsumerProfile | null>(`/profiles/${encodeURIComponent(actorId)}`, (first, next) => {
      if (!first || !next || !Array.isArray(first.actions) || !Array.isArray(next.actions) || first.actorId !== next.actorId) throw new Error('Consumer profile page is invalid.');
      return { ...first, actions: [...first.actions, ...next.actions] };
    }),
    getLeaderboard: (period: '7D' | 'ALL') => allPages<ConsumerLeaderboard>(`/leaderboard?period=${period}`, (first, next) => {
      if (!Array.isArray(first.rows) || !Array.isArray(next.rows) || first.period !== next.period) throw new Error('Consumer leaderboard page is invalid.');
      return { ...first, rows: [...first.rows, ...next.rows] };
    }),
  };
  return {
    read,
    getHistory,
    getNote: (actionId: string) => request<NoteRead>(`/notes/${encodeURIComponent(actionId)}`).then(page => page.data),
    saveNote: (actionId: string, wallet: string, body: string, expectedVersion: number, token: string) => request<{ note: ConsumerNote }>(`/notes/${encodeURIComponent(actionId)}`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet, body, expectedVersion }),
    }).then(result => result.data.note),
  };
}
