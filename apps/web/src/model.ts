import type { Envelope, FreeRecord, LeaderboardPage, LeaderboardPeriod, MarketView, ProofStatus, PublicProfile } from '../../../contracts/types';

export type Period = LeaderboardPeriod;

export type ReadResult<T> = Promise<Envelope<T>>;
export type FixtureMutation =
  | { kind: 'fixture'; record: FreeRecord }
  | { kind: 'notExecutable'; reason: string };

export interface MarketApi {
  listMarkets(): ReadResult<MarketView[]>;
  getMarket(id: string): ReadResult<MarketView | null>;
  getProfile(wallet: string): ReadResult<PublicProfile>;
  getRecord(id: string): ReadResult<FreeRecord | null>;
  getProof(id: string): ReadResult<ProofStatus | null>;
  getLeaderboard(period: Period): ReadResult<LeaderboardPage>;
  openFree(wallet: string, marketId: string): Promise<FixtureMutation>;
  closeFree(wallet: string, recordId: string): Promise<FixtureMutation>;
}
