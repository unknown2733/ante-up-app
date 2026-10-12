import type { Envelope, FreeRecord, LeaderboardPage, MarketView, Mode, ProofStatus, PublicProfile } from '../../../contracts/types';
import type { MarketApi, Period } from './model';

export interface HttpApiOptions {
  allowFixture: boolean;
  onMode?: (mode: Mode) => void;
}

export function createHttpApi(baseUrl: string, options: HttpApiOptions): MarketApi {
  const origin = baseUrl.replace(/\/$/, '');
  let observedMode: Mode | null = null;
  async function read<T>(path: string): Promise<Envelope<T>> {
    const response = await fetch(`${origin}/v1${path}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`API request failed (${response.status})`);
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('schemaVersion' in body) || !('mode' in body) || !('asOf' in body) || !('data' in body) || !('nextCursor' in body)) {
      throw new Error('API envelope is invalid.');
    }
    const envelope = body as Envelope<T>;
    if (envelope.schemaVersion !== '0.1') throw new Error('Unsupported API schemaVersion.');
    if (!Number.isSafeInteger(envelope.asOf) || (envelope.nextCursor !== null && typeof envelope.nextCursor !== 'string')) throw new Error('API envelope timestamp or cursor is invalid.');
    if (envelope.mode !== 'fixture' && envelope.mode !== 'localnet' && envelope.mode !== 'devnet') throw new Error('Unsupported API mode.');
    if (envelope.mode === 'fixture' && !options.allowFixture) throw new Error('HTTP fixture responses require VITE_ALLOW_FIXTURE_API=true.');
    if (observedMode && observedMode !== envelope.mode) throw new Error('API response modes do not match.');
    observedMode = envelope.mode;
    options.onMode?.(envelope.mode);
    return envelope;
  }
  function checkMarket(market: MarketView | null): MarketView | null {
    if (!market?.snapshot) return market;
    const payload = market.snapshot.payload;
    if (typeof payload.queryHash !== 'string' || typeof payload.formulaVersion !== 'string' || !payload.admission || !['BLOCKED', 'RECOVERING', 'OPEN'].includes(payload.admission.state)) {
      throw new Error('API market snapshot does not match common contract v0.2.');
    }
    return market;
  }
  return {
    async listMarkets() { const page = await read<MarketView[]>('/markets'); if (!Array.isArray(page.data)) throw new Error('Market list is invalid.'); return { ...page, data: page.data.map((market) => checkMarket(market)!) }; },
    async getMarket(id) { const page = await read<MarketView | null>(`/markets/${encodeURIComponent(id)}`); return { ...page, data: checkMarket(page.data) }; },
    async getProfile(wallet) {
      const page = await read<PublicProfile>(`/profiles/${encodeURIComponent(wallet)}`);
      if (!page.data || !Array.isArray(page.data.openRecords) || !Array.isArray(page.data.closedRecords)) throw new Error('Profile is invalid.');
      return page;
    },
    getRecord: (id) => read<FreeRecord | null>(`/records/${encodeURIComponent(id)}`),
    async getProof(proofId) {
      const page = await read<ProofStatus | null>(`/proofs/${encodeURIComponent(proofId)}`);
      const proof = page.data;
      if (proof && proof.id !== proofId) throw new Error('Response proof ID does not match the requested ID.');
      if (proof && (proof.state === 'READY_TO_ISSUE' || proof.state === 'ISSUED') && (!proof.payloadHash || !proof.manifestRef?.arweaveItemId || !proof.manifestRef.parentTransactionId || proof.manifestRef.contentHash !== proof.payloadHash)) {
        throw new Error('Completed proof has an invalid manifest reference.');
      }
      return page;
    },
    async getLeaderboard(period: Period) {
      const page = await read<LeaderboardPage>(`/leaderboard?period=${period}`);
      if (!page.data || page.data.period !== period || !Array.isArray(page.data.rows) || !Array.isArray(page.data.heldWallets)) throw new Error('Leaderboard page is invalid.');
      return page;
    },
    async openFree() { return { kind: 'notExecutable', reason: 'Wallet signing and transactions/prepare are not connected yet.' }; },
    async closeFree() { return { kind: 'notExecutable', reason: 'Wallet signing and transactions/prepare are not connected yet.' }; },
  };
}
