/** Additive consumer read contract. Never use chart values to authorize settlement. */
export type ConsumerMode = 'LIVE' | 'REFERENCE' | 'DEMO';
export type ConsumerSubject = 'KEYWORD' | 'VIDEO' | 'TRACK' | 'ALBUM' | 'ACCOUNT' | 'POST';
export type ConsumerSeriesKind = 'CURVE_PRICE' | 'REFERENCE_PRICE' | 'TRADE_PRICE' | 'ATTENTION_INDEX' | 'ACTIVITY_COUNT';
export type ConsumerPeriod = '1D' | '1W' | '1M' | 'ALL';
export interface ConsumerSource { mode: ConsumerMode; label: string; asOfMs: number; sourceUrl?: string; observationLabel?: string; }
export interface ConsumerMarket {
  id: string; title: string; subtitle: string; subject: ConsumerSubject;
  phase: 'CURVE' | 'POOL' | 'PREVIEW'; source: ConsumerSource;
  latestPrice: string | null; priceUnit: string; changeFraction: number | null;
  thumbnailUrl?: string; liveMarketId?: string;
  subjectUrl?: string; creatorLabel?: string; imageAlt?: string; imageSourceUrl?: string;
  /** Actual public-source activity; never a token quote or a settlement input. */
  activity?: { value: string; unit: string; label: string; changeFraction: number | null; asOfMs: number };
}
export interface ConsumerPoint { atMs: number; value: string; observationId?: string; }
export interface ConsumerSeries {
  id: string; kind: ConsumerSeriesKind; label: string; unit: string;
  /** gaps forbid connecting across an interval; observed boundary points are allowed. */
  points: ConsumerPoint[]; gaps: Array<{ fromMs: number; toMs: number }>; source: ConsumerSource;
}
export interface ConsumerNote {
  id: string; actionId: string; authorId: string; body: string;
  createdAtMs: number; updatedAtMs: number; version: number;
  timing: 'AT_ACTION' | 'ADDED_LATER'; proofCoverage: 'NONE';
}
export interface ConsumerAction {
  id: string; marketId: string; actorId: string; actorLabel: string;
  actorAvatarUrl?: string;
  kind: 'CALL_OPEN' | 'CALL_CLOSE' | 'BUY' | 'SELL'; atMs: number;
  seriesId: string | null; value: string | null; recordId?: string;
  returnFraction: number | null; note: ConsumerNote | null; source: ConsumerSource;
}
export interface MarketHistory {
  market: ConsumerMarket; period: ConsumerPeriod; series: ConsumerSeries[];
  actions: ConsumerAction[]; source: ConsumerSource;
}
export interface ConsumerProfile {
  actorId: string; actorLabel: string; source: ConsumerSource;
  avatarUrl?: string; avatarAlt?: string;
  closedCallCount: number; openCallCount: number; meanReturnFraction: number | null;
  actions: ConsumerAction[];
}
export interface ConsumerRank {
  actorId: string; actorLabel: string; closedCallCount: number;
  meanReturnFraction: number; rank: number;
}
export interface ConsumerLeaderboard {
  period: '7D' | 'ALL'; source: ConsumerSource; rows: ConsumerRank[];
}
export interface ConsumerReadApi {
  listMarkets(): Promise<ConsumerMarket[]>;
  getHistory(marketId: string, period: ConsumerPeriod): Promise<MarketHistory | null>;
  getProfile(actorId: string): Promise<ConsumerProfile | null>;
  getLeaderboard(period: '7D' | 'ALL'): Promise<ConsumerLeaderboard>;
}
