import type { ConsumerMarket, ConsumerPeriod, ConsumerSeries } from '../../../../contracts/consumer.ts';

const DAY = 86_400_000;
const DAYS = 28;

/** User-requested layout values. Neither observed counts nor a financial or settlement series. */
export function createIllustrativeHistory(market: ConsumerMarket, period: ConsumerPeriod): ConsumerSeries | null {
  if (market.source.mode !== 'REFERENCE' || !Number.isFinite(market.source.asOfMs)) return null;
  let seed = 2166136261;
  for (const character of market.id) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4_294_967_296;
  };
  // Generate the complete shape before period selection, so overlapping periods agree.
  const values = [100];
  const drift = (next() - 0.45) * 0.025;
  for (let day = 1; day <= DAYS; day++) values.push(values[day - 1] * (1 + drift + (next() - 0.5) * 0.10));
  const final = values.at(-1)!;
  const end = market.source.asOfMs;
  const days = period === '1D' ? 1 : period === '1W' ? 7 : period === '1M' ? 30 : Infinity;
  const points = values.map((value, day) => ({
    atMs: end - (DAYS - day) * DAY,
    value: day === DAYS ? '100.00' : (value / final * 100).toFixed(2),
  })).filter(point => point.atMs >= end - days * DAY);
  return {
    id: `illustrative:${market.id}:layout-preview`, kind: 'ATTENTION_INDEX', evidence: 'ILLUSTRATIVE',
    label: 'Illustrative layout preview', unit: 'preview index', points, gaps: [],
    source: { mode: 'REFERENCE', asOfMs: end, label: 'Illustrative layout preview · not measured',
      observationLabel: 'Generated preview values · latest = 100 · not source observations' },
    observationNote: 'Temporary generated values for the chart layout. Latest preview index = 100. These are not measured platform counts, historical observations, forecasts, trading returns, or settlement inputs.',
  };
}
