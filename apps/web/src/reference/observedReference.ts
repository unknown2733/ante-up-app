import type { ConsumerMarket, ConsumerReadApi, ConsumerSeries, MarketHistory } from '../../../../contracts/consumer.ts';
import type { ReferenceObservation } from '../../../../contracts/reference/observations.ts';
import { validateReferenceObservation } from '../../../../contracts/reference/observations.ts';
import { referenceConsumerReadApi } from './referenceData.ts';
import { createIllustrativeHistory } from './illustrativeHistory.ts';

const DAY = 86_400_000;
const PREFIX = 'reference:market:';
const span = (period: MarketHistory['period']) => period === '1D' ? DAY : period === '1W' ? 7 * DAY : period === '1M' ? 30 * DAY : Infinity;
const observationId = (item: ReferenceObservation) => `public:${item.rawSha256}:${item.observedAtMs}`;
const sourceFor = (item: ReferenceObservation) => ({
  mode: 'REFERENCE' as const, asOfMs: item.observedAtMs, sourceUrl: item.sourceUrl,
  label: `${item.kind.replaceAll('_', ' ')} · ${item.provider} · captured ${new Date(item.capturedAtMs).toISOString()}`,
  observationLabel: item.reportedDate
    ? `${item.provider} report dated ${item.reportedDate} (time zone not supplied)`
    : `Captured platform count · ${new Date(item.capturedAtMs).toISOString()}`,
});

/** New verified observations enrich a read-only subject; they never make it tradeable. */
export function mergeReferenceMarket(base: ConsumerMarket, item: ReferenceObservation | undefined): ConsumerMarket {
  if (!item || item.observedAtMs < base.source.asOfMs) return base;
  const source = sourceFor(item);
  return { ...base, phase: 'PREVIEW', source, latestPrice: null, changeFraction: null,
    activity: base.activity && { ...base.activity, value: item.value, asOfMs: item.observedAtMs, changeFraction: null } };
}

export function mergeReferenceHistory(base: MarketHistory, observations: ReferenceObservation[]): MarketHistory {
  const slug = base.market.id.slice(PREFIX.length);
  const matching = observations.filter(item => item.slug === slug && item.aggregation === (base.series[0].aggregation ?? 'cumulative'));
  if (!matching.length) return base;
  const known = new Map(base.series[0].points.map(point => [point.atMs, point]));
  const byTime = new Map<number, ReferenceObservation>();
  for (const item of matching) {
    const previous = byTime.get(item.observedAtMs);
    if (!previous || item.capturedAtMs > previous.capturedAtMs) byTime.set(item.observedAtMs, item);
  }
  for (const item of byTime.values()) known.set(item.observedAtMs, {
    atMs: item.observedAtMs, value: item.value, observationId: observationId(item),
    ...(item.reportedDate ? { reportedDate: item.reportedDate, sourceUrl: item.sourceUrl } : {}),
  });
  const all = [...known.values()].sort((a, b) => a.atMs - b.atMs);
  const newest = [...byTime.values()].sort((a, b) => b.observedAtMs - a.observedAtMs || b.capturedAtMs - a.capturedAtMs)[0];
  const market = mergeReferenceMarket(base.market, newest);
  const cutoff = market.source.asOfMs - span(base.period);
  const points = all.filter(point => point.atMs >= cutoff);
  const series: ConsumerSeries = { ...base.series[0], source: market.source, points,
    gaps: points.slice(1).flatMap((point, i) => point.atMs - points[i].atMs > DAY
      ? [{ fromMs: points[i].atMs, toMs: point.atMs }] : []) };
  // A new dated report can still leave only a handful of measured points. Keep the
  // optional preview in its own evidence lane until there is usable source history.
  const preview = all.length < 7 ? createIllustrativeHistory(market, base.period) : null;
  return { ...base, market, source: market.source, series: preview ? [series, preview] : [series], actions: [] };
}

export function createObservedReferenceReadApi(baseUrl: string, fetcher: typeof fetch = fetch): ConsumerReadApi {
  const origin = baseUrl.replace(/\/$/, '');
  async function read(path: string): Promise<ReferenceObservation[]> {
    const response = await fetcher(`${origin}/v1/reference/${path}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Reference observations unavailable (${response.status}).`);
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('schemaVersion' in body) || body.schemaVersion !== '0.1' ||
        !('mode' in body) || body.mode !== 'devnet' || !('asOf' in body) || !Number.isSafeInteger(body.asOf) ||
        !('data' in body) || !Array.isArray(body.data)) throw new Error('Invalid reference observation response.');
    return body.data.map(value => validateReferenceObservation(value));
  }
  return {
    ...referenceConsumerReadApi,
    async listMarkets() {
      const base = await referenceConsumerReadApi.listMarkets();
      let latest: ReferenceObservation[];
      try { latest = await read('latest'); } catch { return base; }
      const bySlug = new Map(latest.map(item => [item.slug, item]));
      return base.map(market => mergeReferenceMarket(market, bySlug.get(market.id.slice(PREFIX.length))));
    },
    async getHistory(id, period) {
      const base = await referenceConsumerReadApi.getHistory(id, period);
      if (!base) return null;
      const slug = id.slice(PREFIX.length);
      let observations: ReferenceObservation[];
      // A provider's report date can be older than the day it was captured. Fetch
      // the bounded observation journal before clipping relative to its latest date.
      const sinceMs = 0;
      try { observations = await read(`history/${encodeURIComponent(slug)}?sinceMs=${sinceMs}`); }
      catch { return base; }
      return mergeReferenceHistory(base, observations);
    },
  };
}
