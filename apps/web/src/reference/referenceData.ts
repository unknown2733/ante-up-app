import type { ConsumerMarket, ConsumerReadApi, ConsumerSeries, ConsumerSource, MarketHistory } from '../../../../contracts/consumer.ts';
import { platformReferences } from '../../../../contracts/reference/platform-snapshot.ts';

export const REFERENCE_AS_OF_MS = Math.max(...platformReferences.map(item => Date.parse(item.metric.capturedAt)));
export const REFERENCE_MARKET_PREFIX = 'reference:market:';
const copy = <T>(value: T): T => structuredClone(value);

const built = platformReferences.map(subject => {
  const metric = subject.metric;
  const asOfMs = Date.parse(metric.asOf);
  const source: ConsumerSource = {
    mode: 'REFERENCE', asOfMs, sourceUrl: metric.sourceUrl,
    label: `${metric.label} · ${metric.provider}${metric.sourceType === 'THIRD_PARTY' ? ' (third-party report)' : ''} · captured ${metric.capturedAt}`,
    observationLabel: metric.reportedDate ? `${metric.provider} report dated ${metric.reportedDate} (time zone not supplied)` : 'Captured platform count · the source counter may be cached',
  };
  const market: ConsumerMarket = {
    id: `${REFERENCE_MARKET_PREFIX}${subject.slug}`, title: subject.title, subject: subject.subject,
    subtitle: metric.label, creatorLabel: subject.creatorLabel, subjectUrl: subject.subjectUrl,
    thumbnailUrl: subject.imageUrl, imageAlt: subject.imageAlt, imageSourceUrl: subject.imageSourceUrl,
    phase: 'PREVIEW', source, latestPrice: null, priceUnit: 'tUSD', changeFraction: null,
    activity: { value: metric.value, unit: metric.unit, label: metric.label, changeFraction: null, asOfMs },
  };
  const series: ConsumerSeries = {
    id: `reference:series:${subject.slug}:${metric.kind}`, kind: 'ACTIVITY_COUNT', label: metric.label,
    unit: metric.unit, source, gaps: [],
    points: [{ atMs: asOfMs, value: metric.value, observationId: `public:${metric.rawSha256}` }],
  };
  return { market, series };
});
const byId = new Map(built.map(item => [item.market.id, item]));

export function isReferenceConsumerId(id: string): boolean { return id.startsWith('reference:'); }

/** Exact captured counts, not a synthetic history or an executable quote. */
export function createReferenceConsumerReadApi(): ConsumerReadApi {
  return {
    async listMarkets() { return copy(built.map(item => item.market)); },
    async getHistory(id, period) {
      const item = byId.get(id);
      if (!item) return null;
      const history: MarketHistory = { market: item.market, period, source: item.market.source,
        series: [item.series], actions: [] };
      return copy(history);
    },
    async getProfile() { return null; },
    async getLeaderboard(period) {
      return { period, rows: [], source: { mode: 'REFERENCE', label: 'No participation records in the public reference catalog', asOfMs: REFERENCE_AS_OF_MS } };
    },
  };
}

export const referenceConsumerReadApi = createReferenceConsumerReadApi();
