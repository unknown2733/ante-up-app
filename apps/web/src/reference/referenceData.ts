import type { ConsumerMarket, ConsumerPeriod, ConsumerReadApi, ConsumerSeries, ConsumerSource, MarketHistory } from '../../../../contracts/consumer.ts';
import { referenceSubjects } from '../../../../contracts/reference/catalog.ts';
import { referenceSnapshot } from '../../../../contracts/reference/snapshot.ts';

const DAY_MS = 86_400_000;
export const REFERENCE_AS_OF_MS = Date.parse(referenceSnapshot.capturedAt);
export const REFERENCE_MARKET_PREFIX = 'reference:market:';
const copy = <T>(value: T): T => structuredClone(value);
const dateMs = (date: string) => Date.parse(`${date}T00:00:00.000Z`);
const bySlug = new Map(referenceSnapshot.subjects.map(subject => [subject.slug, subject]));
type SnapshotSubject = typeof referenceSnapshot.subjects[number];

function sourceFor(snapshot: SnapshotSubject): ConsumerSource {
  return snapshot.activity ? {
    mode: 'REFERENCE',
    label: `English Wikipedia · ${snapshot.activity.article.replaceAll('_', ' ')} · daily article pageviews · ${snapshot.activity.firstDate}–${snapshot.activity.lastDate} UTC`,
    asOfMs: dateMs(snapshot.activity.lastDate) + DAY_MS - 1,
    sourceUrl: snapshot.activity.sourceUrl,
  } : {
    mode: 'REFERENCE', label: 'Verified public metadata · activity history unavailable',
    asOfMs: Date.parse(snapshot.metadata.capturedAt), sourceUrl: snapshot.metadata.sourceUrl,
  };
}

const built = referenceSubjects.map(subject => {
  const snapshot = bySlug.get(subject.slug);
  if (!snapshot) throw new Error(`Missing public reference snapshot: ${subject.slug}`);
  const source = sourceFor(snapshot);
  const latest = snapshot.activity?.points.at(-1);
  const weekAgo = latest && snapshot.activity?.points.find(point => dateMs(point.date) === dateMs(latest.date) - 7 * DAY_MS);
  const market: ConsumerMarket = {
    id: `${REFERENCE_MARKET_PREFIX}${subject.slug}`, title: subject.title, subject: subject.subject,
    subtitle: latest ? 'English Wikipedia article views' : 'Verified metadata · history unavailable',
    creatorLabel: subject.creatorLabel, subjectUrl: subject.subjectUrl,
    thumbnailUrl: snapshot.metadata.imageUrl, imageAlt: subject.imageAlt, imageSourceUrl: snapshot.metadata.imageSourceUrl,
    phase: 'PREVIEW', source, latestPrice: null, priceUnit: 'tUSD', changeFraction: null,
    ...(latest ? { activity: {
      value: String(latest.views), unit: 'views/day', label: 'English Wikipedia article pageviews',
      // Latest daily count versus the same article's count exactly seven UTC days earlier.
      changeFraction: weekAgo && weekAgo.views > 0 ? latest.views / weekAgo.views - 1 : null,
      asOfMs: source.asOfMs,
    } } : {}),
  };
  return { market, snapshot };
});
const byId = new Map(built.map(item => [item.market.id, item]));

function seriesFor(snapshot: SnapshotSubject, period: ConsumerPeriod): ConsumerSeries[] {
  const activity = snapshot.activity;
  if (!activity) return [];
  const days = period === '1D' ? 1 : period === '1W' ? 7 : period === '1M' ? 30 : Infinity;
  const windowFrom = dateMs(activity.lastDate) - (days - 1) * DAY_MS;
  const points = activity.points.filter(point => dateMs(point.date) >= windowFrom).map(point => ({
    atMs: dateMs(point.date), value: String(point.views),
    observationId: `wikimedia:en.wikipedia:all-access:user:${activity.article}:${point.date}`,
  }));
  const gaps: ConsumerSeries['gaps'] = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i].atMs - points[i - 1].atMs > DAY_MS) gaps.push({ fromMs: points[i - 1].atMs, toMs: points[i].atMs });
  }
  return [{ id: `reference:series:${snapshot.slug}:wikipedia-pageviews`, kind: 'ACTIVITY_COUNT',
    label: 'English Wikipedia article pageviews', unit: 'views/day', points, gaps, source: sourceFor(snapshot) }];
}

export function isReferenceConsumerId(id: string): boolean { return id.startsWith('reference:'); }

/** Static public observations. No prices, settlement indices, invented people, or execution capability. */
export function createReferenceConsumerReadApi(): ConsumerReadApi {
  return {
    async listMarkets() { return copy(built.map(item => item.market)); },
    async getHistory(id, period) {
      const item = byId.get(id);
      if (!item) return null;
      const history: MarketHistory = { market: item.market, period, source: item.market.source,
        series: seriesFor(item.snapshot, period), actions: [] };
      return copy(history);
    },
    async getProfile() { return null; },
    async getLeaderboard(period) {
      return { period, rows: [], source: { mode: 'REFERENCE', label: 'No participation records in the public reference catalog', asOfMs: REFERENCE_AS_OF_MS } };
    },
  };
}

export const referenceConsumerReadApi = createReferenceConsumerReadApi();
