import type { ConsumerMarket, ConsumerReadApi, ConsumerSeries, ConsumerSource, MarketHistory } from '../../../../contracts/consumer.ts';
import { platformReferences } from '../../../../contracts/reference/platform-snapshot.ts';
import { historyReferences } from '../../../../contracts/reference/platform-history.ts';

export const REFERENCE_AS_OF_MS = Math.max(...platformReferences.map(item => Date.parse(item.metric.capturedAt)), ...historyReferences.map(item => Date.parse(item.capturedAt)));
export const REFERENCE_MARKET_PREFIX = 'reference:market:';
const copy = <T>(value: T): T => structuredClone(value);

const snapshots = platformReferences.map(subject => {
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
const DAY = 86_400_000;
const histories = historyReferences.map(subject => {
  const points = subject.points.map(point => ({ atMs: Date.parse(`${point.date}T00:00:00Z`), value: point.value,
    reportedDate: point.date, sourceUrl: point.sourceUrl, observationId: `public:${point.rawSha256}:${point.date}` })).sort((a, b) => a.atMs - b.atMs);
  const latest = points.at(-1)!;
  const source: ConsumerSource = { mode: 'REFERENCE', asOfMs: latest.atMs, sourceUrl: subject.sourceUrl,
    label: `${subject.label} · ${subject.provider} (third-party report) · captured ${subject.capturedAt}`,
    observationLabel: `Provider report dated ${latest.reportedDate} (time zone not supplied)` };
  const note = subject.aggregation === 'cumulative'
    ? 'Cumulative streams at the recorded dates. Unobserved intervals are left blank.'
    : `${subject.scope}. Each point is one day, not a cumulative total. Missing days remain unknown.`;
  const market: ConsumerMarket = { id: `${REFERENCE_MARKET_PREFIX}${subject.slug}`, title: subject.title, subject: subject.subject,
    subtitle: subject.label, creatorLabel: subject.creatorLabel, subjectUrl: subject.subjectUrl,
    thumbnailUrl: subject.imageUrl, imageAlt: subject.imageAlt, imageSourceUrl: subject.imageSourceUrl,
    phase: 'PREVIEW', source, latestPrice: null, priceUnit: 'tUSD', changeFraction: null,
    activity: { value: latest.value, unit: subject.aggregation === 'daily' ? `${subject.unit}/day` : subject.unit,
      label: subject.label, changeFraction: null, asOfMs: latest.atMs,
      historyLabel: subject.aggregation === 'daily' ? 'Daily history' : 'Dated observations' } };
  const series: ConsumerSeries = { id: `reference:history:${subject.slug}`, kind: 'ACTIVITY_COUNT', label: subject.label,
    unit: market.activity!.unit, source, points, timeBasis: 'REPORT_DATE', aggregation: subject.aggregation, observationNote: note,
    gaps: points.slice(1).flatMap((point, index) => point.atMs - points[index].atMs > DAY
      ? [{ fromMs: points[index].atMs, toMs: point.atMs }] : []) };
  return { market, series };
});
const historyIds = new Set(histories.map(item => item.market.id));
const built = [...snapshots.filter(item => !historyIds.has(item.market.id)), ...histories];
const byId = new Map(built.map(item => [item.market.id, item]));

export function isReferenceConsumerId(id: string): boolean { return id.startsWith('reference:'); }

/** Exact captured counts, not a synthetic history or an executable quote. */
export function createReferenceConsumerReadApi(): ConsumerReadApi {
  return {
    async listMarkets() { return copy(built.map(item => item.market)); },
    async getHistory(id, period) {
      const item = byId.get(id);
      if (!item) return null;
      const span = period === '1D' ? DAY : period === '1W' ? 7 * DAY : period === '1M' ? 30 * DAY : Infinity;
      const start = item.market.source.asOfMs - span;
      const series = item.series.timeBasis === 'REPORT_DATE' ? { ...item.series,
        points: item.series.points.filter(point => point.atMs >= start),
        gaps: item.series.gaps.filter(gap => gap.fromMs >= start) } : item.series;
      const history: MarketHistory = { market: item.market, period, source: item.market.source,
        series: [series], actions: [] };
      return copy(history);
    },
    async getProfile() { return null; },
    async getLeaderboard(period) {
      return { period, rows: [], source: { mode: 'REFERENCE', label: 'No participation records in the public reference catalog', asOfMs: REFERENCE_AS_OF_MS } };
    },
  };
}

export const referenceConsumerReadApi = createReferenceConsumerReadApi();
