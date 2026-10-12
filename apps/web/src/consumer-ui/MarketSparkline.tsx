import type { ConsumerMarket, ConsumerSeries, MarketHistory } from '../../../../contracts/consumer';
import { formatChange } from './copy';

interface SparkPoint { atMs: number; value: number; x: number; y: number }
const activityPreference: ConsumerSeries['kind'][] = ['ACTIVITY_COUNT', 'ATTENTION_INDEX', 'CURVE_PRICE', 'REFERENCE_PRICE', 'TRADE_PRICE'];
const pricePreference: ConsumerSeries['kind'][] = ['CURVE_PRICE', 'REFERENCE_PRICE', 'TRADE_PRICE', 'ATTENTION_INDEX', 'ACTIVITY_COUNT'];
const dateLabel = (atMs: number) => new Date(atMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Coordinates use only observed points. Every source-declared gap breaks the line. */
export function sparklineModel(market: ConsumerMarket, history?: MarketHistory) {
  if (!history || history.market.id !== market.id || history.source.mode !== market.source.mode) return null;
  const preference = market.source.mode === 'LIVE' ? pricePreference : activityPreference;
  const series = preference.map(kind => history.series.find(candidate => candidate.kind === kind && candidate.source.mode === history.source.mode && candidate.points.length > 0)).find(Boolean);
  if (!series) return null;
  const observed = series.points.map(point => ({ atMs: point.atMs, value: Number(point.value) }))
    .filter(point => Number.isFinite(point.atMs) && Number.isFinite(point.value) && point.atMs <= series.source.asOfMs)
    .sort((a, b) => a.atMs - b.atMs);
  if (observed.length < 2 || observed[0].atMs === observed.at(-1)!.atMs) return null;
  const first = observed[0], last = observed.at(-1)!;
  let min = Infinity, max = -Infinity;
  for (const point of observed) { min = Math.min(min, point.value); max = Math.max(max, point.value); }
  const range = max - min;
  const points: SparkPoint[] = observed.map(point => ({ ...point,
    x: 5 + (point.atMs - first.atMs) / (last.atMs - first.atMs) * 170,
    y: range ? 47 - (point.value - min) / range * 38 : 28,
  }));
  const segments: SparkPoint[][] = [];
  for (const point of points) {
    const current = segments.at(-1), previous = current?.at(-1);
    const crossesGap = previous && series.gaps.some(gap => previous.atMs < gap.toMs && point.atMs > gap.fromMs);
    if (!current || crossesGap || series.kind === 'TRADE_PRICE') segments.push([point]);
    else current.push(point);
  }
  return { series, points, segments, first, last, change: first.value > 0 ? last.value / first.value - 1 : null };
}

export function MarketSparkline({ market, history }: { market: ConsumerMarket; history?: MarketHistory }) {
  const model = sparklineModel(market, history);
  if (!model) return <span className="au-sparkline au-sparkline-empty" data-market-id={market.id}>
    <span className="au-sparkline-empty-label">History not available</span>
    <small>{history?.series.some(series => series.points.length === 1) ? 'One captured observation' : 'No observed trend yet'}</small>
  </span>;
  const { series, points, segments, first, last, change } = model;
  const sparse = segments.every(segment => segment.length === 1);
  const dates = `${dateLabel(first.atMs)} – ${dateLabel(last.atMs)}`;
  const metric = series.label;
  const description = `${metric}: ${points.length} observations, ${dates}. ${change === null ? 'Change unavailable because the first observation is zero.' : `${formatChange(change)} from first to last observed value.`}${sparse ? ' Separate dots show sparse observations; intervals are unobserved.' : ' Lines connect consecutive observations; missing intervals remain blank.'}`;
  return <span className={`au-sparkline${change !== null && change < 0 ? ' au-sparkline-down' : ''}`} data-market-id={market.id} data-series-kind={series.kind}>
    <span className="au-sparkline-metric" title={metric}>{metric}</span>
    <svg className="au-sparkline-plot" viewBox="0 0 180 56" role="img" aria-label={description} preserveAspectRatio="none">
      <title>{description}</title>
      {segments.filter(segment => segment.length > 1).map((segment, index) => <polyline key={index} className="au-sparkline-segment"
        data-from-ms={segment[0].atMs} data-to-ms={segment.at(-1)!.atMs}
        points={segment.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')} />)}
      {points.map((point, index) => <circle key={`${point.atMs}:${index}`} className="au-sparkline-point" cx={point.x} cy={point.y}
        r={sparse ? 3.5 : index === points.length - 1 ? 3 : 1.7} data-at-ms={point.atMs} data-value={point.value} />)}
    </svg>
    <span className="au-sparkline-summary"><strong>{formatChange(change)}</strong><small>{sparse ? 'Sparse observations' : dates}</small></span>
    <small className="au-sparkline-basis">First → last observation{sparse ? ` · ${dates}` : ''}</small>
  </span>;
}
