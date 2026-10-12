import type { ConsumerAction, ConsumerMarket, ConsumerPeriod, ConsumerPoint, ConsumerSeries, ConsumerSeriesKind, ConsumerSource, MarketHistory } from '../../../contracts/consumer.ts';
import type { FreeRecord, MarketView, PublishedSnapshot } from '../../../contracts/types.ts';
import type { SqliteProjectionStore } from '../../indexer/src/sqlite.ts';
import type { ReadAdapter } from './app.ts';
import type { FinancialQuote } from '../../../contracts/financial.ts';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { consumerFreeActionId, consumerLiveNamespace } from '../../../contracts/consumer-identity.ts';

const DAY = 86_400_000;
const PRICE_GAP_MS = 15 * 60_000;
const ATTENTION_GAP_MS = 15 * 60_000;
const periods: Record<Exclude<ConsumerPeriod, 'ALL'>, number> = { '1D': DAY, '1W': 7 * DAY, '1M': 30 * DAY };

/** A persisted, finalized observation. Quote-at-read is intentionally not historical evidence. */
export interface FinalizedPriceObservation {
  id: string;
  marketId: string;
  kind: Extract<ConsumerSeriesKind, 'CURVE_PRICE' | 'REFERENCE_PRICE' | 'TRADE_PRICE'>;
  atMs: number;
  valueAtoms: string;
  finality: 'finalized';
  /** Consecutive observations are connected only within this verified capture interval. */
  maxContinuityMs?: number;
}

export interface ConsumerHistoryInputs {
  namespace: string;
  market(marketId: string): Promise<MarketView | null>;
  snapshots(marketId: string): Promise<PublishedSnapshot[]>;
  records(marketId: string): Promise<FreeRecord[]>;
  /** Empty until a verified price/receipt capture is available. */
  priceObservations(marketId: string): Promise<FinalizedPriceObservation[]>;
  /** Public free-call notes only. The note service owns authorization and persistence. */
  noteForAction?(actionId: string): Promise<ConsumerAction['note']>;
  nowMs?: () => number;
}

const validMs = (value: number) => Number.isSafeInteger(value) && value > 0;
const decimal = (value: string) => /^(0|[1-9][0-9]*)$/.test(value);
const source = (asOfMs: number): ConsumerSource => ({ mode: 'LIVE', label: 'Live Devnet · finalized', asOfMs });
const fraction = (numerator: string, denominator: string): number | null => {
  if (!/^-?(0|[1-9][0-9]*)$/.test(numerator) || !decimal(denominator) || denominator === '0') return null;
  const result = Number(numerator) / Number(denominator);
  return Number.isFinite(result) ? result : null;
};
const ratio = (numerator: string, denominator: string): string | null => {
  if (!decimal(numerator) || !decimal(denominator) || denominator === '0') return null;
  const scaled = BigInt(numerator) * 1_000_000n / BigInt(denominator);
  return `${scaled / 1_000_000n}.${String(scaled % 1_000_000n).padStart(6, '0')}`;
};
const atomsToDecimal = (atoms: string): string => {
  const padded = atoms.padStart(7, '0');
  return `${padded.slice(0, -6)}.${padded.slice(-6)}`;
};
const periodStart = (period: ConsumerPeriod, nowMs: number) => period === 'ALL' ? null : nowMs - periods[period];

export function historyGaps(points: ConsumerPoint[], startMs: number | null, endMs: number, maxContinuityMs: number) {
  const gaps: Array<{ fromMs: number; toMs: number }> = [];
  if (!points.length) return gaps;
  if (startMs !== null && points[0].atMs > startMs) gaps.push({ fromMs: startMs, toMs: points[0].atMs });
  for (let i = 1; i < points.length; i++) {
    if (points[i].atMs - points[i - 1].atMs > maxContinuityMs) gaps.push({ fromMs: points[i - 1].atMs, toMs: points[i].atMs });
  }
  if (points.at(-1)!.atMs < endMs) gaps.push({ fromMs: points.at(-1)!.atMs, toMs: endMs });
  return gaps;
}

const priceSeries = (marketId: string, kind: FinalizedPriceObservation['kind'], points: ConsumerPoint[], maxGap: number, start: number | null, now: number, src: ConsumerSource): ConsumerSeries => ({
  id: `${marketId}:${kind.toLowerCase()}`, kind,
  label: kind === 'CURVE_PRICE' ? 'Curve spot quote' : kind === 'REFERENCE_PRICE' ? 'Index reference price' : 'Executed trade price',
  unit: 'tUSD', points, gaps: historyGaps(points, start, now, maxGap), source: src,
});

/** Shared list/detail projection; current quote is never inserted into historical points. */
export function projectConsumerMarket(market: MarketView, asOfMs: number): ConsumerMarket {
  const synthetic=market.dataProvenance==='SYNTHETIC_QA';
  return {
    id: market.id, title: market.keyword, subtitle: synthetic?'Synthetic financial test · not measured attention':'Keyword market', subject: 'KEYWORD',
    phase: market.phase === 'CURVE' ? 'CURVE' : market.phase === 'INDEXED' ? 'POOL' : 'PREVIEW',
    source: synthetic?{mode:'LIVE',label:'Synthetic test feed · Devnet',asOfMs,observationLabel:'Operator-generated test inputs; no real-world traffic'}:source(asOfMs), latestPrice: market.price ? atomsToDecimal(market.price.atoms) : null,
    priceUnit: 'tUSD', changeFraction: null, liveMarketId: market.id,
  };
}

/** Read-only projection over existing finalized records/snapshots and optional verified price captures. */
export function createConsumerHistoryAdapter(input: ConsumerHistoryInputs) {
  // Validate once; action IDs and note lookups must share the canonical live namespace.
  consumerFreeActionId(input.namespace, 'validation', 'open');
  const nowMs = input.nowMs ?? Date.now;
  return {
    async getHistory(marketId: string, period: ConsumerPeriod): Promise<MarketHistory | null> {
      if (!['1D', '1W', '1M', 'ALL'].includes(period)) throw new Error('INVALID_PERIOD');
      const market = await input.market(marketId);
      if (!market) return null;
      const now = nowMs();
      const start = periodStart(period, now);
      const src = projectConsumerMarket(market,now).source;
      const [snapshots, records, observations] = await Promise.all([
        input.snapshots(marketId), input.records(marketId), input.priceObservations(marketId),
      ]);
      const consumerMarket = projectConsumerMarket(market, now);
      const inPeriod = (atMs: number) => validMs(atMs) && atMs <= now && (start === null || atMs >= start);
      const grouped = new Map<FinalizedPriceObservation['kind'], FinalizedPriceObservation[]>();
      for (const item of observations) {
        if (item.finality !== 'finalized' || item.marketId !== marketId || !inPeriod(item.atMs) || !decimal(item.valueAtoms)) continue;
        const group = grouped.get(item.kind) ?? [];
        group.push(item); grouped.set(item.kind, group);
      }
      const series: ConsumerSeries[] = [];
      for (const kind of ['CURVE_PRICE', 'REFERENCE_PRICE', 'TRADE_PRICE'] as const) {
        const items = (grouped.get(kind) ?? []).sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
        if (!items.length) continue;
        const points = items.map(item => ({ atMs: item.atMs, value: atomsToDecimal(item.valueAtoms), observationId: item.id }));
        const maxGap = Math.min(PRICE_GAP_MS, ...items.map(item => item.maxContinuityMs && item.maxContinuityMs > 0 ? item.maxContinuityMs : PRICE_GAP_MS));
        series.push(priceSeries(marketId, kind, points, maxGap, start, now, src));
      }
      const attention = snapshots.filter(snapshot => snapshot.finality === 'finalized' && snapshot.payload.marketId === marketId &&
        ['VALID', 'LOW_ACTIVITY'].includes(snapshot.payload.dataStatus))
        .map(snapshot => ({ snapshot, atMs: snapshot.payload.dataThrough * 1000,
          value: snapshot.payload.activityNowQ12 && snapshot.payload.activity7dQ12
            ? ratio(snapshot.payload.activityNowQ12, snapshot.payload.activity7dQ12) : null }))
        .filter((item): item is typeof item & { value: string } => item.value !== null && inPeriod(item.atMs))
        .sort((a, b) => a.atMs - b.atMs || (BigInt(a.snapshot.payload.sequence) < BigInt(b.snapshot.payload.sequence) ? -1 : 1));
      if (attention.length) {
        const points = attention.map(item => ({ atMs: item.atMs, value: item.value, observationId: item.snapshot.payloadHash }));
        series.push({ id: `${marketId}:attention`, kind: 'ATTENTION_INDEX', label: market.dataProvenance==='SYNTHETIC_QA'?'Synthetic test ratio':'Attention ratio', unit: '×', points,
          gaps: historyGaps(points, start, now, ATTENTION_GAP_MS), source: src });
      }
      const actions: ConsumerAction[] = [];
      for (const record of records) {
        if (record.finality !== 'finalized' || record.marketId !== marketId) continue;
        const add = async (kind: 'CALL_OPEN' | 'CALL_CLOSE', seconds: number, valueSnapshot: FreeRecord['entry']['snapshot'], returnFraction: number | null) => {
          const atMs = seconds * 1000;
          if (!inPeriod(atMs)) return;
          const actionId = consumerFreeActionId(input.namespace, record.id, kind === 'CALL_OPEN' ? 'open' : 'close');
          const matching = valueSnapshot && attention.find(item => item.snapshot.payload.sequence === valueSnapshot.sequence && item.snapshot.payloadHash === valueSnapshot.payloadHash);
          actions.push({ id: actionId, marketId, actorId: record.wallet, actorLabel: record.wallet, kind, atMs,
            seriesId: matching ? `${marketId}:attention` : null, value: matching?.value ?? null,
            recordId: record.id, returnFraction, note: await input.noteForAction?.(actionId) ?? null, source: src });
        };
        await add('CALL_OPEN', record.entry.executedAt, record.entry.snapshot, null);
        if (record.exit) await add('CALL_CLOSE', record.exit.executedAt, record.exit.snapshot,
          record.result?.kind === 'return' ? fraction(record.result.numerator, record.result.denominator) : null);
      }
      actions.sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
      return { market: consumerMarket, period, series, actions, source: src };
    },
  };
}

/** Existing finalized projection wiring. Prices stay empty until a verified historian is injected. */
export function createFinalizedConsumerHistory(options: {
  read: ReadAdapter; projection: SqliteProjectionStore; cluster: 'devnet'; programId: string;
  priceObservations?: ConsumerHistoryInputs['priceObservations'];
  noteForAction?: ConsumerHistoryInputs['noteForAction']; nowMs?: () => number;
}) {
  return createConsumerHistoryAdapter({
    namespace: consumerLiveNamespace(options.cluster, options.programId),
    market: async marketId => (await options.read.markets()).find(market => market.id === marketId) ?? null,
    snapshots: async marketId => options.projection.snapshots(options.cluster, options.programId).filter(snapshot => snapshot.payload.marketId === marketId),
    records: async marketId => options.projection.records(options.cluster, options.programId).filter(record => record.marketId === marketId),
    priceObservations: options.priceObservations ?? (async () => []),
    noteForAction: options.noteForAction, nowMs: options.nowMs,
  });
}

/** Existing saved quotes are historical spot/reference observations, never executed fills. */
export class SqliteFinalizedQuoteHistory {
  private readonly db: DatabaseSync;
  private readonly cluster: 'devnet';
  private readonly programId: string;
  constructor(path: string, cluster: 'devnet', programId: string) {
    this.db = new DatabaseSync(path, { readOnly: true });
    this.cluster = cluster; this.programId = programId;
  }
  close() { this.db.close(); }
  async priceObservations(marketId: string): Promise<FinalizedPriceObservation[]> {
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_financial_quotes'").get();
    if (!exists) return [];
    const rows = this.db.prepare('SELECT quote_json FROM live_financial_quotes WHERE cluster=? AND program_id=?').all(this.cluster, this.programId) as Array<{ quote_json: string }>;
    const result: FinalizedPriceObservation[] = [];
    for (const row of rows) {
      let quote: FinancialQuote;
      try { quote = JSON.parse(row.quote_json) as FinancialQuote; } catch { continue; }
      if (quote.intent?.marketId !== marketId || quote.chain?.cluster !== this.cluster || quote.chain.programId !== this.programId ||
        quote.chain.address !== marketId || !quote.executable || typeof quote.id !== 'string' || !quote.id ||
        !decimal(quote.priceAtoms) || quote.priceAtoms === '0' ||
        !validMs(quote.quotedAt * 1000)) continue;
      const action = quote.intent.action;
      const kind = quote.phase === 'CURVE' && (action === 'curveBuy' || action === 'curveSell') ? 'CURVE_PRICE'
        : quote.phase === 'INDEXED' && (action === 'spotBuy' || action === 'spotSell') ? 'REFERENCE_PRICE' : null;
      if (!kind) continue;
      const publicId = createHash('sha256').update(`${this.cluster}:${this.programId}:${quote.id}`).digest('hex');
      result.push({ id: `quote:${publicId}`, marketId, kind, atMs: quote.quotedAt * 1000, valueAtoms: quote.priceAtoms, finality: 'finalized' });
    }
    return result;
  }
}

/** Merge persisted sampler points with any earlier saved quotes without changing either source. */
export function combinePriceObservationReaders(...readers: Array<Pick<ConsumerHistoryInputs, 'priceObservations'>>) {
  return async (marketId: string): Promise<FinalizedPriceObservation[]> => {
    const groups = await Promise.all(readers.map(reader => reader.priceObservations(marketId)));
    const byId = new Map<string, FinalizedPriceObservation>();
    for (const point of groups.flat()) if (point.marketId === marketId && point.finality === 'finalized') byId.set(point.id, point);
    return [...byId.values()].sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
  };
}
